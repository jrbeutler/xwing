// Three.js presentation layer. Knows nothing about rules; it only draws poses from the engine.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadShipModels } from './shipAsset';
import { arcTime, bakeBoardTexture, buildArcs, buildTurretPointer, buildAsteroid, buildDebris, buildGasCloud, buildBase, buildShip, buildSky, glowTexture, hot } from './visuals';
import { BASE_SIZE, BOARD_SIZE, DAMAGE_CARDS, SHIP_TYPES, UPGRADES, type Obstacle, type Pose, type ShotLook, type ShipState, RANGE_RULES } from '@xw/engine';

const HALF = BOARD_SIZE / 2;
const FLY_HEIGHT = 18;
/** Effect colours that mean the same thing whoever fires: ion is electric blue, jamming violet. */
const ION = 0x7fd8ff, JAM = 0xc58bff;
/** Flight time of one shot, and the gap between shots in a volley, per kind of weapon (ms at 1×). */
/** Camera angles for an attack: the gunner's view over the attacker's shoulder, or one of the cinematic ones. */
export type AttackAngle = 'gunner' | 'reverse' | 'side' | 'low';
export const SHOT_TIMING: Record<ShotLook, { flight: number; gap: number }> = {
  laser: { flight: 170, gap: 110 }, ion: { flight: 300, gap: 170 }, rockets: { flight: 330, gap: 75 },
  missile: { flight: 640, gap: 240 }, torpedo: { flight: 820, gap: 320 },
};

const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const UP = new THREE.Vector3(0, 1, 0);
/**
 * A jagged electric arc thick enough to read on any screen (WebGL lines are one pixel wide): a run of
 * short tubes, each a hot core inside a coloured glow. `set` moves it to new points; the shared tube
 * geometry is never disposed.
 */
class ArcRibbon extends THREE.Group {
  private coreMat: THREE.MeshBasicMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private segs: { c: THREE.Mesh; g: THREE.Mesh }[] = [];
  constructor(points: number, core: THREE.ColorRepresentation, glow: THREE.ColorRepresentation, private coreR: number, private glowR: number) {
    super();
    const mat = (color: THREE.ColorRepresentation) => new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.coreMat = mat(core);
    this.glowMat = mat(glow);
    for (let k = 0; k < points - 1; k++) {
      const c = new THREE.Mesh(UNIT_TUBE, this.coreMat), g = new THREE.Mesh(UNIT_TUBE, this.glowMat);
      c.frustumCulled = g.frustumCulled = false;
      this.add(g, c);
      this.segs.push({ c, g });
    }
    this.opacity = 0;
  }
  set(pts: THREE.Vector3[]) {
    const d = new THREE.Vector3();
    this.segs.forEach(({ c, g }, k) => {
      const a = pts[k], b = pts[k + 1];
      d.subVectors(b, a);
      const len = d.length();
      c.visible = g.visible = len > 0.01;
      if (!c.visible) return;
      d.divideScalar(len);
      for (const [m, r] of [[c, this.coreR], [g, this.glowR]] as const) {
        m.position.lerpVectors(a, b, 0.5);
        m.quaternion.setFromUnitVectors(UP, d);
        m.scale.set(r, len + r, r); // overlap a little so the bends have no gaps
      }
    });
  }
  set opacity(o: number) { this.coreMat.opacity = o; this.glowMat.opacity = o * 0.4; }
  get opacity() { return this.coreMat.opacity; }
  dispose() { this.removeFromParent(); this.coreMat.dispose(); this.glowMat.dispose(); }
}
/** Points along a jagged path from `a` to `b`: kinks up to `amp` off the straight line, ends fixed. */
function jagged(a: THREE.Vector3, b: THREE.Vector3, n: number, amp: number, reach = 1) {
  return Array.from({ length: n }, (_, k) => {
    const f = (k / (n - 1)) * reach;
    const p = new THREE.Vector3().lerpVectors(a, b, f);
    if (k > 0 && k < n - 1) p.add(new THREE.Vector3().randomDirection().multiplyScalar(amp * (0.4 + Math.random() * 0.6) * Math.sin(Math.min(1, f) * Math.PI)));
    return p;
  });
}
const TURRET_COLOR = 0xffd166;
/** The part of a ship model tagged as its turret gun (imported models only). */
const findGun = (model: THREE.Object3D) => {
  let gun: THREE.Object3D | undefined;
  model.traverse((o) => { if (!gun && o.userData.turretGun) gun = o; });
  return gun;
};
/** Turret facing → rotation about the ship's up axis (left is +90°: three's -z is the board's +y). */
const TURRET_ANGLE: Record<string, number> = { front: 0, left: Math.PI / 2, rear: Math.PI, right: -Math.PI / 2 };
export const COLORS: Record<string, number> = { p1: 0x57c7ff, p2: 0xff9f43 };
/** Ship models are drawn this much bigger than their bases (true to scale would be 1). Big enough to read,
 *  small enough that ships at range 1 don't visually run into each other. */
export const MODEL_SCALE = 1.3;
const skinOf = (owner: string): 'blue' | 'red' => (owner === 'p1' ? 'blue' : 'red');

/** Board (x, y) in mm → three.js world. */
export const toV3 = (x: number, y: number, z = 0) => new THREE.Vector3(x - HALF, z, -(y - HALF));

export function placeObject(o: THREE.Object3D, p: Pose) {
  o.position.copy(toV3(p.x, p.y, o.position.y));
  o.rotation.y = p.h;
}

/** Empty a group, removing any HTML labels inside it (three only cleans up direct CSS2D children). */
function clearGroup(g: THREE.Group) {
  g.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
  g.clear();
}

/** One button in a ship's radial menu. */
export interface RadialItem {
  icon: string;
  label: string;
  /** Short description: the accessible name and the help popup's heading (defaults to the label). */
  title?: string;
  /** What the button does, in a sentence or two (HTML): shown in a popup on hover, or when a finger holds the button. */
  help?: string;
  badge?: string | number;
  active?: boolean;
  disabled?: boolean;
  cls?: string;
  onClick: () => void;
  /** Pointer over / off the button (e.g. to preview a turret facing). */
  onHover?: (on: boolean) => void;
  /** Fixed position on the ring, in degrees clockwise from screen-up (otherwise spread over the lower arc). */
  angle?: number;
}

/** `reach` is the ship's horizontal radius (base corner or model tip) and `top` its highest point, both local. */
export interface ShipView {
  /** Last measured label size (px), for decluttering. */
  labelSize?: { w: number; h: number };
  root: THREE.Group; model: THREE.Group; label: CSS2DObject; ring: THREE.Mesh; reach: number; top: number;
  /** Idle-animated inner group, engine glow sprites, and current thrust (1 idle, higher while flying). */
  body: THREE.Group; engines: THREE.Sprite[]; thrust: number; phase: number; typeId: string; owner: string;
  /** Firing-arc fans (hidden unless shown with showArcs). */
  arcs: THREE.Group;
  /** Ships with a turret: its arc fan (shown with the arcs) and a pointer on the base, turned to face `turretArc`. */
  turret?: { holder: THREE.Group; fan: THREE.Group; facing: string; gun?: THREE.Object3D };
  /** Flickering blue aura while the ship has ion tokens. */
  ionAura?: THREE.Group;
}

export class BattleScene {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  labels = new CSS2DRenderer();
  scene = new THREE.Scene();
  // Near plane well off 1: depth precision near the board matters more than seeing things 1 mm away.
  camera = new THREE.PerspectiveCamera(45, 1, 10, 6000);
  controls: OrbitControls;
  ships = new Map<string, ShipView>();
  ghost = new THREE.Group();
  overlay = new THREE.Group();
  planned = new THREE.Group();
  markers = new THREE.Group();
  chips = new THREE.Group();
  private obstacleGroup = new THREE.Group();

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private sky = buildSky();
  private flashes: THREE.PointLight[] = [];
  private clock = new THREE.Clock();

  constructor(private host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true; // firing arcs are clipped to the table
    this.renderer.toneMapping = THREE.NeutralToneMapping; // keeps UI colours true, only rolls off highlights
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    // HDR render → bloom → tone map. Multisampled so edges stay smooth without the default canvas AA.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Clamp HDR and drop NaN/Inf before bloom: one bad pixel otherwise smears into black blocks
    // as the bloom pass downsamples it.
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          // Comparisons with NaN are false, so a NaN channel fails this test; +Inf just clamps to bright.
          bool nan = !(c.r >= -1.0 && c.g >= -1.0 && c.b >= -1.0);
          gl_FragColor = vec4(nan ? vec3(0.0) : clamp(c.rgb, 0.0, 32.0), 1.0);
        }`,
    }));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.45, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
    this.labels.domElement.style.position = 'absolute';
    this.labels.domElement.style.inset = '0';
    this.labels.domElement.style.pointerEvents = 'none';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x03050a);
    this.camera.position.set(0, 1080, 640);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 60);
    this.controls.enableDamping = true;
    // Touch: one finger is reserved for playing (steering, tapping; the game pans with it on empty board,
    // see panBy); two fingers pinch-zoom and pan.
    this.controls.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
    // The player moving the camera themselves (any OrbitControls gesture) is reported, so the game stops
    // re-framing the view under them until they ask it to.
    this.controls.addEventListener('start', () => { this.camTween++; this.onUserCamera?.(); });
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 200;
    this.controls.maxDistance = 2200;

    this.scene.add(new THREE.HemisphereLight(0x9bb7ff, 0x0b0b18, 0.7));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-400, 900, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 1.5; // no shadow acne stripes on the flat board
    sun.shadow.radius = 3;
    Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, far: 2500 });
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6f8cff, 0.9); // cool back light to pick out silhouettes
    rim.position.set(500, 300, -700);
    this.scene.add(rim);
    // Pooled flash lights for shots and explosions (a fixed light count avoids shader recompiles).
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 320, 1.2);
      this.flashes.push(l);
      this.scene.add(l);
    }

    this.buildBoard();
    void loadShipModels(this.renderer).then(() => this.reskinShips());
    this.scene.add(this.sky, this.obstacleGroup, this.ghost, this.overlay, this.planned, this.markers, this.chips);

    addEventListener('resize', () => this.resize());
    this.resize();
    const loop = () => {
      const dt = Math.min(0.05, this.clock.getDelta());
      this.controls.update();
      this.animateIdle(this.clock.elapsedTime, dt);
      this.placeLabels();
      this.composer.render();
      this.labels.render(this.scene, this.camera);
      // The label renderer stacks everything by distance; the action ring and move buttons must sit above
      // the ships' name plates, or a nearby plate covers a button.
      for (const c of this.chips.children) (c as CSS2DObject).element.style.zIndex = '1000000';
      requestAnimationFrame(loop);
    };
    loop();
  }

  private tipEl: HTMLDivElement | null = null;
  private tipTimer = 0;
  /** A small popup over `anchor` explaining it (`help` is HTML). */
  showTip(anchor: HTMLElement, title: string, help?: string) {
    if (!help) return;
    clearTimeout(this.tipTimer);
    if (!this.tipEl) {
      this.tipEl = document.createElement('div');
      this.tipEl.id = 'radtip';
      this.tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(this.tipEl);
    }
    const t = this.tipEl;
    t.innerHTML = `<b>${title}</b><div>${help}</div>`;
    t.hidden = false;
    // Above the button if there is room, else below; kept on screen.
    const r = anchor.getBoundingClientRect(), w = Math.min(280, innerWidth - 24);
    t.style.width = `${w}px`;
    const left = Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
    t.style.left = `${left}px`;
    const h = t.offsetHeight;
    t.style.top = `${r.top - h - 10 >= 8 ? r.top - h - 10 : Math.min(innerHeight - h - 8, r.bottom + 10)}px`;
  }
  /** Hide the help popup (after `delay` ms). */
  hideTip(delay = 0) {
    clearTimeout(this.tipTimer);
    const go = () => { if (this.tipEl) this.tipEl.hidden = true; };
    if (delay) this.tipTimer = window.setTimeout(go, delay); else go();
  }

  /** Called when the player moves the camera themselves (pinch, drag, or panBy). */
  onUserCamera: (() => void) | null = null;

  /**
   * Slide the camera across the table by a finger movement of (dx, dy) screen pixels, as if dragging the
   * table: what was under the finger stays under it. Keeps the view over the board.
   */
  panBy(dx: number, dy: number) {
    this.camTween++; // stop any camera glide in progress
    const cam = this.camera, target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    const perPx = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, this.renderer.domElement.clientHeight);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0).setY(0).normalize();
    const ahead = new THREE.Vector3().subVectors(target, cam.position).setY(0).normalize();
    // Looking down at an angle, a pixel of screen height covers more table than a pixel of width.
    const tilt = Math.max(0.35, Math.abs(new THREE.Vector3().subVectors(target, cam.position).normalize().y));
    const move = right.multiplyScalar(-dx * perPx).add(ahead.multiplyScalar((dy * perPx) / tilt));
    const lim = HALF + 120;
    const clamped = new THREE.Vector3(
      THREE.MathUtils.clamp(target.x + move.x, -lim, lim) - target.x, 0, THREE.MathUtils.clamp(target.z + move.z, -lim, lim) - target.z);
    target.add(clamped);
    cam.position.add(clamped);
    this.onUserCamera?.();
  }

  /** Fit the renderer to its container (call after the screen changes shape, e.g. a phone rotating). */
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Hover bob, engine flicker and the slowly turning sky. */
  private animateIdle(t: number, dt: number) {
    this.sky.rotation.y += dt * 0.004;
    // Device tokens blink.
    const blink = 0.35 + 0.65 * Math.max(0, Math.sin(t * 5));
    this.deviceGroup.traverse((o) => { if (o.userData.blink) ((o as THREE.Sprite).material as THREE.SpriteMaterial).opacity = blink; });
    if (!this.reducedMotion) arcTime.value = t;
    for (const v of this.ships.values()) {
      if (!this.reducedMotion) {
        v.body.position.y = Math.sin(t * 1.3 + v.phase) * 1.2;
        v.body.rotation.x = Math.sin(t * 0.9 + v.phase) * 0.035;
      }
      v.engines.forEach((e, i) => {
        const f = 0.88 + 0.08 * Math.sin(t * 31 + i * 1.7 + v.phase) + Math.random() * 0.08;
        e.scale.setScalar(e.userData.base * f * v.thrust);
      });
      this.animateIonAura(v, t);
    }
  }

  private buildBoard() {
    const map = bakeBoardTexture(this.renderer, 9);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_SIZE, BOARD_SIZE),
      new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0.1, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.6 }));
    board.rotation.x = -Math.PI / 2;
    board.receiveShadow = true;
    this.scene.add(board);
    // table slab and a raised, lit frame around the play area
    const slab = new THREE.Mesh(new THREE.BoxGeometry(BOARD_SIZE + 40, 14, BOARD_SIZE + 40),
      new THREE.MeshStandardMaterial({ color: 0x0b111d, metalness: 0.6, roughness: 0.5 }));
    // Top 3 mm under the board: much closer and phones' depth buffers can't separate them (the slab shows
    // through the board in black stripes).
    slab.position.y = -10;
    slab.receiveShadow = true;
    this.scene.add(slab);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a2436, metalness: 0.8, roughness: 0.3 });
    const w = BOARD_SIZE + 40;
    for (const [x, z, sx, sz] of [[0, HALF + 10, w, 20], [0, -HALF - 10, w, 20], [HALF + 10, 0, 20, BOARD_SIZE], [-HALF - 10, 0, 20, BOARD_SIZE]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, 4, sz), frameMat);
      bar.position.set(x, 1.5, z);
      bar.receiveShadow = true;
      this.scene.add(bar);
    }
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BOARD_SIZE, 0.1, BOARD_SIZE)),
      new THREE.LineBasicMaterial({ color: hot(0x3f6fc4, 1.8) }),
    );
    edge.position.y = 0.4;
    this.scene.add(edge);
  }

  setObstacles(obstacles: Obstacle[]) {
    this.obstacleGroup.clear();
    obstacles.forEach((o, i) => {
      const poly = o.polygon.map((p) => { const v = toV3(p.x, p.y); return { x: v.x, z: v.z }; });
      const seed = i * 7.31 + 1.7;
      this.obstacleGroup.add(o.kind === 'debris' ? buildDebris(poly, seed) : o.kind === 'gas' ? buildGasCloud(poly, seed) : buildAsteroid(poly, seed));
    });
  }

  syncShips(ships: ShipState[]) {
    for (const s of ships) {
      let v = this.ships.get(s.id);
      if (s.removed || s.destroyed) {
        if (v) { this.scene.remove(v.root); v.label.element.remove(); this.ships.delete(s.id); }
        continue;
      }
      if (!v) v = this.createShip(s);
      placeObject(v.root, s.pose);
      if (v.turret && v.turret.facing !== s.turretArc) this.setTurret(s.id, s.turretArc, 0);
      this.updateLabel(v, s);
    }
  }

  private createShip(s: ShipState): ShipView {
    const t = SHIP_TYPES[s.typeId];
    const size = BASE_SIZE[t.size];
    const color = COLORS[s.owner] ?? 0xffffff;
    const root = new THREE.Group();
    root.add(buildBase(size, color, t.primaries.map((p) => p.arc)));
    const { model, body, engines } = buildShip(s.typeId, color, skinOf(s.owner));
    model.position.y = FLY_HEIGHT + 4;
    model.scale.setScalar(MODEL_SCALE); // models are enlarged for readability; bases stay true to scale
    root.add(model);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(size * 0.78, size * 0.86, 40),
      new THREE.MeshBasicMaterial({ color: 0x7cf0c5, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.5;
    ring.visible = false;
    root.add(ring);
    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = '<div class="info"></div><div class="odds" hidden></div>';
    const label = new CSS2DObject(el);
    label.center.set(0.5, 1); // anchor the label's bottom edge; placeLabels() puts that point just past the ship
    root.add(label);
    const box = new THREE.Box3().setFromObject(root);
    const reach = Math.max(Math.hypot(Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z)), size * Math.SQRT1_2);
    const arcs = buildArcs(size, t.primaries.map((p) => p.arc).filter((a) => a !== 'turret'), color); // added after measuring reach
    arcs.visible = false;
    root.add(arcs);
    // Turret: a yellow fan (range 2) and pointer that turn together to the turret's facing.
    let turret: ShipView['turret'];
    const turretPrimary = t.primaries.some((p) => p.arc === 'turret');
    if (turretPrimary || s.upgrades.some((u) => UPGRADES[u.id].weapon?.arc === 'turret')) {
      const holder = new THREE.Group();
      // A turret primary reaches as far as any primary; a turret upgrade to the edge of its own last band.
      const turretWeapon = s.upgrades.map((u) => UPGRADES[u.id].weapon).find((w) => w?.arc === 'turret');
      const reach = RANGE_RULES.edges[(turretPrimary ? RANGE_RULES.edges.length : turretWeapon?.maxRange ?? 2) - 1];
      const fan = buildArcs(size, ['front'], TURRET_COLOR, reach);
      fan.visible = false;
      holder.add(fan, buildTurretPointer(size));
      holder.rotation.y = TURRET_ANGLE[s.turretArc];
      root.add(holder);
      turret = { holder, fan, facing: s.turretArc, gun: findGun(model) };
    }
    this.scene.add(root);
    const v: ShipView = {
      root, model, label, ring, reach, top: box.max.y, body, engines, thrust: 1, phase: Math.random() * 6.28, typeId: s.typeId, owner: s.owner, arcs,
      turret,
    };
    this.ships.set(s.id, v);
    return v;
  }

  /** Swap in the textured model for ships created before it finished loading. */
  private reskinShips() {
    for (const v of this.ships.values()) {
      const next = buildShip(v.typeId, COLORS[v.owner] ?? 0xffffff, skinOf(v.owner));
      v.model.remove(v.body);
      next.model.remove(next.body);
      v.model.add(next.body);
      v.body = next.body;
      v.engines = next.engines;
      if (v.turret) {
        v.turret.gun = findGun(v.model);
        if (v.turret.gun) v.turret.gun.rotation.y = v.turret.holder.rotation.y;
      }
    }
  }

  private readonly tmpUp = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();

  /**
   * Keep each ship's label off the ship: anchor it just beyond the ship's edge in the direction that is
   * "up" on screen, so it sits above the model whether the camera is overhead, tilted, or orbited.
   */
  private placeLabels() {
    const up = this.tmpUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    up.y = 0;
    const flat = up.lengthSq() > 1e-6; // false only when looking exactly horizontally
    if (flat) up.normalize();
    for (const v of this.ships.values()) {
      const p = this.tmpPos.copy(v.root.position);
      if (flat) p.addScaledVector(up, v.reach + 4);
      p.y = v.top + 4;
      v.root.updateMatrixWorld();
      v.label.position.copy(v.root.worldToLocal(p));
    }
    this.declutterLabels();
  }

  private labelFrame = 0;
  /**
   * Keep ship labels from stacking on top of each other when ships are close: working up from the
   * bottom of the screen, a label that would overlap one already placed moves up a step at a time
   * (by changing its anchor, so it still points at its ship). Sizes are re-measured every few frames.
   */
  private declutterLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const measure = this.labelFrame++ % 15 === 0;
    const items: { v: ShipView; x: number; y: number; lw: number; lh: number }[] = [];
    const p = new THREE.Vector3();
    for (const v of this.ships.values()) {
      if (!v.label.visible) continue;
      if (measure || !v.labelSize) v.labelSize = { w: v.label.element.offsetWidth, h: v.label.element.offsetHeight };
      v.label.getWorldPosition(p).project(this.camera);
      if (p.z > 1) continue; // behind the camera
      items.push({ v, x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, lw: v.labelSize.w, lh: v.labelSize.h });
    }
    items.sort((a, b) => b.y - a.y); // lowest on screen first: it keeps its place
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    for (const it of items) {
      let k = 0, box = { l: 0, r: 0, t: 0, b: 0 };
      for (; k < 4; k++) {
        const bottom = it.y - k * (it.lh + 3);
        box = { l: it.x - it.lw / 2, r: it.x + it.lw / 2, t: bottom - it.lh, b: bottom };
        if (!placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) break;
      }
      placed.push(box);
      // center.y = 1 anchors the bottom edge at the ship; each step lifts the label by its height plus a gap.
      it.v.label.center.y = 1 + (it.lh ? (k * (it.lh + 3)) / it.lh : 0);
    }
  }

  updateLabel(v: ShipView, s: ShipState) {
    this.setIonAura(v, s.ion > 0 && !s.destroyed);
    const tokens = [
      s.focus ? `◉${s.focus > 1 ? s.focus : ''}` : '', s.evade ? '◆' : '',
      s.calculate ? `<span title="Calculate">▣${s.calculate > 1 ? s.calculate : ''}</span>` : '',
      s.reinforce ? `<span class="rf" title="Reinforced (${s.reinforce})">${s.reinforce === 'front' ? '◓' : '◒'}</span>` : '',
      s.lock ? '⌖' : '', s.jam ? '<span class="jm" title="Jammed">⌁</span>' : '',
      s.disarmed ? '<span class="dis" title="Disarmed: reloading, cannot attack this round">⊘</span>' : '',
    ].join('');
    v.label.element.querySelector('.info')!.innerHTML =
      `<div class="${s.owner}"><span class="nm">${s.name} </span><b>${s.initiative}</b></div>` +
      `<div class="pips"><span class="sh">${'●'.repeat(s.shields)}</span><span class="hu">${'■'.repeat(s.hull)}</span>` +
      `${s.stress ? `<span class="st"> ⚠${s.stress}</span>` : ''} ${tokens}${s.ion ? '<span class="ion"> ⚡</span>' : ''}</div>` +
      (s.crits.length ? `<div class="crits">${s.crits.map((c) => `<span title="${DAMAGE_CARDS[c].title}: ${DAMAGE_CARDS[c].text}">${DAMAGE_CARDS[c].tag}</span>`).join('')}</div>` : '');
  }

  clearShips() {
    for (const v of this.ships.values()) { this.scene.remove(v.root); v.label.element.remove(); }
    this.ships.clear();
  }

  highlight(shipId: string | null) {
    this.setRings(shipId ? { [shipId]: 0x7cf0c5 } : {});
  }

  /** Show a coloured ring under each listed ship (e.g. acting ship green, valid targets red). */
  setRings(colors: Record<string, number>) {
    for (const [id, v] of this.ships) {
      const c = colors[id];
      v.ring.visible = c !== undefined;
      v.label.element.classList.toggle('sel', c !== undefined);
      if (c !== undefined) (v.ring.material as THREE.MeshBasicMaterial).color.setHex(c);
    }
  }

  private deployZone = new THREE.Group();

  /** Light up a player's setup area (within range 1 of their edge), or clear it with null. */
  setDeployZone(side: 'near' | 'far' | null) {
    clearGroup(this.deployZone);
    if (!this.deployZone.parent) this.scene.add(this.deployZone);
    if (!side) return;
    const depth = 100;
    const cy = side === 'near' ? depth / 2 : BOARD_SIZE - depth / 2;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_SIZE, depth),
      new THREE.MeshBasicMaterial({ color: 0x7cf0c5, transparent: true, opacity: 0.12, depthWrite: false }));
    strip.rotation.x = -Math.PI / 2;
    strip.position.copy(toV3(HALF, cy, 0.4));
    strip.raycast = () => {};
    const edgeY = side === 'near' ? depth : BOARD_SIZE - depth;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([toV3(0, edgeY, 0.6), toV3(BOARD_SIZE, edgeY, 0.6)]),
      new THREE.LineBasicMaterial({ color: 0x7cf0c5, transparent: true, opacity: 0.8 }));
    this.deployZone.add(strip, line);
  }

  // ---------------- devices (bombs and mines) ----------------
  private deviceGroup = new THREE.Group();
  private deviceViews = new Map<string, THREE.Group>();
  private devicePreview = new THREE.Group();

  /** A bomb (dark sphere, red light) or mine (spiked disc, amber light) token. */
  private deviceToken(kind: 'bomb' | 'mine'): THREE.Group {
    const g = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.7, roughness: 0.35 });
    if (kind === 'bomb') {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(9, 20, 14), shell);
      ball.position.y = 9;
      g.add(ball);
      const band = new THREE.Mesh(new THREE.TorusGeometry(9.2, 1.1, 8, 24), new THREE.MeshStandardMaterial({ color: 0xff9f43, metalness: 0.4, roughness: 0.4 }));
      band.rotation.x = Math.PI / 2;
      band.position.y = 9;
      g.add(band);
    } else {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 5, 16), shell);
      disc.position.y = 3;
      g.add(disc);
      for (let i = 0; i < 6; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 6), shell);
        const a = (i / 6) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 11, 3, Math.sin(a) * 11);
        spike.rotation.z = -Math.PI / 2;
        spike.rotation.y = -a;
        g.add(spike);
      }
    }
    const light = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: hot(kind === 'bomb' ? 0xff3b30 : 0xffb020, 3), blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    light.position.y = kind === 'bomb' ? 19 : 8;
    light.scale.setScalar(12);
    light.userData.blink = true;
    g.add(light);
    g.traverse((o) => { o.castShadow = true; o.raycast = () => {}; });
    return g;
  }

  /** Make the table show exactly these device tokens. */
  setDevices(devices: { id: string; kind: 'bomb' | 'mine'; pose: Pose }[]) {
    if (!this.deviceGroup.parent) this.scene.add(this.deviceGroup);
    for (const [id, g] of this.deviceViews) if (!devices.some((d) => d.id === id)) { this.deviceGroup.remove(g); this.deviceViews.delete(id); }
    for (const d of devices) {
      if (this.deviceViews.has(d.id)) continue;
      const g = this.deviceToken(d.kind);
      placeObject(g, d.pose);
      this.deviceGroup.add(g);
      this.deviceViews.set(d.id, g);
    }
  }

  /** Range-1 blast outline around a device token: its square grown by 100 mm, corners rounded. */
  private blastOutline(pose: Pose, color: number) {
    const half = 15, r = 100, pts: THREE.Vector3[] = [];
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    corners.forEach(([sx, sy], i) => {
      const a0 = (i * Math.PI) / 2;
      for (let k = 0; k <= 8; k++) {
        const a = a0 + (k / 8) * (Math.PI / 2);
        const lx = sx * half + Math.cos(a) * r, ly = sy * half + Math.sin(a) * r;
        const c = Math.cos(pose.h), sn = Math.sin(pose.h);
        pts.push(toV3(pose.x + lx * c - ly * sn, pose.y + lx * sn + ly * c, 1.2));
      }
    });
    return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
  }

  /** Preview a drop: a ghost token where it would land and, for bombs, its range-1 blast. */
  previewDevice(drop: { pose: Pose; kind: 'bomb' | 'mine' } | null) {
    clearGroup(this.devicePreview);
    if (!this.devicePreview.parent) this.scene.add(this.devicePreview);
    if (!drop) return;
    const ghost = this.deviceToken(drop.kind);
    ghost.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) { m.transparent = true; m.opacity = 0.55; }
    });
    placeObject(ghost, drop.pose);
    this.devicePreview.add(ghost);
    if (drop.kind === 'bomb') this.devicePreview.add(this.blastOutline(drop.pose, 0xff6a3d));
  }

  /** Slide a newly dropped token out from behind the ship to where it lands. */
  async dropDevice(shipId: string, d: { id: string; kind: 'bomb' | 'mine'; pose: Pose }) {
    if (!this.deviceGroup.parent) this.scene.add(this.deviceGroup);
    const v = this.ships.get(shipId);
    const g = this.deviceToken(d.kind);
    const to = toV3(d.pose.x, d.pose.y, 0);
    const from = v ? v.root.position.clone().setY(FLY_HEIGHT) : to.clone();
    g.rotation.y = d.pose.h;
    this.deviceGroup.add(g);
    this.deviceViews.set(d.id, g);
    await this.tween(500, (t) => {
      const e = 1 - (1 - t) * (1 - t);
      g.position.lerpVectors(from, to, e);
      g.position.y = from.y * (1 - e) + Math.sin(t * Math.PI) * 6;
    });
    g.position.copy(to);
  }

  /** A device going off: flash, a blast ring out to range 1 (blue for ion), and the token is gone. */
  async detonate(d: { id: string; pose: Pose }, ion = false) {
    const g = this.deviceViews.get(d.id);
    if (g) { this.deviceGroup.remove(g); this.deviceViews.delete(d.id); }
    const at = toV3(d.pose.x, d.pose.y, 10);
    const color = ion ? 0x7fd8ff : 0xff9944;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(ion ? 0xd8f4ff : 0xfff0d0, 3), blending: THREE.AdditiveBlending, depthWrite: false }));
    flash.position.copy(at);
    this.scene.add(flash);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), this.additive(hot(color, 2.2)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at).setY(2);
    this.scene.add(ring);
    const debris = this.burst(at, hot(color, 2.5), 50, 110, 6);
    this.flash(at, color, 3000, 700);
    await this.tween(800, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      flash.scale.setScalar(20 + 80 * Math.min(1, t * 3));
      flash.material.opacity = Math.max(0, 1 - t * 2.5);
      ring.scale.setScalar(10 + 105 * e); // out to about range 1 from the token
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 1.3);
      debris.update(t);
    });
    this.scene.remove(flash, ring);
    flash.material.dispose();
    ring.geometry.dispose();
    debris.dispose();
  }

  /**
   * Show the firing arcs of exactly these ships (none when empty). `which` picks the primary arcs, the
   * turret arc, or both (the default).
   */
  showArcs(ids: string[], which: 'primary' | 'turret' | 'all' = 'all') {
    for (const [id, v] of this.ships) {
      v.arcs.visible = ids.includes(id) && which !== 'turret';
      if (v.turret) v.turret.fan.visible = ids.includes(id) && which !== 'primary';
    }
  }

  /** Turn a ship's turret arc to face `arc` (animated unless ms is 0); `preview` leaves the recorded facing alone. */
  setTurret(shipId: string, arc: string, ms = 400, preview = false) {
    const t = this.ships.get(shipId)?.turret;
    if (!t) return Promise.resolve();
    if (!preview) t.facing = arc;
    const from = t.holder.rotation.y;
    let to = TURRET_ANGLE[arc] ?? 0;
    while (to - from > Math.PI) to -= Math.PI * 2;
    while (to - from < -Math.PI) to += Math.PI * 2;
    // The model's own gun (if it has one) swivels with the arc.
    const turn = (y: number) => { t.holder.rotation.y = y; if (t.gun) t.gun.rotation.y = y; };
    if (ms <= 0 || this.reducedMotion) { turn(to); return Promise.resolve(); }
    return this.tween(ms, (k) => turn(from + (to - from) * (1 - (1 - k) * (1 - k))));
  }

  /** Extra line on ships' labels (e.g. hit odds); ships not listed have theirs cleared. */
  setOdds(lines: Record<string, string>) {
    for (const [id, v] of this.ships) {
      const el = v.label.element.querySelector<HTMLElement>('.odds')!;
      const html = lines[id];
      el.hidden = html === undefined;
      if (html !== undefined && el.innerHTML !== html) el.innerHTML = html;
    }
  }

  private chipsKey = '';

  /**
   * Clickable HTML buttons floating just below a ship. With `key`, an identical row is left in place
   * rather than rebuilt (rebuilding under the pointer can swallow a tap).
   */
  showChips(pose: Pose, chips: { label: string; cls?: string; onClick: () => void }[], opts: { key?: string; cls?: string } = {}) {
    if (opts.key !== undefined && opts.key === this.chipsKey) return;
    this.clearChips();
    this.chipsKey = opts.key ?? '';
    if (!chips.length) return;
    const el = document.createElement('div');
    el.className = `chips ${opts.cls ?? ''}`;
    for (const c of chips) {
      const b = document.createElement('button');
      b.className = `chip ${c.cls ?? ''}`;
      b.innerHTML = c.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); c.onClick(); });
      el.appendChild(b);
    }
    const obj = new CSS2DObject(el);
    obj.position.copy(toV3(pose.x, pose.y, 0));
    obj.center.set(0.5, -1.6); // sit well below the ship, clear of its label and preview labels
    this.chips.add(obj);
  }
  clearChips() { clearGroup(this.chips); this.chipsKey = ''; this.hideTip(); }

  /**
   * A ring of icon buttons around a ship (the acting ship's menu). Items are spread around the ship,
   * leaving a gap at the top for its label. With `key`, an identical ring is left in place rather than
   * rebuilt (rebuilding under the pointer can swallow a tap). Shares the chips layer, so clearChips clears it.
   */
  showRadial(pose: Pose, items: RadialItem[], opts: { key?: string; caption?: string } = {}) {
    if (opts.key !== undefined && opts.key === this.chipsKey) return;
    this.clearChips();
    this.chipsKey = opts.key ?? '';
    if (!items.length) return;
    const el = document.createElement('div');
    el.className = 'radial';
    const n = items.length;
    // Use the lower arc (75° to 285° clockwise from screen-up) so the ship's label above it stays clear,
    // and push the ring out when there are many buttons so neighbours never overlap.
    const from = 75, to = 285;
    const arc = ((to - from) * Math.PI) / 180;
    const radius = Math.max(88, n > 1 ? (62 * (n - 1)) / arc : 0);
    el.style.setProperty('--r', `${radius.toFixed(0)}px`);
    items.forEach((it, i) => {
      const deg = it.angle ?? (n === 1 ? 180 : from + ((to - from) * i) / (n - 1));
      const rad = (deg * Math.PI) / 180;
      const b = document.createElement('button');
      b.className = `rad-item ${it.cls ?? ''}${it.active ? ' active' : ''}`;
      b.style.setProperty('--x', `${Math.sin(rad).toFixed(3)}`);
      b.style.setProperty('--y', `${(-Math.cos(rad)).toFixed(3)}`);
      b.disabled = !!it.disabled;
      b.setAttribute('aria-label', it.help ? `${it.title ?? it.label}. ${it.help.replace(/<[^>]+>/g, '')}` : it.title ?? it.label);
      b.innerHTML = `${it.icon}<span class="rad-label">${it.label}</span>${it.badge !== undefined ? `<span class="rad-badge">${it.badge}</span>` : ''}`;
      // Help: a held finger (or a resting mouse) shows what the button does. A hold doesn't press it.
      let held = false, timer = 0;
      const tip = () => this.showTip(b, it.title ?? it.label, it.help);
      b.addEventListener('pointerdown', (e) => {
        held = false;
        clearTimeout(timer);
        if (e.pointerType !== 'mouse') timer = window.setTimeout(() => { held = true; tip(); }, 450);
      });
      b.addEventListener('pointerup', () => { clearTimeout(timer); if (held) this.hideTip(2500); });
      b.addEventListener('pointercancel', () => { clearTimeout(timer); this.hideTip(held ? 2500 : 0); });
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clearTimeout(timer); timer = window.setTimeout(tip, 350); } });
      b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { clearTimeout(timer); this.hideTip(); } });
      b.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press must not open the browser's menu
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (held) { held = false; return; } // the finger was reading the help
        this.hideTip();
        if (!b.disabled) it.onClick();
      });
      if (it.onHover) {
        b.addEventListener('pointerenter', () => it.onHover!(true));
        b.addEventListener('pointerleave', () => it.onHover!(false));
      }
      el.appendChild(b);
    });
    if (opts.caption) {
      const c = document.createElement('div');
      c.className = 'rad-caption';
      // Phones can't hover: say how to get the help.
      const touchHelp = n > 1 && items.some((it) => it.help) && matchMedia('(hover: none)').matches;
      c.innerHTML = opts.caption + (touchHelp ? ' <span class="rad-help-hint">· hold a button for help</span>' : '');
      el.appendChild(c);
    }
    const obj = new CSS2DObject(el);
    obj.position.copy(toV3(pose.x, pose.y, FLY_HEIGHT));
    this.chips.add(obj);
  }

  /** A ghost base at the end of a path, with the dashed path itself and an optional label. */
  private ghostGroup(size: number, poses: Pose[], color: number, opacity = 1, label?: string,
    arcs?: { arcs: string[]; color: number }): THREE.Group {
    const out = new THREE.Group();
    if (!poses.length) return out;
    const final = poses[poses.length - 1];
    const s = size / 2;
    const sq = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(s, 3, -s), new THREE.Vector3(-s, 3, -s), new THREE.Vector3(-s, 3, s), new THREE.Vector3(s, 3, s),
      ]),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2 * opacity, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 2.5;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(4, 10, 3), new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(s + 6, 3, 0);
    const g = new THREE.Group();
    g.add(sq, fill, nose);
    if (arcs) g.add(buildArcs(size, arcs.arcs, arcs.color));
    placeObject(g, final);
    out.add(g);
    if (label) {
      const el = document.createElement('div');
      el.className = 'label ghost-label';
      el.innerHTML = label;
      const obj = new CSS2DObject(el);
      obj.position.copy(toV3(final.x, final.y, 8));
      obj.center.set(0.5, -0.6);
      out.add(obj);
    }
    if (poses.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(poses.map((p) => toV3(p.x, p.y, 3))),
        new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4, transparent: true, opacity }),
      );
      line.computeLineDistances();
      out.add(line);
    }
    return out;
  }

  /** `arcsOf` draws that ship's firing arcs from the ghost's final position. */
  showGhost(size: number, poses: Pose[], color = 0x7cf0c5, label?: string, arcsOf?: string) {
    this.clearGhost();
    const v = arcsOf ? this.ships.get(arcsOf) : undefined;
    const arcs = v ? { arcs: SHIP_TYPES[v.typeId].primaries.map((p) => p.arc), color: COLORS[v.owner] ?? 0xffffff } : undefined;
    this.ghost.add(this.ghostGroup(size, poses, color, 1, label, arcs));
  }

  clearGhost() { clearGroup(this.ghost); }

  /** Persistent, dimmer ghosts for maneuvers already chosen this planning phase. */
  setPlanned(items: { size: number; poses: Pose[]; color: number }[]) {
    clearGroup(this.planned);
    for (const it of items) this.planned.add(this.ghostGroup(it.size, it.poses, it.color, 0.45));
  }

  /** Small dots on the table showing every spot the selected ship can reach. */
  /** `ring` circles a dot that hides more maneuvers (e.g. a K-turn behind a straight), in that colour. */
  /** Maneuver dots. `ring`: a special maneuver hides here (its colour). `suggested`: the hint's pick (gold halo). */
  setMarkers(points: { x: number; y: number; color: number; active?: boolean; ring?: number; suggested?: boolean }[]) {
    this.markers.clear();
    for (const p of points) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(p.active ? 5 : 3.5, 16),
        new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: p.active ? 1 : 0.55 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.copy(toV3(p.x, p.y, 0.6));
      this.markers.add(m);
      if (p.ring !== undefined) {
        const r = new THREE.Mesh(new THREE.RingGeometry(7, 8.6, 24), new THREE.MeshBasicMaterial({ color: p.ring, transparent: true, opacity: 0.9 }));
        r.rotation.x = -Math.PI / 2;
        r.position.copy(toV3(p.x, p.y, 0.7));
        this.markers.add(r);
      }
      if (p.suggested) {
        const halo = new THREE.Mesh(new THREE.RingGeometry(10, 12.5, 32), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 }));
        halo.rotation.x = -Math.PI / 2;
        halo.position.copy(toV3(p.x, p.y, 0.8));
        this.markers.add(halo);
      }
    }
  }

  private raycaster = new THREE.Raycaster();
  private ndc(clientX: number, clientY: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** Board coordinates (mm) under the pointer, or null if it misses the table plane. */
  boardPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x + HALF, y: -hit.z + HALF };
  }

  // ---------------- camera framing ----------------
  private camTween = 0;

  /** Glide the camera to a new target/position (instant when reduced motion is preferred). */
  flyTo(target: THREE.Vector3, position: THREE.Vector3, ms = 500) {
    const id = ++this.camTween;
    const t0 = this.controls.target.clone(), p0 = this.camera.position.clone();
    if (ms <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      return;
    }
    void this.tween(ms, (t) => {
      if (id !== this.camTween) return; // a newer flight took over
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.controls.target.lerpVectors(t0, target, e);
      this.camera.position.lerpVectors(p0, position, e);
    });
  }

  private aimFrom: ShipView | null = null;
  private savedView: { target: THREE.Vector3; position: THREE.Vector3; minDistance: number; maxPolarAngle: number; enabled: boolean } | null = null;

  /**
   * Gunner's-eye view: drop in just behind and above the attacker, looking down its line of fire at the
   * defender. The orbit limits that keep the normal view overhead are lifted until restoreView().
   */
  attackView(attackerId: string, defenderId: string, ms = 600, angle: AttackAngle = 'gunner') {
    const a = this.ships.get(attackerId), d = this.ships.get(defenderId);
    if (!a || !d) return;
    if (angle !== 'gunner') return this.cinematicView(a, d, ms, angle);
    if (!this.savedView) {
      this.savedView = {
        target: this.controls.target.clone(), position: this.camera.position.clone(),
        minDistance: this.controls.minDistance, maxPolarAngle: this.controls.maxPolarAngle, enabled: this.controls.enabled,
      };
    }
    this.controls.minDistance = 0;
    this.controls.maxPolarAngle = Math.PI / 2;
    this.controls.enabled = false;
    const from = a.root.position.clone().setY(FLY_HEIGHT);
    const to = d.root.position.clone().setY(FLY_HEIGHT);
    const dist = to.distanceTo(from);
    const dir = to.clone().sub(from).setY(0).normalize();
    // Low and close behind, so the attacker fills the lower third of the frame with the target ahead.
    // A close target would hide behind the attacker's own hull, so rise above it the closer the target is.
    const back = a.reach * 1.5 + 25;
    const lift = Math.max(0, 220 - dist) * 0.4;
    const pos = from.clone().addScaledVector(dir, -back).setY(Math.max(a.top, FLY_HEIGHT) + 14 + lift);
    this.flyTo(to, pos, ms);
    // The attacker's own label would float up into the middle of the view.
    if (this.aimFrom && this.aimFrom !== a) this.aimFrom.label.visible = true;
    this.aimFrom = a;
    a.label.visible = false;
  }

  /**
   * The other attack angles, for variety while the shots fly (the camera keeps drifting slowly until
   * restoreView(), like a film camera on a dolly):
   * - `reverse`: from behind the defender, over its shoulder, watching the fire come in;
   * - `side`: side-on to the line of fire, both ships in frame, tracking along it;
   * - `low`: low beside the attacker, its hull large in the foreground, the target beyond.
   */
  private cinematicView(a: ShipView, d: ShipView, ms: number, angle: Exclude<AttackAngle, 'gunner'>) {
    if (!this.savedView) {
      this.savedView = {
        target: this.controls.target.clone(), position: this.camera.position.clone(),
        minDistance: this.controls.minDistance, maxPolarAngle: this.controls.maxPolarAngle, enabled: this.controls.enabled,
      };
    }
    this.controls.minDistance = 0;
    this.controls.maxPolarAngle = Math.PI / 2;
    this.controls.enabled = false;
    const from = a.root.position.clone().setY(FLY_HEIGHT), to = d.root.position.clone().setY(FLY_HEIGHT);
    const dist = to.distanceTo(from);
    const dir = to.clone().sub(from).setY(0).normalize();
    // Which side to film from: the one facing the player's own table edge, so left and right read as usual.
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    if (across.z * this.facing < 0) across.negate();
    // Distance at which a span of `w` fits across the screen (narrow on an upright phone).
    const fit = (w: number) => {
      const v = THREE.MathUtils.degToRad(this.camera.fov) / 2;
      const h = Math.atan(Math.tan(v) * this.camera.aspect);
      return (w / 2) / Math.tan(h);
    };
    let target: THREE.Vector3, pos: THREE.Vector3, drift: THREE.Vector3, hide: ShipView;
    if (angle === 'reverse') {
      const lift = Math.max(0, 220 - dist) * 0.4;
      pos = to.clone().addScaledVector(dir, d.reach * 1.5 + 25).addScaledVector(across, d.reach * 0.7)
        .setY(Math.max(d.top, FLY_HEIGHT) + 16 + lift);
      target = from.clone().lerp(to, 0.2);
      drift = across.clone().multiplyScalar(-30);
      hide = d;
    } else if (angle === 'side') {
      const mid = from.clone().lerp(to, 0.5);
      const back = Math.max(fit(dist + a.reach + d.reach + 30), 110);
      pos = mid.clone().addScaledVector(across, back).setY(FLY_HEIGHT + 12 + back * 0.1);
      target = mid.setY(FLY_HEIGHT);
      drift = dir.clone().multiplyScalar(dist * 0.18);
      hide = a;
    } else {
      // An upright phone has little width: come in more from behind than from the side.
      const narrow = this.camera.aspect < 1;
      pos = from.clone().addScaledVector(dir, -(a.reach * (narrow ? 2.4 : 1.7) + 20)).addScaledVector(across, a.reach * (narrow ? 0.55 : 1.1) + 12)
        .setY(Math.max(6, FLY_HEIGHT * 0.6));
      target = from.clone().lerp(to, 0.6);
      drift = new THREE.Vector3(0, 14, 0).addScaledVector(dir, -12);
      hide = a;
    }
    this.flyTo(target, pos, ms);
    if (this.aimFrom && this.aimFrom !== hide) this.aimFrom.label.visible = true;
    this.aimFrom = hide;
    hide.label.visible = false;
    if (this.reducedMotion) return;
    // Once in place, keep drifting until the next camera move takes over.
    const id = this.camTween;
    void this.wait(ms).then(() => {
      if (id !== this.camTween) return;
      const p0 = this.camera.position.clone();
      void this.tween(4000, (t) => {
        if (id !== this.camTween) return;
        this.camera.position.copy(p0).addScaledVector(drift, t);
      });
    });
  }

  /** True while the camera is in attackView(), so the normal framing leaves it alone. */
  get inAttackView() { return this.savedView !== null; }

  /** Return from attackView() to wherever the camera was before. */
  restoreView(ms = 600) {
    const v = this.savedView;
    if (!v) return;
    this.savedView = null;
    if (this.aimFrom) { this.aimFrom.label.visible = true; this.aimFrom = null; }
    this.flyTo(v.target, v.position, ms);
    this.controls.enabled = v.enabled;
    // Put the orbit limits back once the camera is up again, so they don't yank it mid-flight.
    void this.wait(ms).then(() => {
      if (this.savedView) return; // the next shot's view has already taken over
      this.controls.minDistance = v.minDistance;
      this.controls.maxPolarAngle = v.maxPolarAngle;
    });
  }

  /** Which edge the camera looks from: 1 = player 1's (near) edge, -1 = player 2's (far) edge. */
  facing: 1 | -1 = 1;

  /** The original desktop view of the whole table, from the current `facing` edge. */
  resetView(ms = 500) {
    this.flyTo(new THREE.Vector3(0, 0, 60 * this.facing), new THREE.Vector3(0, 1080, 640 * this.facing), ms);
  }

  private fitCam = new THREE.PerspectiveCamera();

  /**
   * Frame a rectangle of the board (centre cx, cy; half sizes hw, hh in mm) inside the part of
   * the screen not covered by UI (insets in CSS px). `tilt` is the camera's angle from vertical.
   * The fit is measured on screen (perspective makes the near edge wider than the far one), then
   * the rectangle is centred in the uncovered area. `zoom` > 1 lets it be that much wider than the
   * uncovered area (spilling past the sides, e.g. a wide board on an upright phone), never taller.
   */
  frameRect(cx: number, cy: number, hw: number, hh: number,
    insets: { top: number; right: number; bottom: number; left: number }, tilt = 0.3, ms = 500, zoom = 1) {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const availW = Math.max(120, w - insets.left - insets.right);
    const availH = Math.max(120, h - insets.top - insets.bottom);
    const midX = insets.left + availW / 2, midY = insets.top + availH / 2;
    const tv = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const cam = this.fitCam;
    cam.fov = this.camera.fov; cam.aspect = w / h; cam.near = this.camera.near; cam.far = this.camera.far;
    cam.updateProjectionMatrix();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toV3(cx + sx * hw, cy + sy * hh, 0));
    const target = toV3(cx, cy, 0);
    let d = Math.max(hw / (tv * (w / h) * (availW / w)), hh / (tv * (availH / h)));
    const place = () => {
      cam.position.copy(target).add(new THREE.Vector3(0, Math.cos(tilt) * d, Math.sin(tilt) * d * this.facing));
      cam.lookAt(target);
      cam.updateMatrixWorld();
    };
    // A few rounds of: measure where the corners land, rescale to fit, recentre.
    for (let i = 0; i < 6; i++) {
      place();
      const px = corners.map((c) => { const v = c.clone().project(cam); return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h }; });
      const x0 = Math.min(...px.map((p) => p.x)), x1 = Math.max(...px.map((p) => p.x));
      const y0 = Math.min(...px.map((p) => p.y)), y1 = Math.max(...px.map((p) => p.y));
      d *= Math.max((x1 - x0) / (availW * zoom), (y1 - y0) / availH) * 1.04;
      const mmPerPx = (2 * d * tv) / h;
      // Seen from the far edge, screen right is -x and screen down is -z.
      target.x -= (midX - (x0 + x1) / 2) * mmPerPx * this.facing;
      target.z -= ((midY - (y0 + y1) / 2) * mmPerPx * this.facing) / Math.cos(tilt);
    }
    place();
    this.flyTo(target, cam.position.clone(), ms);
  }

  /** Screen direction (degrees clockwise from screen-up) of the board heading `h` seen from point (x, y). */
  screenBearing(x: number, y: number, h: number): number {
    const a = this.screenPoint(x, y), b = this.screenPoint(x + Math.cos(h) * 60, y + Math.sin(h) * 60);
    return ((Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI + 360) % 360;
  }

  /** Screen (client) coordinates of a board point; used by tests and tutorials. */
  screenPoint(x: number, y: number): { x: number; y: number } {
    const v = toV3(x, y, 0).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** Id of the ship model/base under the pointer, if any. */
  pickShip(clientX: number, clientY: number): string | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    let best: { id: string; d: number } | null = null;
    for (const [id, v] of this.ships) {
      const hits = this.raycaster.intersectObject(v.root, true).filter((h) => h.object !== v.ring);
      if (hits.length && (!best || hits[0].distance < best.d)) best = { id, d: hits[0].distance };
    }
    return best?.id ?? null;
  }

  showLine(a: Pose, b: Pose, color: number, label?: string) {
    this.clearOverlay();
    this.overlay.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([toV3(a.x, a.y, FLY_HEIGHT + 4), toV3(b.x, b.y, FLY_HEIGHT + 4)]),
      new THREE.LineBasicMaterial({ color }),
    ));
    if (label) {
      const el = document.createElement('div');
      el.className = 'label ghost-label';
      el.innerHTML = label;
      const obj = new CSS2DObject(el);
      obj.position.copy(toV3((a.x + b.x) / 2, (a.y + b.y) / 2, FLY_HEIGHT + 4));
      this.overlay.add(obj);
    }
  }
  clearOverlay() { clearGroup(this.overlay); }

  // ---------------- animations ----------------
  /** Animation speed multiplier (2 = twice as fast). */
  speed = 1;
  /** While true, running and new tweens jump straight to their end (tap-to-skip). */
  skipping = false;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  tween(ms: number, fn: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const dur = ms / this.speed;
      const step = () => {
        const t = this.skipping ? 1 : Math.min(1, (performance.now() - t0) / dur);
        try {
          fn(t);
        } catch (err) {
          // Never leave the caller awaiting forever: a broken frame would freeze the game loop.
          console.error('tween frame failed', err);
          resolve();
          return;
        }
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // ---------------- end of battle ----------------
  private celebration = 0;

  /**
   * The winner's moment: their surviving ships barrel-roll one after another, and fireworks in their
   * colour (with gold and white) go off over the board until stopCelebration(). `owner` null: a draw,
   * which gets no fireworks. Runs at normal speed whatever the animation speed, and calmly under
   * reduced motion (a few slow bursts, no rolls).
   */
  celebrate(owner: string | null) {
    const id = ++this.celebration;
    if (!owner) return;
    const color = COLORS[owner] ?? 0xffffff;
    const winners = [...this.ships.values()].filter((v) => v.owner === owner);
    if (!this.reducedMotion) {
      winners.forEach((v, i) => setTimeout(() => { if (id === this.celebration) void this.victoryRoll(v); }, 500 + i * 380));
    }
    let n = 0;
    const next = () => {
      if (id !== this.celebration) return;
      const opening = n < 8; // a quick volley first, then a steady show
      this.firework([color, 0xffd166, 0xffffff][n % 3 === 2 ? 1 : n % 5 === 4 ? 2 : 0]);
      n++;
      const gap = this.reducedMotion ? 1800 : opening ? 260 + Math.random() * 200 : 700 + Math.random() * 600;
      setTimeout(next, gap);
    };
    setTimeout(next, 250);
  }

  stopCelebration() { this.celebration++; }

  /** Rise, barrel roll with the engines lit, settle back. */
  private async victoryRoll(v: ShipView) {
    const y0 = v.model.position.y;
    const thrust = v.thrust;
    await this.tween(1300 * this.speed, (t) => {
      const lift = Math.sin(t * Math.PI);
      v.model.position.y = y0 + lift * 22;
      v.model.rotation.x = Math.PI * 2 * (t < 0.15 ? 0 : t > 0.85 ? 1 : (1 - Math.cos(((t - 0.15) / 0.7) * Math.PI)) / 2);
      v.thrust = thrust + lift * 2;
    });
    v.model.position.y = y0;
    v.model.rotation.x = 0;
    v.thrust = thrust;
  }

  /** One firework over a random spot of the board: a bright flash and a drooping, fading shell of sparks. */
  private async firework(color: number) {
    const at = new THREE.Vector3((Math.random() - 0.5) * BOARD_SIZE * 0.7, 120 + Math.random() * 120, (Math.random() - 0.5) * BOARD_SIZE * 0.7);
    // Two single-colour layers: the main shell, and a few white sparkles.
    const layers = [this.shell(at, hot(color, 4), 140, 230, 40), this.shell(at, hot(0xffffff, 3.5), 30, 200, 30)];
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(color, 4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.position.copy(at);
    this.scene.add(flash);
    this.flash(at, color, 6000, 700);
    await this.tween(1800 * this.speed, (t) => {
      const fade = t < 0.55 ? 1 : ((1 - t) / 0.45) * (0.75 + 0.25 * Math.sin(t * 90)); // twinkle out
      layers.forEach((l) => l.update(t, fade));
      flash.scale.setScalar(160 * (1 + t * 2));
      flash.material.opacity = Math.max(0, 1 - t * 4);
    });
    layers.forEach((l) => l.dispose());
    this.scene.remove(flash);
    flash.material.dispose();
  }

  /** Sparks bursting from `at` that slow, droop under gravity and fade (update(t, opacity) per frame). */
  private shell(at: THREE.Vector3, color: THREE.Color, count: number, speed: number, size: number) {
    const pos = new Float32Array(count * 3);
    const vel = Array.from({ length: count }, () => new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.85 + Math.random() * 0.3)));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size, map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return {
      update: (t: number, opacity: number) => {
        const k = 1 - Math.pow(1 - t, 3), fall = 90 * t * t;
        vel.forEach((v, i) => pos.set([at.x + v.x * k, at.y + v.y * k - fall, at.z + v.z * k], i * 3));
        geo.attributes.position.needsUpdate = true;
        mat.opacity = opacity;
      },
      dispose: () => { this.scene.remove(pts); geo.dispose(); mat.dispose(); },
    };
  }

  /** A pause that respects speed and skipping. */
  wait(ms: number): Promise<void> { return this.tween(ms, () => {}); }

  private gunPoint(shipId: string): THREE.Vector3 | null {
    const v = this.ships.get(shipId);
    if (!v) return null;
    const p = v.root.position.clone().setY(FLY_HEIGHT + 4);
    // muzzle slightly ahead of the ship's nose
    return p.add(new THREE.Vector3(Math.cos(v.root.rotation.y) * 14, 0, -Math.sin(v.root.rotation.y) * 14));
  }

  /** Where a bolt should end: on the target, or streaking past it for a miss. */
  boltEnd(fromId: string, toId: string, hit: boolean, i: number): THREE.Vector3 | null {
    const a = this.gunPoint(fromId), b = this.ships.get(toId);
    if (!a || !b) return null;
    const t = b.root.position.clone().setY(FLY_HEIGHT + 4);
    if (hit) return t.add(new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 10));
    const dir = t.clone().sub(a).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((i % 2 ? 1 : -1) * (26 + Math.random() * 14));
    return t.add(side).add(dir.multiplyScalar(90)).setY(FLY_HEIGHT + 4 + (Math.random() - 0.5) * 10);
  }

  private flashIdx = 0;
  /**
   * Briefly light up the surroundings from a point (pooled lights). The light sits above the effect,
   * not inside the hull: a strong light right against shiny metal overflows the HDR buffer.
   */
  private flash(at: THREE.Vector3, color: number, peak: number, ms: number) {
    const l = this.flashes[this.flashIdx++ % this.flashes.length];
    l.position.copy(at).y += 30;
    l.color.setHex(color);
    void this.tween(ms, (t) => { l.intensity = peak * (1 - t) * (1 - t); }).then(() => { l.intensity = 0; });
  }

  private additive(color: THREE.ColorRepresentation, opacity = 1, map?: THREE.Texture) {
    return new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  }

  // ---------------- shots (docs/VFX.md, phase 1) ----------------

  /** A muzzle point on the attacker: its nose, nudged to one side (`side` -1..1) for twin guns. */
  private muzzle(shipId: string, side = 0): THREE.Vector3 | null {
    const v = this.ships.get(shipId);
    const p = this.gunPoint(shipId);
    if (!v || !p) return null;
    const h = v.root.rotation.y;
    return p.add(new THREE.Vector3(Math.sin(h), 0, Math.cos(h)).multiplyScalar(side * Math.min(10, v.reach * 0.22)));
  }

  /** A glowing sprite (additive) at `at`, added to the scene. */
  private glow(at: THREE.Vector3, color: THREE.Color, size: number, opacity = 1) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
    sp.position.copy(at);
    sp.scale.setScalar(size);
    this.scene.add(sp);
    return sp;
  }
  private drop(...objs: (THREE.Sprite | THREE.Mesh | THREE.Line | THREE.Points)[]) {
    for (const o of objs) {
      this.scene.remove(o);
      o.geometry.dispose();
      const m = o.material as THREE.Material | THREE.Material[];
      (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    }
  }

  /**
   * Smoke puffs left along a flight path: they hang where they were made, swell and fade. `add` drops one
   * puff; `settle()` lets the last ones fade out (not awaited by the shot).
   */
  private smokeTrail(life: number, size: number, color = 0x8a8f99) {
    const puffs: { sp: THREE.Sprite; born: number; drift: THREE.Vector3 }[] = [];
    const tex = glowTexture();
    let clock = 0;
    const add = (at: THREE.Vector3, now: number) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0.45, depthWrite: false }));
      sp.position.copy(at);
      sp.scale.setScalar(size * 0.4);
      this.scene.add(sp);
      puffs.push({ sp, born: now, drift: new THREE.Vector3().randomDirection().multiplyScalar(4) });
    };
    const update = (now: number) => {
      clock = now;
      for (const p of puffs) {
        const age = Math.min(1, (now - p.born) / life);
        p.sp.scale.setScalar(size * (0.4 + age * 1.1));
        p.sp.material.opacity = 0.45 * (1 - age) * (1 - age);
        p.sp.position.addScaledVector(p.drift, 0.016);
      }
    };
    const settle = () => this.tween(life, (t) => update(clock + t * life)).then(() => puffs.forEach((p) => this.drop(p.sp)));
    return { add, update, settle };
  }

  /**
   * One shot from the attacker to `end` (on the target for a hit, past it for a miss), resolving when it
   * arrives. Each kind of weapon has its own look: lasers, ion arcs, missiles, rocket salvoes, torpedoes.
   * `i` is the shot's number in the volley (alternates the guns, varies the paths).
   */
  async shot(kind: ShotLook, fromId: string, end: THREE.Vector3, color: number, hit: boolean, i = 0) {
    const ms = SHOT_TIMING[kind].flight;
    if (kind === 'laser') return this.laserShot(fromId, end, color, hit, i, ms);
    if (kind === 'ion') return this.ionShot(fromId, end, hit, ms);
    if (kind === 'missile') return this.missileShot(fromId, end, hit, i, ms, false);
    if (kind === 'rockets') return this.missileShot(fromId, end, hit, i, ms, true);
    return this.torpedoShot(fromId, end, color, hit, ms);
  }

  /** Laser: a white-hot core in a coloured glow with a short fading tail, from alternating guns. */
  private async laserShot(fromId: string, end: THREE.Vector3, color: number, hit: boolean, i: number, ms: number) {
    const start = this.muzzle(fromId, i % 2 ? 1 : -1);
    if (!start) return;
    const dir = end.clone().sub(start).normalize();
    const len = 30;
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, len, 6).rotateZ(Math.PI / 2), this.additive(hot(0xffffff, 3.2)));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, len * 1.15, 10).rotateZ(Math.PI / 2), this.additive(hot(color, 2.6), 0.6));
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 2.6, len * 1.8, 8).rotateZ(Math.PI / 2), this.additive(hot(color, 1.6), 0.35));
    tail.position.x = -len * 1.2; // trailing behind the bolt
    g.add(core, glow, tail);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    const flare = this.glow(start, hot(color, 4), 22);
    this.flash(start, color, 380, 150);
    void this.tween(150, (t) => { flare.scale.setScalar(22 * (1 + t)); flare.material.opacity = 1 - t; }).then(() => this.drop(flare));
    this.scene.add(g);
    await this.tween(ms, (t) => g.position.lerpVectors(start, end, t));
    this.scene.remove(g);
    [core, glow, tail].forEach((m) => { m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
    if (hit) void this.impactFlare(end, color, 1);
  }

  /** A quick flare and a few sparks where a shot lands; `scale` 1 for a laser, more for warheads. */
  private async impactFlare(at: THREE.Vector3, color: number, scale: number) {
    const core = this.glow(at, hot(0xfff4e0, 3.5), 10 * scale);
    const ring = this.glow(at, hot(color, 2.4), 16 * scale, 0.8);
    const pts = this.burst(at, hot(color, 2.6), Math.round(10 * scale), 30 * scale, 4);
    await this.tween(260, (t) => {
      core.scale.setScalar(10 * scale * (1 + t * 1.5)); core.material.opacity = 1 - t;
      ring.scale.setScalar(16 * scale * (1 + t * 2)); ring.material.opacity = 0.8 * (1 - t);
      pts.update(t);
    });
    this.drop(core, ring);
    pts.dispose();
  }

  /**
   * Ion cannon: a jagged arc of electricity that reaches out to the target, flickers, and fades. A hit
   * crackles over the target.
   */
  private async ionShot(fromId: string, end: THREE.Vector3, hit: boolean, ms: number) {
    const start = this.muzzle(fromId);
    if (!start) return;
    const n = 18;
    // The main bolt, and a thinner second strand that wanders around it.
    const main = new ArcRibbon(n, hot(0xeefaff, 3.2), hot(ION, 2.6), 1.1, 4.2);
    const strand = new ArcRibbon(n, hot(0xd8f4ff, 2.4), hot(ION, 2), 0.6, 2.6);
    this.scene.add(main, strand);
    const amp = Math.min(12, end.distanceTo(start) * 0.045);
    const muzzleGlow = this.glow(start, hot(ION, 3), 26);
    let reach = 0, last = -1;
    this.flash(start, ION, 500, 300);
    await this.tween(ms, (t) => {
      reach = Math.min(1, t * 2.2);
      const step = Math.floor(t * 14); // re-jag the arc a dozen times while it lives
      if (step !== last) {
        last = step;
        main.set(jagged(start, end, n, amp, reach));
        strand.set(jagged(start, end, n, amp * 1.6, reach));
      }
      const fade = t > 0.75 ? (1 - t) / 0.25 : 1;
      main.opacity = fade * (0.7 + Math.random() * 0.3);
      strand.opacity = fade * (Math.random() < 0.7 ? 0.7 : 0.15);
      muzzleGlow.material.opacity = fade * (0.6 + Math.random() * 0.4);
    });
    main.dispose();
    strand.dispose();
    this.drop(muzzleGlow);
    if (hit) void this.crackle(end, 18, 480);
  }

  /** Little arcs of electricity flickering around a point (an ion hit, or an ionized ship). */
  private async crackle(at: THREE.Vector3, radius: number, ms: number) {
    const arcs = Array.from({ length: 3 }, () => {
      const r = new ArcRibbon(6, hot(0xeefaff, 3), hot(ION, 2.4), 0.7, 2.6);
      this.scene.add(r);
      return r;
    });
    const core = this.glow(at, hot(ION, 2.4), 26);
    const pts = this.burst(at, hot(ION, 2.6), 14, 26, 4);
    this.flash(at, ION, 700, ms);
    let last = -1;
    await this.tween(ms, (t) => {
      const step = Math.floor(t * 12);
      if (step !== last) {
        last = step;
        for (const r of arcs) {
          const a = new THREE.Vector3().randomDirection().multiplyScalar(radius).add(at), b = new THREE.Vector3().randomDirection().multiplyScalar(radius).add(at);
          r.set(jagged(a, b, 6, 6));
        }
      }
      arcs.forEach((r) => { r.opacity = (1 - t) * (Math.random() < 0.8 ? 1 : 0.2); });
      core.scale.setScalar(26 * (1 + t)); core.material.opacity = 0.7 * (1 - t);
      pts.update(t);
    });
    arcs.forEach((r) => r.dispose());
    this.drop(core);
    pts.dispose();
  }

  /**
   * Missile: a body with a flickering exhaust drops off the launcher, curves in on the target and leaves
   * smoke hanging behind it; a hit is a fireball. `rocket`: a small, fast, wobbling rocket from a salvo.
   */
  private async missileShot(fromId: string, end: THREE.Vector3, hit: boolean, i: number, ms: number, rocket: boolean) {
    const start = this.muzzle(fromId, rocket ? ((i % 3) - 1) * 0.8 : i % 2 ? 0.8 : -0.8);
    if (!start) return;
    const s = rocket ? 0.6 : 1;
    const body = new THREE.Mesh(new THREE.ConeGeometry(1.8 * s, 9 * s, 8), new THREE.MeshBasicMaterial({ color: 0xc9ced6 }));
    const exhaust = this.glow(start, hot(0xffb060, 3), 14 * s);
    const head = this.glow(start, hot(0xfff0d0, 2.2), 7 * s);
    this.scene.add(body);
    const smoke = this.smokeTrail(rocket ? 420 : 900, rocket ? 12 : 20);
    const dir = end.clone().sub(start);
    const dist = dir.length();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(i % 2 ? 1 : -1);
    // Missiles drop away, then swing round onto the target; rockets fly nearly straight with a wobble.
    const c1 = start.clone().addScaledVector(side, rocket ? 4 : dist * 0.22).add(new THREE.Vector3(0, rocket ? 0 : -6, 0));
    const c2 = end.clone().addScaledVector(dir, -0.35).addScaledVector(side, rocket ? 0 : dist * 0.12).add(new THREE.Vector3(0, rocket ? 3 : dist * 0.1, 0));
    const at = (t: number) => {
      const u = 1 - t;
      const p = start.clone().multiplyScalar(u * u * u).addScaledVector(c1, 3 * u * u * t).addScaledVector(c2, 3 * u * t * t).addScaledVector(end, t * t * t);
      if (rocket) p.addScaledVector(side, Math.sin(t * Math.PI * 4 + i) * 2.5 * Math.sin(t * Math.PI));
      return p;
    };
    this.flash(start, 0xffa040, rocket ? 160 : 320, 200);
    let lastPuff = -1, now = 0;
    await this.tween(ms, (t) => {
      now = t * ms;
      const p = at(t), ahead = at(Math.min(1, t + 0.02));
      body.position.copy(p);
      const v = ahead.clone().sub(p);
      if (v.lengthSq() > 1e-6) body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
      head.position.copy(p);
      exhaust.position.copy(p).addScaledVector(v, -5 * s);
      exhaust.scale.setScalar(14 * s * (0.75 + Math.random() * 0.5));
      const puff = Math.floor(t * (rocket ? 10 : 22));
      if (puff !== lastPuff) { lastPuff = puff; smoke.add(exhaust.position, now); }
      smoke.update(now);
    });
    this.drop(body, exhaust, head);
    void smoke.settle();
    if (hit) void (rocket ? this.impactFlare(end, 0xff9a40, 1.3) : this.fireball(end, 1));
    else void this.impactFlare(end, 0xffb060, rocket ? 0.6 : 0.9); // a miss self-destructs past the target
  }

  /** A small explosion: white core, licks of fire, smoke and sparks. `scale` 1 for a missile, more for a torpedo. */
  private async fireball(at: THREE.Vector3, scale: number) {
    const core = this.glow(at, hot(0xfff2d0, 5), 14 * scale);
    const fire = Array.from({ length: 4 }, () => {
      const sp = this.glow(at, hot(Math.random() < 0.5 ? 0xff7a2a : 0xffb347, 3), 12 * scale);
      sp.userData.off = new THREE.Vector3().randomDirection().multiplyScalar(8 * scale);
      return sp;
    });
    const pts = this.burst(at, hot(0xffc070, 3), Math.round(24 * scale), 50 * scale, 5);
    this.flash(at, 0xff9944, 1200 * scale, 450);
    await this.tween(520, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      core.scale.setScalar(14 * scale * (1 + e * 2.5)); core.material.opacity = Math.max(0, 1 - t * 2);
      fire.forEach((f) => { f.position.copy(at).addScaledVector(f.userData.off, e * 1.6); f.scale.setScalar(12 * scale * (1 + e * 2)); f.material.opacity = (1 - t) * (1 - t); });
      pts.update(t);
    });
    this.drop(core, ...fire);
    pts.dispose();
  }

  /**
   * Torpedo: a slow, heavy warhead that pulses as it comes, with a sparkling wake; a hit is a big flash with
   * a shockwave ring (ion torpedoes crackle too). Proton warheads glow orange-white, ion ones blue.
   */
  private async torpedoShot(fromId: string, end: THREE.Vector3, color: number, hit: boolean, ms: number) {
    const start = this.muzzle(fromId);
    if (!start) return;
    const ion = color === ION;
    const tint = ion ? ION : 0xff8a3d;
    const core = this.glow(start, hot(0xffffff, 4), 12);
    const halo = this.glow(start, hot(tint, 2.6), 34, 0.85);
    const wakeN = 26;
    const wakePos = new Float32Array(wakeN * 3);
    const wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.BufferAttribute(wakePos, 3));
    const wake = new THREE.Points(wakeGeo, new THREE.PointsMaterial({ color: hot(tint, 2.2), size: 7, map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    wake.frustumCulled = false;
    this.scene.add(wake);
    const lift = new THREE.Vector3(0, start.distanceTo(end) * 0.06, 0);
    const at = (t: number) => new THREE.Vector3().lerpVectors(start, end, t).addScaledVector(lift, Math.sin(t * Math.PI));
    this.flash(start, tint, 700, 350);
    await this.tween(ms, (t) => {
      // Slow off the launcher, then accelerating in.
      const e = t * t * (1.6 - 0.6 * t);
      const p = at(e);
      core.position.copy(p);
      halo.position.copy(p);
      halo.scale.setScalar(34 * (0.85 + 0.2 * Math.sin(t * 40)));
      for (let k = 0; k < wakeN; k++) {
        const q = at(Math.max(0, e - (k / wakeN) * 0.25)).add(new THREE.Vector3().randomDirection().multiplyScalar(k * 0.35));
        wakePos.set([q.x, q.y, q.z], k * 3);
      }
      wakeGeo.attributes.position.needsUpdate = true;
    });
    this.drop(core, halo, wake);
    if (!hit) { void this.impactFlare(end, tint, 1.2); return; }
    void this.shockwave(end, tint, 1);
    void this.fireball(end, 1.7);
    if (ion) void this.crackle(end, 24, 650);
  }

  /** A flat ring racing out along the table from a blast. */
  private async shockwave(at: THREE.Vector3, color: number, scale: number) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), this.additive(hot(color, 2.4)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at);
    this.scene.add(ring);
    await this.tween(600, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      ring.scale.setScalar(8 + 90 * scale * e);
      (ring.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.9;
    });
    this.drop(ring);
  }

  /**
   * Jamming: rings of interference travel from the jammer to the target over a crackle of static; then
   * the target glitches (its model flickers and jitters, violet static) as its token is knocked off.
   */
  async jam(fromId: string, toId: string) {
    const from = this.ships.get(fromId), to = this.ships.get(toId);
    if (!from || !to) return;
    const a = from.root.position.clone().setY(FLY_HEIGHT + 6), b = to.root.position.clone().setY(FLY_HEIGHT + 6);
    const dir = b.clone().sub(a);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    const rings = Array.from({ length: 5 }, () => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 40), this.additive(hot(JAM, 2.4), 0));
      m.quaternion.copy(q);
      this.scene.add(m);
      return m;
    });
    const n = 24;
    const staticLine = new ArcRibbon(n, hot(0xf0e0ff, 2), hot(JAM, 2), 0.35, 1.6);
    this.scene.add(staticLine);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    this.flash(a, JAM, 500, 400);
    let last = -1;
    await this.tween(850, (t) => {
      rings.forEach((r, k) => {
        const f = THREE.MathUtils.clamp(t * 1.6 - k * 0.15, 0, 1);
        r.position.lerpVectors(a, b, f);
        r.scale.setScalar(6 + 10 * Math.sin(f * Math.PI));
        (r.material as THREE.MeshBasicMaterial).opacity = f > 0 && f < 1 ? 0.85 * Math.sin(f * Math.PI) : 0;
      });
      const step = Math.floor(t * 20);
      if (step !== last) {
        last = step;
        staticLine.set(Array.from({ length: n }, (_, k) => {
          const f = k / (n - 1);
          return new THREE.Vector3().lerpVectors(a, b, f).addScaledVector(side, Math.sin(f * 30 + t * 40) * 3 + (Math.random() - 0.5) * 3);
        }));
      }
      staticLine.opacity = 0.4 * Math.sin(t * Math.PI);
    });
    rings.forEach((r) => this.drop(r));
    staticLine.dispose();
    // The target glitches.
    const pts = this.burst(b, hot(JAM, 2.6), 18, 28, 4);
    const base = to.model.position.clone();
    let lastG = -1;
    await this.tween(480, (t) => {
      pts.update(t);
      const step = Math.floor(t * 16);
      if (step === lastG) return;
      lastG = step;
      to.model.visible = t > 0.9 || Math.random() > 0.35;
      if (!this.reducedMotion) to.model.position.set(base.x + (Math.random() - 0.5) * 4 * (1 - t), base.y, base.z + (Math.random() - 0.5) * 4 * (1 - t));
    });
    to.model.visible = true;
    to.model.position.copy(base);
    pts.dispose();
  }

  /**
   * Ionized ships keep a faint flickering blue aura with stray sparks while they have ion tokens (set from
   * the ship's label refresh; animated in animateIdle).
   */
  private setIonAura(v: ShipView, on: boolean) {
    if (on === !!v.ionAura) return;
    if (!on) {
      for (const o of [...v.ionAura!.children]) {
        if (o instanceof ArcRibbon) o.dispose();
        else { o.removeFromParent(); (o as THREE.Sprite).material.dispose(); }
      }
      v.root.remove(v.ionAura!);
      v.ionAura = undefined;
      return;
    }
    const g = new THREE.Group();
    g.position.y = FLY_HEIGHT + 4;
    const r = Math.max(16, v.reach * 0.6);
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(ION, 1.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4 }));
      sp.scale.setScalar(r * 1.4);
      sp.userData.k = k;
      g.add(sp);
    }
    g.add(new ArcRibbon(5, hot(0xeefaff, 2.6), hot(ION, 2.2), 0.5, 1.9));
    g.userData.r = r;
    v.root.add(g);
    v.ionAura = g;
  }

  private animateIonAura(v: ShipView, t: number) {
    const g = v.ionAura;
    if (!g) return;
    const r = g.userData.r as number;
    for (const o of g.children) {
      if (o instanceof ArcRibbon) {
        // Now and then a stray spark arcs over the hull.
        if (!this.reducedMotion && Math.random() < 0.04) {
          o.set(jagged(new THREE.Vector3().randomDirection().multiplyScalar(r), new THREE.Vector3().randomDirection().multiplyScalar(r), 5, 4));
          o.opacity = 0.9;
        } else o.opacity *= 0.82;
        continue;
      }
      const sp = o as THREE.Sprite;
      const k = o.userData.k as number;
      sp.position.set(Math.sin(t * 2 + k * 2.1) * r * 0.3, Math.sin(t * 3 + k) * 2, Math.cos(t * 2.3 + k * 2.1) * r * 0.3);
      sp.material.opacity = this.reducedMotion ? 0.3 : 0.22 + 0.2 * Math.random();
    }
  }

  /** Blue energy bubble around a ship: its shields took the hit. Bright at the rim, ripples outward. */
  async shieldFlash(shipId: string) {
    const v = this.ships.get(shipId);
    if (!v) return;
    const mat = new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uT: { value: 0 }, uColor: { value: hot(0x5ab8ff, 2.2) } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main() { vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: `uniform float uT; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float rim = pow(clamp(1.0 - abs(dot(vN, vV)), 0.0, 1.0), 2.5);
          float hex = 0.5 + 0.5 * sin(vP.x * 0.6) * sin(vP.y * 0.6) * sin(vP.z * 0.6);
          float a = (rim * 0.9 + hex * 0.15) * (1.0 - uT);
          gl_FragColor = vec4(uColor * a, 1.0);
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(34, v.reach * 0.95), 32, 20), mat); // wraps big ships too
    m.position.copy(v.root.position).setY(FLY_HEIGHT + 4);
    this.scene.add(m);
    this.flash(m.position, 0x5ab8ff, 300, 300);
    await this.tween(420, (t) => { m.scale.setScalar(0.85 + t * 0.35); mat.uniforms.uT.value = t; });
    this.scene.remove(m);
    m.geometry.dispose();
    mat.dispose();
  }

  /** Burst of sparks: hull damage (bigger for a critical hit). */
  async sparks(shipId: string, color = 0xffa040, count = 26, big = false) {
    const v = this.ships.get(shipId);
    if (!v) return;
    // On top of the hull: from the centre, a big model hides the whole burst.
    const origin = v.root.position.clone().setY(Math.max(FLY_HEIGHT + 4, v.top - 2));
    const pts = this.burst(origin, hot(color, 2.5), big ? count * 2 : count, big ? 90 : 55, big ? 7 : 5);
    this.flash(origin, color, big ? 1100 : 500, big ? 500 : 300);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(big ? 0xffe0a0 : color, big ? 4 : 3), blending: THREE.AdditiveBlending, depthWrite: false }));
    flash.position.copy(origin);
    this.scene.add(flash);
    const flashSize = big ? 40 : 22;
    await this.tween(big ? 650 : 480, (t) => {
      pts.update(t);
      flash.scale.setScalar(flashSize * (1 + t * 2.5));
      flash.material.opacity = (1 - t) * (1 - t);
    });
    pts.dispose();
    this.scene.remove(flash);
    flash.material.dispose();
  }

  /** Points flying out from `origin`, slowing as they go. Call update(t) per frame, then dispose(). */
  private burst(origin: THREE.Vector3, color: THREE.Color, count: number, speed: number, size: number) {
    const pos = new Float32Array(count * 3);
    const vel = Array.from({ length: count }, () => new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.4 + Math.random())));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size, map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; // bounds would come from the all-zero start positions
    this.scene.add(pts);
    return {
      update: (t: number) => {
        const k = 1 - (1 - t) * (1 - t); // ease out
        vel.forEach((vv, i) => pos.set([origin.x + vv.x * k, origin.y + vv.y * k, origin.z + vv.z * k], i * 3));
        geo.attributes.position.needsUpdate = true;
        mat.opacity = 1 - t;
      },
      dispose: () => { this.scene.remove(pts); geo.dispose(); mat.dispose(); },
    };
  }

  /** Jolt the model (hull hit). */
  async shake(shipId: string, ms = 300, amp = 3) {
    const v = this.ships.get(shipId);
    if (!v || this.reducedMotion) return;
    const base = v.model.position.clone();
    await this.tween(ms, (t) => {
      const k = amp * (1 - t);
      v.model.position.set(base.x + (Math.random() - 0.5) * k * 2, base.y + (Math.random() - 0.5) * k, base.z + (Math.random() - 0.5) * k * 2);
    });
    v.model.position.copy(base);
  }

  /** Quick sideways jink: the target evaded everything. */
  async dodge(shipId: string) {
    const v = this.ships.get(shipId);
    if (!v || this.reducedMotion) return;
    const base = v.model.position.clone();
    const dir = Math.random() < 0.5 ? 1 : -1;
    await this.tween(420, (t) => {
      const k = Math.sin(t * Math.PI);
      v.model.position.set(base.x, base.y, base.z + dir * 12 * k); // model-local Z = sideways
      v.model.rotation.x = dir * -0.6 * k;
    });
    v.model.position.copy(base);
    v.model.rotation.x = 0;
  }

  /** Refresh one ship's label from a (displayed) ship state. */
  refreshLabel(s: ShipState) {
    const v = this.ships.get(s.id);
    if (v) this.updateLabel(v, s);
  }

  async animatePath(shipId: string, path: Pose[], final: Pose, ms = 900) {
    const v = this.ships.get(shipId);
    if (!v) return;
    // A ship bumped at the very start of its move gets a one-pose path: nothing to animate.
    if (path.length < 2) { placeObject(v.root, final); return; }
    await this.tween(ms, (t) => {
      v.thrust = 1 + Math.sin(t * Math.PI) * 1.4;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const f = e * (path.length - 1);
      const i = Math.min(path.length - 2, Math.floor(f));
      const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
      const k = f - i;
      let dh = b.h - a.h;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      placeObject(v.root, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, h: a.h + dh * k });
      v.model.rotation.x = Math.sin(t * Math.PI) * dh * 6; // bank into turns
    });
    v.model.rotation.x = 0;
    v.thrust = 1;
    placeObject(v.root, final);
  }

  async floatText(shipId: string, html: string, cls: string) {
    const v = this.ships.get(shipId);
    if (!v) return;
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.innerHTML = html;
    const obj = new CSS2DObject(el);
    obj.position.set(0, FLY_HEIGHT + 40, 0);
    v.root.add(obj);
    await this.tween(1000, (t) => { obj.position.y = FLY_HEIGHT + 40 + t * 30; el.style.opacity = String(1 - t * t); });
    v.root.remove(obj);
    el.remove();
  }

  /** Fireball, shockwave, flying debris and a lingering smoke puff. */
  async explode(shipId: string) {
    const v = this.ships.get(shipId);
    if (!v) return;
    const at = v.root.position.clone().setY(FLY_HEIGHT + 4);
    const tex = glowTexture();
    const sprite = (color: THREE.Color, blending: THREE.Blending = THREE.AdditiveBlending) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, blending, depthWrite: false, transparent: true }));
      sp.position.copy(at);
      this.scene.add(sp);
      return sp;
    };
    const core = sprite(hot(0xfff2d0, 6));
    const fire = Array.from({ length: 6 }, () => {
      const sp = sprite(hot(Math.random() < 0.5 ? 0xff7a2a : 0xffb347, 3));
      sp.userData.off = new THREE.Vector3().randomDirection().multiplyScalar(14);
      return sp;
    });
    const smoke = Array.from({ length: 5 }, () => {
      const sp = sprite(new THREE.Color(0x1a1a22), THREE.NormalBlending);
      sp.userData.off = new THREE.Vector3().randomDirection().multiplyScalar(22).setY(Math.random() * 10);
      return sp;
    });
    const wave = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), this.additive(hot(0xffc27a, 2.5)));
    wave.rotation.x = -Math.PI / 2;
    wave.position.copy(at);
    this.scene.add(wave);
    const debris = this.burst(at, hot(0xffd08a, 3), 70, 140, 6);
    this.flash(at, 0xff9944, 4000, 900);
    await this.tween(1100, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      core.scale.setScalar(30 + 90 * Math.min(1, t * 4));
      core.material.opacity = Math.max(0, 1 - t * 3);
      fire.forEach((f, i) => {
        f.position.copy(at).addScaledVector(f.userData.off, e * (1.5 + i * 0.2));
        f.scale.setScalar(20 + 70 * e);
        f.material.opacity = (1 - t) * (1 - t);
      });
      smoke.forEach((sm) => {
        sm.position.copy(at).addScaledVector(sm.userData.off, e * 1.8);
        sm.scale.setScalar(30 + 90 * e);
        sm.material.opacity = 0.7 * Math.sin(Math.min(1, t * 1.4) * Math.PI);
      });
      wave.scale.setScalar(10 + 130 * e);
      (wave.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 1.6);
      debris.update(t);
      v.root.scale.setScalar(Math.max(0.001, 1 - t * 2.5));
      v.model.rotation.y += 0.15;
    });
    for (const sp of [core, ...fire, ...smoke]) { this.scene.remove(sp); sp.material.dispose(); }
    this.scene.remove(wave);
    wave.geometry.dispose();
    debris.dispose();
    this.scene.remove(v.root);
    v.label.element.remove();
    this.ships.delete(shipId);
  }
}
