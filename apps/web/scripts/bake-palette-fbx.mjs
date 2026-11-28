// Bake low-poly FBX models painted from a tiny palette texture (one flat colour per face) into the game's
// compact model format: one group per palette colour, so the client paints them like its other ships
// (hull silver, accent in the team colour, dark panels and black vents) with no texture or UVs at all.
//
//   node apps/web/scripts/bake-palette-fbx.mjs <dir with the .fbx files and Texture/T_Spase_64.png> [--budget 8000]
//
// Made for the "Battle SpaceShip" low-poly pack (craftpix.net): 5 destroyers and 5 light cruisers, noses
// along -X, a 64×64 palette with four colours. The source files are not in the repo. Outputs, nose along +X,
// centred, 100 units long: apps/web/src/assets/library/<id>.bin (format v2, positions and indices only;
// the client flat-shades them).
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from './png-read.mjs';
import { ab, simplify, write } from './model-pack-lib.mjs';

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dir) { console.error('usage: node bake-palette-fbx.mjs <dir> [--budget 8000]'); process.exit(1); }
const BUDGET = opt('budget', 8000);
const LENGTH = 100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'library');

/** The pack's file names → library ids. */
const idOf = (file) => {
  const m = /^(Destroyer|Light cruiser)_0?(\d+)\.fbx$/i.exec(file);
  return m ? `${/destroyer/i.test(m[1]) ? 'destroyer' : 'cruiser'}-${m[2]}` : null;
};

// The palette: which of its four colours each face uses decides its group.
const palette = PNG(readFileSync(join(dir, 'Texture', 'T_Spase_64.png')));
function groupAt(u, v) {
  const x = Math.min(palette.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * palette.width)));
  const y = Math.min(palette.height - 1, Math.max(0, Math.floor((1 - (v - Math.floor(v))) * palette.height)));
  const [r, g, b] = palette.pixel(x, y);
  if (r > 100 && g < 60) return 'accent'; // the red trim (blue in the other skin)
  const l = (r + g + b) / 3;
  return l > 60 ? 'hull' : l > 20 ? 'dark' : 'black';
}

mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(dir).filter((f) => f.endsWith('.fbx')).sort()) {
  const id = idOf(file);
  if (!id) continue;
  const root = new FBXLoader().parse(ab(readFileSync(join(dir, file))), '');
  root.updateMatrixWorld(true);
  const groups = new Map(); // name → { pos: [] } triangle soup
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const P = g.attributes.position, UV = g.attributes.uv, I = g.index;
    const n = I ? I.count : P.count;
    for (let t = 0; t < n; t += 3) {
      const ids = [0, 1, 2].map((k) => (I ? I.getX(t + k) : t + k));
      const u = ids.reduce((s, i) => s + UV.getX(i), 0) / 3, v = ids.reduce((s, i) => s + UV.getY(i), 0) / 3;
      const name = groupAt(u, v);
      if (!groups.has(name)) groups.set(name, { pos: [] });
      const out = groups.get(name).pos;
      // Nose from -X to +X: turn 180° about Y.
      for (const i of ids) out.push(-P.getX(i), P.getY(i), -P.getZ(i));
    }
  });
  // Centre and scale to LENGTH along X.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { pos } of groups.values()) for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]); }
  const c = min.map((m, a) => (m + max[a]) / 2), k = LENGTH / (max[0] - min[0]);
  const list = ['hull', 'accent', 'dark', 'black'].filter((n) => groups.has(n)).map((name) => {
    const pos = groups.get(name).pos.map((x, i) => (x - c[i % 3]) * k);
    return { name, material: name, pos, nrm: null, uv: null, idx: Array.from({ length: pos.length / 3 }, (_, i) => i) };
  });
  const t0 = list.reduce((s, g) => s + g.idx.length / 3, 0);
  const simple = simplify(list, BUDGET);
  const t1 = simple.reduce((s, g) => s + g.idx.length / 3, 0);
  const bytes = write(join(OUT, `${id}.bin`), simple, { normals: false, uv: false });
  const size = max.map((m, a) => ((m - min[a]) * k).toFixed(0)).join(' × ');
  console.log(`${id.padEnd(11)} ${String(t0).padStart(6)} → ${String(t1).padStart(6)} triangles, ${size}, ${(bytes / 1024) | 0} KB  (${simple.map((g) => g.name).join(', ')})`);
}
