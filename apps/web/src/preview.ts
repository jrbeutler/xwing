// A small turntable view of one ship model, for the squad builder. One renderer serves both the live
// view (a canvas that is moved into whichever card is selected) and still thumbnails for the picker.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildShip } from './visuals';
import { shipModelsReady, type Skin } from './shipAsset';

const TEAM = { blue: 0x57c7ff, red: 0xff9f43 } as const;

class ShipPreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  private holder = new THREE.Group();
  private shown = '';
  private running = false;
  private last = 0;
  private thumbs = new Map<string, string>();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'ship-preview';
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0x9bb7ff, 0x0b0b18, 0.8));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(-3, 5, 4);
    const rim = new THREE.DirectionalLight(0x6f8cff, 1.2);
    rim.position.set(4, 2, -5);
    this.scene.add(key, rim, this.holder);
  }

  /** Put ship type `typeId` on the turntable (no-op if it is already there). */
  show(typeId: string, skin: Skin = 'blue') {
    const key = `${typeId}|${skin}`;
    if (key === this.shown) return;
    this.shown = key;
    this.holder.clear();
    const { model } = buildShip(typeId, TEAM[skin], skin);
    // Centre and frame the hull itself (engine glow sprites would make the ship look tiny), seen from a
    // little above and ahead; the frame fits the ship at any turn of the turntable.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh && !(o as THREE.Sprite).isSprite) box.expandByObject(o); });
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    model.position.sub(sphere.center);
    this.holder.add(model);
    const d = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.78;
    this.camera.position.set(0, d * 0.45, d * 0.9);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = d / 100;
    this.camera.far = d * 10;
    this.camera.updateProjectionMatrix();
    this.holder.rotation.y = -0.6;
  }

  /** Render the live view into its canvas, turning slowly, while the canvas is on the page. */
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.canvas.isConnected) { this.running = false; return; }
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (w && h) {
        if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.holder.rotation.y += Math.min(0.05, (now - this.last) / 1000) * 0.6;
        this.renderer.render(this.scene, this.camera);
      }
      this.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** A still image of a ship type for the picker (cached per type). */
  thumbnail(typeId: string, w = 160, h = 100): string {
    const cached = this.thumbs.get(typeId);
    if (cached) return cached;
    const keep = this.shown, keepRot = this.holder.rotation.y;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.show(typeId);
    this.holder.rotation.y = -0.6;
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    this.thumbs.set(typeId, url);
    if (keep) { this.shown = ''; this.show(keep.split('|')[0], keep.split('|')[1] as Skin); this.holder.rotation.y = keepRot; }
    this.renderer.setSize(this.canvas.clientWidth || w, this.canvas.clientHeight || h, false);
    return url;
  }

  /** Imported models load in the background: drop anything drawn with the stand-in models. */
  refresh() {
    this.thumbs.clear();
    const keep = this.shown;
    this.shown = '';
    if (keep) this.show(keep.split('|')[0], keep.split('|')[1] as Skin);
  }
}

let instance: ShipPreview | null = null;
/** The shared preview (created on first use, so the battle view never pays for it). */
export function shipPreview(): ShipPreview {
  instance ??= new ShipPreview();
  return instance;
}

/** Call `cb` once the imported models are in (immediately-resolved if they already are). */
export const onModelsReady = (cb: () => void) => { void shipModelsReady.then(cb); };
