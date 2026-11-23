// 2D geometry for the play area. Units are millimetres. Math convention: +y is "up"
// on the board, headings are radians, forward = (cos h, sin h), left = forward rotated +90°.

export interface Vec2 { x: number; y: number }
export interface Pose { x: number; y: number; h: number }
export type Polygon = Vec2[]; // convex, counter-clockwise

export const EPS = 1e-6;

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));
export const fwd = (h: number): Vec2 => ({ x: Math.cos(h), y: Math.sin(h) });
export const leftOf = (h: number): Vec2 => fwd(h + Math.PI / 2);

export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Transform a point in a pose's local frame (x = forward, y = left) to world space. */
export function toWorld(pose: Pose, local: Vec2): Vec2 {
  const f = fwd(pose.h);
  const l = leftOf(pose.h);
  return { x: pose.x + f.x * local.x + l.x * local.y, y: pose.y + f.y * local.x + l.y * local.y };
}

/** Compose a local-frame pose onto a world pose. */
export function composePose(base: Pose, local: Pose): Pose {
  const p = toWorld(base, local);
  return { x: p.x, y: p.y, h: normalizeAngle(base.h + local.h) };
}

/** Square base polygon (CCW) for a ship centred at pose. */
export function basePolygon(pose: Pose, size: number): Polygon {
  const s = size / 2;
  return [
    toWorld(pose, vec(s, s)),   // front-left
    toWorld(pose, vec(-s, s)),  // rear-left
    toWorld(pose, vec(-s, -s)), // rear-right
    toWorld(pose, vec(s, -s)),  // front-right
  ];
}

function project(poly: Polygon, axis: Vec2): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const p of poly) {
    const d = dot(p, axis);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** Separating-axis test. Touching edges do not count as overlapping. */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
      const [amin, amax] = project(a, axis);
      const [bmin, bmax] = project(b, axis);
      const l = len(axis) || 1;
      if (amax - bmin <= EPS * l || bmax - amin <= EPS * l) return false;
    }
  }
  return true;
}

export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (cross(sub(b, a), sub(p, a)) < -EPS) return false;
  }
  return true;
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): { d: number; q: Vec2 } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const q = add(a, scale(ab, t));
  return { d: dist(p, q), q };
}

/** Closest distance between two convex polygons plus the closest points (a on A, b on B). */
export function polygonDistance(A: Polygon, B: Polygon): { d: number; a: Vec2; b: Vec2 } {
  if (polygonsOverlap(A, B)) {
    const ca = centroid(A), cb = centroid(B);
    return { d: 0, a: ca, b: cb };
  }
  let best = { d: Infinity, a: A[0], b: B[0] };
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      const r1 = pointSegmentDistance(A[i], B[j], B[(j + 1) % B.length]);
      if (r1.d < best.d) best = { d: r1.d, a: A[i], b: r1.q };
      const r2 = pointSegmentDistance(B[j], A[i], A[(i + 1) % A.length]);
      if (r2.d < best.d) best = { d: r2.d, a: r2.q, b: B[j] };
    }
  }
  return best;
}

export function centroid(poly: Polygon): Vec2 {
  const s = poly.reduce((acc, p) => add(acc, p), vec(0, 0));
  return scale(s, 1 / poly.length);
}

/** Keep the part of a convex polygon where dot(x - p, n) >= 0 (Sutherland–Hodgman, one plane). */
export function clipHalfPlane(poly: Polygon, p: Vec2, n: Vec2): Polygon {
  const out: Polygon = [];
  const side = (v: Vec2) => dot(sub(v, p), n);
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % poly.length];
    const sc = side(cur), sn = side(nxt);
    if (sc >= 0) out.push(cur);
    if ((sc >= 0) !== (sn >= 0)) {
      const t = sc / (sc - sn);
      out.push(add(cur, scale(sub(nxt, cur), t)));
    }
  }
  return out;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function segmentIntersectsPolygon(a: Vec2, b: Vec2, poly: Polygon): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}

/** Convex hull (monotone chain), returns CCW polygon. */
export function convexHull(points: Vec2[]): Polygon {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 2])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 2])) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
