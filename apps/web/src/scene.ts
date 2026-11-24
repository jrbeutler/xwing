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
import { arcTime, bakeBoardTexture, buildArcs, buildTurretPointer, buildAsteroid, buildBase, buildShip, buildSky, glowTexture, hot } from './visuals';
import { BASE_SIZE, BOARD_SIZE, DAMAGE_CARDS, SHIP_TYPES, UPGRADES, type Obstacle, type Pose, type ShipState } from '@xw/engine';

const HALF = BOARD_SIZE / 2;
const FLY_HEIGHT = 18;
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
  /** Tooltip / accessible name (defaults to the label). */
  title?: string;
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
  root: THREE.Group; model: THREE.Group; label: CSS2DObject; ring: THREE.Mesh; reach: number; top: number;
  /** Idle-animated inner group, engine glow sprites, and current thrust (1 idle, higher while flying). */
  body: THREE.Group; engines: THREE.Sprite[]; thrust: number; phase: number; typeId: string; owner: string;
  /** Firing-arc fans (hidden unless shown with showArcs). */
  arcs: THREE.Group;
  /** Ships with a turret: its arc fan (shown with the arcs) and a pointer on the base, turned to face `turretArc`. */
  turret?: { holder: THREE.Group; fan: THREE.Group; facing: string; gun?: THREE.Object3D };
}

export class BattleScene {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  labels = new CSS2DRenderer();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
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
    // Touch: one finger is reserved for playing (steering, tapping); two fingers pinch-zoom and pan.
    this.controls.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 200;
    this.controls.maxDistance = 2200;

    this.scene.add(new THREE.HemisphereLight(0x9bb7ff, 0x0b0b18, 0.7));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-400, 900, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
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
      requestAnimationFrame(loop);
    };
    loop();
  }

  private resize() {
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
    slab.position.y = -7.2;
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
      this.obstacleGroup.add(buildAsteroid(poly, i * 7.31 + 1.7));
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
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, FLY_HEIGHT, 8),
      new THREE.MeshStandardMaterial({ color: 0x5a6b85, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.55 }));
    stand.position.y = FLY_HEIGHT / 2;
    root.add(stand);
    const { model, body, engines } = buildShip(s.typeId, color, skinOf(s.owner));
    model.position.y = FLY_HEIGHT + 4;
    model.scale.setScalar(1.7); // models are enlarged for readability; bases stay true to scale
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
      const fan = buildArcs(size, ['front'], TURRET_COLOR, turretPrimary ? 300 : 200); // a turret primary reaches range 3
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
  }

  updateLabel(v: ShipView, s: ShipState) {
    const tokens = [s.focus ? `◉${s.focus > 1 ? s.focus : ''}` : '', s.evade ? '◆' : '', s.lock ? '⌖' : ''].join('');
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
  clearChips() { clearGroup(this.chips); this.chipsKey = ''; }

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
      b.title = it.title ?? it.label;
      b.setAttribute('aria-label', it.title ?? it.label);
      b.innerHTML = `${it.icon}<span class="rad-label">${it.label}</span>${it.badge !== undefined ? `<span class="rad-badge">${it.badge}</span>` : ''}`;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.disabled) it.onClick(); });
      if (it.onHover) {
        b.addEventListener('pointerenter', () => it.onHover!(true));
        b.addEventListener('pointerleave', () => it.onHover!(false));
      }
      el.appendChild(b);
    });
    if (opts.caption) {
      const c = document.createElement('div');
      c.className = 'rad-caption';
      c.innerHTML = opts.caption;
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
  setMarkers(points: { x: number; y: number; color: number; active?: boolean; ring?: number }[]) {
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

  /** The original desktop view of the whole table. */
  resetView(ms = 500) {
    this.flyTo(new THREE.Vector3(0, 0, 60), new THREE.Vector3(0, 1080, 640), ms);
  }

  /**
   * Frame a rectangle of the board (centre cx, cy; half sizes hw, hh in mm) inside the part of
   * the screen not covered by UI (insets in CSS px). `tilt` is the camera's angle from vertical.
   */
  frameRect(cx: number, cy: number, hw: number, hh: number,
    insets: { top: number; right: number; bottom: number; left: number }, tilt = 0.3, ms = 500) {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const availW = Math.max(120, w - insets.left - insets.right);
    const availH = Math.max(120, h - insets.top - insets.bottom);
    const tv = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const th = tv * (w / h);
    const d = 1.08 * Math.max(hw / (th * (availW / w)), (hh * Math.cos(tilt)) / (tv * (availH / h)));
    const mmPerPx = (2 * d * tv) / h;
    const target = toV3(cx, cy, 0);
    // Shift the look-at point so the framed area sits in the middle of the uncovered region.
    target.x += ((insets.right - insets.left) / 2) * mmPerPx;
    target.z += (((insets.bottom - insets.top) / 2) * mmPerPx) / Math.cos(tilt);
    const pos = target.clone().add(new THREE.Vector3(0, Math.cos(tilt) * d, Math.sin(tilt) * d));
    this.flyTo(target, pos, ms);
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
        fn(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
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

  /**
   * One shot flying from the attacker's nose to `end`, resolving on arrival: a laser bolt, or a slower
   * missile (glowing head with an exhaust trail) for ordnance.
   */
  async bolt(fromId: string, end: THREE.Vector3, color: number, ms = 170, style: 'laser' | 'missile' = 'laser') {
    const start = this.gunPoint(fromId);
    if (!start) return;
    if (style === 'missile') return this.missile(start, end, color, ms);
    const dir = end.clone().sub(start);
    const len = 34;
    const geo = new THREE.CylinderGeometry(1.6, 1.6, len, 8);
    geo.rotateZ(Math.PI / 2); // along +X
    const core = new THREE.Mesh(geo, this.additive(hot(0xffffff, 3)));
    const glowGeo = new THREE.CylinderGeometry(4.5, 4.5, len * 1.2, 10).rotateZ(Math.PI / 2);
    const glow = new THREE.Mesh(glowGeo, this.additive(hot(color, 2.5), 0.6));
    const g = new THREE.Group();
    g.add(core, glow);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
    // muzzle flash at the attacker's nose
    const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(color, 4), blending: THREE.AdditiveBlending, depthWrite: false }));
    muzzle.position.copy(start);
    muzzle.scale.setScalar(26);
    this.scene.add(muzzle);
    this.flash(start, color, 400, 160);
    void this.tween(160, (t) => { muzzle.scale.setScalar(26 * (1 + t)); muzzle.material.opacity = 1 - t; })
      .then(() => { this.scene.remove(muzzle); muzzle.material.dispose(); });
    this.scene.add(g);
    await this.tween(ms, (t) => g.position.lerpVectors(start, end, t));
    this.scene.remove(g);
    geo.dispose();
    glowGeo.dispose();
  }

  private async missile(start: THREE.Vector3, end: THREE.Vector3, color: number, ms: number) {
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(0xfff0d0, 2.4), blending: THREE.AdditiveBlending, depthWrite: false }));
    head.scale.setScalar(16);
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hot(color, 1.6), blending: THREE.AdditiveBlending, depthWrite: false }));
    flare.scale.setScalar(36);
    const trailN = 40;
    const trailPos = new Float32Array(trailN * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const trailMat = new THREE.PointsMaterial({ color: hot(0xffa060, 2.2), size: 16, map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const trail = new THREE.Points(trailGeo, trailMat);
    trail.frustumCulled = false; // its bounds would be computed from the all-zero start positions
    this.scene.add(head, flare, trail);
    this.flash(start, color, 300, 200);
    // A slight arc so a volley reads as missiles, not lasers.
    const lift = new THREE.Vector3(0, start.distanceTo(end) * 0.12, 0);
    const at = (t: number) => new THREE.Vector3().lerpVectors(start, end, t).addScaledVector(lift, Math.sin(t * Math.PI));
    await this.tween(ms, (t) => {
      const p = at(t);
      head.position.copy(p);
      flare.position.copy(p);
      for (let i = 0; i < trailN; i++) {
        const q = at(Math.max(0, t - (i / trailN) * 0.35));
        trailPos.set([q.x, q.y, q.z], i * 3);
      }
      trailGeo.attributes.position.needsUpdate = true;
    });
    this.scene.remove(head, flare, trail);
    head.material.dispose(); flare.material.dispose(); trailMat.dispose(); trailGeo.dispose();
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
    if (!v || !path.length) return;
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
