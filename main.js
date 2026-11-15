// main.js — render layer only. All maths comes from src/core.mjs, unchanged
// from what bench/verify.mjs asserts in node.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { optimizeIndices, simulateCache, triangleCount } from './src/core.mjs';

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 1.2, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x101418, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(3, 4, 2);
scene.add(key);

const params = { k: 32, showOriginal: true };
const view = { mesh: null, json: null, group: new THREE.Group() };
scene.add(view.group);

const COL_HIT = new THREE.Color(0x4ea3ff);
const COL_MISS = new THREE.Color(0xff6b6b);
const COL_HALF = new THREE.Color(0x8f9bb3);

/** Non-indexed geometry with one colour per triangle: red when the simulated
 *  cache missed that vertex at least twice, blue when it hit at least twice. */
function buildTriangleSoup(json, indices) {
  const t = triangleCount(indices);
  const pos = new Float32Array(3 * 3 * t);
  const col = new Float32Array(3 * 3 * t);
  const sim = simulateCache(indices, params.k);
  // replay the same LRU semantics to colour each triangle by its own hit count
  const k = Math.max(1, Math.min(params.k, json.vertexCount));
  const recency = [];
  for (let i = 0; i < t; i++) {
    let h = 0;
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      const at = recency.indexOf(v);
      if (at >= 0) { h++; recency.splice(at, 1); recency.unshift(v); }
      else { recency.unshift(v); if (recency.length > k) recency.pop(); }
    }
    const col3 = h >= 2 ? COL_HIT : h <= 1 ? COL_MISS : COL_HALF;
    for (let c = 0; c < 3; c++) {
      const v = indices[3 * i + c];
      const o = 3 * (3 * i + c);
      pos[o] = json.positions[3 * v];
      pos[o + 1] = json.positions[3 * v + 1];
      pos[o + 2] = json.positions[3 * v + 2];
      col[o] = col3.r; col[o + 1] = col3.g; col[o + 2] = col3.b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.userData.stats = sim;
  return g;
}

function rebuild() {
  view.group.clear();
  if (!view.json) return;
  const { json } = view;
  const optimized = optimizeIndices(json.indices, json.vertexCount, params.k);
  const simOrig = simulateCache(json.indices, params.k);
  const simOpt = simulateCache(optimized, params.k);

  const r = 1.35;
  const left = new THREE.Mesh(buildTriangleSoup(json, json.indices), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.1, roughness: 0.7 }));
  left.position.set(-r, 0, 0);
  const right = new THREE.Mesh(buildTriangleSoup(json, optimized), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.1, roughness: 0.7 }));
  right.position.set(r, 0, 0);
  left.visible = params.showOriginal;
  view.group.add(right);
  if (params.showOriginal) view.group.add(left);

  const cut = 100 * (1 - simOpt.atvr / simOrig.atvr);
  document.getElementById('stats').innerHTML = `
    <tr><th>${json.name}</th><th>ATVR @k=${simOpt.cacheSize}</th><th>hits</th><th>misses</th></tr>
    <tr><td>exporter order</td><td>${simOrig.atvr.toFixed(4)}</td><td>${simOrig.hits}</td><td>${simOrig.misses}</td></tr>
    <tr><td>vertexcache-lab</td><td class="good">${simOpt.atvr.toFixed(4)}</td><td>${simOpt.hits}</td><td>${simOpt.misses}</td></tr>
    <tr><td>cut vs exporter</td><td class="good">${cut.toFixed(2)}%</td><td colspan="2">${json.triangleCount} tris / ${json.vertexCount} verts</td></tr>`;
}

const kInput = document.getElementById('k');
kInput.addEventListener('input', () => {
  params.k = Number(kInput.value);
  document.getElementById('kv').textContent = String(params.k);
  rebuild();
});
document.getElementById('toggle').addEventListener('change', (e) => {
  params.showOriginal = e.target.checked;
  rebuild();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  view.group.rotation.y += 0.0015;
  controls.update();
  renderer.render(scene, camera);
}

const res = await fetch('./data/sphere-soup.json');
view.json = await res.json();
rebuild();
animate();
