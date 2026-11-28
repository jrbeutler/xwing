// Loads the imported ship models once and hands out per-team clones.
// Until a model has loaded (or if it fails) the procedural model in visuals.ts stands in.
//
// Team colours: hulls are silver with highlights in the team colour (passed to build()).
// - Textured models: greyscale detail maps (scripts/shrink-textures.py) shade the paint, and an accent
//   mask (scripts/make-accent-masks.py, from the original colour maps) says where the team colour goes.
// - Untextured models: a named part, or a region of the hull (wing tips, nose), carries the accent.
// Lights and glow maps shine in the team colour too.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import fighterUrl from './assets/spaceship/fighter.bin?url'; // packed by scripts/pack-models.mjs
import fighterDetail from './assets/spaceship/base.jpg?url';
import fighterGlow from './assets/spaceship/emissive.jpg?url';
import fighterAccent from './assets/spaceship/accent.jpg?url';
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
/** The model library (scripts/bake-palette-fbx.mjs): capital-ship models not yet tied to a ship type, by id. */
const libraryUrls = Object.fromEntries(Object.entries(import.meta.glob('./assets/library/*.bin', { eager: true, query: '?url', import: 'default' }) as Record<string, string>)
  .map(([path, url]) => [/([^/]+)\.bin$/.exec(path)![1], url]));

/** Freighter display length (procedural-model units; ships are drawn at MODEL_SCALE = 1.3×, so 78 ≈ 101 mm). */
const FREIGHTER_LENGTH = 78;

export type Skin = 'blue' | 'red';

/** Engine exhaust per side: the glow and the hot core of the nozzle (blue for the player, orange for the opponent). */
export const EXHAUST: Record<Skin, { glow: number; core: number }> = {
  blue: { glow: 0x7fd8ff, core: 0xbdefff },
  red: { glow: 0xff8a2a, core: 0xffd2a0 },
};
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

/** Hull silver (sRGB hex; three converts it to linear). */
const SILVER = 0xc6ccd5;

/**
 * Silver paint with team-coloured highlights. Where the accent is 1 the hull takes the team colour,
 * where it is 0 it stays silver; any detail map still shades both. The accent comes from a mask texture
 * (same UVs as the detail map) or from a per-vertex `accent` attribute (see markAccents).
 */
function teamPaint(team: number, params: THREE.MeshStandardMaterialParameters, accent: { map?: THREE.Texture | null; attribute?: boolean } = {}) {
  const m = new THREE.MeshStandardMaterial({ ...params, color: 0xffffff });
  const useMap = !!(accent.map && params.map), useAttr = !!accent.attribute;
  const source = useMap && useAttr ? 'both' : useMap ? 'map' : useAttr ? 'attr' : 'none';
  const uniforms = { uSilver: { value: new THREE.Color(SILVER) }, uTeam: { value: new THREE.Color(team) }, uAccentMap: { value: accent.map ?? null } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (useAttr) {
      sh.vertexShader = 'attribute float accent;\nvarying float vAccent;\n' +
        sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAccent = accent;');
    }
    const acc = source === 'both' ? 'max(texture2D(uAccentMap, vMapUv).r, vAccent)'
      : source === 'map' ? 'texture2D(uAccentMap, vMapUv).r' : source === 'attr' ? 'vAccent' : '0.0';
    sh.fragmentShader = `uniform vec3 uSilver;\nuniform vec3 uTeam;\n${useMap ? 'uniform sampler2D uAccentMap;\n' : ''}${useAttr ? 'varying float vAccent;\n' : ''}` +
      sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n\tdiffuseColor.rgb *= mix(uSilver, uTeam, clamp(${acc}, 0.0, 1.0));`);
  };
  m.customProgramCacheKey = () => `team-paint-${source}`;
  return m;
}

/**
 * Give an untextured model's meshes a per-vertex `accent` (1 = team colour) from where each vertex sits in
 * the finished model (+X forward, Z across): the outer part of the wings and the tip of the nose.
 */
function markAccents(outer: THREE.Object3D, { wing = 0.7, nose = 0.82 } = {}) {
  outer.updateMatrixWorld(true);
  // Work in the model's own frame (before its display scale), measuring the extent and the vertices alike.
  const inv = new THREE.Matrix4().copy(outer.matrixWorld).invert();
  const meshes: { mesh: THREE.Mesh; pts: THREE.Vector3[] }[] = [];
  const box = new THREE.Box3();
  outer.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh) return;
    const toOuter = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position;
    const pts = Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toOuter));
    for (const p of pts) box.expandByPoint(p);
    meshes.push({ mesh, pts });
  });
  const zMax = Math.max(Math.abs(box.min.z), Math.abs(box.max.z)), xMax = box.max.x;
  for (const { mesh, pts } of meshes) {
    const a = Float32Array.from(pts, (p) => (Math.abs(p.z) > wing * zMax || p.x > nose * xMax ? 1 : 0));
    mesh.geometry.setAttribute('accent', new THREE.BufferAttribute(a, 1));
  }
}

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
  const [parts, detail, glow, accent, nrm, rough, metal, ao] = await Promise.all([
    bytes(fighterUrl).then(parsePacked),
    tex(fighterDetail, true), tex(fighterGlow, true), tex(fighterAccent), tex(normalUrl), tex(roughUrl), tex(metalUrl), tex(aoUrl),
  ]);
  const paint = perColor((color) => teamPaint(color, {
    map: detail, emissive: color, emissiveMap: glow, emissiveIntensity: 2.2,
    normalMap: nrm, normalScale: new THREE.Vector2(1, -1), // DirectX-style normal map → flip green
    roughnessMap: rough, metalnessMap: metal, metalness: 0.8, roughness: 1, aoMap: ao,
  }, { map: accent }));
  const { outer, box } = normalise(packedGroup(parts, () => paint(0xffffff)), Math.PI / 2, 38); // source nose points +Z
  castShadows(outer);
  templates.kestrel = {
    build(_skin, color) { const m = paint(color); return paintClone(outer, () => m); },
    engines: [{ x: box.min.x + 0.5, y: 0, z: 0, r: 2.2 }],
  };
}

async function loadFreighter() {
  const parts = parsePacked(await bytes(freighterUrl));
  // No textures came with this model: a silver hull with its armour plating in the team colour,
  // flat-shaded to keep its hard-surface panelling crisp.
  const paint = perColor((color) => ({
    hull: teamPaint(color, { metalness: 0.6, roughness: 0.4, flatShading: true }),
    plate: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.8), metalness: 0.5, roughness: 0.45, flatShading: true }),
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
  // Its own exhaust part glows in the side's exhaust colour.
  const exhaustMat = { blue: new THREE.MeshBasicMaterial({ color: new THREE.Color(EXHAUST.blue.glow).multiplyScalar(3) }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(EXHAUST.red.glow).multiplyScalar(3) }) };
  const byColor = new Map<number, { hull: THREE.Material; lights: THREE.Material }>();
  const mats = (color: number) => {
    let m = byColor.get(color);
    if (!m) {
      m = {
        hull: teamPaint(color, { metalness: 0.6, roughness: 0.38 }, { attribute: true }),
        lights: new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5) }),
      };
      byColor.set(color, m);
    }
    return m;
  };
  const { outer, box } = normalise(obj, Math.PI / 2, 34); // source nose points +Z
  markAccents(outer, { wing: 0.62, nose: 0.8 });
  castShadows(outer);
  templates.wasp = {
    build(skin, color) {
      const o = outer.clone(true);
      const m = mats(color);
      o.traverse((n) => {
        const mesh = n as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (/engine_glow/i.test(mesh.name)) { mesh.material = exhaustMat[skin]; mesh.castShadow = false; }
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
      map(`m${id}_accent.jpg`),
    ]));
  }
  // The one untextured part is the canopy.
  const canopy = new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.1, emissive: 0x0c2f4a, emissiveIntensity: 0.6 });
  const paint = perColor((color) => new Map([...maps].map(([id, [base, normal, rough, metal, emissive, accent]]) => [id, base
    ? teamPaint(color, {
      map: base, normalMap: normal, roughnessMap: rough, metalnessMap: metal, roughness: 1, metalness: 0.8,
      emissiveMap: emissive, emissive: emissive ? color : 0x000000, emissiveIntensity: 2, side: THREE.DoubleSide,
    }, { map: accent, attribute: true })
    : canopy])));
  const pick = (color: number, material: string) => paint(color).get(/Material\.(\d+)/.exec(material)?.[1] ?? '') ?? canopy;
  const outer = packedGroup(parts, (p) => pick(0xffffff, p.material));
  outer.children.forEach((m, i) => { m.userData.material = parts[i].material; });
  markAccents(outer, { wing: 0.72, nose: 0.86 }); // its painted trim is thin, so the wing tips and nose carry the colour too
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
  const paint = perColor((color) => teamPaint(color, { metalness: 0.6, roughness: 0.38 }, { attribute: true }));
  const outer = packedGroup(parts, () => paint(0xffffff));
  markAccents(outer, { wing: 0.68, nose: 0.84 });
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
  // Its texture paints most of the hull, so a mask would make it mostly team colour: accent the
  // outer pods and the nose instead.
  const paint = perColor((color) => teamPaint(color, {
    map: base, emissiveMap: emissive, emissive: color, emissiveIntensity: 2, metalness: 0.6, roughness: 0.42,
  }, { attribute: true }));
  fbx.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = paint(0xffffff);
    if (/gun/i.test(m.name)) m.userData.turretGun = true; // swivels with the turret arc
  });
  const { outer, box } = normalise(fbx, Math.PI / 2, 58); // source nose points +Z; a medium ship, Bulwark-sized
  markAccents(outer, { wing: 0.7, nose: 0.82 });
  castShadows(outer);
  templates.wayfarer = {
    build(_skin, color) { const m = paint(color); return paintClone(outer, () => m); },
    engines: [-1, 1].map((sd) => ({ x: box.min.x + 0.8, y: 0, z: sd * box.max.z * 0.4, r: 3 })),
  };
}

/** Ids of the models in the library (e.g. 'destroyer-3', 'cruiser-4'). */
export const LIBRARY_MODELS = Object.keys(libraryUrls).sort();

/**
 * A library model as a ship template, `length` units long (the procedural-model scale: a small fighter is
 * about 38, a medium ship 58). Baked in four palette groups: the hull is silver, the trim takes the team
 * colour, and the dark panels and black vents stay dark. Flat-shaded, as the models were made.
 */
export async function libraryTemplate(id: string, length: number): Promise<ShipTemplate> {
  const url = libraryUrls[id];
  if (!url) throw new Error(`no library model ${id}`);
  const parts = parsePacked(await bytes(url));
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b414c, metalness: 0.5, roughness: 0.55, flatShading: true });
  const black = new THREE.MeshStandardMaterial({ color: 0x0e1014, metalness: 0.3, roughness: 0.7, flatShading: true });
  const paint = perColor((color) => ({
    hull: teamPaint(color, { metalness: 0.6, roughness: 0.42, flatShading: true }),
    accent: new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.85), metalness: 0.45, roughness: 0.45, flatShading: true }),
  }));
  const pick = (color: number, group: string) => (group === 'accent' ? paint(color).accent : group === 'dark' ? dark : group === 'black' ? black : paint(color).hull);
  const outer = packedGroup(parts, (p) => pick(0xffffff, p.name));
  outer.scale.setScalar(length / 100); // baked 100 units long
  castShadows(outer);
  const box = new THREE.Box3().setFromObject(outer);
  return {
    build(_skin, color) { return paintClone(outer, (m) => pick(color, m.name)); },
    engines: [{ x: box.min.x + length * 0.02, y: 0, z: 0, r: length * 0.05 }],
  };
}

/** Use a library model for a ship type (e.g. a new hull before it has a model of its own). */
export async function useLibraryModel(typeId: string, id: string, length: number) {
  templates[typeId] = await libraryTemplate(id, length);
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
