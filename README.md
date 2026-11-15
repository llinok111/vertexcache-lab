# vertexcache-lab

**Cache-aware index reordering with a permutation certificate.** On a shuffled 20,480-triangle icosphere the simulated **ATVR drops from 2.9927 to 0.7606 (−74.58 %)** at a 32-entry LRU vertex cache, while the emitted triangle set stays **bit-identical** (0 changed, 0 flipped, 0 added) and the cheap `sortByMinVertex` baseline only reaches 1.2871. One command reproduces every number: `node tools/gen-sample.mjs && node bench/verify.mjs`.

Upstream: none

## What this is

GPU vertex post-transform caches hold a few dozen vertices. If a mesh's index
buffer walks the surface in a scattered order, almost every triangle's three
vertex fetches miss the cache and the vertex shader runs again for a vertex it
just transformed. `src/core.mjs::optimizeIndices` reorders the triangles so the
walk stays inside the cache, without touching geometry: same vertices, same
winding, same triangle set — only the order changes.

Two numbers matter and both come from the same pure module:

* **ATVR** (average transformed vertices per triangle) = cache misses / triangles.
  Lower is better; the theoretical floor is `uniqueVertices / triangles`.
* **Permutation certificate**: the canonical, rotation-invariant but
  flip-sensitive multiset of directed triangles must be identical before and
  after. The reorderer is a pure integer permutation, so this is exact.

## How to run

```bash
# 1. regenerate the deterministic sample meshes (fixed seed 20261115)
node tools/gen-sample.mjs

# 2. assertions (36 of them) — exit code 0 only if every one passes
node bench/verify.mjs

# 3. timings + cache metrics -> bench/result.json
node bench/bench.mjs

# 4. browser view (module + importmap, three.js 0.169.0 pinned)
python3 -m http.server 4173   # then open http://localhost:4173
```

No `npm install`, no bundler, no `node_modules`. Node 20+ (verified on v24.19.0).

## Evidence (`bench/result.json`, node v24.19.0, 32-entry LRU)

| mesh | tris / verts | order | ATVR before | ATVR after | cut | `sortByMinVertex` | median | cold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sphere-soup` | 20,480 / 10,242 | shuffled | 2.9927 | **0.7606** | **−74.58 %** | 1.2871 | 5.43 ms | 15.93 ms |
| `sphere-vmajor` | 5,120 / 2,562 | vertex-major | 1.2588 | **0.7875** | −37.44 % | 1.2879 | 1.25 ms | 5.31 ms |
| `torus-natural` | 9,216 / 4,608 | natural grid | 1.0105 | **0.8761** | −13.30 % | 0.9951 | 2.07 ms | 2.12 ms |

* The torus is already cache-friendly, so its headroom is small **by
  construction** — that row is kept as an honest negative control, not dropped.
* Timings: 9 samples, 6 (large) / 10 (small) inner repeats per sample, warmup
  before sampling, cold start recorded separately. Relative stddev 4.3 % / 2.1 %
  / 1.7 %, all below the 10 % bar; absolute stddev, p95 and min are in
  `bench/result.json`. **Wall-clock numbers are not a promise** (4-core shared
  box); the ATVR and certificate numbers are exact and deterministic.
* Independent oracle: `baseline/naive.mjs::naiveLru` re-simulates every order
  with a linear-scan recency list (structurally unlike core's intrusive linked
  list) and agrees on **0 mismatches / 36 comparisons**; a FIFO ring in core is
  cross-checked against an independent FIFO queue. A 300-case random brute force
  was run during development and agreed 300/300.
* Limits checked exactly: `k=1` → ATVR `3 − consecutiveRepeatedRefs/T`
  (2.925146 on the optimized soup, 1,533 repeats), `k ≥ V` → ATVR
  `uniqueVertices/T` (0.500098 = 10,242/20,480). ATVR is monotone in cache size
  on all three meshes.
* Scale invariance: identical index hash and identical ATVR for scale factors
  `1e-6 … 1e6`; `scalePositions` is bit-identical to `ref[i]*k`. The reorderer
  reads **topology only**, so there is no geometric epsilon anywhere — the
  module has no absolute threshold to disclose.
* Negative control: flipping one triangle makes the certificate fail
  (`same=false`, `changed=2`), so the check is not vacuous.

## 本轮创新

**B 档。** 先按台账查重（`innovation.md` / `PROJECTS.md` / `used-upstreams.txt`
对 vertex-cache / ATVR / index reordering **零先例**；最近的 `streamchunk-lab`
只是把三角按半边图切成流式 chunk，既没有缓存模型也没有命中率指标；
`mesh-lod-lab` 是减面，改变几何）。新在三点：

1. 把「缓存友好的三角重排」做成一个**可复算的指标**：ATVR 由一份纯拓扑、
   零 epsilon 的模块给出，浏览器里拖动 cache size 时屏幕上的数字与
   `bench/result.json` 逐位同源（同一 `simulateCache`，确定性整数序）。
2. 重排器 **bucket-hit 调度**：保留 `hits = 当前驻留顶点数` 的三档 LIFO 桶，
   总是从最高桶发射，桶内条目惰性校验——不建堆、不改几何，20k 三角
   **5.43 ms** 重排完。
3. **排列证书**作为发布门槛：旋转不变但翻转敏感的规范三角键多重集必须逐项相等，
   并带一个会失败的负对照。同账号的 `skinbound`/`mesh-selfint` 管形变与自交，
   本条管显存/着色器吞吐，机制与产出指标都不同。

## Known limitations

* The cache model is a **simulation**: a true LRU of `cacheSize` distinct
  vertices, touched in index order. Real GPUs use sector/line-based FIFO caches
  and warp-level coalescing, so absolute ATVR differs from hardware counters.
  The *relative* ranking and the permutation certificate do not depend on the
  model.
* FIFO is exposed and cross-checked, but the optimizer is tuned for LRU; on FIFO
  its gain is smaller (see `simulateCacheFifo` in `bench/verify.mjs`).
* Only post-transform vertex cache behaviour is addressed: no triangle-strip
  conversion, no overdraw, no fetch ordering across warps.
* The sample meshes are procedural (two icospheres and a torus, generated by
  `tools/gen-sample.mjs`); no real glTF asset is bundled. `data/` is fully
  reproducible from the script with seed 20261115.

## Layout

```
index.html              entry point, pinned three.js 0.169.0 importmap
main.js                 render + orbit + cache-size slider (no maths)
src/core.mjs            pure topology/cache math, no three, no DOM
baseline/naive.mjs      independent LRU/FIFO oracles + two ordering baselines
tools/gen-sample.mjs    deterministic sample meshes -> data/*.json
bench/verify.mjs        36 assertions, exit 0 only if all pass
bench/bench.mjs         cold start + 9 samples -> bench/result.json
```

MIT © 2026 llinok111
