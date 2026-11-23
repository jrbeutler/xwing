// Three.js presentation layer. Knows nothing about rules; it only draws poses from the engine.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BASE_SIZE, BOARD_SIZE, SHIP_TYPES, type Obstacle, type Pose, type ShipState } from '@xw/engine';

const HALF = BOARD_SIZE / 2;
const FLY_HEIGHT = 18;
export const COLORS: Record<string, number> = { p1: 0x57c7ff, p2: 0xff9f43 };

/** Board (x, y) in mm → three.js world. */
export const toV3 = (x: number, y: number, z = 0) => new THREE.Vector3(x - HALF, z, -(y - HALF));

export function placeObject(o: THREE.Object3D, p: Pose) {
  o.position.copy(toV3(p.x, p.y, o.position.y));
  o.rotation.y = p.h;
}

function shipModel(typeId: string, color: number): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xcfd6e3, metalness: 0.4, roughness: 0.45 });
  const trim = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4, emissive: color, emissiveIntensity: 0.15 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  if (typeId === 'kestrel') {
    add(new THREE.ConeGeometry(4, 34, 10), hull, 2, 0, 0, -Math.PI / 2);
    add(new THREE.BoxGeometry(12, 1.5, 34), trim, -4, 0, 0);
    add(new THREE.BoxGeometry(6, 6, 1.2), hull, -10, 3, 16);
    add(new THREE.BoxGeometry(6, 6, 1.2), hull, -10, 3, -16);
    add(new THREE.SphereGeometry(2.2, 8, 8), glow, -15, 0, 0);
  } else if (typeId === 'wasp') {
    add(new THREE.SphereGeometry(6, 14, 10), hull, 0, 0, 0);
    add(new THREE.CylinderGeometry(4, 4, 2, 6), trim, 6, 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(14, 22, 1.2), trim, -2, 0, 12);
    add(new THREE.BoxGeometry(14, 22, 1.2), trim, -2, 0, -12);
    add(new THREE.BoxGeometry(2, 2, 24), hull, 0, 0, 0);
  } else {
    add(new THREE.BoxGeometry(44, 9, 22), hull, 0, 0, 0);
    add(new THREE.BoxGeometry(18, 7, 14), trim, 8, 6, 0);
    add(new THREE.ConeGeometry(6, 14, 8), hull, 26, 0, 0, -Math.PI / 2);
    add(new THREE.BoxGeometry(6, 4, 40), trim, -14, 0, 0);
    add(new THREE.SphereGeometry(3, 8, 8), glow, -23, 0, 6);
    add(new THREE.SphereGeometry(3, 8, 8), glow, -23, 0, -6);
  }
  return g;
}

function baseMesh(size: number, color: number, arcs: string[]): THREE.Group {
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(size, 2, size),
    new THREE.MeshStandardMaterial({ color: 0x111827, transparent: true, opacity: 0.9 }),
  );
  plate.position.y = 1;
  plate.receiveShadow = true;
  g.add(plate);
  const s = size / 2;
  const pts: number[] = [];
  const line = (a: [number, number], b: [number, number]) => pts.push(a[0], 2.2, -a[1], b[0], 2.2, -b[1]);
  line([s, s], [-s, s]); line([-s, s], [-s, -s]); line([-s, -s], [s, -s]); line([s, -s], [s, s]);
  if (arcs.includes('front')) { line([0, 0], [s, s]); line([0, 0], [s, -s]); }
  if (arcs.includes('rear')) { line([0, 0], [-s, s]); line([0, 0], [-s, -s]); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color })));
  // front notch
  const notch = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 3), new THREE.MeshBasicMaterial({ color }));
  notch.rotation.z = -Math.PI / 2;
  notch.position.set(s - 4, 2.5, 0);
  g.add(notch);
  return g;
}

export interface ShipView { root: THREE.Group; model: THREE.Group; label: CSS2DObject; ring: THREE.Mesh }

export class BattleScene {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  labels = new CSS2DRenderer();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
  controls: OrbitControls;
  ships = new Map<string, ShipView>();
  ghost = new THREE.Group();
  overlay = new THREE.Group();
  private obstacleGroup = new THREE.Group();

  constructor(private host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);
    this.labels.domElement.style.position = 'absolute';
    this.labels.domElement.style.inset = '0';
    this.labels.domElement.style.pointerEvents = 'none';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x03050a);
    this.camera.position.set(0, 1080, 640);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 60);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 200;
    this.controls.maxDistance = 2200;

    this.scene.add(new THREE.HemisphereLight(0x9bb7ff, 0x0b0b18, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-400, 900, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, far: 2500 });
    this.scene.add(sun);

    this.buildBoard();
    this.buildStars();
    this.scene.add(this.obstacleGroup, this.ghost, this.overlay);

    addEventListener('resize', () => this.resize());
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private buildBoard() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0a1222, roughness: 0.95 });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_SIZE, BOARD_SIZE), mat);
    board.rotation.x = -Math.PI / 2;
    board.receiveShadow = true;
    this.scene.add(board);
    const grid = new THREE.GridHelper(BOARD_SIZE, 9, 0x1c2a48, 0x14203a);
    grid.position.y = 0.2;
    this.scene.add(grid);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BOARD_SIZE, 0.1, BOARD_SIZE)),
      new THREE.LineBasicMaterial({ color: 0x3a5486 }),
    );
    this.scene.add(edge);
  }

  private buildStars() {
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2500 + Math.random() * 800);
      v.y = Math.abs(v.y) * 0.8 - 400;
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false })));
  }

  setObstacles(obstacles: Obstacle[]) {
    this.obstacleGroup.clear();
    for (const o of obstacles) {
      const shape = new THREE.Shape(o.polygon.map((p) => new THREE.Vector2(p.x - HALF, p.y - HALF)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 22, bevelEnabled: true, bevelSize: 4, bevelThickness: 6, bevelSegments: 2 });
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * (0.8 + Math.random() * 0.5));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5b5148, roughness: 1, flatShading: true }));
      mesh.castShadow = mesh.receiveShadow = true;
      this.obstacleGroup.add(mesh);
    }
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
      this.updateLabel(v, s);
    }
  }

  private createShip(s: ShipState): ShipView {
    const t = SHIP_TYPES[s.typeId];
    const size = BASE_SIZE[t.size];
    const color = COLORS[s.owner] ?? 0xffffff;
    const root = new THREE.Group();
    root.add(baseMesh(size, color, t.primaries.map((p) => p.arc)));
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, FLY_HEIGHT, 6), new THREE.MeshBasicMaterial({ color: 0x334155 }));
    stand.position.y = FLY_HEIGHT / 2;
    root.add(stand);
    const model = shipModel(s.typeId, color);
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
    const label = new CSS2DObject(el);
    label.position.set(0, FLY_HEIGHT + 34, 0);
    root.add(label);
    this.scene.add(root);
    const v = { root, model, label, ring };
    this.ships.set(s.id, v);
    return v;
  }

  updateLabel(v: ShipView, s: ShipState) {
    const tokens = [s.focus ? `◉${s.focus > 1 ? s.focus : ''}` : '', s.evade ? '◆' : '', s.lock ? '⌖' : ''].join('');
    v.label.element.innerHTML =
      `<div class="${s.owner}">${s.name} <b>${s.initiative}</b></div>` +
      `<div class="pips"><span class="sh">${'●'.repeat(s.shields)}</span><span class="hu">${'■'.repeat(s.hull)}</span>` +
      `${s.stress ? `<span class="st"> ⚠${s.stress}</span>` : ''} ${tokens}</div>`;
  }

  clearShips() {
    for (const v of this.ships.values()) { this.scene.remove(v.root); v.label.element.remove(); }
    this.ships.clear();
  }

  highlight(shipId: string | null) {
    for (const [id, v] of this.ships) v.ring.visible = id === shipId;
  }

  showGhost(size: number, poses: Pose[], color = 0x7cf0c5) {
    this.clearGhost();
    if (!poses.length) return;
    const final = poses[poses.length - 1];
    const s = size / 2;
    const sq = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(s, 3, -s), new THREE.Vector3(-s, 3, -s), new THREE.Vector3(-s, 3, s), new THREE.Vector3(s, 3, s),
      ]),
      new THREE.LineBasicMaterial({ color }),
    );
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 2.5;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(4, 10, 3), new THREE.MeshBasicMaterial({ color }));
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(s + 6, 3, 0);
    const g = new THREE.Group();
    g.add(sq, fill, nose);
    placeObject(g, final);
    this.ghost.add(g);
    if (poses.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(poses.map((p) => toV3(p.x, p.y, 3))),
        new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4 }),
      );
      line.computeLineDistances();
      this.ghost.add(line);
    }
  }

  clearGhost() { this.ghost.clear(); }

  showLine(a: Pose, b: Pose, color: number) {
    this.overlay.clear();
    this.overlay.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([toV3(a.x, a.y, FLY_HEIGHT + 4), toV3(b.x, b.y, FLY_HEIGHT + 4)]),
      new THREE.LineBasicMaterial({ color }),
    ));
  }
  clearOverlay() { this.overlay.clear(); }

  // ---------------- animations ----------------
  tween(ms: number, fn: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / ms);
        fn(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async animatePath(shipId: string, path: Pose[], final: Pose, ms = 900) {
    const v = this.ships.get(shipId);
    if (!v || !path.length) return;
    await this.tween(ms, (t) => {
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
    placeObject(v.root, final);
  }

  async laser(fromId: string, toId: string, color: number) {
    const a = this.ships.get(fromId), b = this.ships.get(toId);
    if (!a || !b) return;
    const p = a.root.position.clone().setY(FLY_HEIGHT + 4);
    const q = b.root.position.clone().setY(FLY_HEIGHT + 4);
    for (let i = 0; i < 3; i++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, q.clone().add(off)]), new THREE.LineBasicMaterial({ color, transparent: true }));
      this.scene.add(line);
      await this.tween(110, (t) => ((line.material as THREE.LineBasicMaterial).opacity = 1 - t));
      this.scene.remove(line);
    }
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

  async explode(shipId: string) {
    const v = this.ships.get(shipId);
    if (!v) return;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true }));
    ball.position.copy(v.root.position).setY(FLY_HEIGHT + 4);
    this.scene.add(ball);
    await this.tween(600, (t) => {
      ball.scale.setScalar(1 + t * 4);
      (ball.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      v.root.scale.setScalar(1 - t);
    });
    this.scene.remove(ball);
    this.scene.remove(v.root);
    v.label.element.remove();
    this.ships.delete(shipId);
  }
}
