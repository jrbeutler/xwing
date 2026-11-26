// Baseline AI: one-ply lookahead. Scores each candidate maneuver by the position it
// produces against a naive prediction of enemy movement. Fast, beatable, good enough
// to test rules; later AIs can plug into the same `decide` contract.
import { Pose, dist, fwd } from './geometry';
import { BOARD_SIZE, maneuverFinalPose } from './maneuvers';
import { attackOdds, clipToArc, legalTargets, maxRangeBand, measureArc, RANGE_RULES, rangeBand, shipPolygon, shipSize, shipType } from './combat';
import { UPGRADES } from './content';
import { activeShips, coordinatedOptions, devicePolygon, inBounds, legalDial, maneuverFor, pendingFor } from './game';
import type { DamageCardId } from './damage';
import { basePolygon, polygonDistance, polygonsOverlap } from './geometry';
import { nextFloat } from './rng';
import { charged, effectsOf } from './effects';
import type { ActionChoice, ActionType, ArcName, Command, DropChoice, GameState, PlayerId, ShipState, TargetInfo } from './types';

/**
 * How much a ship likes having a target at each range band (0 = out of range). Most ships want range 2
 * (the sweet spot, where primaries roll an extra die) and will settle for 3; agile interceptors are happy
 * to dive in to range 1. Range 1 is otherwise a poor place to be: a lost bonus die and a likely bump.
 */
const PREFERS3 = {
  standoff: [0, 10, 30, 24],
  interceptor: [0, 22, 30, 14],
};
/** How dangerous it is to sit in an enemy's arc at each range (worst at the sweet spot). */
const THREAT3 = [0, 20, 30, 15];
/** The same for a four-band rule set (range 1 is short and penalised, range 4 gives the defender a die). */
const PREFERS4 = { standoff: [0, 4, 30, 24, 14], interceptor: [0, 14, 30, 18, 8] };
const THREAT4 = [0, 12, 30, 18, 10];
const tables = () => (RANGE_RULES.edges.length >= 4 ? { PREFERS: PREFERS4, THREAT: THREAT4 } : { PREFERS: PREFERS3, THREAT: THREAT3 });

const bandOf = (d: number) => { const b = rangeBand(Math.max(d, 1e-3)); return b ?? 0; };
const roleOf = (sh: ShipState): keyof typeof PREFERS3 => (shipType(sh).agility >= 3 ? 'interceptor' : 'standoff');
const hasTurretPrimary = (sh: ShipState) => shipType(sh).primaries.some((w) => w.arc === 'turret');

/**
 * Value of having `toPoly` as a target from `fromPose`: in the front arc (any direction for a turret
 * primary, which can rotate to bear), scored by range band from `table`.
 */
function arcScore(fromPose: Pose, fromSize: number, toPoly: ReturnType<typeof shipPolygon>, table: number[], anyArc = false): number {
  const clipped = anyArc ? toPoly : clipToArc(fromPose, 'front', toPoly);
  if (clipped.length < 3) return 0;
  return table[bandOf(polygonDistance(basePolygon(fromPose, fromSize), clipped).d)];
}

function predictEnemy(e: ShipState): Pose {
  const f = fwd(e.pose.h);
  return { x: e.pose.x + f.x * 100, y: e.pose.y + f.y * 100, h: e.pose.h };
}

export function scoreManeuver(s: GameState, sh: ShipState, dialIndex: number, jitter: () => number): number {
  const m = maneuverFor(sh, dialIndex); // as damage cards make it fly
  const size = shipSize(sh);
  const pose = maneuverFinalPose(sh.pose, size, m);
  const poly = basePolygon(pose, size);
  if (!inBounds(poly)) return -1000;
  let score = 0;
  if (s.obstacles.some((o) => polygonsOverlap(poly, o.polygon))) score -= 40;
  if (s.devices.some((d) => d.kind === 'mine' && polygonsOverlap(poly, devicePolygon(d)))) score -= 45;
  const edge = Math.min(pose.x, pose.y, BOARD_SIZE - pose.x, BOARD_SIZE - pose.y);
  if (edge < 80) score -= (80 - edge) * 0.5;
  const role = roleOf(sh);
  const turret = hasTurretPrimary(sh);
  let nearest = Infinity;
  for (const e of activeShips(s).filter((x) => x.owner !== sh.owner)) {
    const ep = predictEnemy(e);
    const eSize = shipSize(e);
    const ePoly = basePolygon(ep, eSize);
    const { PREFERS, THREAT } = tables();
    score += arcScore(pose, size, ePoly, PREFERS[role], turret);
    score -= 0.6 * arcScore(ep, eSize, poly, THREAT, hasTurretPrimary(e));
    const gap = polygonDistance(poly, ePoly).d;
    nearest = Math.min(nearest, gap);
    if (gap < 25) score -= 30; // about to collide: a bump costs the action and a stress
  }
  // Keep a distance: range 1 is for interceptors only; beyond range 3, close in.
  const [r1, ...rest] = RANGE_RULES.edges, reach = rest.length ? rest[rest.length - 1] : r1;
  if (nearest < r1) score -= role === 'interceptor' ? 6 : 22;
  if (nearest > reach && nearest < Infinity) score -= (nearest - reach) * 0.05;
  // Don't fly into friends either.
  for (const f of activeShips(s)) {
    if (f.owner !== sh.owner || f.id === sh.id) continue;
    if (polygonDistance(poly, basePolygon(f.pose, shipSize(f))).d < 15) score -= 25;
  }
  if (m.difficulty === 'red') score -= 8;
  if (m.difficulty === 'blue' && sh.stress > 0) score += 10;
  return score + jitter() * 6;
}

/** How good a shot is (as the attack decision weighs it): expected damage, plus kills and ion tokens. */
const shotWorth = (s: GameState, a: ShipState, d: ShipState, t: TargetInfo) => {
  const o = attackOdds(a, d, t, s);
  return o.expected + o.kill * 3 + o.ion * 0.6;
};
/** The best shot `a` has right now (0 if none), weapons that need a lock included. */
const bestShot = (s: GameState, a: ShipState) =>
  Math.max(0, ...legalTargets(s, a).map((t) => shotWorth(s, a, s.ships.find((x) => x.id === t.targetId)!, t)));

/**
 * Token weights. lockCarry: share of a lock's value counted for later rounds (it lasts until spent).
 * lockBase: rough value of a lock reroll on a typical shot, for an enemy the ship cannot shoot yet.
 * defense: weight of damage prevented against damage dealt. reload: value of a recovered ordnance or bomb
 * charge (paid for by not attacking this round). stress: cost of the stress a red linked action brings.
 * abilityToken: rough value of a token an ability gives after an action (e.g. calculate after a Jam).
 * Mutable for experiments.
 */
export const TOKEN_WEIGHTS = { lockCarry: 0.3, lockBase: 0.4, defense: 1, reload: 1.2, stress: 0.5, abilityToken: 0.4 };

/** What the ship's own triggered effects (pilot abilities, talents) add to performing `action`: tokens they give. */
export function actionBonus(sh: ShipState, action: ActionChoice['type']): number {
  return effectsOf(sh, 'trigger')
    .filter((a) => a.effect.on === 'actionPerformed' && a.effect.if?.actions?.includes(action as ActionType) && charged(a))
    .reduce((v, a) => v + a.effect.do.filter((op) => op.op === 'gainFocus' || op.op === 'gainCalculate').length * TOKEN_WEIGHTS.abilityToken, 0);
}

/**
 * Focus, Evade, Calculate, Reinforce, a Lock or a Reload, chosen by what each is worth, measured with the exact odds:
 *   attack: how much better this round's best shot gets (a lock can also make ordnance legal);
 *   defense: how much less damage the enemies that can still shoot this ship expect to deal
 *     (each enemy counted once, split across the targets it has);
 *   later: a lock outlasts the round (lockCarry of its value on that enemy), and replacing a lock
 *     gives up the old one; a reload is worth a charge but gives up this round's shot.
 * Returns the best option worth more than `minValue` (a red linked action must pay for its stress).
 */
export function bestToken(s: GameState, sh: ShipState, options: ActionChoice[], minValue = 0): ActionChoice | undefined {
  const best = tokenChoice(s, sh, options);
  return best && best.v > minValue ? best.o : undefined;
}

/** The most valuable token-like option and its value (see bestToken), or undefined if there is none. */
export function tokenChoice(s: GameState, sh: ShipState, options: ActionChoice[]): { o: ActionChoice; v: number } | undefined {
  const kinds = ['focus', 'evade', 'lock', 'calculate', 'reinforce', 'reload'];
  const tokens = options.filter((o) => kinds.includes(o.type));
  if (!tokens.length) return undefined;
  const ship = (id: string) => s.ships.find((x) => x.id === id)!;
  const enemies = activeShips(s).filter((x) => x.owner !== sh.owner);
  const waiting = s.phase === 'engagement' ? new Set(s.queue.slice(s.queueIndex + 1)) : null;
  // Enemies that can still shoot this ship, with their best shot at it and how many targets they have.
  const threats = enemies.filter((e) => !waiting || waiting.has(e.id)).flatMap((e) => {
    const ts = legalTargets(s, e);
    const atMe = ts.filter((t) => t.targetId === sh.id);
    return atMe.length ? [{ e, atMe, share: 1 / new Set(ts.map((t) => t.targetId)).size }] : [];
  });
  const incoming = (me: ShipState) => threats.reduce((a, { e, atMe, share }) =>
    a + share * Math.max(...atMe.map((t) => attackOdds(e, me, t, s).expected)), 0);
  // What a lock on `id` adds to a shot at that enemy now, or a base value if it is not a target yet.
  const lockGain = (id: string) => {
    const shots = legalTargets(s, { ...sh, lock: id }).filter((t) => t.targetId === id);
    if (!shots.length) return TOKEN_WEIGHTS.lockBase;
    const e = ship(id);
    const now = Math.max(0, ...legalTargets(s, sh).filter((t) => t.targetId === id).map((t) => shotWorth(s, sh, e, t)));
    return Math.max(TOKEN_WEIGHTS.lockBase, Math.max(...shots.map((t) => shotWorth(s, { ...sh, lock: id }, e, t))) - now);
  };
  const oldLock = sh.lock && enemies.some((e) => e.id === sh.lock) ? sh.lock : null;
  const shotNow = bestShot(s, sh), hitNow = incoming(sh);
  const value = (o: ActionChoice) => {
    const me: ShipState =
      o.type === 'focus' ? { ...sh, focus: sh.focus + 1 }
      : o.type === 'evade' ? { ...sh, evade: sh.evade + 1 }
      : o.type === 'calculate' ? { ...sh, calculate: sh.calculate + 1 }
      : o.type === 'reinforce' ? { ...sh, reinforce: o.side }
      : o.type === 'reload' ? { ...sh, disarmed: true }
      : { ...sh, lock: (o as { targetId: string }).targetId };
    let v = bestShot(s, me) - shotNow + TOKEN_WEIGHTS.defense * (hitNow - incoming(me));
    if (o.type === 'lock') v += TOKEN_WEIGHTS.lockCarry * (lockGain(o.targetId) - (oldLock ? lockGain(oldLock) : 0));
    if (o.type === 'reload') v += TOKEN_WEIGHTS.reload;
    return v + actionBonus(sh, o.type);
  };
  return tokens.map((o) => ({ o, v: value(o) })).sort((a, b) => b.v - a.v)[0];
}

/**
 * Coordinate a friend when the best action it could take is worth more than this ship's own best
 * (both valued like bestToken, red actions paying for their stress).
 */
function coordinateChoice(s: GameState, sh: ShipState, options: ActionChoice[]): ActionChoice | undefined {
  const coords = options.filter((o): o is Extract<ActionChoice, { type: 'coordinate' }> => o.type === 'coordinate');
  if (!coords.length) return undefined;
  const own = tokenChoice(s, sh, options)?.v ?? 0;
  const worth = (o: Extract<ActionChoice, { type: 'coordinate' }>) => {
    const t = s.ships.find((x) => x.id === o.targetId)!;
    const best = tokenChoice(s, t, coordinatedOptions(s, t));
    if (!best) return 0;
    const red = shipType(t).actions.find((a) => a.type === best.o.type)?.red;
    return best.v - (red ? TOKEN_WEIGHTS.stress : 0);
  };
  const best = coords.map((o) => ({ o, v: worth(o) })).sort((a, b) => b.v - a.v)[0];
  return best.v + actionBonus(sh, 'coordinate') > Math.max(0, own) ? best.o : undefined;
}

/** Rotate the turret toward the closest enemy it could then shoot, if the current arc has none. */
function turretTurn(s: GameState, sh: ShipState, options: ActionChoice[]): ActionChoice | undefined {
  const rotations = options.filter((o): o is Extract<ActionChoice, { type: 'rotateArc' }> => o.type === 'rotateArc');
  // Reach of the turret: range 3 for a turret primary, else the turret upgrade's.
  const turretPrimary = shipType(sh).primaries.some((w) => w.arc === 'turret');
  const turret = turretPrimary ? { maxRange: maxRangeBand() } : sh.upgrades.map((u) => UPGRADES[u.id].weapon).find((w) => w?.arc === 'turret');
  if (!rotations.length || !turret) return undefined;
  const enemies = activeShips(s).filter((x) => x.owner !== sh.owner);
  const reach = (arc: ArcName) => Math.min(...enemies.map((e) => {
    const m = measureArc(s, sh, e, arc);
    return m && m.range <= turret.maxRange ? m.range : Infinity;
  }));
  if (reach(sh.turretArc) < Infinity) return undefined;
  const best = rotations.map((o) => ({ o, r: reach(o.to) })).sort((a, b) => a.r - b.r)[0];
  return best.r < Infinity ? best.o : undefined;
}

/**
 * System phase: drop a bomb if, by the end of Activation, enemies are likely in its blast and friends
 * are not (enemies are predicted to fly on; friends' dials are known); lay a mine where an enemy is heading.
 */
function bestDrop(s: GameState, sh: ShipState, options: DropChoice[]): DropChoice {
  const none = options.find((o) => o.type === 'none')!;
  const drops = options.filter((o): o is Extract<DropChoice, { type: 'drop' }> => o.type === 'drop');
  if (!drops.length) return none;
  const token = devicePolygon({ pose: drops[0].pose });
  const near = (pose: Pose, size: number, reach: number) => polygonDistance(token, basePolygon(pose, size)).d <= reach;
  const friendsEnd = activeShips(s).filter((x) => x.owner === sh.owner)
    .map((x) => ({ pose: x.dial === null ? x.pose : maneuverFinalPose(x.pose, shipSize(x), maneuverFor(x, x.dial)), size: shipSize(x) }));
  const enemies = activeShips(s).filter((x) => x.owner !== sh.owner).map((e) => ({ pose: predictEnemy(e), size: shipSize(e) }));
  const score = (o: Extract<DropChoice, { type: 'drop' }>) => {
    const dev = UPGRADES[o.upgrade].device!;
    const reach = dev.kind === 'bomb' ? 100 : 60;
    const foes = enemies.filter((e) => near(e.pose, e.size, reach)).length;
    const friends = friendsEnd.filter((f) => near(f.pose, f.size, reach + 10)).length; // small margin: a bomber flying its slowest straight ends 120 mm away
    if (!foes || friends) return 0;
    return foes * (dev.effect === 'proton' ? 3 : dev.effect === 'ion' ? 2 : 2.5);
  };
  const best = drops.map((o) => ({ o, sc: score(o) })).sort((a, b) => b.sc - a.sc)[0];
  return best.sc > 0 ? best.o : none;
}

export function decide(s: GameState, playerId: PlayerId): Command | null {
  const d = pendingFor(s, playerId);
  if (!d) return null;
  // Use a private RNG copy so AI choices never consume game dice.
  const local = { rng: (s.rng ^ 0x9e3779b9 ^ (s.round * 7919)) | 0 };
  const jitter = () => nextFloat(local);

  if (d.kind === 'planning') {
    const dials: Record<string, number> = {};
    for (const sh of activeShips(s).filter((x) => x.owner === playerId)) {
      let best = -Infinity, bestIdx = legalDial(s, sh)[0];
      for (const i of legalDial(s, sh)) {
        const sc = scoreManeuver(s, sh, i, jitter);
        if (sc > best) { best = sc; bestIdx = i; }
      }
      dials[sh.id] = bestIdx;
    }
    return { type: 'setDials', playerId, dials };
  }

  if (d.kind === 'action' && d.linked) {
    // A linked action: turn the turret if it has nothing to shoot, else a token worth its stress (if red).
    const sh = s.ships.find((x) => x.id === d.shipId)!;
    const choice = turretTurn(s, sh, d.options) ?? bestToken(s, sh, d.options, d.linked.red ? TOKEN_WEIGHTS.stress : 0);
    return { type: 'action', playerId, choice: choice ?? { type: 'none' } };
  }

  if (d.kind === 'action') {
    const sh = s.ships.find((x) => x.id === d.shipId)!;
    const hasShot = legalTargets(s, sh).length > 0;
    const pick = (t: string) => d.options.find((o) => o.type === t);
    const repair = (cards: DamageCardId[]) => d.options.find((o) => o.type === 'repair' && cards.includes(o.card));
    // Fix what hurts most right now: cards that cost hull first, then ones that blunt this turn's shot.
    const urgent = repair(['consoleFire', 'hullBreach', 'fuelLeak']);
    const blunted = hasShot ? repair(['blindedPilot', 'weaponsFailure']) : undefined;
    // Jam an enemy that is holding tokens: strip its Focus/Evade (best of all, one we're about to shoot).
    const shootable = new Set(legalTargets(s, sh).map((t) => t.targetId));
    const jamWorth = (o: ActionChoice) => {
      if (o.type !== 'jam') return 0;
      const t = s.ships.find((x) => x.id === o.targetId)!;
      const tokens = t.focus + t.evade + t.calculate + (t.reinforce ? 1 : 0);
      return tokens ? tokens * 2 + t.evade + (shootable.has(t.id) ? 3 : 0) + actionBonus(sh, 'jam') : 0;
    };
    const jam = [...d.options].sort((a, b) => jamWorth(b) - jamWorth(a)).find((o) => jamWorth(o) > 0);
    const choice = urgent ?? blunted ?? jam
      ?? (hasShot ? undefined : repair(['damagedSensorArray', 'woundedPilot', 'looseStabilizer', 'weaponsFailure', 'blindedPilot']) ?? turretTurn(s, sh, d.options))
      ?? coordinateChoice(s, sh, d.options) ?? bestToken(s, sh, d.options) ?? pick('focus');
    return { type: 'action', playerId, choice: choice ?? { type: 'none' } };
  }

  if (d.kind === 'system') {
    const sh = s.ships.find((x) => x.id === d.shipId)!;
    return { type: 'drop', playerId, choice: bestDrop(s, sh, d.options) };
  }

  // attack: the shot (target and weapon) with the best exact odds; kills and weak targets count extra.
  const me = s.ships.find((x) => x.id === d.shipId)!;
  const worth = (t: TargetInfo) => {
    const e = s.ships.find((x) => x.id === t.targetId)!;
    const o = attackOdds(me, e, t, s);
    return o.expected + o.kill * 3 + o.ion * 0.6 - (e.hull + e.shields) * 0.05;
  };
  const best = [...d.targets].sort((a, b) => worth(b) - worth(a))[0];
  return { type: 'attack', playerId, targetId: best ? best.targetId : null, ...(best?.weapon ? { weapon: best.weapon } : {}) };
}
