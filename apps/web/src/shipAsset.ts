// Loads the imported ship models (FBX) once and hands out per-team clones.
// Until a model has loaded (or if it fails) the procedural model in visuals.ts stands in.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import fighterUrl from './assets/spaceship/fighter.fbx?url';
import blueBase from './assets/spaceship/blue_base.jpg?url';
import blueEmissive from './assets/spaceship/blue_emissive.jpg?url';
import redBase from './assets/spaceship/red_base.jpg?url';
import redEmissive from './assets/spaceship/red_emissive.jpg?url';
import normalUrl from './assets/spaceship/normal.jpg?url';
import roughUrl from './assets/spaceship/roughness.jpg?url';
import metalUrl from './assets/spaceship/metallic.jpg?url';
import aoUrl from './assets/spaceship/ao.jpg?url';
import interceptorObj from './assets/interceptor/interceptor.obj?raw';
import wayfarerUrl from './assets/wayfarer/wayfarer.fbx?url';
import wayfarerBase from './assets/wayfarer/base.jpg?url';
import wayfarerEmissive from './assets/wayfarer/emissive.jpg?url';
import javelinUrl from './assets/javelin/javelin.bin?url'; // baked by scripts/bake-obj.mjs
import bomberUrl from './assets/bomber/bomber.bin?url'; // baked by scripts/bake-glb.mjs
const bomberMaps = import.meta.glob('./assets/bomber/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
import freighterUrl from './assets/freighter/freighter.bin?url'; // baked by scripts/bake-freighter.mjs

/** Freighter display length (procedural-model units; ships are drawn at 1.7×, so 78 ≈ 133 mm). */
const FREIGHTER_LENGTH = 78;

export type Skin = 'blue' | 'red';
export interface ShipTemplate {
  /** A fresh copy of the model, +X forward, centred, in procedural-model units. */
  build(skin: Skin, color: number): THREE.Object3D;
  /** Engine exhaust points (+X forward model space) for glow sprites. */
  engines: { x: number; y: number; z: number; r: number }[];
}

const templates: Record<string, ShipTemplate> = {};
export const shipTemplate = (typeId: string): ShipTemplate | null => templates[typeId] ?? null;

// The FBX files reference textures by paths on the author's machine; never fetch those.
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAoAAx9k7/gAAAAASUVORK5CYII=';
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => (/\.(png|jpe?g|tga|tiff?|bmp|dds)(\.\d+)?$/i.test(url) ? BLANK_PNG : url));

/**
 * Wrap a loaded model so it faces +X (after turning it `rotY` about Y), is centred on the origin,
 * and is `length` long nose to tail.
 */
function normalise(obj: THREE.Object3D, rotY: number, length: number) {
  const pivot = new THREE.Group();
  pivot.add(obj);
  pivot.rotation.y = rotY;
  const outer = new THREE.Group();
  outer.add(pivot);
  outer.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(outer);
  const c = box.getCenter(new THREE.Vector3());
  pivot.position.sub(c);
  const k = length / box.getSize(new THREE.Vector3()).x;
  outer.scale.setScalar(k);
  outer.updateMatrixWorld(true);
  return { outer, box: new THREE.Box3().setFromObject(outer) };
}

/** Bytes of an asset URL; inlined data: URLs are decoded directly (artifact sandboxes may block fetching them). */
async function bytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return (await fetch(url)).arrayBuffer();
}

const castShadows = (o: THREE.Object3D) => o.traverse((m) => { if ((m as THREE.Mesh).isMesh) m.castShadow = true; });

async function loadFighter(renderer: THREE.WebGLRenderer) {
  const tl = new THREE.TextureLoader();
  const tex = (url: string, srgb = false) => tl.loadAsync(url).then((t) => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  });
  const [fbx, bb, be, rb, re, nrm, rough, metal, ao] = await Promise.all([
    bytes(fighterUrl).then((b) => new FBXLoader(manager).parse(b, '')),
    tex(blueBase, true), tex(blueEmissive, true), tex(redBase, true), tex(redEmissive, true),
    tex(normalUrl), tex(roughUrl), tex(metalUrl), tex(aoUrl),
  ]);
  const mat = (base: THREE.Texture, emissive: THREE.Texture) => new THREE.MeshStandardMaterial({
    map: base, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 2.2,
    normalMap: nrm, normalScale: new THREE.Vector2(1, -1), // DirectX-style normal map → flip green
    roughnessMap: rough, metalnessMap: metal, metalness: 1, roughness: 1, aoMap: ao,
  });
  const skins = { blue: mat(bb, be), red: mat(rb, re) };
  const { outer, box } = normalise(fbx, Math.PI / 2, 38); // source nose points +Z
  castShadows(outer);
  templates.kestrel = {
    build(skin) {
      const o = outer.clone(true);
      o.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).material = skins[skin]; });
      return o;
    },
    engines: [{ x: box.min.x + 0.5, y: 0, z: 0, r: 2.2 }],
  };
}

async function loadFreighter() {
  const buf = await bytes(freighterUrl);
  const headerLen = new DataView(buf).getUint32(0, true);
  const header: { groups: { name: string; vertices: number; indices: number }[] } =
    JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
  // No textures came with this model: painted metal, flat-shaded to keep its hard-surface panelling crisp.
  const mats: Record<string, THREE.Material> = {
    hull: new THREE.MeshStandardMaterial({ color: 0x7d8491, metalness: 0.55, roughness: 0.55, flatShading: true }),
    plate: new THREE.MeshStandardMaterial({ color: 0x3c424c, metalness: 0.7, roughness: 0.45, flatShading: true }),
  };
  const outer = new THREE.Group();
  let off = 4 + headerLen;
  for (const g of header.groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, off, g.vertices * 3), 3));
    off += g.vertices * 12;
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, off, g.indices), 1));
    off += g.indices * 4;
    geo.computeBoundingSphere();
    outer.add(new THREE.Mesh(geo, mats[g.name] ?? mats.hull));
  }
  // Baked at 44 units long; shown bigger so the heavy, hard-to-kill ship looks the part next to the fighters
  // (it overhangs its 60 mm base, as the fighters overhang theirs; the base still defines the rules footprint).
  const k = FREIGHTER_LENGTH / 44;
  outer.scale.setScalar(k);
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.bulwark = {
    build() { return outer.clone(true); },
    engines: [{ x: box.min.x + 1, y: 0, z: 0, r: 3 * k }],
  };
}

async function loadInterceptor() {
  const obj = new OBJLoader().parse(interceptorObj);
  // No .mtl or UVs came with it, but its parts are separate objects: colour each one by name.
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.08, emissive: 0x0c2f4a, emissiveIntensity: 0.6 });
  const exhaust = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7fd8ff).multiplyScalar(3) });
  const byColor = new Map<number, { hull: THREE.Material; lights: THREE.Material }>();
  const mats = (color: number) => {
    let m = byColor.get(color);
    if (!m) {
      m = {
        hull: new THREE.MeshStandardMaterial({ color: new THREE.Color(0x9aa3b0).lerp(new THREE.Color(color), 0.3), metalness: 0.6, roughness: 0.4 }),
        lights: new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5) }),
      };
      byColor.set(color, m);
    }
    return m;
  };
  const { outer, box } = normalise(obj, Math.PI / 2, 34); // source nose points +Z
  castShadows(outer);
  templates.wasp = {
    build(_skin, color) {
      const o = outer.clone(true);
      const m = mats(color);
      o.traverse((n) => {
        const mesh = n as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (/engine_glow/i.test(mesh.name)) { mesh.material = exhaust; mesh.castShadow = false; }
        else if (/lights/i.test(mesh.name)) { mesh.material = m.lights; mesh.castShadow = false; }
        else if (/^WindS/i.test(mesh.name)) mesh.material = glass;
        else mesh.material = m.hull;
      });
      return o;
    },
    engines: [{ x: box.min.x + 0.3, y: -0.5, z: 0, r: 1.6 }],
  };
}

/** Read a binary written by scripts/bake-glb.mjs into one geometry per source material. */
function parseBakedGlb(buf: ArrayBuffer) {
  const headerLen = new DataView(buf).getUint32(0, true);
  const header: { posScale: number; groups: { material: string; vertices: number; indices: number; wide: boolean }[] } =
    JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
  let off = 4 + headerLen;
  const take = (bytes: number) => { const at = off; off += Math.ceil(bytes / 4) * 4; return at; };
  return header.groups.map((g) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Int16Array(buf, take(g.vertices * 6), g.vertices * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, take(g.vertices * 3), g.vertices * 3), 3, true));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, take(g.vertices * 8), g.vertices * 2), 2));
    const idx = g.wide ? new Uint32Array(buf, take(g.indices * 4), g.indices) : new Uint16Array(buf, take(g.indices * 2), g.indices);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return { material: g.material, geometry: geo, posScale: header.posScale };
  });
}

async function loadBomber(renderer: THREE.WebGLRenderer) {
  const tl = new THREE.TextureLoader();
  const map = (file: string, srgb = false) => {
    const url = bomberMaps[`./assets/bomber/${file}`];
    if (!url) return Promise.resolve(null);
    return tl.loadAsync(url).then((t) => {
      t.flipY = false; // glTF UV convention
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return t;
    });
  };
  const parts = parseBakedGlb(await bytes(bomberUrl));
  const outer = new THREE.Group();
  for (const p of parts) {
    const id = /Material\.(\d+)/.exec(p.material)?.[1] ?? '';
    const [base, normal, rough, metal, emissive] = await Promise.all([
      map(`m${id}_base.jpg`, true), map(`m${id}_normal.jpg`), map(`m${id}_rough.jpg`), map(`m${id}_metal.jpg`), map(`m${id}_emissive.jpg`, true),
    ]);
    const mat = base
      ? new THREE.MeshStandardMaterial({
        map: base, normalMap: normal, roughnessMap: rough, metalnessMap: metal, roughness: 1, metalness: 1,
        emissiveMap: emissive, emissive: emissive ? 0xffffff : 0x000000, emissiveIntensity: 2, side: THREE.DoubleSide,
      })
      // The one untextured part is the canopy.
      : new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.1, emissive: 0x0c2f4a, emissiveIntensity: 0.6 });
    const mesh = new THREE.Mesh(p.geometry, mat);
    mesh.scale.setScalar(p.posScale); // positions are quantised to int16
    outer.add(mesh);
  }
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.anvil = {
    build() { return outer.clone(true); },
    // twin engine nacelles at the tail
    engines: [-1, 1].map((s) => ({ x: box.min.x + 0.8, y: 0, z: s * box.max.z * 0.6, r: 2.2 })),
  };
}

/** The Javelin: an untextured model, painted in team-tinted metal like the Wasp. */
async function loadJavelin() {
  const parts = parseBakedGlb(await bytes(javelinUrl));
  const byColor = new Map<number, THREE.Material>();
  const paint = (color: number) => {
    let m = byColor.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x868e9b).lerp(new THREE.Color(color), 0.3), metalness: 0.55, roughness: 0.45 });
      byColor.set(color, m);
    }
    return m;
  };
  const outer = new THREE.Group();
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, paint(0xffffff));
    mesh.scale.setScalar(p.posScale); // positions are quantised to int16
    outer.add(mesh);
  }
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.javelin = {
    build(_skin, color) {
      const o = outer.clone(true);
      o.traverse((n) => { if ((n as THREE.Mesh).isMesh) (n as THREE.Mesh).material = paint(color); });
      return o;
    },
    // twin engines at the back of the wedge
    engines: [-1, 1].map((sd) => ({ x: box.min.x + 0.6, y: 0, z: sd * box.max.z * 0.32, r: 1.8 })),
  };
}

/** The Wayfarer: a small textured FBX whose separate gun mesh swivels with the turret arc. */
async function loadWayfarer(renderer: THREE.WebGLRenderer) {
  const tl = new THREE.TextureLoader();
  const tex = (url: string) => tl.loadAsync(url).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  });
  const [fbx, base, emissive] = await Promise.all([
    bytes(wayfarerUrl).then((b) => new FBXLoader(manager).parse(b, '')), tex(wayfarerBase), tex(wayfarerEmissive),
  ]);
  const mat = new THREE.MeshStandardMaterial({ map: base, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 2, metalness: 0.45, roughness: 0.5 });
  fbx.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = mat;
    if (/gun/i.test(m.name)) m.userData.turretGun = true; // swivels with the turret arc
  });
  const { outer, box } = normalise(fbx, Math.PI / 2, 58); // source nose points +Z; a medium ship, Bulwark-sized
  castShadows(outer);
  templates.wayfarer = {
    build() { return outer.clone(true); },
    engines: [-1, 1].map((sd) => ({ x: box.min.x + 0.8, y: 0, z: sd * box.max.z * 0.4, r: 3 })),
  };
}

/** Load every imported model; each one that fails just leaves its procedural stand-in. */
let modelsLoaded!: () => void;
/** Resolves once every imported model has loaded or failed (other views, like previews, can then rebuild). */
export const shipModelsReady = new Promise<void>((r) => { modelsLoaded = r; });

export async function loadShipModels(renderer: THREE.WebGLRenderer): Promise<void> {
  const results = await Promise.allSettled([loadFighter(renderer), loadFreighter(), loadInterceptor(), loadBomber(renderer), loadJavelin(), loadWayfarer(renderer)]);
  for (const r of results) if (r.status === 'rejected') console.warn('ship model failed to load; using built-in model', r.reason);
  modelsLoaded();
}
