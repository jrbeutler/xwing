// Loads the imported ship models once and hands out per-team clones.
// Until a model has loaded (or if it fails) the procedural model in visuals.ts stands in.
//
// Team colours: every ship on a side wears the same paint (the team colour passed to build()).
// Textured models keep only their surface detail: the old colour maps are greyscale detail maps
// (scripts/shrink-textures.py) that the paint shows through, and glow masks tinted with the same colour.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import fighterUrl from './assets/spaceship/fighter.bin?url'; // packed by scripts/pack-models.mjs
import fighterDetail from './assets/spaceship/base.jpg?url';
import fighterGlow from './assets/spaceship/emissive.jpg?url';
import normalUrl from './assets/spaceship/normal.jpg?url';
import roughUrl from './assets/spaceship/roughness.jpg?url';
import metalUrl from './assets/spaceship/metallic.jpg?url';
import aoUrl from './assets/spaceship/ao.jpg?url';
import interceptorObj from './assets/interceptor/interceptor.obj?raw';
import wayfarerUrl from './assets/wayfarer/wayfarer.fbx?url';
import wayfarerBase from './assets/wayfarer/base.jpg?url';
import wayfarerEmissive from './assets/wayfarer/emissive.jpg?url';
import javelinUrl from './assets/javelin/javelin.bin?url'; // packed by scripts/pack-models.mjs
import bomberUrl from './assets/bomber/bomber.bin?url'; // packed by scripts/pack-models.mjs
const bomberMaps = import.meta.glob('./assets/bomber/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
import freighterUrl from './assets/freighter/freighter.bin?url'; // packed by scripts/pack-models.mjs

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

/** Memoise one material (or set) per team colour. */
function perColor<T>(make: (color: number) => T): (color: number) => T {
  const cache = new Map<number, T>();
  return (color) => {
    let v = cache.get(color);
    if (!v) { v = make(color); cache.set(color, v); }
    return v;
  };
}

/** Swap every mesh's material in a cloned model (by mesh name when a ship has distinct parts). */
function paintClone(src: THREE.Object3D, pick: (mesh: THREE.Mesh) => THREE.Material | THREE.Material[]) {
  const o = src.clone(true);
  o.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh) m.material = pick(m); });
  return o;
}

interface PackedPart { name: string; material: string; geometry: THREE.BufferGeometry; posScale: number }

/**
 * Read a model written by scripts/pack-models.mjs (format v2): per group int16 positions (× posScale),
 * optional int8 normals, optional uint16 UVs (expanded here to floats), uint16/uint32 indices.
 */
function parsePacked(buf: ArrayBuffer): PackedPart[] {
  const headerLen = new DataView(buf).getUint32(0, true);
  const header: {
    posScale: number;
    groups: { name: string; material: string; vertices: number; indices: number; wide: boolean; normals: boolean; uv: boolean; uvMin?: [number, number]; uvSize?: [number, number] }[];
  } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
  let off = 4 + headerLen;
  const take = (bytes: number) => { const at = off; off += Math.ceil(bytes / 4) * 4; return at; };
  return header.groups.map((g) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Int16Array(buf, take(g.vertices * 6), g.vertices * 3), 3));
    if (g.normals) geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, take(g.vertices * 3), g.vertices * 3), 3, true));
    if (g.uv && g.uvMin && g.uvSize) {
      const q = new Uint16Array(buf, take(g.vertices * 4), g.vertices * 2);
      const [u0, v0] = g.uvMin, [du, dv] = g.uvSize;
      geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(q, (x, i) => (i % 2 ? v0 + (x / 65535) * dv : u0 + (x / 65535) * du)), 2));
    }
    const idx = g.wide ? new Uint32Array(buf, take(g.indices * 4), g.indices) : new Uint16Array(buf, take(g.indices * 2), g.indices);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return { name: g.name, material: g.material, geometry: geo, posScale: header.posScale };
  });
}

/** One group holding a packed model's parts (positions are quantised, so each mesh carries posScale). */
function packedGroup(parts: PackedPart[], material: (p: PackedPart) => THREE.Material) {
  const g = new THREE.Group();
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, material(p));
    mesh.name = p.name;
    mesh.scale.setScalar(p.posScale);
    g.add(mesh);
  }
  return g;
}

async function loadFighter(renderer: THREE.WebGLRenderer) {
  const tl = new THREE.TextureLoader();
  const tex = (url: string, srgb = false) => tl.loadAsync(url).then((t) => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  });
  const [parts, detail, glow, nrm, rough, metal, ao] = await Promise.all([
    bytes(fighterUrl).then(parsePacked),
    tex(fighterDetail, true), tex(fighterGlow, true), tex(normalUrl), tex(roughUrl), tex(metalUrl), tex(aoUrl),
  ]);
  const paint = perColor((color) => new THREE.MeshStandardMaterial({
    color, map: detail, emissive: color, emissiveMap: glow, emissiveIntensity: 2.2,
    normalMap: nrm, normalScale: new THREE.Vector2(1, -1), // DirectX-style normal map → flip green
    roughnessMap: rough, metalnessMap: metal, metalness: 0.7, roughness: 1, aoMap: ao,
  }));
  const { outer, box } = normalise(packedGroup(parts, () => paint(0xffffff)), Math.PI / 2, 38); // source nose points +Z
  castShadows(outer);
  templates.kestrel = {
    build(_skin, color) { const m = paint(color); return paintClone(outer, () => m); },
    engines: [{ x: box.min.x + 0.5, y: 0, z: 0, r: 2.2 }],
  };
}

async function loadFreighter() {
  const parts = parsePacked(await bytes(freighterUrl));
  // No textures came with this model: painted metal in the team colour with darker plating,
  // flat-shaded to keep its hard-surface panelling crisp.
  const paint = perColor((color) => ({
    hull: new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.55, flatShading: true }),
    plate: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.45), metalness: 0.6, roughness: 0.45, flatShading: true }),
  }));
  const pick = (color: number, name: string) => (name === 'plate' ? paint(color).plate : paint(color).hull);
  const outer = packedGroup(parts, (p) => pick(0xffffff, p.name));
  // Baked at 44 units long; shown bigger so the heavy, hard-to-kill ship looks the part next to the fighters
  // (it overhangs its 60 mm base, as the fighters overhang theirs; the base still defines the rules footprint).
  const k = FREIGHTER_LENGTH / 44;
  outer.scale.setScalar(k);
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.bulwark = {
    build(_skin, color) { return paintClone(outer, (m) => pick(color, m.name)); },
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
        hull: new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.45 }),
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
  const parts = parsePacked(await bytes(bomberUrl));
  // Per source material: detail (greyscale), normal, roughness, metalness and glow maps; the team paints over them.
  const maps = new Map<string, Awaited<ReturnType<typeof map>>[]>();
  for (const p of parts) {
    const id = /Material\.(\d+)/.exec(p.material)?.[1] ?? '';
    if (!maps.has(id)) maps.set(id, await Promise.all([
      map(`m${id}_base.jpg`, true), map(`m${id}_normal.jpg`), map(`m${id}_rough.jpg`), map(`m${id}_metal.jpg`), map(`m${id}_emissive.jpg`, true),
    ]));
  }
  // The one untextured part is the canopy.
  const canopy = new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.1, emissive: 0x0c2f4a, emissiveIntensity: 0.6 });
  const paint = perColor((color) => new Map([...maps].map(([id, [base, normal, rough, metal, emissive]]) => [id, base
    ? new THREE.MeshStandardMaterial({
      color, map: base, normalMap: normal, roughnessMap: rough, metalnessMap: metal, roughness: 1, metalness: 0.7,
      emissiveMap: emissive, emissive: emissive ? color : 0x000000, emissiveIntensity: 2, side: THREE.DoubleSide,
    })
    : canopy])));
  const pick = (color: number, material: string) => paint(color).get(/Material\.(\d+)/.exec(material)?.[1] ?? '') ?? canopy;
  const outer = packedGroup(parts, (p) => pick(0xffffff, p.material));
  outer.children.forEach((m, i) => { m.userData.material = parts[i].material; });
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.anvil = {
    build(_skin, color) { return paintClone(outer, (m) => pick(color, m.userData.material)); },
    // twin engine nacelles at the tail
    engines: [-1, 1].map((s) => ({ x: box.min.x + 0.8, y: 0, z: s * box.max.z * 0.6, r: 2.2 })),
  };
}

/** The Javelin: an untextured model, painted in the team colour. */
async function loadJavelin() {
  const parts = parsePacked(await bytes(javelinUrl));
  const paint = perColor((color) => new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.45 }));
  const outer = packedGroup(parts, () => paint(0xffffff));
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  templates.javelin = {
    build(_skin, color) { const m = paint(color); return paintClone(outer, () => m); },
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
  const paint = perColor((color) => new THREE.MeshStandardMaterial({
    color, map: base, emissiveMap: emissive, emissive: color, emissiveIntensity: 2, metalness: 0.45, roughness: 0.5,
  }));
  fbx.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = paint(0xffffff);
    if (/gun/i.test(m.name)) m.userData.turretGun = true; // swivels with the turret arc
  });
  const { outer, box } = normalise(fbx, Math.PI / 2, 58); // source nose points +Z; a medium ship, Bulwark-sized
  castShadows(outer);
  templates.wayfarer = {
    build(_skin, color) { const m = paint(color); return paintClone(outer, () => m); },
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
