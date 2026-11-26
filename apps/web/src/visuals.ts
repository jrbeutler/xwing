// Procedural art: ship models, asteroids, the table surface and the sky. No rules, no game state.
import * as THREE from 'three';
import { BOARD_SIZE, RANGE_RULES } from '@xw/engine';
import { EXHAUST, shipTemplate, type Skin } from './shipAsset';

// ---------------- noise ----------------
function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x: number, y: number, z: number, oct = 4) {
  let a = 0.5, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) { sum += a * vnoise(x * f, y * f, z * f); f *= 2.03; a *= 0.5; }
  return sum; // ~0..1
}

const GLSL_NOISE = /* glsl */ `
  float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vn(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

// ---------------- shared textures ----------------
let glowTex: THREE.Texture | null = null;
/** Soft radial dot used for engine glows, flashes and smoke. */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** A colour pushed above 1.0 so the bloom pass picks it up. */
export const hot = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

// ---------------- ships ----------------
export interface ShipModel { model: THREE.Group; body: THREE.Group; engines: THREE.Sprite[] }

/**
 * Ship models face +X with +Y up. `model` is the part the game animates (banking, shake, dodge);
 * `body` sits inside it and only idles (hover bob); `engines` are glow sprites to flicker.
 */
export function buildShip(typeId: string, color: number, skin: Skin): ShipModel {
  const model = new THREE.Group();
  const body = new THREE.Group();
  model.add(body);
  const engines: THREE.Sprite[] = [];

  const hull = new THREE.MeshStandardMaterial({ color: 0xaeb5c2, metalness: 0.55, roughness: 0.42 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3342, metalness: 0.6, roughness: 0.45 });
  const trim = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.35, emissive: color, emissiveIntensity: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b1626, metalness: 0.9, roughness: 0.08, emissive: 0x0c2f4a, emissiveIntensity: 0.6 });
  const light = new THREE.MeshBasicMaterial({ color: hot(color, 2.4) });
  const nozzle = new THREE.MeshBasicMaterial({ color: hot(EXHAUST[skin].core, 2.2) });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    body.add(m);
    return m;
  };
  /** Engine exhaust: a hot disc plus a flickering additive glow sprite. */
  const engine = (x: number, y: number, z: number, r: number) => {
    const disc = add(new THREE.CircleGeometry(r * 0.75, 16), nozzle, x, y, z);
    disc.rotation.y = -Math.PI / 2;
    disc.castShadow = false;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: hot(EXHAUST[skin].glow, 2.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    sp.position.set(x - r * 0.9, y, z);
    sp.scale.setScalar(r * 5);
    sp.userData.base = r * 5;
    sp.raycast = () => {}; // not part of the clickable ship
    body.add(sp);
    engines.push(sp);
  };
  /** Lathe a profile (radius, along-ship) into a body of revolution pointing +X. */
  const lathe = (pts: [number, number][], seg = 16) => {
    const g = new THREE.LatheGeometry(pts.map(([r, a]) => new THREE.Vector2(r, a)), seg);
    g.rotateZ(-Math.PI / 2);
    return g;
  };
  /** A flat plate in the X-Z plane from an (x, z) outline, `t` thick. */
  const plate = (pts: [number, number][], t: number) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z))),
      { depth: t, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 1 });
    g.translate(0, 0, -t / 2);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const cyl = (r: number, len: number, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);

  const tpl = shipTemplate(typeId);
  if (tpl) {
    // Imported model (see shipAsset.ts), skinned per team.
    body.add(tpl.build(skin, color));
    for (const e of tpl.engines) engine(e.x, e.y, e.z, e.r);
  } else if (typeId === 'kestrel' || typeId === 'anvil' || typeId === 'javelin' || typeId === 'wayfarer') {
    // Sleek strike fighter: needle fuselage, swept wings with tip cannons, twin engines.
    add(lathe([[0.01, -16], [3.2, -15], [4.2, -10], [4, 2], [2.8, 10], [1.2, 16], [0.01, 19]]), hull);
    const canopy = add(new THREE.SphereGeometry(2.6, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass, 4, 2.4, 0);
    canopy.scale.set(2.3, 1, 0.9);
    add(new THREE.BoxGeometry(16, 0.6, 1.2), trim, 2, 3.4, 0); // spine stripe
    for (const s of [1, -1]) {
      add(plate([[2, 3 * s], [-10, 3 * s], [-13, 17 * s], [-7, 17 * s]], 0.9), hull);
      add(plate([[-4, 6 * s], [-9, 6 * s], [-11.2, 14 * s], [-8.2, 14 * s]], 1.1), trim);
      add(cyl(0.7, 18), dark, -3, 0, 17.2 * s);
      add(cyl(0.35, 4), light, 7.5, 0, 17.2 * s);
      add(cyl(2.1, 9), dark, -11, 0, 4.6 * s);
      engine(-15.6, 0, 4.6 * s, 1.9);
    }
  } else if (typeId === 'wasp') {
    // Agile interceptor: ball cockpit, a cross-pylon and two upright hex wing panels.
    add(new THREE.SphereGeometry(6, 24, 16), hull);
    const ring = add(new THREE.TorusGeometry(3.4, 0.7, 8, 24), dark, 5, 0.4, 0);
    ring.rotation.y = Math.PI / 2;
    const win = add(new THREE.CircleGeometry(3.1, 24), glass, 5.25, 0.4, 0);
    win.rotation.y = Math.PI / 2;
    add(new THREE.CylinderGeometry(1.3, 1.3, 24, 10).rotateX(Math.PI / 2), dark);
    for (const s of [1, -1]) {
      add(new THREE.CylinderGeometry(2.4, 2.4, 2.2, 6).rotateX(Math.PI / 2), trim, 0, 0, 6.6 * s);
      const hex = (r: number) => Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        return new THREE.Vector2(Math.cos(a) * r * 0.75, Math.sin(a) * r);
      });
      const panel = new THREE.ExtrudeGeometry(new THREE.Shape(hex(12)), { depth: 0.6, bevelEnabled: false });
      panel.translate(0, 0, -0.3);
      add(panel, dark, -1, 0, 12.2 * s);
      const frameShape = new THREE.Shape(hex(13));
      frameShape.holes.push(new THREE.Path(hex(11.6)));
      const frame = new THREE.ExtrudeGeometry(frameShape, { depth: 1.4, bevelEnabled: false });
      frame.translate(0, 0, -0.7);
      add(frame, trim, -1, 0, 12.2 * s);
      add(new THREE.BoxGeometry(1, 20, 1.2), hull, -1, 0, 12.2 * s); // panel spar
      engine(-5.8, 0, 2.2 * s, 1.3);
    }
  } else {
    // Heavy gunship: armoured wedge hull, raised bridge, side engine nacelles, front and rear turrets.
    const top = new THREE.Shape([[28, 0], [16, 9], [-18, 11], [-23, 8], [-23, -8], [-18, -11], [16, -9]].map(([x, z]) => new THREE.Vector2(x, z)));
    const hullGeo = new THREE.ExtrudeGeometry(top, { depth: 7, bevelEnabled: true, bevelThickness: 1.5, bevelSize: 1.5, bevelSegments: 2 });
    hullGeo.translate(0, 0, -3.5);
    hullGeo.rotateX(Math.PI / 2);
    add(hullGeo, hull);
    add(new THREE.BoxGeometry(30, 1.2, 4), dark, -2, 5.3, 0); // dorsal plating
    add(new THREE.BoxGeometry(16, 6.5, 11), trim, -4, 7, 0);
    add(new THREE.BoxGeometry(1.2, 2.2, 9), glass, 4.2, 8, 0);
    for (const s of [1, -1]) {
      add(cyl(3.6, 24, 16), dark, -9, -0.5, 14 * s);
      add(new THREE.BoxGeometry(10, 2, 4), hull, -6, -0.5, 11 * s);
      add(new THREE.BoxGeometry(18, 0.6, 0.6), light, -9, 3.2, 14 * s);
      engine(-21.4, -0.5, 14 * s, 3);
      engine(-24.4, 0, 5 * s, 2);
    }
    const turret = (x: number, dir: 1 | -1) => {
      add(new THREE.CylinderGeometry(3.6, 4.2, 2.6, 14), dark, x, 5.4, 0);
      add(new THREE.SphereGeometry(3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), hull, x, 6.6, 0);
      for (const z of [1.3, -1.3]) add(cyl(0.55, 10), dark, x + dir * 6, 7.6, z);
    };
    turret(14, 1);
    turret(-15, -1);
  }
  return { model, body, engines };
}

/** Square base plate with arc lines and a nose notch, in the owner's colour. */
/**
 * What sits on the table under a ship. The base itself is not drawn (it distracted from the ships): it
 * stays as an invisible hit area so ships are easy to click or tap, plus a soft pool of light in the team
 * colour that marks where the ship is and whose it is. The rules measure from the base footprint either way.
 */
export function buildBase(size: number, color: number, _arcs: string[] = []): THREE.Group {
  const g = new THREE.Group();
  // Invisible, but still picked by the raycaster: the whole footprint is a click/tap target.
  const hit = new THREE.Mesh(new THREE.BoxGeometry(size, 2, size), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  hit.position.y = 1;
  g.add(hit);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(size * 2.2, size * 2.2), new THREE.MeshBasicMaterial({
    map: glowTexture(), color: new THREE.Color(color).multiplyScalar(0.35), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.3;
  pool.raycast = () => {};
  g.add(pool);
  return g;
}

// ---------------- asteroids ----------------
/** Distance from `c` to the polygon edge along direction `a` (polygon in x/z, star-shaped around c). */
function radiusAt(poly: { x: number; z: number }[], c: { x: number; z: number }, a: number) {
  const dx = Math.cos(a), dz = Math.sin(a);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ez = q.z - p.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p.x - c.x) * ez - (p.z - c.z) * ex) / den;
    const u = ((p.x - c.x) * dz - (p.z - c.z) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * A lumpy rock whose footprint fills (but never exceeds) the obstacle polygon, so what you see is
 * what you collide with. `poly` is in world x/z.
 */
export function buildAsteroid(poly: { x: number; z: number }[], seed: number): THREE.Group {
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, z: a.z + p.z / poly.length }), { x: 0, z: 0 });
  const avgR = poly.reduce((a, p) => a + Math.hypot(p.x - c.x, p.z - c.z), 0) / poly.length;
  const height = THREE.MathUtils.clamp(avgR * 0.7, 18, 55);
  const geo = new THREE.IcosahedronGeometry(1, 4);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const base = new THREE.Color(0x544a42), dark = new THREE.Color(0x221d1a), light = new THREE.Color(0x8c7a68);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * 1.7 + seed, v.y * 1.7, v.z * 1.7 - seed, 5);
    const crater = Math.max(0, vnoise(v.x * 4 + seed, v.y * 4, v.z * 4) - 0.72) * 1.6;
    const bump = 0.78 + n * 0.32 - crater;
    const a = Math.atan2(v.z, v.x);
    const R = radiusAt(poly, c, a) * 0.97;
    const horiz = Math.min(1, bump) * R;
    let y = v.y * height * (0.7 + n * 0.5);
    if (y < 0) y *= 0.25; // flatter underside
    const rr = Math.hypot(v.x, v.z);
    pos.setXYZ(i, c.x + (rr ? (v.x / rr) * horiz * rr : 0), y + 4, c.z + (rr ? (v.z / rr) * horiz * rr : 0));
    tmp.copy(base).lerp(n > 0.55 ? light : dark, Math.min(1, Math.abs(n - 0.5) * 2.4)).lerp(dark, Math.min(1, crater * 2.5));
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.05, flatShading: true }));
  rock.castShadow = rock.receiveShadow = true;
  const g = new THREE.Group();
  g.add(rock);
  // faint hazard outline of the true footprint
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(poly.map((p) => new THREE.Vector3(p.x, 0.5, p.z))),
    new THREE.LineBasicMaterial({ color: 0xd08a4a, transparent: true, opacity: 0.45 }),
  );
  g.add(outline);
  return g;
}

// ---------------- table surface ----------------
/** Bake a starfield-and-nebula play mat with a faint range grid into a texture (GPU, once). */
export function bakeBoardTexture(renderer: THREE.WebGLRenderer, divisions: number, res = 2048): THREE.Texture {
  const rt = new THREE.WebGLRenderTarget(res, res, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uDiv: { value: divisions } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uDiv;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vUv * 3.0;
        float n1 = fbm(vec3(p, 1.3));
        float n2 = fbm(vec3(p * 1.7 + 4.0, 7.1));
        float wisp = smoothstep(0.45, 0.85, fbm(vec3(p * 0.8 + n1 * 1.5, 3.3)));
        vec3 col = vec3(0.006, 0.010, 0.022);
        col += vec3(0.010, 0.028, 0.060) * smoothstep(0.35, 0.8, n1);
        col += vec3(0.040, 0.012, 0.050) * smoothstep(0.5, 0.9, n2) * 0.8;
        col += vec3(0.020, 0.050, 0.065) * wisp;
        // stars
        vec2 sp = vUv * 420.0; vec2 si = floor(sp), sf = fract(sp) - 0.5;
        float r = h31(vec3(si, 2.0));
        if (r > 0.985) { float b = (r - 0.985) / 0.015; col += vec3(0.5, 0.6, 0.8) * b * smoothstep(0.35, 0.0, length(sf)); }
        // range grid with brighter crosses at intersections
        vec2 g = vUv * uDiv; vec2 gd = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        float line = 1.0 - min(min(gd.x, gd.y), 1.0);
        vec2 gc = abs(fract(g + 0.5) - 0.5);
        float cross = step(max(gc.x, gc.y), 0.04) * (1.0 - min(min(gd.x, gd.y), 1.0));
        col += vec3(0.020, 0.040, 0.080) * line + vec3(0.06, 0.10, 0.16) * cross;
        // vignette toward the table edge
        vec2 e = abs(vUv - 0.5) * 2.0;
        col *= 1.0 - 0.35 * smoothstep(0.7, 1.0, max(e.x, e.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(quad, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  rt.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return rt.texture;
}

// ---------------- sky ----------------
/** Big inside-out nebula sphere plus layered, tinted stars and a distant ringed planet. */
export function buildSky(): THREE.Group {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3400, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float n = fbm(d * 2.2 + 3.0);
        float m = fbm(d * 4.0 + n * 1.8);
        float band = exp(-pow((d.y - 0.15 + (n - 0.5) * 0.6) * 2.4, 2.0));
        vec3 col = vec3(0.003, 0.005, 0.012);
        col += vec3(0.05, 0.10, 0.22) * smoothstep(0.35, 0.9, m) * band;
        col += vec3(0.22, 0.06, 0.18) * smoothstep(0.55, 0.95, fbm(d * 3.0 + 11.0)) * band * 0.7;
        col += vec3(0.30, 0.14, 0.05) * smoothstep(0.7, 1.0, m) * band * 0.5;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  dome.renderOrder = -10;
  g.add(dome);

  const layer = (n: number, size: number, bright: number) => {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const tints = [new THREE.Color(0xffffff), new THREE.Color(0xbcd4ff), new THREE.Color(0xffe2bc), new THREE.Color(0x9fc0ff)];
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(3000);
      pos.set([v.x, v.y, v.z], i * 3);
      const c = tints[i % tints.length].clone().multiplyScalar(bright * (0.4 + Math.random() * 0.6));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size, sizeAttenuation: false, vertexColors: true, depthWrite: false, map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending,
    })));
  };
  layer(3500, 2.4, 1.0);
  layer(700, 3.6, 1.3);
  layer(80, 6, 2.5); // a few bright ones that catch the bloom

  // distant planet with an atmosphere rim and a thin ring
  const planet = new THREE.Group();
  const surf = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 32), new THREE.MeshStandardMaterial({ color: 0x2c4a6e, roughness: 0.9 }));
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(316, 48, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main() { vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying vec3 vN; varying vec3 vV; void main() { float f = pow(clamp(1.0 - abs(dot(vN, vV)), 0.0, 1.0), 3.0); gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * f * 1.6, 1.0); }',
  }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(400, 560, 96), new THREE.MeshBasicMaterial({
    color: 0x8aa2c4, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
  }));
  ring.rotation.x = -Math.PI / 2 + 0.35;
  planet.add(surf, atmo, ring);
  planet.position.set(-2100, 150, -2600);
  g.add(planet);
  return g;
}

// ---------------- firing arcs ----------------
/** Shared clock for the arc sweep pulse; BattleScene advances it every frame. */
export const arcTime = { value: 0 };
/** Reach of a primary weapon (the far edge of the last range band), measured from the base edge. */
const ARC_RANGE = RANGE_RULES.edges[RANGE_RULES.edges.length - 1];
/** Keep arcs on the table (needs renderer.localClippingEnabled). */
const BOARD_CLIP = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), BOARD_SIZE / 2), new THREE.Plane(new THREE.Vector3(-1, 0, 0), BOARD_SIZE / 2),
  new THREE.Plane(new THREE.Vector3(0, 0, 1), BOARD_SIZE / 2), new THREE.Plane(new THREE.Vector3(0, 0, -1), BOARD_SIZE / 2),
];

/**
 * Outline of a front arc out to range `r`, in local board coords (x forward, y left): a 90° wedge
 * through the base's front corners, with the far edge rounded around those corners (distance is
 * measured from the base, not its centre). With `closed`, it returns along the base's front edge.
 */
function arcOutline(size: number, r: number, closed: boolean): THREE.Vector2[] {
  const s = size / 2, pts: THREE.Vector2[] = [];
  const around = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= 12; i++) {
      const a = a0 + ((a1 - a0) * i) / 12;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };
  if (closed) pts.push(new THREE.Vector2(s, -s));
  around(s, -s, -Math.PI / 4, 0); // right corner: from the diagonal round to straight ahead
  around(s, s, 0, Math.PI / 4); // left corner: straight ahead round to the diagonal
  if (closed) pts.push(new THREE.Vector2(s, s));
  return pts;
}

/**
 * Translucent fans showing a ship's firing arcs (any of front/left/rear/right) out to `range` (default: the last range band), with faint lines at each band's edge and a
 * sweep pulse. Board-local (x forward, y left) maps to three's (x, -z). Not clickable.
 */
const arcCache = new Map<string, THREE.Group>();
export function buildArcs(size: number, arcs: string[], color: number, range = ARC_RANGE): THREE.Group {
  // Ghost previews rebuild on every pointer move: share geometry and materials, hand out cheap clones.
  const key = `${size}|${arcs.join(',')}|${color}|${range}`;
  let tpl = arcCache.get(key);
  if (!tpl) { tpl = makeArcs(size, arcs, color, range); arcCache.set(key, tpl); }
  const g = tpl.clone(true);
  g.traverse((o) => { o.raycast = () => {}; });
  return g;
}

function makeArcs(size: number, arcs: string[], color: number, range: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, clipping: true, clippingPlanes: BOARD_CLIP,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: arcTime, uHalf: { value: size / 2 }, uRange: { value: range } },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec2 vP;
      void main() {
        vP = position.xz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor; uniform float uTime, uHalf, uRange; varying vec2 vP;
      void main() {
        #include <clipping_planes_fragment>
        // distance from the base's front edge (approx.), 0..1 across the fan's reach
        float d = clamp((abs(vP.x) - uHalf) / uRange, 0.0, 1.0);
        float a = mix(0.26, 0.06, d);
        float sweep = fract(uTime * 0.35);
        a += 0.16 * smoothstep(0.08, 0.0, abs(d - sweep)) * (1.0 - d);
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, clippingPlanes: BOARD_CLIP });
  const band = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, clippingPlanes: BOARD_CLIP });
  const to3 = (p: THREE.Vector2) => new THREE.Vector3(p.x, 0, -p.y);
  for (const arc of arcs) {
    const a = new THREE.Group();
    const fan = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(arcOutline(size, range, true)), 4).rotateX(Math.PI / 2), mat);
    fan.scale.z = -1; // rotateX(+90°) sends shape y to +z; board-left is three's -z
    a.add(fan);
    a.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(arcOutline(size, range, true).map(to3)), edge));
    for (const r of RANGE_RULES.edges.filter((e) => e < range)) { // a faint line at each range band's edge
      a.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcOutline(size, r, false).map(to3)), band));
    }
    a.rotation.y = ({ front: 0, left: Math.PI / 2, rear: Math.PI, right: -Math.PI / 2 } as Record<string, number>)[arc] ?? 0;
    g.add(a);
  }
  g.position.y = 0.8;
  g.traverse((o) => { o.raycast = () => {}; o.renderOrder = 1; });
  return g;
}

/** Turret-arc pointer for a ship's base: a small chevron at the base edge, pointing out of the arc. */
export function buildTurretPointer(size: number): THREE.Mesh {
  const s = size / 2;
  const shape = new THREE.Shape([new THREE.Vector2(s - 9, -5), new THREE.Vector2(s - 1, 0), new THREE.Vector2(s - 9, 5), new THREE.Vector2(s - 6, 0)]);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: hot(0xffd166, 1.4), side: THREE.DoubleSide }));
  m.scale.z = -1;
  m.position.y = 2.6;
  m.raycast = () => {};
  return m;
}
