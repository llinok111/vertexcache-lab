// src/core.mjs — pure index-order / vertex-cache math.
// No three.js, no DOM, no I/O, no globals. Every function is deterministic.
//
// Vocabulary
//   references = 3 * triangles (one fetch per index)
//   misses     = vertex fetches that the simulated cache could not serve
//   ATVR       = misses / triangles  (average transformed vertices per triangle)
//   ACMR       = references / triangles = 3 by definition
//
// The cache model is an LRU of `cacheSize` distinct vertex ids. A triangle's
// three indices are touched left-to-right; a fetch of a vertex already resident
// is a hit, and the vertex becomes most-recently-used.

export const DEFAULT_CACHE_SIZE = 32;

/** @param {ArrayLike<number>} indices */
export function triangleCount(indices) {
  return (indices.length / 3) | 0;
}

/**
 * Rotate each triangle so its smallest index comes first, keeping winding.
 * Returns a Float64Array of packed keys, sorted ascending. Two index buffers
 * denote the same oriented triangle set iff their keys are element-wise equal.
 * Keys fit in 2^53 for vertexCount <= 200000.
 */
export function canonicalTriangles(indices, vertexCount) {
  const t = triangleCount(indices);
  const V = Math.max(1, vertexCount);
  const keys = new Float64Array(t);
  for (let i = 0; i < t; i++) {
    const a = indices[3 * i], b = indices[3 * i + 1], c = indices[3 * i + 2];
    let x = a, y = b, z = c;
    if (b < x && b <= c) { x = b; y = c; z = a; }
    else if (c < x && c < b) { x = c; y = a; z = b; }
    keys[i] = x * V * V + y * V + z;
  }
  keys.sort();
  return keys;
}

/**
 * Certificate that `b` is a permutation of `a` with no triangle added, removed
 * or re-wound. `changed` counts canonical keys present in one buffer only.
 */
export function permutationCertificate(a, b, vertexCount) {
  if (a.length !== b.length) {
    return { same: false, changed: Math.abs(a.length - b.length), triangles: triangleCount(a) };
  }
  const ka = canonicalTriangles(a, vertexCount);
  const kb = canonicalTriangles(b, vertexCount);
  let diff = 0;
  let firstAt = -1;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) { diff++; if (firstAt < 0) firstAt = i; }
  }
  return {
    same: diff === 0,
    changed: diff,
    triangles: ka.length,
    firstDifferenceAt: firstAt,
    distinctTriangles: new Set(ka).size,
  };
}

/** FNV-1a over the uint32 index stream; used for determinism assertions. */
export function hashIndices(indices) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < indices.length; i++) {
    let x = indices[i] >>> 0;
    for (let k = 0; k < 4; k++) {
      h ^= (x >>> (8 * k)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/**
 * O(1)-per-reference LRU cache simulation using an intrusive doubly linked list
 * over vertex ids. Independent of the bucket scheduler below, so `bench/verify`
 * can cross-check the two.
 *
 * LRU only; `simulateCacheFifo` below is a separate FIFO implementation.
 */
export function simulateCache(indices, cacheSize) {
  const t = triangleCount(indices);
  const V = maxIndex(indices) + 1;
  const k = Math.max(1, Math.min(cacheSize | 0, Math.max(1, V)));
  const prev = new Int32Array(V).fill(-1);
  const next = new Int32Array(V).fill(-1);
  const resident = new Uint8Array(V);
  let head = -1; // most recently used (or newest for FIFO)
  let tail = -1; // eviction candidate
  let size = 0;
  let hits = 0;
  let misses = 0;

  const unlink = (v) => {
    if (prev[v] >= 0) next[prev[v]] = next[v]; else head = next[v];
    if (next[v] >= 0) prev[next[v]] = prev[v]; else tail = prev[v];
    prev[v] = next[v] = -1;
    size--;
  };
  const pushFront = (v) => {
    prev[v] = -1; next[v] = head;
    if (head >= 0) prev[head] = v; else tail = v;
    head = v;
    if (tail < 0) tail = v;
    size++;
  };
  for (let i = 0; i < t; i++) {
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      if (resident[v]) {
        hits++;
        if (head !== v) { unlink(v); pushFront(v); }
      } else {
        misses++;
        if (size >= k) {
          const victim = tail;
          unlink(victim);
          resident[victim] = 0;
        }
        resident[v] = 1;
        pushFront(v);
      }
    }
  }
  return {
    cacheSize: k,
    policy: 'LRU',
    triangles: t,
    references: 3 * t,
    hits,
    misses,
    atvr: t ? misses / t : 0,
    acmr: t ? (3 * t) / t : 0,
    uniqueVertices: countUnique(indices),
  };
}

/** FIFO needs its own victim end; this wrapper keeps the public shape honest. */
export function simulateCacheFifo(indices, cacheSize) {
  const t = triangleCount(indices);
  const V = maxIndex(indices) + 1;
  const k = Math.max(1, Math.min(cacheSize | 0, Math.max(1, V)));
  const ring = new Int32Array(k).fill(-1);
  const where = new Int32Array(V).fill(-1);
  let head = 0;
  let fill = 0;
  let hits = 0;
  let misses = 0;
  for (let i = 0; i < t; i++) {
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      const s = where[v];
      if (s >= 0 && ring[s] === v) { hits++; continue; }
      misses++;
      let slot;
      if (fill < k) { slot = fill++; }
      else { slot = head; head = (head + 1) % k; where[ring[slot]] = -1; }
      ring[slot] = v;
      where[v] = slot;
    }
  }
  return { cacheSize: k, policy: 'FIFO', triangles: t, references: 3 * t, hits, misses, atvr: t ? misses / t : 0, acmr: 3, uniqueVertices: countUnique(indices) };
}

function maxIndex(indices) {
  let m = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] > m) m = indices[i];
  return m;
}

function countUnique(indices) {
  const seen = new Set();
  for (let i = 0; i < indices.length; i++) seen.add(indices[i]);
  return seen.size;
}

/**
 * Cache-aware index reordering.
 *
 * Bucket scheduler: every unemitted triangle carries `hits` = how many of its
 * three vertices are currently resident. Triangles are kept in four LIFO
 * buckets indexed by `hits`; we always emit from the highest non-empty bucket
 * (3 -> 2 -> 1), which keeps the current fan hot. When every bucket is empty
 * (a cold seam) we resume at the lowest-index unemitted triangle. Entries are
 * validated lazily against the live hit count, so eviction needs no deletion.
 *
 * Returns a fresh Uint32Array; the input array is never mutated.
 */
export function optimizeIndices(indices, vertexCount, cacheSize = DEFAULT_CACHE_SIZE) {
  const t = triangleCount(indices);
  const V = Math.max(1, vertexCount | 0);
  const out = new Uint32Array(Math.max(0, 3 * t));
  if (t === 0) return out;
  const k = Math.max(1, Math.min(cacheSize | 0, V));

  // vertex -> incident triangles (CSR)
  const start = new Uint32Array(V + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const cursor = start.slice(0, V);
  const adj = new Uint32Array(indices.length);
  for (let i = 0; i < t; i++) {
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      adj[cursor[v]++] = i;
    }
  }

  const emitted = new Uint8Array(t);
  const hits = new Uint8Array(t);
  const buckets = [[], [], [], []];
  const pos = new Int32Array(V).fill(-1); // position in cache, MRU = 0
  const cache = new Int32Array(k).fill(-1);
  let cacheLen = 0;
  let pending = 0;

  const bucketPush = (tri) => { buckets[hits[tri]].push(tri); pending++; };

  // A vertex enters the cache: every unemitted incident triangle gains a hit.
  const enter = (v) => {
    for (let j = start[v]; j < start[v + 1]; j++) {
      const tri = adj[j];
      if (emitted[tri]) continue;
      hits[tri]++;
      bucketPush(tri);
    }
  };
  const leave = (v) => {
    for (let j = start[v]; j < start[v + 1]; j++) {
      const tri = adj[j];
      if (emitted[tri]) continue;
      if (hits[tri] > 0) hits[tri]--;
    }
  };

  const touch = (v) => {
    const p = pos[v];
    if (p >= 0) { // hit: move to front
      for (let i = p; i > 0; i--) { cache[i] = cache[i - 1]; pos[cache[i]] = i; }
      cache[0] = v;
      pos[v] = 0;
      return;
    }
    // miss: insert at front, evict the tail if full
    if (cacheLen === k) {
      const victim = cache[k - 1];
      pos[victim] = -1;
      leave(victim);
      for (let i = k - 1; i > 0; i--) { cache[i] = cache[i - 1]; pos[cache[i]] = i; }
      cache[0] = v;
      pos[v] = 0;
      enter(v);
    } else {
      for (let i = cacheLen; i > 0; i--) { cache[i] = cache[i - 1]; pos[cache[i]] = i; }
      cache[0] = v;
      pos[v] = 0;
      cacheLen++;
      enter(v);
    }
  };

  let nextCold = 0;
  let written = 0;
  const popValid = () => {
    for (let b = 3; b >= 1; b--) {
      const bucket = buckets[b];
      while (bucket.length) {
        const tri = bucket.pop();
        pending--;
        if (emitted[tri]) continue;
        if (hits[tri] === b) return tri;
        // stale: its hit count moved since it was queued
        buckets[hits[tri]].push(tri);
        pending++;
      }
    }
    return -1;
  };

  for (let e = 0; e < t; e++) {
    let tri = popValid();
    if (tri < 0) {
      while (nextCold < t && emitted[nextCold]) nextCold++;
      if (nextCold >= t) break;
      tri = nextCold;
    }
    emitted[tri] = 1;
    out[3 * written] = indices[3 * tri];
    out[3 * written + 1] = indices[3 * tri + 1];
    out[3 * written + 2] = indices[3 * tri + 2];
    written++;
    touch(indices[3 * tri]);
    touch(indices[3 * tri + 1]);
    touch(indices[3 * tri + 2]);
  }
  if (written !== t) throw new Error(`internal: emitted ${written}/${t}`);
  return out;
}

/** Axis-aligned bounds of a packed xyz position array. */
export function bounds(positions) {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0], diagonal: 0 };
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return { min: [x0, y0, z0], max: [x1, y1, z1], diagonal: Math.hypot(dx, dy, dz) };
}

export function scalePositions(positions, k) {
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] * k;
  return out;
}

/** Maximum absolute coordinate difference between two packed xyz arrays. */
export function maxPositionDelta(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}
