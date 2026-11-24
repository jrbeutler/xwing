// Bake a heavy textured GLB into a compact binary the game loads: per-material meshes, simplified,
// facing +X, centred and scaled, keeping normals and UVs so the textures still map.
//
//   node apps/web/scripts/bake-glb.mjs <in.glb> <out.bin> [--length 40] [--cell 0.08] [--rot-y 0] [--info]
//
// Simplification is vertex clustering: vertices merge only when position, UV and normal all fall in the
// same small cell, so texture seams and hard edges stay split while dense geometry collapses.
// Output layout: u32 headerBytes, JSON header (padded to 4), then per group, each block 4-byte aligned:
//   i16 positions ×3 (× header.posScale), i8 normals ×3 (normalised), f32 uvs ×2, u16|u32 indices.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const [src, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!src || !out) { console.error('usage: node bake-glb.mjs <in.glb> <out.bin> [--length 40] [--cell 0.08] [--rot-y deg] [--info]'); process.exit(1); }
const LENGTH = opt('length', 40), CELL = opt('cell', 0.08), ROT_Y = (opt('rot-y', 0) * Math.PI) / 180;
const UV_Q = opt('uv', 1 / 128); // UV cell: only texels this close merge (keeps texture seams split)
const N_Q = opt('normal', 0.7); // normal cell: keeps sharp creases split

// ---- read the GLB ----
const buf = readFileSync(src);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const binStart = 20 + jsonLen + 8;
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessor(i) {
  const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
  const T = COMP[a.componentType], n = SIZE[a.type];
  const stride = bv.byteStride ?? n * T.BYTES_PER_ELEMENT;
  const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const outArr = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    for (let c = 0; c < n; c++) {
      const off = base + k * stride + c * T.BYTES_PER_ELEMENT;
      outArr[k * n + c] = T === Float32Array ? buf.readFloatLE(off) : T === Uint16Array ? buf.readUInt16LE(off) : T === Uint32Array ? buf.readUInt32LE(off) : buf[off];
    }
  }
  return outArr;
}

// ---- gather world-space triangles per material ----
const world = new Map(); // node index -> Matrix4
const visit = (i, parent) => {
  const n = gltf.nodes[i];
  const m = new THREE.Matrix4();
  if (n.matrix) m.fromArray(n.matrix);
  else m.compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
  const w = parent ? parent.clone().multiply(m) : m;
  world.set(i, w);
  for (const c of n.children ?? []) visit(c, w);
};
const rootFix = new THREE.Matrix4().makeRotationY(ROT_Y);
for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, rootFix);

const groups = new Map(); // material index -> { p: [], n: [], uv: [] } as flat triangle soups
const v = new THREE.Vector3(), nv = new THREE.Vector3();
for (const [ni, mtx] of world) {
  const node = gltf.nodes[ni];
  if (node.mesh === undefined) continue;
  const nmat = new THREE.Matrix3().getNormalMatrix(mtx);
  for (const prim of gltf.meshes[node.mesh].primitives) {
    const P = accessor(prim.attributes.POSITION), N = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL) : null;
    const UV = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null;
    const I = prim.indices !== undefined ? accessor(prim.indices) : null;
    const g = groups.get(prim.material ?? -1) ?? { p: [], n: [], uv: [] };
    groups.set(prim.material ?? -1, g);
    const count = I ? I.length : P.length / 3;
    for (let k = 0; k < count; k++) {
      const idx = I ? I[k] : k;
      v.set(P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2]).applyMatrix4(mtx);
      g.p.push(v.x, v.y, v.z);
      if (N) { nv.set(N[idx * 3], N[idx * 3 + 1], N[idx * 3 + 2]).applyMatrix3(nmat).normalize(); g.n.push(nv.x, nv.y, nv.z); } else g.n.push(0, 1, 0);
      g.uv.push(UV ? UV[idx * 2] : 0, UV ? UV[idx * 2 + 1] : 0);
    }
  }
}

// ---- normalise: centre and scale so the model is LENGTH long along X ----
const box = new THREE.Box3();
for (const g of groups.values()) for (let i = 0; i < g.p.length; i += 3) box.expandByPoint(v.set(g.p[i], g.p[i + 1], g.p[i + 2]));
const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
const k = LENGTH / size.x;
if (args.includes('--info')) {
  console.log('size', size.toArray().map((x) => +x.toFixed(2)), 'centre', c.toArray().map((x) => +x.toFixed(2)));
  for (const [mi, g] of groups) {
    const gb = new THREE.Box3();
    for (let i = 0; i < g.p.length; i += 3) gb.expandByPoint(v.set(g.p[i], g.p[i + 1], g.p[i + 2]));
    const name = gltf.materials[mi]?.name, em = gltf.materials[mi]?.emissiveTexture ? 'emissive' : '';
    console.log(`material ${mi} ${name} ${em}: ${g.p.length / 9} tris, x ${gb.min.x.toFixed(2)}..${gb.max.x.toFixed(2)}`);
  }
  process.exit(0);
}

function simplify(g) {
  const cells = new Map(), acc = [], index = [];
  const id = (i) => {
    const x = (g.p[i * 3] - c.x) * k, y = (g.p[i * 3 + 1] - c.y) * k, z = (g.p[i * 3 + 2] - c.z) * k;
    const nx = g.n[i * 3], ny = g.n[i * 3 + 1], nz = g.n[i * 3 + 2], u = g.uv[i * 2], w = g.uv[i * 2 + 1];
    const key = `${Math.round(x / CELL)},${Math.round(y / CELL)},${Math.round(z / CELL)}|${Math.round(u / UV_Q)},${Math.round(w / UV_Q)}|${Math.round(nx / N_Q)},${Math.round(ny / N_Q)},${Math.round(nz / N_Q)}`;
    let n = cells.get(key);
    if (n === undefined) { n = acc.length / 9; cells.set(key, n); acc.push(0, 0, 0, 0, 0, 0, 0, 0, 0); }
    const a = n * 9;
    acc[a] += x; acc[a + 1] += y; acc[a + 2] += z; acc[a + 3] += nx; acc[a + 4] += ny; acc[a + 5] += nz; acc[a + 6] += u; acc[a + 7] += w; acc[a + 8]++;
    return n;
  };
  const seen = new Set();
  for (let t = 0; t < g.p.length / 9; t++) {
    const tri = [id(t * 3), id(t * 3 + 1), id(t * 3 + 2)];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    const key = tri.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    index.push(...tri);
  }
  const remap = new Map(), verts = [];
  const indices = index.map((n) => {
    let m = remap.get(n);
    if (m === undefined) {
      m = verts.length;
      remap.set(n, m);
      const a = n * 9, cnt = acc[a + 8];
      const nl = Math.hypot(acc[a + 3], acc[a + 4], acc[a + 5]) || 1;
      verts.push([acc[a] / cnt, acc[a + 1] / cnt, acc[a + 2] / cnt, acc[a + 3] / nl, acc[a + 4] / nl, acc[a + 5] / nl, acc[a + 6] / cnt, acc[a + 7] / cnt]);
    }
    return m;
  });
  return { verts, indices };
}

// ---- write ----
const posScale = (Math.max(size.x, size.y, size.z) * k) / 2 / 32767 * 1.01;
const header = { posScale, groups: [] };
const blobs = [];
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
let totalIn = 0, totalOut = 0;
for (const [mi, g] of groups) {
  const s = simplify(g);
  const n = s.verts.length;
  const pos = new Int16Array(n * 3), nrm = new Int8Array(n * 3), uv = new Float32Array(n * 2);
  s.verts.forEach((q, i) => {
    for (let a = 0; a < 3; a++) { pos[i * 3 + a] = Math.round(q[a] / posScale); nrm[i * 3 + a] = Math.round(q[3 + a] * 127); }
    uv[i * 2] = q[6]; uv[i * 2 + 1] = q[7];
  });
  const wide = n > 65535;
  const idx = wide ? new Uint32Array(s.indices) : new Uint16Array(s.indices);
  header.groups.push({ material: gltf.materials[mi]?.name ?? 'default', vertices: n, indices: s.indices.length, wide });
  blobs.push(pad4(Buffer.from(pos.buffer)), pad4(Buffer.from(nrm.buffer)), pad4(Buffer.from(uv.buffer)), pad4(Buffer.from(idx.buffer)));
  totalIn += g.p.length / 9; totalOut += s.indices.length / 3;
  console.log(`${gltf.materials[mi]?.name}: ${g.p.length / 9} → ${s.indices.length / 3} triangles, ${n} vertices`);
}
let json = JSON.stringify(header);
json += ' '.repeat((4 - (json.length % 4)) % 4);
const len = Buffer.alloc(4);
len.writeUInt32LE(json.length);
const file = Buffer.concat([len, Buffer.from(json), ...blobs]);
writeFileSync(out, file);
console.log(`total ${totalIn} → ${totalOut} triangles; wrote ${out} (${(file.length / 1024).toFixed(0)} KB)`);
