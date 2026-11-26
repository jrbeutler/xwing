import {
  Polygon, Pose, basePolygon, clipHalfPlane, fwd, leftOf, polygonDistance, scale, segmentIntersectsPolygon, toWorld, vec,
} from './geometry';
import { BASE_SIZE, RANGE_BAND, TEMPLATE_WIDTH } from './maneuvers';
import { nextInt } from './rng';
import {
  attackDicePenalty, canModifyAttack, defenseDicePenalty, discardCard, drawDamageCard, hasCard,
} from './damage';
import { SHIP_TYPES, UPGRADES } from './content';
import { AttackFacts, attackEffects, diceDelta, payFor, runTriggers } from './effects';
import type { ArcName, AttackFace, DefenseFace, GameState, Obstacle, ShipState, TargetInfo } from './types';

/**
 * House rule: primary weapons roll one extra attack die at this range (the board game gives it at range 0-1).
 * Rewarding range 2 instead keeps fights from collapsing into knife-fights.
 */
export const SWEET_SPOT_RANGE = 2;

export const ATTACK_DIE: AttackFace[] = ['hit', 'hit', 'hit', 'crit', 'focus', 'focus', 'blank', 'blank'];
export const DEFENSE_DIE: DefenseFace[] = ['evade', 'evade', 'evade', 'focus', 'focus', 'blank', 'blank', 'blank'];

export const shipType = (s: ShipState) => SHIP_TYPES[s.typeId];
export const shipSize = (s: ShipState) => BASE_SIZE[shipType(s).size];
export const shipPolygon = (s: ShipState, pose: Pose = s.pose) => basePolygon(pose, shipSize(s));

/**
 * The range rules in one place. `edges` are the far edge of each band in mm (range 1, 2, ...); primaries
 * reach the last one. `attack` / `defense` are the dice modifiers for a primary-weapon shot at each band
 * (0 = touching). Mutable so experiments can compare rule sets; the game uses the defaults.
 *
 * House rules, four bands (the board game has three 10 cm bands with +1 attack die at range 0-1 and +1
 * defense die at range 3):
 *   range 1 (0-6 cm)    -1 attack die: too close to track the target
 *   range 2 (6-16 cm)   +1 attack die: the sweet spot
 *   range 3 (16-26 cm)  no modifier
 *   range 4 (26-36 cm)  +1 defense die: long range
 * In 200 AI-vs-AI games this cut range-1 shots from 21% to 9% versus the three-band rules.
 */
export const RANGE_RULES: { edges: number[]; attack: Record<number, number>; defense: Record<number, number> } = {
  edges: [60, 160, 260, 360],
  attack: { 0: -1, 1: -1, [SWEET_SPOT_RANGE]: 1 },
  defense: { 4: 1 },
};
/** Furthest range band (primary weapons, locks). */
export const maxRangeBand = () => RANGE_RULES.edges.length;

/** Range band for a distance in mm: 0 when touching, null beyond the last band. */
export function rangeBand(d: number): number | null {
  if (d <= 1e-6) return 0;
  const i = RANGE_RULES.edges.findIndex((e) => d <= e);
  return i < 0 ? null : i + 1;
}

/**
 * Clip a target polygon to a firing arc. Arcs on square bases are 90° wedges bounded
 * by lines from the base centre through the corners.
 */
/** Heading offset of each arc from the ship's facing (board y is left of x, so left is +90°). */
export const ARC_OFFSET: Record<ArcName, number> = { front: 0, left: Math.PI / 2, rear: Math.PI, right: -Math.PI / 2 };

export function clipToArc(attackerPose: Pose, arc: ArcName, target: Polygon): Polygon {
  const facing = attackerPose.h + ARC_OFFSET[arc];
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
      const turret = w.arc === 'turret';
      const arc: ArcName = turret ? attacker.turretArc : w.arc as ArcName;
      const m = measureArc(state, attacker, t, arc);
      if (!m) continue;
      // A turret primary is not a front-arc attack, so it has no bullseye.
      const cand: TargetInfo = { targetId: t.id, arc, attack: w.attack, ...m, ...(turret ? { bullseye: false, turret: true } : {}) };
      if (!best || cand.attack > best.attack || (cand.attack === best.attack && cand.range < best.range)) best = cand;
    }
    if (best) out.push(best);
    // Secondary weapons: loaded, in their range band and arc (front, or the turret's), requirement met.
    for (const u of attacker.upgrades) {
      const w = UPGRADES[u.id].weapon;
      if (!w || !hasAmmo(u)) continue;
      if (w.requires === 'lock' && attacker.lock !== t.id) continue;
      const arc: ArcName = w.arc === 'turret' ? attacker.turretArc : 'front';
      const m = measureArc(state, attacker, t, arc);
      if (!m || m.range < w.minRange || m.range > w.maxRange) continue;
      const turret = w.arc === 'turret';
      out.push({ targetId: t.id, arc, attack: w.attack, ...m, bullseye: !turret && arc === 'front' && m.bullseye, weapon: u.id, ...(turret ? { turret } : {}) });
    }
  }
  return out;
}

/** Weapons with charges need one left; turrets (no charges) never run out. */
export const hasAmmo = (u: { id: string; charges: number }) => UPGRADES[u.id].charges === undefined || u.charges > 0;

/** Whether a target entry is a primary attack (range bonuses and bullseye talents apply only to those). */
export const isPrimary = (t: Pick<TargetInfo, 'weapon'>) => !t.weapon || t.weapon === 'primary';
const weaponOf = (t: Pick<TargetInfo, 'weapon'>) => (isPrimary(t) ? undefined : UPGRADES[t.weapon!].weapon);

export function rollAttack(state: GameState, n: number): AttackFace[] {
  return Array.from({ length: Math.max(0, n) }, () => ATTACK_DIE[nextInt(state, 8)]);
}
export function rollDefense(state: GameState, n: number): DefenseFace[] {
  return Array.from({ length: Math.max(0, n) }, () => DEFENSE_DIE[nextInt(state, 8)]);
}

/** The attack-shaped part of a target entry: what the dice and effect rules need to know about a shot. */
export type ShotInfo = Pick<TargetInfo, 'range' | 'obstructed'> & Partial<Pick<TargetInfo, 'attack' | 'arc' | 'weapon' | 'turret' | 'bullseye'>>;

/**
 * The facts effect conditions test (AttackCondition). `outsideDefenderArcs` is only measured if an effect
 * asks for it, and is false when the attacker is not known.
 */
export function attackFacts(t: ShotInfo, defender: ShipState, attacker?: ShipState): AttackFacts {
  const turret = !!t.turret || weaponOf(t)?.arc === 'turret';
  let outside: boolean | undefined;
  return {
    primary: isPrimary(t), turret, bullseye: !!t.bullseye, frontArc: (t.arc ?? 'front') === 'front' && !turret,
    get outsideDefenderArcs() { return (outside ??= !!attacker && !inFiringArc(defender, attacker)); },
  };
}

/**
 * Attack dice for a shot: weapon value, range modifier (primary only), effects (when the defender is known),
 * minus damage-card penalties. Shared with attackOdds.
 */
export const attackDiceFor = (attacker: ShipState, t: Pick<TargetInfo, 'attack'> & ShotInfo, defender?: ShipState) =>
  Math.max(0, t.attack + (isPrimary(t) ? RANGE_RULES.attack[t.range] ?? 0 : 0) - attackDicePenalty(attacker)
    + (defender ? diceDelta('attack', attackFacts(t, defender, attacker), attacker, defender) : 0));
/**
 * Defense dice: agility, range modifier (primary only), +1 obstructed, both ships' dice effects (Stealth Coating,
 * an Outmaneuver attacker), minus damage-card penalties. Without `attacker`, only the defender's effects count.
 * Shared with attackOdds.
 */
export const defenseDiceFor = (defender: ShipState, t: ShotInfo, attacker?: ShipState) =>
  Math.max(0, shipType(defender).agility + (isPrimary(t) ? RANGE_RULES.defense[t.range] ?? 0 : 0) + (t.obstructed ? 1 : 0)
    + diceDelta('defense', attackFacts(t, defender, attacker), attacker, defender) - defenseDicePenalty(defender));

/** Attack dice to reroll for the attacker's reroll effects (e.g. Marksman), before any lock. */
const rerollCount = (fx: { effect: { dice: number } }[]) => fx.reduce((a, x) => a + x.effect.dice, 0);

/** A fitted upgrade, optionally only if it still has a charge. */
export const upgradeOf = (sh: ShipState, id: string, needCharge = false) =>
  sh.upgrades.find((u) => u.id === id && (!needCharge || u.charges > 0));

/** Whether `target` sits in any of `from`'s firing arcs (at any range). */
export const inFiringArc = (from: ShipState, target: ShipState) =>
  shipType(from).primaries.some((w) => clipToArc(from.pose, w.arc === 'turret' ? from.turretArc : w.arc, shipPolygon(target)).length >= 3);

/**
 * Whether `ship` can still be shot this round: an enemy that has not fired yet in this Engagement phase
 * (or any enemy, outside it) has it in a primary arc and in range. Measured against `ship` as passed, so
 * a planning ghost works too.
 */
export function stillThreatened(state: GameState, ship: ShipState): boolean {
  if (!state.ships || state.phase === 'over' || state.phase === 'end') return false;
  const waiting = state.phase === 'engagement' ? new Set(state.queue.slice(state.queueIndex + 1)) : null;
  return state.ships.some((e) => e.owner !== ship.owner && !e.removed && e.id !== ship.id && (!waiting || waiting.has(e.id)) &&
    shipType(e).primaries.some((w) => measureArc(state, e, ship, w.arc === 'turret' ? e.turretArc : w.arc as ArcName) !== null));
}

/**
 * How the automatic dice policy treats the attacker's tokens on one attack, worked out before the roll.
 *   holdFocus: an enemy can still shoot the attacker this round and it has defense dice, so focus is kept
 *     for defense unless it turns 2+ dice or could make the shot lethal (and lock/talent rerolls take focus
 *     results too, as if there were no focus token).
 *   saveLock: a primary attack by a ship with lock-only ordnance still loaded keeps the lock (for next
 *     round's torpedo) unless the reroll covers 2+ dice.
 *   health / defenseDice: no token is spent once hits + crits reach health + defenseDice, the most the
 *     defender could cancel and still die (not for ion weapons, whose extra hits become ion tokens).
 */
export interface SpendPlan { holdFocus: boolean; saveLock: boolean; health: number; defenseDice: number; capped: boolean }
export function spendPlan(state: GameState | undefined, attacker: ShipState, defender: ShipState, t: Pick<TargetInfo, 'range' | 'obstructed'> & Partial<Pick<TargetInfo, 'weapon' | 'arc' | 'turret'>>): SpendPlan {
  const primary = isPrimary(t);
  return {
    holdFocus: attacker.focus > 0 && shipType(attacker).agility - defenseDicePenalty(attacker) > 0 && !!state && stillThreatened(state, attacker),
    saveLock: primary && attacker.upgrades.some((u) => UPGRADES[u.id].weapon?.requires === 'lock' && hasAmmo(u)),
    health: defender.shields + defender.hull,
    defenseDice: defenseDiceFor(defender, t, attacker),
    capped: weaponOf(t)?.effect !== 'ion',
  };
}
/** Hits + crits already enough that no token can add anything. */
const enough = (p: SpendPlan, total: number) => p.capped && total >= p.health + p.defenseDice;
/** Focus results when focus is being held: spend it anyway if it turns 2+ dice or could finish the defender. */
const spendHeldFocus = (p: SpendPlan, total: number, focus: number) => focus >= 2 || total + focus >= p.health;

/**
 * Resolve one primary attack. Dice modification is automated with a policy that attackOdds mirrors:
 *   attack: reroll effects (Marksman, Steady Gunner, Ordnance Specialist) → lock reroll → focus, each skipped
 *     when it cannot help (see SpendPlan: overkill, holding focus for defense, saving a lock for ordnance);
 *   defense: reroll effects (Elusive) → focus → evade token → the attacker's cancel-evade effects (Crack Shot).
 * A die is rerolled at most once. Blinded Pilot stops all of the attacker's modifications.
 * `kept` lists tokens the policy chose not to spend although they could have changed a die.
 */
export function resolveAttack(state: GameState, attacker: ShipState, defender: ShipState, t: TargetInfo) {
  const spent: string[] = [], kept: string[] = [];
  const plan = spendPlan(state, attacker, defender, t);
  const attackDice = attackDiceFor(attacker, t, defender);
  const defenseDice = defenseDiceFor(defender, t, attacker);
  const mods = canModifyAttack(attacker);
  const primary = isPrimary(t), weapon = weaponOf(t);
  const facts = attackFacts(t, defender, attacker);
  if (!primary) { const u = upgradeOf(attacker, t.weapon!); if (u && UPGRADES[u.id].charges !== undefined) u.charges--; }

  const attackRoll = rollAttack(state, attackDice);
  const atk = [...attackRoll];
  const rerolled = new Set<number>();
  const reroll = (idx: number[]) => { const rr = rollAttack(state, idx.length); idx.forEach((i, k) => { atk[i] = rr[k]; rerolled.add(i); }); };
  const canFocus = attacker.focus > 0;
  // Focus results are worth rerolling when there is no focus token, or it is being held for defense.
  const focusRerollable = !canFocus || plan.holdFocus;
  const landed = () => atk.filter((f) => f === 'hit' || f === 'crit').length;
  const rerollFx = mods ? attackEffects(attacker, 'rerollAttack', facts) : [];
  if (rerollFx.length && !enough(plan, landed())) {
    // Blanks first, then focus results (when focus is not being spent on them).
    const n = rerollCount(rerollFx);
    const blanks = atk.flatMap((f, i) => (f === 'blank' ? [i] : []));
    const focus = focusRerollable ? atk.flatMap((f, i) => (f === 'focus' ? [i] : [])) : [];
    const idx = [...blanks, ...focus].slice(0, n);
    if (idx.length) {
      reroll(idx);
      for (const fx of rerollFx) { payFor(fx); spent.push(`attacker:${fx.source.id}`); }
    }
  }
  if (mods && attacker.lock === defender.id) {
    const idx = atk.map((f, i) => (!rerolled.has(i) && (f === 'blank' || (focusRerollable && f === 'focus')) ? i : -1)).filter((i) => i >= 0);
    if (idx.length && (enough(plan, landed()) || (plan.saveLock && idx.length <= 1))) kept.push('attacker:lock');
    else if (idx.length) {
      reroll(idx);
      attacker.lock = null;
      spent.push('attacker:lock');
    }
  }
  const focusDice = atk.filter((f) => f === 'focus').length;
  if (mods && canFocus && focusDice) {
    if (enough(plan, landed()) || (plan.holdFocus && !spendHeldFocus(plan, landed(), focusDice))) kept.push('attacker:focus');
    else {
      atk.forEach((f, i) => { if (f === 'focus') atk[i] = 'hit'; });
      attacker.focus--;
      spent.push('attacker:focus');
    }
  }
  if (weapon?.effect === 'proton') { const i = atk.indexOf('hit'); if (i >= 0) atk[i] = 'crit'; }
  const hits = atk.filter((f) => f === 'hit').length;
  const crits = atk.filter((f) => f === 'crit').length;

  const defenseRoll = rollDefense(state, defenseDice);
  const def = [...defenseRoll];
  const evades = () => def.filter((f) => f === 'evade').length;
  const defRerollFx = attackEffects(defender, 'rerollDefense', facts);
  if (defRerollFx.length && evades() < hits + crits) {
    // Blanks first, then focus results if there is no focus token to turn them.
    const blanks = def.flatMap((f, i) => (f === 'blank' ? [i] : []));
    const focus = defender.focus > 0 ? [] : def.flatMap((f, i) => (f === 'focus' ? [i] : []));
    const idx = [...blanks, ...focus].slice(0, rerollCount(defRerollFx));
    if (idx.length) {
      const rr = rollDefense(state, idx.length);
      idx.forEach((i, k) => { def[i] = rr[k]; });
      for (const fx of defRerollFx) { payFor(fx); spent.push(`defender:${fx.source.id}`); }
    }
  }
  if (defender.focus > 0 && evades() < hits + crits && def.includes('focus')) {
    def.forEach((f, i) => { if (f === 'focus') def[i] = 'evade'; });
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
  for (const fx of mods ? attackEffects(attacker, 'cancelEvade', facts) : []) {
    if (evades() > 0 && evades() <= hits + crits) {
      def[def.indexOf('evade')] = 'blank';
      payFor(fx);
      spent.push(`attacker:${fx.source.id}`);
    }
  }

  let e = evades();
  const finalHits = Math.max(0, hits - e);
  e = Math.max(0, e - hits);
  const finalCrits = Math.max(0, crits - e);
  let ion = 0, dmg;
  if (weapon?.effect === 'ion' && finalHits + finalCrits > 0) {
    // Ion: one hit's worth of damage; everything else that got through becomes ion tokens.
    ion = finalHits + finalCrits - 1;
    dmg = sufferDamage(state, defender, 1, 0);
    defender.ion += ion;
  } else {
    dmg = sufferDamage(state, defender, finalHits, finalCrits);
  }
  return {
    attackRoll, attackFinal: atk, defenseRoll, defenseFinal: def, spent, ...(kept.length ? { kept } : {}), hits: finalHits, crits: finalCrits, ...dmg,
    ...(primary ? {} : { weapon: t.weapon, ion }),
  };
}

// ---------------------------------------------------------------------------
// Odds: the exact outcome distribution of resolveAttack, without rolling
// ---------------------------------------------------------------------------

export interface AttackOdds {
  /** Chance of at least one damage getting through. */
  hit: number;
  /** Expected ion tokens (ion weapons). */
  ion: number;
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
 * Exact odds for `resolveAttack(state, attacker, defender, t)` given both ships' current tokens and upgrades.
 * Mirrors its automated policy step by step; keep the two in sync (the test suite checks them against
 * each other by simulation).
 */
export function attackOdds(
  attacker: ShipState, defender: ShipState,
  t: Pick<TargetInfo, 'attack' | 'range' | 'obstructed'> & Partial<Pick<TargetInfo, 'bullseye' | 'arc' | 'weapon' | 'turret'>>,
  /** The game, so the odds know whether focus will be held for defense (pass it whenever you have it). */
  state?: GameState,
): AttackOdds {
  // Note: dice odds only. Damage-card cascades (Direct Hit!, Fuel Leak...) are not included in `dist`.
  const attackDice = attackDiceFor(attacker, t, defender);
  const defenseDice = defenseDiceFor(defender, t, attacker);
  const mods = canModifyAttack(attacker);
  const aw = faceWeights(ATTACK_DIE, ATK_FACES), dw = faceWeights(DEFENSE_DIE, DEF_FACES);
  const reroll = (n: number, w: number[]) => (n ? faceCounts(n, w) : [{ counts: w.map(() => 0), p: 1 }]);
  const plus = (a: number[], b: number[]) => a.map((x, i) => x + b[i]);

  // Attack: distribution of hits + crits after modification (evades cancel either, so only the total matters).
  const landed = new Map<number, number>();
  const add = (k: number, p: number) => landed.set(k, (landed.get(k) ?? 0) + p);
  const canFocus = attacker.focus > 0;
  const weapon = weaponOf(t);
  const plan = spendPlan(state, attacker, defender, t);
  const focusRerollable = !canFocus || plan.holdFocus;
  const facts = attackFacts(t, defender, attacker);
  const talentRerolls = mods ? rerollCount(attackEffects(attacker, 'rerollAttack', facts)) : 0;
  const useLock = mods && attacker.lock === defender.id;
  const useFocus = mods && canFocus;
  const [HIT, CRIT, FOCUS, BLANK] = [0, 1, 2, 3];
  for (const roll of faceCounts(attackDice, aw)) {
    // Dice split into not-yet-rerolled (u) and rerolled (r) counts, by face.
    let states = [{ u: roll.counts, r: [0, 0, 0, 0], p: roll.p }];
    if (talentRerolls && !enough(plan, roll.counts[HIT] + roll.counts[CRIT])) {
      const b = Math.min(roll.counts[BLANK], talentRerolls);
      const f = focusRerollable ? Math.min(roll.counts[FOCUS], talentRerolls - b) : 0;
      if (b + f > 0) {
        const u = roll.counts.map((x, i) => (i === BLANK ? x - b : i === FOCUS ? x - f : x));
        states = reroll(b + f, aw).map((o) => ({ u, r: o.counts, p: roll.p * o.p }));
      }
    }
    for (const st of states) {
      let n = useLock ? st.u[BLANK] + (focusRerollable ? st.u[FOCUS] : 0) : 0;
      if (enough(plan, st.u[HIT] + st.u[CRIT] + st.r[HIT] + st.r[CRIT]) || (plan.saveLock && n <= 1)) n = 0;
      const kept = n ? st.u.map((x, i) => (i === BLANK || (focusRerollable && i === FOCUS) ? 0 : x)) : st.u;
      for (const o of reroll(n, aw)) {
        const f = plus(plus(kept, st.r), o.counts);
        const total = f[HIT] + f[CRIT], fd = f[FOCUS];
        const spendFocus = useFocus && fd > 0 && !enough(plan, total) && (!plan.holdFocus || spendHeldFocus(plan, total, fd));
        add(total + (spendFocus ? fd : 0), st.p * o.p);
      }
    }
  }

  // Defense against each attack total.
  const [EVADE, DFOCUS, DBLANK] = [0, 1, 2];
  const defRerolls = rerollCount(attackEffects(defender, 'rerollDefense', facts));
  const cancels = mods ? attackEffects(attacker, 'cancelEvade', facts).length : 0;
  const dist: number[] = Array(attackDice + 1).fill(0);
  for (const [total, pa] of landed) {
    for (const roll of faceCounts(defenseDice, dw)) {
      let states = [{ c: roll.counts, p: roll.p }];
      if (defRerolls && roll.counts[EVADE] < total) {
        const b = Math.min(roll.counts[DBLANK], defRerolls);
        const f = defender.focus === 0 ? Math.min(roll.counts[DFOCUS], defRerolls - b) : 0;
        if (b + f > 0) {
          const kept = roll.counts.map((x, i) => (i === DBLANK ? x - b : i === DFOCUS ? x - f : x));
          states = reroll(b + f, dw).map((o) => ({ c: plus(kept, o.counts), p: roll.p * o.p }));
        }
      }
      for (const st of states) {
        let e = st.c[EVADE];
        if (defender.focus > 0 && e < total && st.c[DFOCUS] > 0) e += st.c[DFOCUS];
        if (defender.evade > 0 && e < total && e < defenseDice) e += 1;
        for (let k = 0; k < cancels; k++) if (e > 0 && e <= total) e -= 1;
        dist[Math.max(0, total - e)] += pa * st.p;
      }
    }
  }
  // Ion weapons: at most 1 damage, the rest becomes ion tokens. (Proton keeps the total; it only makes a crit.)
  let ion = 0;
  if (weapon?.effect === 'ion') {
    ion = dist.reduce((a, p, k) => a + p * Math.max(0, k - 1), 0);
    const miss = dist[0];
    dist.length = 0;
    dist.push(miss, 1 - miss);
  }
  const health = defender.shields + defender.hull;
  return {
    ion,
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
  if (shieldDamage + hullDamage > 0) runTriggers(s, ship, 'damaged');
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

