// bench/verify.mjs — assertions over the sample meshes. Exit 0 only if all pass.
//   node tools/gen-sample.mjs && node bench/verify.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  optimizeIndices, simulateCache, simulateCacheFifo, permutationCertificate,
  hashIndices, bounds, scalePositions, maxPositionDelta, DEFAULT_CACHE_SIZE,
} from '../src/core.mjs';
import { originalOrder, sortByMinVertex, naiveLru, naiveFifo } from '../baseline/naive.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const K = DEFAULT_CACHE_SIZE;
const SCALES = [1e-6, 1e-3, 1, 1e3, 1e6];

let passed = 0;
let failed = 0;
const log = [];
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  const line = `${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`;
  log.push(line);
  console.log(line);
}
const pct = (a, b) => (100 * (1 - b / a));

const meshes = ['sphere-soup', 'sphere-vmajor', 'torus-natural'].map((n) =>
  JSON.parse(readFileSync(join(root, 'data', `${n}.json`), 'utf8')));

const prepared = meshes.map((m) => {
  const optimized = optimizeIndices(m.indices, m.vertexCount, K);
  const orig = simulateCache(m.indices, K);
  const opt = simulateCache(optimized, K);
  const sorted = sortByMinVertex(m.indices);
  return {
    m, optimized, orig, opt,
    sorted,
    sortedSim: simulateCache(sorted, K),
    cert: permutationCertificate(m.indices, optimized, m.vertexCount),
  };
});

console.log('--- corpus ---');
for (const p of prepared) {
  console.log(`${p.m.name}: ${p.m.triangleCount} tris / ${p.m.vertexCount} verts, order=${p.m.order}`);
}

// --- G4 assertions ---------------------------------------------------------
for (const p of prepared) {
  const { m, optimized, cert } = p;
  check(`${m.name}/length`, optimized.length === m.indices.length,
    `out=${optimized.length} in=${m.indices.length}`);
  let outOfRange = 0;
  for (const v of optimized) if (v < 0 || v >= m.vertexCount) outOfRange++;
  check(`${m.name}/indices-in-range`, outOfRange === 0,
    `outOfRange=${outOfRange} vertexCount=${m.vertexCount}`);
  check(`${m.name}/permutation-certificate`, cert.same === true && cert.changed === 0,
    `same=${cert.same} changed=${cert.changed} distinctTriangles=${cert.distinctTriangles}/${cert.triangles}`);
  const flipped = Uint32Array.from(m.indices);
  if (flipped.length >= 3) { const t0 = flipped[0]; flipped[0] = flipped[1]; flipped[1] = t0; }
  const neg = permutationCertificate(m.indices, flipped, m.vertexCount);
  check(`${m.name}/negative-control-detects-flip`, neg.same === false && neg.changed > 0,
    `flipped one triangle: same=${neg.same} changed=${neg.changed} (certificate is not vacuous)`);
  check(`${m.name}/atvr-cut-vs-exporter-order`, pct(p.orig.atvr, p.opt.atvr) >= (m.order === 'natural-grid' ? 3 : 20),
    `ATVR ${p.orig.atvr.toFixed(4)} -> ${p.opt.atvr.toFixed(4)} (${pct(p.orig.atvr, p.opt.atvr).toFixed(2)}% cut @k=${K})`);
  check(`${m.name}/atvr-beats-min-vertex-sort`, p.opt.atvr <= p.sortedSim.atvr,
    `ours=${p.opt.atvr.toFixed(4)} sortByMinVertex=${p.sortedSim.atvr.toFixed(4)}`);
  check(`${m.name}/hits+misses==references`, p.opt.hits + p.opt.misses === 3 * p.m.triangleCount,
    `${p.opt.hits}+${p.opt.misses}==${3 * p.m.triangleCount}`);
}

// determinism
for (const p of prepared) {
  const again = optimizeIndices(p.m.indices, p.m.vertexCount, K);
  check(`${p.m.name}/deterministic`, hashIndices(again) === hashIndices(p.optimized),
    `hash=${hashIndices(p.optimized).toString(16)} twice=${hashIndices(again).toString(16)}`);
}

// independent simulator agreement (LRU and FIFO), several cache sizes
{
  let mismatches = 0;
  let comparisons = 0;
  const detail = [];
  for (const p of prepared) {
    for (const order of [{ tag: 'input', idx: p.m.indices }, { tag: 'optimized', idx: p.optimized }]) {
      for (const k of [8, 32, 64]) {
        const a = simulateCache(order.idx, k);
        const b = naiveLru(order.idx, k);
        comparisons += 2;
        if (a.hits !== b.hits || a.misses !== b.misses) { mismatches++; detail.push(`${p.m.name}/${order.tag}/k=${k}: core=${a.hits}/${a.misses} naive=${b.hits}/${b.misses}`); }
        const c = simulateCacheFifo(order.idx, k);
        const d = naiveFifo(order.idx, k);
        if (c.hits !== d.hits || c.misses !== d.misses) { mismatches++; detail.push(`${p.m.name}/${order.tag}/k=${k}/FIFO: core=${c.hits} naive=${d.hits}`); }
      }
    }
  }
  check('independent-simulator/0-mismatch', mismatches === 0,
    `comparisons=${comparisons} mismatches=${mismatches}${detail.length ? ' first=' + detail[0] : ''}`);
}

// cache-size limits
{
  const p = prepared[0];
  const one = simulateCache(p.optimized, 1);
  const huge = simulateCache(p.optimized, 1 << 20);
  const unique = new Set(p.optimized).size;
  let adj = 0;
  for (let i = 1; i < p.optimized.length; i++) if (p.optimized[i] === p.optimized[i - 1]) adj++;
  const expectOne = 3 - adj / p.m.triangleCount;
  check('limit/k=1 => ATVR=3-consecutiveRepeat/T', Math.abs(one.atvr - expectOne) < 1e-15,
    `atvr=${one.atvr} expected=${expectOne.toFixed(6)} consecutiveRepeatRefs=${adj} misses=${one.misses}/${3 * p.m.triangleCount}`);
  check('limit/k>=V => ATVR=uniqueVerts/T', Math.abs(huge.atvr - unique / p.m.triangleCount) < 1e-15,
    `atvr=${huge.atvr} expected=${(unique / p.m.triangleCount).toFixed(6)} unique=${unique}`);
}

// cache-size monotonicity on the optimized order
for (const p of prepared) {
  const a = simulateCache(p.optimized, 8).atvr;
  const b = simulateCache(p.optimized, 32).atvr;
  const c = simulateCache(p.optimized, 64).atvr;
  check(`${p.m.name}/monotone-atvr-8>=32>=64`, a >= b - 1e-12 && b >= c - 1e-12,
    `${a.toFixed(4)} >= ${b.toFixed(4)} >= ${c.toFixed(4)}`);
}

// scale invariance: integer output depends only on topology
{
  let hashMismatch = 0;
  let atvrMismatch = 0;
  let bboxErr = 0;
  let posDelta = 0;
  const rows = [];
  const p = prepared[0];
  const baseHash = hashIndices(p.optimized);
  const baseAtvr = p.opt.atvr;
  const ref = bounds(p.m.positions);
  for (const k of SCALES) {
    const scaled = scalePositions(p.m.positions, k);
    const b = bounds(scaled);
    const rel = Math.abs(b.diagonal / (ref.diagonal * k) - 1);
    if (rel > bboxErr) bboxErr = rel;
    const idx = optimizeIndices(p.m.indices, p.m.vertexCount, K);
    if (hashIndices(idx) !== baseHash) hashMismatch++;
    const sim = simulateCache(idx, K);
    if (Math.abs(sim.atvr - baseAtvr) > 0) atvrMismatch++;
    // the reorderer is topology-only: it must return the same integer stream
    // at every scale, and the scaled positions must be exactly k * original
    let worst = 0;
    for (let i = 0; i < scaled.length; i++) {
      const ref = p.m.positions[i];
      worst = Math.max(worst, Math.abs(scaled[i] - ref * k));
    }
    if (worst > posDelta) posDelta = worst;
    rows.push(`k=${k}: bbox=${b.diagonal.toFixed(6)} atvr=${sim.atvr.toFixed(6)}`);
  }
  check('scale/invariant-order-and-atvr', hashMismatch === 0 && atvrMismatch === 0,
    `scales=${SCALES.length} hashMismatch=${hashMismatch} atvrMismatch=${atvrMismatch}`);
  check('scale/bbox-exact-ratio', bboxErr < 1e-12, `maxRelErr=${bboxErr.toExponential(3)} | ${rows[0]} | ${rows[4]}`);
  check('scale/scalePositions-identical-product', posDelta === 0, `max|scaled[i] - ref[i]*k|=${posDelta}`);
}

// degenerate / tiny inputs must not throw and must stay a permutation
{
  const cases = [
    { name: 'empty', indices: [], vertexCount: 1 },
    { name: 'one-triangle', indices: [0, 1, 2], vertexCount: 3 },
    { name: 'degenerate-triangle', indices: [4, 4, 4], vertexCount: 5 },
    { name: 'repeated-pair', indices: [2, 2, 3, 3, 2, 2], vertexCount: 4 },
  ];
  let bad = [];
  for (const c of cases) {
    try {
      const out = optimizeIndices(c.indices, c.vertexCount, K);
      const cert = permutationCertificate(c.indices, out, c.vertexCount);
      if (!cert.same) bad.push(`${c.name}: changed=${cert.changed}`);
      if (out.length !== c.indices.length) bad.push(`${c.name}: length`);
    } catch (e) {
      bad.push(`${c.name}: threw ${e.message}`);
    }
  }
  check('edge-cases/no-throw-and-permutation', bad.length === 0, `cases=${cases.length} problems=${bad.length}${bad.length ? ' ' + bad.join('; ') : ''}`);
}

// baseline cost comparison (topology-only alternative is cheaper but weaker)
{
  const p = prepared[0];
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) sortByMinVertex(p.m.indices);
  const sortMs = (performance.now() - t0) / 5;
  const t1 = performance.now();
  for (let i = 0; i < 5; i++) optimizeIndices(p.m.indices, p.m.vertexCount, K);
  const optMs = (performance.now() - t1) / 5;
  check('headline/soup-cut>=60%', pct(p.orig.atvr, p.opt.atvr) >= 60,
    `${p.m.name} ATVR ${p.orig.atvr.toFixed(4)} -> ${p.opt.atvr.toFixed(4)} (${pct(p.orig.atvr, p.opt.atvr).toFixed(2)}% cut)`);
  check('headline/quality-vs-cheap-baseline', p.opt.atvr < p.sortedSim.atvr,
    `ours=${p.opt.atvr.toFixed(4)} minVertexSort=${p.sortedSim.atvr.toFixed(4)} (${sortMs.toFixed(2)} ms vs ${optMs.toFixed(2)} ms)`);
}

console.log(`\nRESULT ${failed ? 'FAIL' : 'PASS'}: ${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
