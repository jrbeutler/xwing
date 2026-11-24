import { Pose, composePose, normalizeAngle } from './geometry';

// ---------------------------------------------------------------------------
// Table measurements (mm). Values are approximations of the physical templates
// and live in one place so they can be tuned against real components.
// ---------------------------------------------------------------------------
export const BOARD_SIZE = 914; // 3' x 3'
export const RANGE_BAND = 100; // each range band on the range ruler
export const STRAIGHT_UNIT = 40; // straight template length per speed
export const TEMPLATE_WIDTH = 20;
/** Centre-line radius of bank (45°) templates, indexed by speed. */
export const BANK_RADIUS = [0, 80, 130, 180];
/** Centre-line radius of turn (90°) templates, indexed by speed. */
export const TURN_RADIUS = [0, 35, 62.5, 90];
export const BASE_SIZE = { small: 40, medium: 60, large: 80 } as const;
export type BaseSize = keyof typeof BASE_SIZE;

export type Bearing =
  | 'straight' | 'bankLeft' | 'bankRight' | 'turnLeft' | 'turnRight'
  | 'kturn' | 'sloopLeft' | 'sloopRight' | 'trollLeft' | 'trollRight'
  | 'stop' | 'reverseStraight' | 'reverseBankLeft' | 'reverseBankRight';
export type Difficulty = 'blue' | 'white' | 'red';

export interface Maneuver { bearing: Bearing; speed: number; difficulty: Difficulty }

const CODES: Record<string, Bearing> = {
  S: 'straight', BL: 'bankLeft', BR: 'bankRight', TL: 'turnLeft', TR: 'turnRight',
  K: 'kturn', SL: 'sloopLeft', SR: 'sloopRight', RL: 'trollLeft', RR: 'trollRight',
  X: 'stop', RS: 'reverseStraight', RBL: 'reverseBankLeft', RBR: 'reverseBankRight',
};
const DIFF: Record<string, Difficulty> = { b: 'blue', w: 'white', r: 'red' };

/** Parse a compact dial: "1BL:b 1S:b 2TL:w 4K:r" */
export function parseDial(spec: string): Maneuver[] {
  return spec.trim().split(/\s+/).map((tok) => {
    const m = /^(\d)([A-Z]+):([bwr])$/.exec(tok);
    if (!m || !CODES[m[2]]) throw new Error(`Bad maneuver token: ${tok}`);
    return { speed: Number(m[1]), bearing: CODES[m[2]], difficulty: DIFF[m[3]] };
  });
}

export function maneuverLabel(m: Maneuver): string {
  const code = Object.entries(CODES).find(([, b]) => b === m.bearing)?.[0] ?? m.bearing;
  return `${m.speed}${code}`;
}

type Shape = { kind: 'straight' } | { kind: 'arc'; radius: number; angle: number; side: 1 | -1 };

function templateShape(bearing: Bearing, speed: number): Shape {
  switch (bearing) {
    case 'straight': case 'kturn': case 'reverseStraight':
      return { kind: 'straight' };
    case 'bankLeft': case 'sloopLeft':
      return { kind: 'arc', radius: BANK_RADIUS[speed], angle: Math.PI / 4, side: 1 };
    case 'bankRight': case 'sloopRight':
      return { kind: 'arc', radius: BANK_RADIUS[speed], angle: Math.PI / 4, side: -1 };
    case 'turnLeft': case 'trollLeft':
      return { kind: 'arc', radius: TURN_RADIUS[speed], angle: Math.PI / 2, side: 1 };
    case 'turnRight': case 'trollRight':
      return { kind: 'arc', radius: TURN_RADIUS[speed], angle: Math.PI / 2, side: -1 };
    default:
      throw new Error(`No template for ${bearing}`);
  }
}

/** Point on a template centre-line, in the template's local frame (start at origin, heading +x). */
function templatePoint(shape: Shape, speed: number, u: number): Pose {
  if (shape.kind === 'straight') return { x: u * STRAIGHT_UNIT * speed, y: 0, h: 0 };
  const phi = u * shape.angle;
  return { x: shape.radius * Math.sin(phi), y: shape.side * shape.radius * (1 - Math.cos(phi)), h: shape.side * phi };
}

function templateLength(shape: Shape, speed: number): number {
  return shape.kind === 'straight' ? STRAIGHT_UNIT * speed : shape.radius * shape.angle;
}

export interface ManeuverPath {
  /** Ship-centre poses from start to full completion (before any final rotation). */
  path: Pose[];
  /** Extra rotation applied only if the maneuver completes fully (K-turn, loops, rolls). */
  finalRotation: number;
}

const REVERSE_MIRROR: Partial<Record<Bearing, Bearing>> = {
  reverseStraight: 'straight', reverseBankLeft: 'bankRight', reverseBankRight: 'bankLeft',
};

/**
 * Sample the ship-centre path for a maneuver. The ship first slides forward until
 * its rear sits at the template start, then follows the template so its rear rides
 * the centre-line. This path is also what a bumped ship backs up along.
 */
export function maneuverPath(start: Pose, baseSize: number, m: Maneuver, stepMm = 2): ManeuverPath {
  if (m.bearing === 'stop' || m.speed === 0) return { path: [start], finalRotation: 0 };

  const mirrored = REVERSE_MIRROR[m.bearing];
  if (mirrored) {
    // Reverse = flip the ship, fly the mirrored forward template, flip back.
    const flipped = { ...start, h: normalizeAngle(start.h + Math.PI) };
    const r = maneuverPath(flipped, baseSize, { ...m, bearing: mirrored }, stepMm);
    return { path: r.path.map((p) => ({ ...p, h: normalizeAngle(p.h + Math.PI) })), finalRotation: 0 };
  }

  const shape = templateShape(m.bearing, m.speed);
  const L = baseSize;
  const tLen = templateLength(shape, m.speed);
  const total = L + tLen;
  const n = Math.max(2, Math.ceil(total / stepMm));
  const path: Pose[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total;
    let local: Pose;
    if (s <= L) {
      local = { x: s, y: 0, h: 0 };
    } else {
      const tp = templatePoint(shape, m.speed, (s - L) / tLen);
      // template starts at the original front edge (L/2); rear rides the curve
      const rear = { x: L / 2 + tp.x, y: tp.y };
      local = { x: rear.x + Math.cos(tp.h) * L / 2, y: rear.y + Math.sin(tp.h) * L / 2, h: tp.h };
    }
    path.push(composePose(start, local));
  }

  let finalRotation = 0;
  if (m.bearing === 'kturn' || m.bearing === 'sloopLeft' || m.bearing === 'sloopRight') finalRotation = Math.PI;
  if (m.bearing === 'trollLeft') finalRotation = Math.PI / 2;
  if (m.bearing === 'trollRight') finalRotation = -Math.PI / 2;
  return { path, finalRotation };
}

/** Where the ship ends if nothing gets in the way. */
export function maneuverFinalPose(start: Pose, baseSize: number, m: Maneuver): Pose {
  const { path, finalRotation } = maneuverPath(start, baseSize, m);
  const last = path[path.length - 1];
  return { ...last, h: normalizeAngle(last.h + finalRotation) };
}
