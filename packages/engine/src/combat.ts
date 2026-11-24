import {
  Polygon, Pose, basePolygon, clipHalfPlane, fwd, leftOf, polygonDistance, scale, segmentIntersectsPolygon, toWorld, vec,
} from './geometry';
import { BASE_SIZE, RANGE_BAND, TEMPLATE_WIDTH } from './maneuvers';
import { nextInt } from './rng';
import {
  attackDicePenalty, canModifyAttack, defenseDicePenalty, discardCard, drawDamageCard, hasCard,
} from './damage';
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
/** Attack dice for a shot: primary value, +1 at range 1, minus damage-card penalties. Shared with attackOdds. */
export const attackDiceFor = (attacker: ShipState, t: Pick<TargetInfo, 'attack' | 'range'>) =>
  Math.max(0, t.attack + (t.range <= 1 ? 1 : 0) - attackDicePenalty(attacker));
/** Defense dice: agility, +1 at range 3, +1 obstructed, minus damage-card penalties. Shared with attackOdds. */
export const defenseDiceFor = (defender: ShipState, t: Pick<TargetInfo, 'range' | 'obstructed'>) =>
  Math.max(0, shipType(defender).agility + (t.range === 3 ? 1 : 0) + (t.obstructed ? 1 : 0) + (stealthActive(defender) ? 1 : 0)
    - defenseDicePenalty(defender));

/** Stealth Coating: an extra defense die while its charge lasts (lost on first damage). */
const stealthActive = (sh: ShipState) => sh.upgrades.some((u) => u.id === 'stealth-coating' && u.charges > 0);

export function resolveAttack(state: GameState, attacker: ShipState, defender: ShipState, t: TargetInfo) {
  const spent: string[] = [];
  const attackDice = attackDiceFor(attacker, t);
  const defenseDice = defenseDiceFor(defender, t);
  const mods = canModifyAttack(attacker); // Blinded Pilot: no focus / lock spending

  const attackRoll = rollAttack(state, attackDice);
  let atk = [...attackRoll];
  if (mods && attacker.lock === defender.id) {
    const rerollFocus = attacker.focus === 0;
    const idx = atk.map((f, i) => (f === 'blank' || (rerollFocus && f === 'focus') ? i : -1)).filter((i) => i >= 0);
    if (idx.length) {
      const rr = rollAttack(state, idx.length);
      idx.forEach((i, k) => (atk[i] = rr[k]));
      attacker.lock = null;
      spent.push('attacker:lock');
    }
  }
  if (mods && attacker.focus > 0 && atk.includes('focus')) {
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
  const dmg = sufferDamage(state, defender, finalHits, finalCrits);
  return { attackRoll, attackFinal: atk, defenseRoll, defenseFinal: def, spent, hits: finalHits, crits: finalCrits, ...dmg };
}

// ---------------------------------------------------------------------------
// Odds: the exact outcome distribution of resolveAttack, without rolling
// ---------------------------------------------------------------------------

export interface AttackOdds {
  /** Chance of at least one damage getting through. */
  hit: number;
  /** Expected damage (hits + crits after evades), before shields/hull caps. */
  expected: number;
  /** Chance the attack destroys the defender outright. */
  kill: number;
  /** dist[k] = chance of exactly k damage. */
  dist: number[];
  attackDice: number;
  defenseDice: number;
}

const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));

/** Every way n dice with the given face weights can land, as face counts with their probability. */
function faceCounts(n: number, weights: number[]): { counts: number[]; p: number }[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const out: { counts: number[]; p: number }[] = [];
  const rec = (i: number, left: number, counts: number[]) => {
    if (i === weights.length - 1) {
      const c = [...counts, left];
      let p = fact(n);
      c.forEach((k, j) => { p *= Math.pow(weights[j] / total, k) / fact(k); });
      out.push({ counts: c, p });
      return;
    }
    for (let k = 0; k <= left; k++) rec(i + 1, left - k, [...counts, k]);
  };
  rec(0, n, []);
  return out;
}

const faceWeights = <F extends string>(die: F[], faces: F[]) => faces.map((f) => die.filter((d) => d === f).length);
const ATK_FACES: AttackFace[] = ['hit', 'crit', 'focus', 'blank'];
const DEF_FACES: DefenseFace[] = ['evade', 'focus', 'blank'];

/**
 * Exact odds for `resolveAttack(attacker, defender, t)` given both ships' current tokens. Mirrors its
 * automated policy step by step (lock reroll → attacker focus → defender focus → evade token);
 * keep the two in sync (the test suite checks them against each other).
 */
export function attackOdds(attacker: ShipState, defender: ShipState, t: Pick<TargetInfo, 'attack' | 'range' | 'obstructed'>): AttackOdds {
  // Note: dice odds only. Damage-card cascades (Direct Hit!, Fuel Leak...) are not included in `dist`.
  const attackDice = attackDiceFor(attacker, t);
  const defenseDice = defenseDiceFor(defender, t);
  const mods = canModifyAttack(attacker);
  const aw = faceWeights(ATTACK_DIE, ATK_FACES), dw = faceWeights(DEFENSE_DIE, DEF_FACES);

  // Attack: distribution of hits + crits after modification (evades cancel either, so only the total matters).
  const landed = new Map<number, number>();
  const add = (k: number, p: number) => landed.set(k, (landed.get(k) ?? 0) + p);
  const useLock = mods && attacker.lock === defender.id;
  const useFocus = mods && attacker.focus > 0;
  for (const { counts: [h, c, f, b], p } of faceCounts(attackDice, aw)) {
    const rerollFocus = attacker.focus === 0;
    const r = useLock ? b + (rerollFocus ? f : 0) : 0;
    const keptFocus = useLock && rerollFocus ? 0 : f;
    const finish = (hh: number, cc: number, ff: number, pp: number) => add(hh + cc + (useFocus ? ff : 0), pp);
    if (r === 0) finish(h, c, f, p);
    else for (const rr of faceCounts(r, aw)) finish(h + rr.counts[0], c + rr.counts[1], keptFocus + rr.counts[2], p * rr.p);
  }

  // Defense against each attack total.
  const defRolls = faceCounts(defenseDice, dw);
  const dist: number[] = Array(attackDice + 1).fill(0);
  for (const [total, pa] of landed) {
    for (const { counts: [e0, fo], p } of defRolls) {
      let e = e0;
      if (defender.focus > 0 && e < total && fo > 0) e += fo;
      if (defender.evade > 0 && e < total && e < defenseDice) e += 1;
      dist[Math.max(0, total - e)] += pa * p;
    }
  }
  const health = defender.shields + defender.hull;
  return {
    hit: 1 - dist[0],
    expected: dist.reduce((a, p, k) => a + p * k, 0),
    kill: dist.reduce((a, p, k) => a + (k >= health ? p : 0), 0),
    dist, attackDice, defenseDice,
  };
}

/**
 * Apply damage: hits before crits, shields absorb first. Each crit that reaches the hull deals a face-up
 * damage card (and may trigger cards already in play); hits just remove hull. Cards' follow-on damage
 * is applied here too, logged as `damageCard` events. Returns the dice damage only (not cascades).
 */
export function sufferDamage(s: GameState, ship: ShipState, hits: number, crits: number) {
  if (hasCard(ship, 'hullBreach')) { crits += hits; hits = 0; }
  let shieldDamage = 0, hullDamage = 0;
  const one = (crit: boolean) => {
    if (ship.hull <= 0) return;
    if (ship.shields > 0) { ship.shields--; shieldDamage++; return; }
    ship.hull--;
    hullDamage++;
    if (crit) critToHull(s, ship);
  };
  for (let i = 0; i < hits; i++) one(false);
  for (let i = 0; i < crits; i++) one(true);
  const stealth = ship.upgrades.find((u) => u.id === 'stealth-coating' && u.charges > 0);
  if (stealth && shieldDamage + hullDamage > 0) {
    stealth.charges = 0;
    s.log.push({ type: 'upgrade', shipId: ship.id, upgrade: stealth.id, what: 'spent' });
  }
  return { shieldDamage, hullDamage };
}

/** Follow-on damage from a card: applied like any other damage and logged on the card's event. */
export function cardDamage(s: GameState, ship: ShipState, ev: { shieldDamage?: number; hullDamage?: number }, hits: number) {
  const d = sufferDamage(s, ship, hits, 0);
  ev.shieldDamage = (ev.shieldDamage ?? 0) + d.shieldDamage;
  ev.hullDamage = (ev.hullDamage ?? 0) + d.hullDamage;
}

/** A crit reached the hull: cards already in play react, then a new face-up card is dealt. */
function critToHull(s: GameState, ship: ShipState) {
  if (hasCard(ship, 'fuelLeak')) {
    const ev = { type: 'damageCard' as const, shipId: ship.id, card: 'fuelLeak' as const, what: 'triggered' as const, shieldDamage: 0, hullDamage: 0 };
    s.log.push(ev);
    discardCard(s, ship, 'fuelLeak');
    cardDamage(s, ship, ev, 1);
    s.log.push({ type: 'damageCard', shipId: ship.id, card: 'fuelLeak', what: 'discarded' });
  }
  if (ship.hull <= 0) return; // destroyed: no card to deal
  const id = drawDamageCard(s);
  if (!id) return;
  ship.crits.push(id);
  const ev: Extract<GameState['log'][number], { type: 'damageCard' }> = { type: 'damageCard', shipId: ship.id, card: id, what: 'dealt' };
  s.log.push(ev);
  // Cards that act once, the moment they are dealt.
  if (id === 'panickedPilot') {
    ship.stress += 2;
    ev.stress = 2;
    discardCard(s, ship, id);
    s.log.push({ type: 'damageCard', shipId: ship.id, card: id, what: 'discarded' });
  }
  if (id === 'directHit') {
    discardCard(s, ship, id);
    cardDamage(s, ship, ev, 1);
    s.log.push({ type: 'damageCard', shipId: ship.id, card: id, what: 'discarded' });
  }
}

