import {
  Polygon, Pose, basePolygon, clipHalfPlane, fwd, leftOf, polygonDistance, scale, segmentIntersectsPolygon, toWorld, vec,
} from './geometry';
import { BASE_SIZE, RANGE_BAND, TEMPLATE_WIDTH } from './maneuvers';
import { nextInt } from './rng';
import { SHIP_TYPES } from './content';
import type { ArcName, AttackFace, DefenseFace, GameState, Obstacle, ShipState, TargetInfo } from './types';

export const ATTACK_DIE: AttackFace[] = ['hit', 'hit', 'hit', 'crit', 'focus', 'focus', 'blank', 'blank'];
export const DEFENSE_DIE: DefenseFace[] = ['evade', 'evade', 'evade', 'focus', 'focus', 'blank', 'blank', 'blank'];

export const shipType = (s: ShipState) => SHIP_TYPES[s.typeId];
export const shipSize = (s: ShipState) => BASE_SIZE[shipType(s).size];
export const shipPolygon = (s: ShipState, pose: Pose = s.pose) => basePolygon(pose, shipSize(s));

/** Range band for a distance in mm: 0 when touching, null beyond range 3. */
export function rangeBand(d: number): number | null {
  if (d <= 1e-6) return 0;
  if (d > RANGE_BAND * 3) return null;
  return Math.ceil(d / RANGE_BAND);
}

/**
 * Clip a target polygon to a firing arc. Arcs on square bases are 90° wedges bounded
 * by lines from the base centre through the corners.
 */
export function clipToArc(attackerPose: Pose, arc: ArcName, target: Polygon): Polygon {
  const facing = arc === 'front' ? attackerPose.h : attackerPose.h + Math.PI;
  const c = vec(attackerPose.x, attackerPose.y);
  // Wedge = intersection of two half-planes through the centre at ±45°.
  const n1 = fwd(facing + Math.PI / 4 - Math.PI / 2); // inward normal of the left boundary
  const n2 = fwd(facing - Math.PI / 4 + Math.PI / 2); // inward normal of the right boundary
  return clipHalfPlane(clipHalfPlane(target, c, n1), c, n2);
}

/** Bullseye: a strip as wide as a template extending straight out of the front edge. */
export function clipToBullseye(attackerPose: Pose, size: number, target: Polygon): Polygon {
  const f = fwd(attackerPose.h), l = leftOf(attackerPose.h);
  const front = toWorld(attackerPose, vec(size / 2, 0));
  const w = TEMPLATE_WIDTH / 2;
  let p = clipHalfPlane(target, front, f);
  p = clipHalfPlane(p, toWorld(attackerPose, vec(0, w)), scale(l, -1));
  p = clipHalfPlane(p, toWorld(attackerPose, vec(0, -w)), l);
  return p;
}

export function isObstructed(a: { x: number; y: number }, b: { x: number; y: number }, obstacles: Obstacle[]): boolean {
  return obstacles.some((o) => segmentIntersectsPolygon(a, b, o.polygon));
}

/** Measure attacker → target for a given arc. Null if target is not in that arc or out of range. */
export function measureArc(state: GameState, attacker: ShipState, target: ShipState, arc: ArcName) {
  const tPoly = shipPolygon(target);
  const inArc = clipToArc(attacker.pose, arc, tPoly);
  if (inArc.length < 3) return null;
  const m = polygonDistance(shipPolygon(attacker), inArc);
  const range = rangeBand(m.d);
  if (range === null) return null;
  const bull = arc === 'front' && clipToBullseye(attacker.pose, shipSize(attacker), tPoly).length >= 3;
  return { range, obstructed: m.d > 0 && isObstructed(m.a, m.b, state.obstacles), bullseye: bull };
}

/** Base-to-base range regardless of arcs (used by lock). */
export function rangeBetween(a: ShipState, b: ShipState): number | null {
  return rangeBand(polygonDistance(shipPolygon(a), shipPolygon(b)).d);
}

export function legalTargets(state: GameState, attacker: ShipState): TargetInfo[] {
  const out: TargetInfo[] = [];
  for (const t of state.ships) {
    if (t.owner === attacker.owner || t.destroyed) continue;
    let best: TargetInfo | null = null;
    for (const w of shipType(attacker).primaries) {
      const m = measureArc(state, attacker, t, w.arc);
      if (!m) continue;
      const cand: TargetInfo = { targetId: t.id, arc: w.arc, attack: w.attack, ...m };
      if (!best || cand.attack > best.attack || (cand.attack === best.attack && cand.range < best.range)) best = cand;
    }
    if (best) out.push(best);
  }
  return out;
}

export function rollAttack(state: GameState, n: number): AttackFace[] {
  return Array.from({ length: Math.max(0, n) }, () => ATTACK_DIE[nextInt(state, 8)]);
}
export function rollDefense(state: GameState, n: number): DefenseFace[] {
  return Array.from({ length: Math.max(0, n) }, () => DEFENSE_DIE[nextInt(state, 8)]);
}

/**
 * Resolve one primary attack. Dice modification is automated for now with a sensible
 * policy (lock reroll → focus → defender focus → evade token); interactive mods come later.
 */
export function resolveAttack(state: GameState, attacker: ShipState, defender: ShipState, t: TargetInfo) {
  const spent: string[] = [];
  const attackDice = t.attack + (t.range <= 1 ? 1 : 0);
  const defenseDice = shipType(defender).agility + (t.range === 3 ? 1 : 0) + (t.obstructed ? 1 : 0);

  const attackRoll = rollAttack(state, attackDice);
  let atk = [...attackRoll];
  if (attacker.lock === defender.id) {
    const rerollFocus = attacker.focus === 0;
    const idx = atk.map((f, i) => (f === 'blank' || (rerollFocus && f === 'focus') ? i : -1)).filter((i) => i >= 0);
    if (idx.length) {
      const rr = rollAttack(state, idx.length);
      idx.forEach((i, k) => (atk[i] = rr[k]));
      attacker.lock = null;
      spent.push('attacker:lock');
    }
  }
  if (attacker.focus > 0 && atk.includes('focus')) {
    atk = atk.map((f) => (f === 'focus' ? 'hit' : f));
    attacker.focus--;
    spent.push('attacker:focus');
  }
  const hits = atk.filter((f) => f === 'hit').length;
  const crits = atk.filter((f) => f === 'crit').length;

  const defenseRoll = rollDefense(state, defenseDice);
  let def = [...defenseRoll];
  const evades = () => def.filter((f) => f === 'evade').length;
  if (defender.focus > 0 && evades() < hits + crits && def.includes('focus')) {
    def = def.map((f) => (f === 'focus' ? 'evade' : f));
    defender.focus--;
    spent.push('defender:focus');
  }
  if (defender.evade > 0 && evades() < hits + crits) {
    const i = def.findIndex((f) => f !== 'evade');
    if (i >= 0) {
      def[i] = 'evade';
      defender.evade--;
      spent.push('defender:evade');
    }
  }

  let e = evades();
  const finalHits = Math.max(0, hits - e);
  e = Math.max(0, e - hits);
  const finalCrits = Math.max(0, crits - e);
  const dmg = dealDamage(defender, finalHits, finalCrits);
  return { attackRoll, attackFinal: atk, defenseRoll, defenseFinal: def, spent, hits: finalHits, crits: finalCrits, ...dmg };
}

/** Shields absorb damage first (hits, then crits); the rest is hull damage. */
export function dealDamage(ship: ShipState, hits: number, crits: number) {
  const total = hits + crits;
  const shieldDamage = Math.min(ship.shields, total);
  ship.shields -= shieldDamage;
  const hullDamage = Math.min(ship.hull, total - shieldDamage);
  ship.hull -= hullDamage;
  return { shieldDamage, hullDamage };
}
