// Bake a Wavefront OBJ into the same compact binary as bake-glb.mjs (so the game loads both the same way):
// per-material meshes with welded vertices, facing +X, centred, scaled so the largest horizontal extent
// is `--size` units.
//
//   node apps/web/scripts/bake-obj.mjs <in.obj> <out.bin> [--size 38] [--rot-y 90] [--info]
//
// Output layout (see bake-glb.mjs): u32 headerBytes, JSON header, then per group, 4-byte aligned:
//   i16 positions ×3 (× header.posScale), i8 normals ×3, f32 uvs ×2, u16|u32 indices.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const [src, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!src || !out) { console.error('usage: node bake-obj.mjs <in.obj> <out.bin> [--size 38] [--rot-y deg] [--info]'); process.exit(1); }
const SIZE = opt('size', 38), ROT_Y = (opt('rot-y', 0) * Math.PI) / 180;

const root = new OBJLoader().parse(readFileSync(src, 'utf8'));
root.rotation.y = ROT_Y;
root.updateMatrixWorld(true);

// One geometry per material, in world space, welded (OBJ faces come unindexed).
const groups = new Map();
root.traverse((o) => {
  if (!o.isMesh) return;
  const mats = [].concat(o.material);
  const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
  const ranges = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
  for (const r of ranges) {
    const name = mats[r.materialIndex]?.name || o.name || 'default';
    const part = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'uv']) {
      const a = g.attributes[key];
      if (!a) continue;
      part.setAttribute(key, new THREE.BufferAttribute(a.array.slice(r.start * a.itemSize, (r.start + r.count) * a.itemSize), a.itemSize));
    }
    if (!part.attributes.uv) part.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(r.count * 2), 2));
    if (!part.attributes.normal) part.computeVertexNormals();
    (groups.get(name) ?? groups.set(name, []).get(name)).push(part);
  }
});

const box = new THREE.Box3();
for (const parts of groups.values()) for (const p of parts) { p.computeBoundingBox(); box.union(p.boundingBox); }
const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
const k = SIZE / Math.max(size.x, size.z);
if (args.includes('--info')) {
  console.log('size', size.toArray().map((x) => +x.toFixed(2)), 'groups', [...groups.keys()]);
  process.exit(0);
}

const posScale = (Math.max(size.x, size.y, size.z) * k) / 2 / 32767 * 1.01;
const header = { posScale, groups: [] };
const blobs = [];
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
for (const [name, parts] of groups) {
  // Merge the parts, then weld identical vertices so the mesh is indexed and much smaller.
  const merged = new THREE.BufferGeometry();
  for (const key of ['position', 'normal', 'uv']) {
    const n = parts[0].attributes[key].itemSize;
    merged.setAttribute(key, new THREE.BufferAttribute(Float32Array.from(parts.flatMap((p) => Array.from(p.attributes[key].array))), n));
  }
  merged.translate(-c.x, -c.y, -c.z);
  merged.scale(k, k, k);
  const g = mergeVertices(merged, 1e-4);
  const n = g.attributes.position.count;
  const pos = new Int16Array(n * 3), nrm = new Int8Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      pos[i * 3 + a] = Math.round(g.attributes.position.array[i * 3 + a] / posScale);
      nrm[i * 3 + a] = Math.round(g.attributes.normal.array[i * 3 + a] * 127);
    }
    uv[i * 2] = g.attributes.uv.array[i * 2];
    uv[i * 2 + 1] = g.attributes.uv.array[i * 2 + 1];
  }
  const index = Array.from(g.index.array);
  const wide = n > 65535;
  const idx = wide ? new Uint32Array(index) : new Uint16Array(index);
  header.groups.push({ material: name, vertices: n, indices: index.length, wide });
  blobs.push(pad4(Buffer.from(pos.buffer)), pad4(Buffer.from(nrm.buffer)), pad4(Buffer.from(uv.buffer)), pad4(Buffer.from(idx.buffer)));
  console.log(`${name}: ${index.length / 3} triangles, ${n} vertices`);
}
let json = JSON.stringify(header);
json += ' '.repeat((4 - (json.length % 4)) % 4);
const len = Buffer.alloc(4);
len.writeUInt32LE(json.length);
const file = Buffer.concat([len, Buffer.from(json), ...blobs]);
writeFileSync(out, file);
console.log(`wrote ${out} (${(file.length / 1024).toFixed(0)} KB)`);
