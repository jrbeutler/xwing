// Bake the freighter FBX (16 MB, ~540k triangles, 342 meshes) into a compact binary the game loads:
// two merged, simplified, position-only meshes (hull + plating), already facing +X, centred and scaled.
//
//   node apps/web/scripts/bake-freighter.mjs ~/Downloads/Freighter.fbx
//
// Output: apps/web/src/assets/freighter/freighter.bin
// Layout: u32 headerBytes, JSON header (space-padded to 4 bytes), then per group: f32 positions, u32 indices.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// FBXLoader touches a couple of DOM globals while parsing; geometry parsing itself needs none of them.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.document ??= { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) };
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const LENGTH = 44; // nose-to-tail, procedural-model units (see shipAsset.ts)
const CELL = 0.14; // clustering grid in output units: smaller keeps more detail

const src = process.argv[2];
if (!src) { console.error('usage: node bake-freighter.mjs <Freighter.fbx>'); process.exit(1); }
const buf = readFileSync(src);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
root.rotation.y = Math.PI / 2; // source nose points +Z; the game's ships face +X
root.updateMatrixWorld(true);

// Gather world-space triangles per group, skipping decal planes whose textures we don't have.
const groups = { hull: [], plate: [] };
const v = new THREE.Vector3();
root.traverse((o) => {
  if (!o.isMesh || /projected|^Examples?_/i.test(o.name)) return;
  const g = o.geometry, pos = g.attributes.position, idx = g.index;
  const mats = [].concat(o.material);
  const ranges = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
  for (const r of ranges) {
    const name = mats[r.materialIndex]?.name ?? '';
    const out = groups[/alum/i.test(name) ? 'plate' : 'hull'];
    for (let i = r.start; i < r.start + r.count; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
});

// Normalise: centre on the bounding box and scale to LENGTH along X.
const box = new THREE.Box3();
for (const arr of Object.values(groups)) for (let i = 0; i < arr.length; i += 3) box.expandByPoint(v.set(arr[i], arr[i + 1], arr[i + 2]));
const c = box.getCenter(new THREE.Vector3());
const k = LENGTH / box.getSize(new THREE.Vector3()).x;

/** Vertex clustering: snap to a grid, share vertices per cell (averaged), drop collapsed/duplicate triangles. */
function simplify(tri) {
  const cells = new Map(), sums = [], index = [];
  const id = (x, y, z) => {
    const key = `${Math.round(x / CELL)},${Math.round(y / CELL)},${Math.round(z / CELL)}`;
    let n = cells.get(key);
    if (n === undefined) { n = sums.length / 4; cells.set(key, n); sums.push(0, 0, 0, 0); }
    sums[n * 4] += x; sums[n * 4 + 1] += y; sums[n * 4 + 2] += z; sums[n * 4 + 3]++;
    return n;
  };
  const seen = new Set();
  for (let i = 0; i < tri.length; i += 9) {
    const p = [0, 3, 6].map((o) => id((tri[i + o] - c.x) * k, (tri[i + o + 1] - c.y) * k, (tri[i + o + 2] - c.z) * k));
    if (p[0] === p[1] || p[1] === p[2] || p[0] === p[2]) continue;
    const key = [...p].sort((a, b) => a - b).join(',') + (p[0] < p[1] ? 'a' : 'b'); // keep both windings
    if (seen.has(key)) continue;
    seen.add(key);
    index.push(...p);
  }
  // compact away vertices only used by dropped triangles
  const remap = new Map(), positions = [];
  const indices = index.map((n) => {
    let m = remap.get(n);
    if (m === undefined) { m = positions.length / 3; remap.set(n, m); positions.push(sums[n * 4] / sums[n * 4 + 3], sums[n * 4 + 1] / sums[n * 4 + 3], sums[n * 4 + 2] / sums[n * 4 + 3]); }
    return m;
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const header = { groups: [] };
const blobs = [];
for (const [name, tri] of Object.entries(groups)) {
  const s = simplify(tri);
  header.groups.push({ name, vertices: s.positions.length / 3, indices: s.indices.length });
  blobs.push(Buffer.from(s.positions.buffer), Buffer.from(s.indices.buffer));
  console.log(`${name}: ${tri.length / 9} → ${s.indices.length / 3} triangles, ${s.positions.length / 3} vertices`);
}
let json = JSON.stringify(header);
json += ' '.repeat((4 - (json.length % 4)) % 4);
const len = Buffer.alloc(4);
len.writeUInt32LE(json.length);
const outDir = fileURLToPath(new URL('../src/assets/freighter/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const out = Buffer.concat([len, Buffer.from(json), ...blobs]);
writeFileSync(outDir + 'freighter.bin', out);
console.log(`wrote freighter.bin (${(out.length / 1024).toFixed(0)} KB)`);
