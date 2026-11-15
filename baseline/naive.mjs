// baseline/naive.mjs — independent comparators for src/core.mjs.
//
// Every function here is written separately from core on purpose: the cache
// simulators are the oracle the bucket scheduler in core is checked against,
// so they must not share code or magic constants with it.
//
// No three.js, no DOM, no I/O.

/** Identity: the order the exporter produced. ATVR baseline #1. */
export function originalOrder(indices) {
  return Uint32Array.from(indices);
}

/**
 * Sort triangles by their smallest vertex index. O(T log T), no cache
 * simulation at all: the cheap alternative our scheduler must beat in quality.
 */
export function sortByMinVertex(indices) {
  const t = indices.length / 3;
  const order = new Int32Array(t);
  for (let i = 0; i < t; i++) order[i] = i;
  const key = (i) => {
    const a = indices[3 * i], b = indices[3 * i + 1], c = indices[3 * i + 2];
    return Math.min(a, b, c) * 4294967296 + i; // stable tie-break by index
  };
  const keys = new Float64Array(t);
  for (let i = 0; i < t; i++) keys[i] = key(i);
  const idx = Array.from({ length: t }, (_, i) => i).sort((p, q) => keys[p] - keys[q] || p - q);
  const out = new Uint32Array(3 * t);
  for (let i = 0; i < t; i++) {
    const s = idx[i];
    out[3 * i] = indices[3 * s];
    out[3 * i + 1] = indices[3 * s + 1];
    out[3 * i + 2] = indices[3 * s + 2];
  }
  return out;
}

/**
 * LRU simulation by linear scan over an explicit recency list. Deliberately
 * O(k) per reference and structurally unlike core's intrusive linked list.
 */
export function naiveLru(indices, cacheSize) {
  const t = indices.length / 3;
  const k = Math.max(1, cacheSize);
  const recency = []; // index 0 = most recently used
  let hits = 0;
  let misses = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    const at = recency.indexOf(v);
    if (at >= 0) {
      hits++;
      recency.splice(at, 1);
      recency.unshift(v);
    } else {
      misses++;
      recency.unshift(v);
      if (recency.length > k) recency.pop();
    }
  }
  return { hits, misses, references: 3 * t, triangles: t, cacheSize: k, atvr: t ? misses / t : 0 };
}

/** FIFO simulation with an explicit FIFO array (oldest first). */
export function naiveFifo(indices, cacheSize) {
  const t = indices.length / 3;
  const k = Math.max(1, cacheSize);
  const queue = []; // index 0 = oldest
  let hits = 0;
  let misses = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (queue.includes(v)) { hits++; continue; }
    misses++;
    if (queue.length >= k) queue.shift();
    queue.push(v);
  }
  return { hits, misses, references: 3 * t, triangles: t, cacheSize: k, atvr: t ? misses / t : 0 };
}

/** Hit/miss flag per triangle under an LRU of `cacheSize` (for the viewer). */
export function perTriangleHits(indices, cacheSize) {
  const t = indices.length / 3;
  const k = Math.max(1, cacheSize);
  const recency = [];
  const out = new Uint8Array(t);
  for (let i = 0; i < t; i++) {
    let h = 0;
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      const at = recency.indexOf(v);
      if (at >= 0) { h++; recency.splice(at, 1); recency.unshift(v); }
      else { recency.unshift(v); if (recency.length > k) recency.pop(); }
    }
    out[i] = h;
  }
  return out;
}
