// bench/bench.mjs — real timings + cache metrics into bench/result.json.
//   node tools/gen-sample.mjs && node bench/bench.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeIndices, simulateCache, hashIndices, DEFAULT_CACHE_SIZE } from '../src/core.mjs';
import { sortByMinVertex, naiveLru } from '../baseline/naive.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const K = DEFAULT_CACHE_SIZE;
const SAMPLES = 9;
const names = ['sphere-soup', 'sphere-vmajor', 'torus-natural'];
const meshes = names.map((n) => JSON.parse(readFileSync(join(root, 'data', `${n}.json`), 'utf8')));

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const p95 = s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return { min: s[0], median, p95, max: s[n - 1], stddev: Math.sqrt(variance), relStddev: Math.sqrt(variance) / (mean || 1) };
}

const out = {
  schema: 'vertexcache-lab/bench/1',
  node: process.version,
  cacheSize: K,
  samples: SAMPLES,
  measuredAt: new Date().toISOString(),
  meshes: [],
};

for (const m of meshes) {
  const inner = m.triangleCount > 15000 ? 6 : 10;
  // cold start = very first call in this process
  const c0 = performance.now();
  optimizeIndices(m.indices, m.vertexCount, K);
  const coldMs = performance.now() - c0;

  // warmup
  optimizeIndices(m.indices, m.vertexCount, K);

  const times = [];
  let last = null;
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let r = 0; r < inner; r++) last = optimizeIndices(m.indices, m.vertexCount, K);
    times.push((performance.now() - t0) / inner);
  }

  const sortTimes = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let r = 0; r < inner; r++) sortByMinVertex(m.indices);
    sortTimes.push((performance.now() - t0) / inner);
  }

  const optimized = last;
  const origSim = simulateCache(m.indices, K);
  const optSim = simulateCache(optimized, K);
  const sortedSim = simulateCache(sortByMinVertex(m.indices), K);
  const ours = stats(times);
  const cheap = stats(sortTimes);

  out.meshes.push({
    name: m.name,
    order: m.order,
    triangles: m.triangleCount,
    vertices: m.vertexCount,
    atvrExporterOrder: origSim.atvr,
    atvrOptimized: optSim.atvr,
    atvrCutPct: 100 * (1 - optSim.atvr / origSim.atvr),
    atvrSortByMinVertex: sortedSim.atvr,
    uniqueVertices: origSim.uniqueVertices,
    optimizeMs: { cold: coldMs, ...ours, samples: SAMPLES, inner },
    sortByMinVertexMs: { ...cheap, samples: SAMPLES, inner },
    throughputTrisPerMs: m.triangleCount / ours.median,
    outputHash: hashIndices(optimized),
    independentOracleHits: { core: optSim.hits, naiveLru: naiveLru(optimized, K).hits },
  });
  const r = out.meshes[out.meshes.length - 1];
  console.log(`${m.name}: ATVR ${origSim.atvr.toFixed(4)} -> ${optSim.atvr.toFixed(4)} (${r.atvrCutPct.toFixed(2)}%) | median ${ours.median.toFixed(2)} ms (cold ${coldMs.toFixed(2)}, relSD ${(100 * ours.relStddev).toFixed(1)}%) | oracle ${r.independentOracleHits.core}/${r.independentOracleHits.naiveLru}`);
}

writeFileSync(join(root, 'bench', 'result.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote bench/result.json');
