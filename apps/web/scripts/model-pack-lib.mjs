// Shared by pack-models.mjs and bake-palette-fbx.mjs: model readers (all → groups of plain arrays),
// vertex-clustering simplification to a triangle budget, and the v2 binary writer (format in pack-models.mjs).
import { writeFileSync } from 'node:fs';

// FBXLoader asks for textures we never use here; these stand-ins keep it from touching a real DOM.
globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {}, set src(_v) {} }) };
globalThis.self ??= globalThis;
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

export const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

// ---------------------------------------------------------------- readers (all → groups of plain arrays)
/** Old bake-glb format (v1): i16 pos × posScale, i8 normals, f32 uvs, u16|u32 indices. Also reads v2. */
export function readBaked(buf) {
  const headerLen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.toString('utf8', 4, 4 + headerLen));
  let off = 4 + headerLen;
  const take = (bytes) => { const at = off; off += Math.ceil(bytes / 4) * 4; return at; };
  const b = ab(buf);
  return header.groups.map((g) => {
    const pos = Array.from(new Int16Array(b, take(g.vertices * 6), g.vertices * 3), (q) => q * header.posScale);
    let nrm = null, uv = null;
    if (header.version !== 2 || g.normals) nrm = Array.from(new Int8Array(b, take(g.vertices * 3), g.vertices * 3), (q) => q / 127);
    if (header.version !== 2) uv = Array.from(new Float32Array(b, take(g.vertices * 8), g.vertices * 2));
    else if (g.uv) uv = Array.from(new Uint16Array(b, take(g.vertices * 4), g.vertices * 2), (q, i) => g.uvMin[i % 2] + (q / 65535) * g.uvSize[i % 2]);
    const idx = Array.from(g.wide ? new Uint32Array(b, take(g.indices * 4), g.indices) : new Uint16Array(b, take(g.indices * 2), g.indices));
    return { name: g.name ?? g.material, material: g.material ?? g.name, pos, nrm, uv, idx };
  });
}

/** Freighter format: f32 positions, u32 indices, no normals or UVs. */
export function readFreighter(buf) {
  const headerLen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.toString('utf8', 4, 4 + headerLen));
  if (header.version === 2) return readBaked(buf);
  let off = 4 + headerLen;
  const b = ab(buf);
  return header.groups.map((g) => {
    const pos = Array.from(new Float32Array(b, off, g.vertices * 3)); off += g.vertices * 12;
    const idx = Array.from(new Uint32Array(b, off, g.indices)); off += g.indices * 4;
    return { name: g.name, material: g.name, pos, nrm: null, uv: null, idx };
  });
}

/** FBX: every mesh, world transform baked in, with normals and UVs. */
export function readFbx(buf) {
  const obj = new FBXLoader().parse(ab(buf), '');
  obj.updateMatrixWorld(true);
  const out = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const n = g.attributes.position.count;
    out.push({
      name: o.name, material: o.name,
      pos: Array.from(g.attributes.position.array), nrm: g.attributes.normal ? Array.from(g.attributes.normal.array) : null,
      uv: g.attributes.uv ? Array.from(g.attributes.uv.array) : null,
      idx: g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i),
    });
  });
  return out;
}

// ---------------------------------------------------------------- simplification
/** Vertex clustering. `cell` in model units; uv/normal cells keep seams and creases split. */
export function cluster(g, cell, uvCell = 1 / 96, nCell = 0.6) {
  const map = new Map();
  const acc = []; // per new vertex: sum pos(3), nrm(3), uv(2), count
  const remap = new Int32Array(g.pos.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const p = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
    let key = `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)},${Math.round(p[2] / cell)}`;
    if (g.uv) key += `|${Math.round(g.uv[i * 2] / uvCell)},${Math.round(g.uv[i * 2 + 1] / uvCell)}`;
    if (g.nrm) key += `|${Math.round(g.nrm[i * 3] / nCell)},${Math.round(g.nrm[i * 3 + 1] / nCell)},${Math.round(g.nrm[i * 3 + 2] / nCell)}`;
    let v = map.get(key);
    if (v === undefined) { v = acc.length; map.set(key, v); acc.push([0, 0, 0, 0, 0, 0, 0, 0, 0]); }
    const a = acc[v];
    a[0] += p[0]; a[1] += p[1]; a[2] += p[2];
    if (g.nrm) { a[3] += g.nrm[i * 3]; a[4] += g.nrm[i * 3 + 1]; a[5] += g.nrm[i * 3 + 2]; }
    if (g.uv) { a[6] += g.uv[i * 2]; a[7] += g.uv[i * 2 + 1]; }
    a[8]++;
    remap[i] = v;
  }
  const seen = new Set();
  const tris = [];
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = remap[g.idx[t]], b = remap[g.idx[t + 1]], c = remap[g.idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    const k = [a, b, c].sort((x, y) => x - y).join(',') + (a < b ? '+' : '-');
    if (seen.has(k)) continue;
    seen.add(k);
    tris.push(a, b, c);
  }
  // compact: keep only used vertices
  const used = new Int32Array(acc.length).fill(-1);
  const pos = [], nrm = g.nrm ? [] : null, uv = g.uv ? [] : null, idx = [];
  for (const v of tris) {
    if (used[v] < 0) {
      used[v] = pos.length / 3;
      const a = acc[v], n = a[8];
      pos.push(a[0] / n, a[1] / n, a[2] / n);
      if (nrm) { const l = Math.hypot(a[3], a[4], a[5]) || 1; nrm.push(a[3] / l, a[4] / l, a[5] / l); }
      if (uv) uv.push(a[6] / n, a[7] / n);
    }
    idx.push(used[v]);
  }
  return { ...g, pos, nrm, uv, idx };
}

/** Weld identical vertices without simplifying (for unindexed FBX soups). */
export const weld = (g) => cluster(g, 1e-5, 1e-6, 1e-4);

/**
 * Find the coarsest cell (by bisection) that keeps the total triangle count within `budget`. If seams
 * and creases stop it getting there, relax the UV and normal tolerances a step at a time.
 */
export function simplify(groups, budget) {
  const tris = (gs) => gs.reduce((s, g) => s + g.idx.length / 3, 0);
  const welded = groups.map(weld);
  if (tris(welded) <= budget) return welded;
  let ext = 0;
  for (const g of welded) for (const v of g.pos) ext = Math.max(ext, Math.abs(v));
  let best = null;
  for (const [uvCell, nCell] of [[1 / 96, 0.6], [1 / 48, 0.9], [1 / 24, 1.3], [1 / 12, 2]]) {
    let lo = ext * 1e-5, hi = ext * 0.04;
    best = null;
    for (let it = 0; it < 20; it++) {
      const mid = Math.sqrt(lo * hi);
      const s = welded.map((g) => cluster(g, mid, uvCell, nCell));
      if (tris(s) > budget) lo = mid; else { hi = mid; best = s; }
    }
    if (best) return best;
  }
  return welded.map((g) => cluster(g, ext * 0.04, 1 / 12, 2));
}

// ---------------------------------------------------------------- writer
export function write(path, groups, { normals = true, uv = true } = {}) {
  let ext = 0;
  for (const g of groups) for (const v of g.pos) ext = Math.max(ext, Math.abs(v));
  const posScale = ext / 32767;
  const header = { version: 2, posScale, groups: [] };
  const blobs = [];
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  for (const g of groups) {
    const n = g.pos.length / 3;
    const hasN = normals && !!g.nrm, hasUv = uv && !!g.uv;
    const wide = n > 65535;
    const entry = { name: g.name, material: g.material, vertices: n, indices: g.idx.length, wide, normals: hasN, uv: hasUv };
    blobs.push(pad(Buffer.from(Int16Array.from(g.pos, (v) => Math.round(v / posScale)).buffer)));
    if (hasN) blobs.push(pad(Buffer.from(Int8Array.from(g.nrm, (v) => Math.round(v * 127)).buffer)));
    if (hasUv) {
      const us = g.uv.filter((_, i) => i % 2 === 0), vs = g.uv.filter((_, i) => i % 2 === 1);
      const min = [Math.min(...us), Math.min(...vs)];
      const size = [Math.max(...us) - min[0] || 1, Math.max(...vs) - min[1] || 1];
      entry.uvMin = min; entry.uvSize = size;
      blobs.push(pad(Buffer.from(Uint16Array.from(g.uv, (v, i) => Math.round(((v - min[i % 2]) / size[i % 2]) * 65535)).buffer)));
    }
    blobs.push(pad(Buffer.from((wide ? Uint32Array : Uint16Array).from(g.idx).buffer)));
    header.groups.push(entry);
  }
  let json = JSON.stringify(header);
  while ((json.length + 4) % 4) json += ' ';
  const head = Buffer.alloc(4);
  head.writeUInt32LE(Buffer.byteLength(json));
  const out = Buffer.concat([head, Buffer.from(json), ...blobs]);
  writeFileSync(path, out);
  return out.length;
}

