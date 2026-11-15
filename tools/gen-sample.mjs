// tools/gen-sample.mjs — deterministic sample meshes. Same command, same bytes.
//   node tools/gen-sample.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'data');

// ---- deterministic LCG (numerical recipes constants) -----------------------
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- icosphere -------------------------------------------------------------
function icosphere(subdiv) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(normalize);
  let tris = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map();
    const next = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const p = normalize([
        (verts[a][0] + verts[b][0]) / 2,
        (verts[a][1] + verts[b][1]) / 2,
        (verts[a][2] + verts[b][2]) / 2,
      ]);
      verts.push(p);
      const id = verts.length - 1;
      mid.set(key, id);
      return id;
    };
    for (const [a, b, c] of tris) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  return { positions: verts.flat(), indices: tris.flat() };
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---- torus -----------------------------------------------------------------
function torus(nU, nV, R = 1, r = 0.38) {
  const positions = [];
  const index = (u, v) => (u % nU) * nV + (v % nV);
  for (let u = 0; u < nU; u++) {
    const a = (2 * Math.PI * u) / nU;
    for (let v = 0; v < nV; v++) {
      const b = (2 * Math.PI * v) / nV;
      positions.push(
        (R + r * Math.cos(b)) * Math.cos(a),
        (R + r * Math.cos(b)) * Math.sin(a),
        r * Math.sin(b),
      );
    }
  }
  const indices = [];
  for (let u = 0; u < nU; u++) {
    for (let v = 0; v < nV; v++) {
      const a = index(u, v), b = index(u + 1, v), c = index(u + 1, v + 1), d = index(u, v + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices };
}

// ---- order transforms ------------------------------------------------------
function shuffleTriangles(indices, seed) {
  const rnd = lcg(seed);
  const t = indices.length / 3;
  const order = Array.from({ length: t }, (_, i) => i);
  for (let i = t - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  const out = [];
  for (const i of order) out.push(indices[3 * i], indices[3 * i + 1], indices[3 * i + 2]);
  return out;
}

function vertexMajor(indices, vertexCount) {
  const byVertex = Array.from({ length: vertexCount }, () => []);
  for (let i = 0; i < indices.length / 3; i++) {
    byVertex[indices[3 * i]].push(i);
  }
  const seen = new Uint8Array(indices.length / 3);
  const out = [];
  for (let v = 0; v < vertexCount; v++) {
    for (const t of byVertex[v]) {
      if (seen[t]) continue;
      seen[t] = 1;
      out.push(indices[3 * t], indices[3 * t + 1], indices[3 * t + 2]);
    }
  }
  return out;
}

// ---- build -----------------------------------------------------------------
function round6(x) { return Math.round(x * 1e6) / 1e6; }

function writeMesh(name, mesh, order, note) {
  const positions = mesh.positions.map(round6);
  const payload = {
    name,
    order,
    note,
    vertexCount: positions.length / 3,
    triangleCount: mesh.indices.length / 3,
    positions,
    indices: mesh.indices,
  };
  const text = JSON.stringify(payload);
  writeFileSync(join(outDir, `${name}.json`), text + '\n');
  const sha = createHash('sha256').update(text).digest('hex').slice(0, 16);
  console.log(`${name}: ${payload.triangleCount} tris, ${payload.vertexCount} verts, ${(text.length / 1024).toFixed(1)} KiB, sha256:${sha}`);
  return { name, sha };
}

mkdirSync(outDir, { recursive: true });

const ico5 = icosphere(5);
const ico4 = icosphere(4);
const tor = torus(96, 48);

const manifest = [];
manifest.push(writeMesh(
  'sphere-soup',
  { positions: ico5.positions, indices: shuffleTriangles(ico5.indices, 20261115) },
  'shuffled',
  'Icosphere subdiv 5 with all triangles shuffled: worst-case exporter / post-filter order.',
));
manifest.push(writeMesh(
  'sphere-vmajor',
  { positions: ico4.positions, indices: vertexMajor(ico4.indices, ico4.positions.length / 3) },
  'vertex-major',
  'Icosphere subdiv 4 grouped by first vertex: a common naive CPU exporter order.',
));
manifest.push(writeMesh(
  'torus-natural',
  { positions: tor.positions, indices: tor.indices },
  'natural-grid',
  'Torus 96x48 in natural grid order: already cache-friendly, so the headroom is small by construction.',
));

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ seed: 20261115, meshes: manifest }, null, 2) + '\n');
console.log('wrote data/manifest.json');
