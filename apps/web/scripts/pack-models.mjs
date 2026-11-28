// Simplify and pack the heavy ship models into one compact binary format the game loads.
//
//   node apps/web/scripts/pack-models.mjs            # rewrites the *.bin files in apps/web/src/assets
//
// Inputs are whatever is in assets now (earlier bakes, or the fighter's FBX); outputs:
//   spaceship/fighter.bin, bomber/bomber.bin, javelin/javelin.bin, freighter/freighter.bin
//
// Simplification is vertex clustering (as in bake-glb.mjs): vertices merge when position, UV and normal
// fall in the same cell, so texture seams and hard creases survive. The cell size is searched per model
// to land near a triangle budget sized for ~4 cm ships on a phone.
//
// Format v2: u32 headerBytes, JSON header (space-padded to 4), then per group, each block 4-byte aligned:
//   i16 positions ×3 (× posScale)
//   [i8 normals ×3]            if group.normals
//   [u16 uvs ×2]               if group.uv (u = uvMin[0] + q/65535 × uvSize[0], same for v)
//   u16|u32 indices            (u32 when group.wide)
// header = { version: 2, posScale, groups: [{ name, material, vertices, indices, wide, normals, uv, uvMin, uvSize }] }
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBaked, readFbx, readFreighter, simplify, write } from './model-pack-lib.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets');

// ---------------------------------------------------------------- models
const jobs = [
  // file in → file out, triangle budget, what to keep
  { name: 'fighter', src: 'spaceship/fighter.fbx', out: 'spaceship/fighter.bin', read: readFbx, budget: 12000 },
  { name: 'bomber', src: 'bomber/bomber.bin', out: 'bomber/bomber.bin', read: readBaked, budget: 16000 },
  { name: 'javelin', src: 'javelin/javelin.bin', out: 'javelin/javelin.bin', read: readBaked, budget: 12000, keep: { uv: false } },
  { name: 'freighter', src: 'freighter/freighter.bin', out: 'freighter/freighter.bin', read: readFreighter, budget: 14000, keep: { normals: false, uv: false } },
];
for (const j of jobs) {
  const src = join(ASSETS, j.src);
  if (!existsSync(src)) { console.log(`${j.name}: ${j.src} missing, skipped`); continue; }
  const buf = readFileSync(src);
  const groups = j.read(buf).map((g) => ({ ...g, uv: j.keep?.uv === false ? null : g.uv, nrm: j.keep?.normals === false ? null : g.nrm }));
  const t0 = groups.reduce((s, g) => s + g.idx.length / 3, 0);
  const simple = simplify(groups, j.budget);
  const t1 = simple.reduce((s, g) => s + g.idx.length / 3, 0);
  const bytes = write(join(ASSETS, j.out), simple, j.keep);
  console.log(`${j.name.padEnd(9)} ${String(t0).padStart(6)} → ${String(t1).padStart(6)} triangles   ${(buf.length / 1024) | 0} KB → ${(bytes / 1024) | 0} KB`);
}
