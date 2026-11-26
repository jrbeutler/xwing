// Baseline AI: one-ply lookahead. Scores each candidate maneuver by the position it produces against
// where the enemies will likely be (it predicts each enemy's maneuver by scoring it from that enemy's seat).
// Fast, beatable, good enough to test rules; later AIs can plug into the same `decide` contract.
import { Pose, fwd } from './geometry';
import { BOARD_SIZE, Maneuver, maneuverFinalPose, maneuverPath } from './maneuvers';
import { attackOdds, clipToArc, legalTargets, maxRangeBand, measureArc, RANGE_RULES, rangeBand, shipPolygon, shipSize, shipType } from './combat';
import { UPGRADES } from './content';
import { actionOptions, activeShips, coordinatedOptions, ION_MANEUVER, isIonized, devicePolygon, inBounds, legalDial, maneuverFor, pendingFor } from './game';
import type { DamageCardId } from './damage';
import { basePolygon, polygonDistance, polygonsOverlap } from './geometry';
import { nextFloat } from './rng';
import { charged, effectsOf } from './effects';
import type { ActionChoice, ActionType, ArcName, ObstacleKind, Command, DropChoice, GameState, PlayerId, ShipState, TargetInfo } from './types';

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

/** A likely end position for an enemy this round, with its probability. */
export interface Prediction { pose: Pose; w: number }

/** The naive guess: 100 mm straight ahead. Also what a modelled enemy assumes about our ships. */
const straightAhead = (e: ShipState): Prediction[] => {
  const f = fwd(e.pose.h);
  return [{ pose: { x: e.pose.x + f.x * 100, y: e.pose.y + f.y * 100, h: e.pose.h }, w: 1 }];
};

/**
 * How the AI predicts enemy maneuvers. 'modeled': it puts itself in each enemy's seat, scores that enemy's
 * legal maneuvers with scoreManeuver (assuming our ships fly straight ahead), and keeps the `top` best,
 * weighted by exp((score - best) / temperature). 'straight': everyone flies 100 mm straight ahead.
 * Ionized enemies are known to drift 1 straight; stressed ones cannot pick red maneuvers. Mutable for experiments.
 */
export const PREDICTION = { mode: 'modeled' as 'modeled' | 'straight', top: 3, temperature: 8 };

/** Likely end positions of every enemy of `playerId`, computed once per decision. */
export function predictEnemies(s: GameState, playerId: PlayerId): Map<string, Prediction[]> {
  return new Map(activeShips(s).filter((e) => e.owner !== playerId).map((e) => [e.id, predictShip(s, e)]));
}

function predictShip(s: GameState, e: ShipState): Prediction[] {
  if (PREDICTION.mode === 'straight') return straightAhead(e);
  const size = shipSize(e);
  if (isIonized(e)) return [{ pose: maneuverFinalPose(e.pose, size, ION_MANEUVER), w: 1 }];
  const naive = new Map(activeShips(s).filter((x) => x.owner !== e.owner).map((x) => [x.id, straightAhead(x)]));
  const scored = legalDial(s, e).map((i) => ({ i, sc: scoreManeuver(s, e, i, () => 0, naive) }))
    .filter((x) => x.sc > -1000).sort((a, b) => b.sc - a.sc).slice(0, PREDICTION.top);
  if (!scored.length) return straightAhead(e);
  const raw = scored.map((x) => Math.exp((x.sc - scored[0].sc) / PREDICTION.temperature));
  const total = raw.reduce((a, b) => a + b, 0);
  return scored.map((x, k) => ({ pose: maneuverFinalPose(e.pose, size, maneuverFor(e, x.i)), w: raw[k] / total }));
}

/**
 * How good a maneuver's end position looks. `predictions`: where the enemies will likely be (predictEnemies);
 * without it every enemy is assumed to fly straight ahead.
 */
export function scoreManeuver(s: GameState, sh: ShipState, dialIndex: number, jitter: () => number, predictions?: Map<string, Prediction[]>): number {
  const m = maneuverFor(sh, dialIndex); // as damage cards make it fly
  const size = shipSize(sh);
  const pose = maneuverFinalPose(sh.pose, size, m);
  const poly = basePolygon(pose, size);
  if (!inBounds(poly)) return -1000;
  let score = 0;
  // Flying through or onto an obstacle (the rules treat both the same): asteroids cost the action and maybe
  // hull, debris a stress, gas clouds an ion token. Ignores bumps that might stop the ship short of it.
  if (s.obstacles.length) {
    score -= obstacleCost(s, sh.pose, size, m);
    // Don't end nose-up to an obstacle: if every gentle move from there runs into one, next round is a contact too.
    if (ESCAPES.every((next) => obstacleCost(s, pose, size, next) > 0)) score -= OBSTACLE_AVOID.boxedIn;
  }
  if (s.devices.some((d) => d.kind === 'mine' && polygonsOverlap(poly, devicePolygon(d)))) score -= 45;
  const edge = Math.min(pose.x, pose.y, BOARD_SIZE - pose.x, BOARD_SIZE - pose.y);
  if (edge < 80) score -= (80 - edge) * 0.5;
  const role = roleOf(sh);
  const turret = hasTurretPrimary(sh);
  let nearest = Infinity;
  const { PREFERS, THREAT } = tables();
  for (const e of activeShips(s).filter((x) => x.owner !== sh.owner)) {
    const eSize = shipSize(e);
    let gapE = 0;
    // Each likely enemy end position counts by its probability.
    for (const { pose: ep, w } of predictions?.get(e.id) ?? straightAhead(e)) {
      const ePoly = basePolygon(ep, eSize);
      score += w * arcScore(pose, size, ePoly, PREFERS[role], turret);
      score -= w * 0.6 * arcScore(ep, eSize, poly, THREAT, hasTurretPrimary(e));
      const gap = polygonDistance(poly, ePoly).d;
      gapE += w * gap;
      if (gap < 25) score -= w * 30; // about to collide: a bump costs the action and a stress
    }
    nearest = Math.min(nearest, gapE);
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

/** Spacing (mm) of the base positions the AI checks along a maneuver for obstacles: well under any base or obstacle size. */
const PATH_STEP = 8;

/**
 * How much the AI dislikes flying through or onto each kind of obstacle, and (boxedIn) ending where a short
 * straight and both gentle banks would all hit one next round. Heavier than one good firing position (up to 30),
 * so the AI gives up a shot rather than take a contact. In 300 mirrored games against 40/30/22 without the
 * lookahead, these won 183-104 (13 draws) with 0.2 contacts per side per game instead of 4.6. Mutable for experiments.
 */
export const OBSTACLE_AVOID: Record<ObstacleKind | 'boxedIn', number> = { asteroid: 120, debris: 90, gas: 60, boxedIn: 40 };

/** Gentle moves a ship can usually make next round; if all of them hit an obstacle, it is boxed in. */
const ESCAPES: Maneuver[] = [
  { bearing: 'straight', speed: 2, difficulty: 'white' },
  { bearing: 'bankLeft', speed: 2, difficulty: 'white' },
  { bearing: 'bankRight', speed: 2, difficulty: 'white' },
];

/** Penalty for the obstacles a maneuver from `from` flies through or onto (each counted once, by kind). */
function obstacleCost(s: GameState, from: Pose, size: number, m: Maneuver): number {
  const swept = [...maneuverPath(from, size, m, PATH_STEP).path, maneuverFinalPose(from, size, m)].map((p) => basePolygon(p, size));
  return s.obstacles.reduce((cost, o) => cost + (swept.some((b) => polygonsOverlap(b, o.polygon)) ? OBSTACLE_AVOID[o.kind] : 0), 0);
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
 * The rest weigh barrel rolls and boosts (see repositionValue). Mutable for experiments.
 */
export const TOKEN_WEIGHTS = {
  lockCarry: 0.3, lockBase: 0.4, defense: 1, reload: 1.2, stress: 0.5, abilityToken: 0.4,
  // Barrel roll and boost: weight of shots at / threats from enemies that have not moved yet this round, and
  // the costs of a mine on the way, each mm closer than 80 mm to the board edge, and ending boxed in.
  unmoved: 0.5, mine: 1.5, edge: 0.01, boxedIn: 0.6,
};

/** What the ship's own triggered effects (pilot abilities, talents) add to performing `action`: tokens they give. */
export function actionBonus(sh: ShipState, action: ActionChoice['type']): number {
  return effectsOf(sh, 'trigger')
    .filter((a) => a.effect.on === 'actionPerformed' && a.effect.if?.actions?.includes(action as ActionType) && charged(a))
    .reduce((v, a) => v + a.effect.do.filter((op) => op.op === 'gainFocus' || op.op === 'gainCalculate').length * TOKEN_WEIGHTS.abilityToken, 0);
}

/**
 * Focus, Evade, Calculate, Reinforce, a Lock, a Reload, a Barrel Roll or a Boost, chosen by what each is worth,
 * measured with the exact odds (repositions: see repositionValue):
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
  const moves = AI_OPTIONS.reposition ? options.filter((o): o is Reposition => o.type === 'barrelRoll' || o.type === 'boost') : [];
  if (!tokens.length && !moves.length) return undefined;
  const ship = (id: string) => s.ships.find((x) => x.id === id)!;
  const enemies = activeShips(s).filter((x) => x.owner !== sh.owner);
  const incoming = threatsTo(s, sh);
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
  return [
    ...tokens.map((o) => ({ o, v: value(o) })),
    ...moves.map((o) => ({ o: o as ActionChoice, v: repositionValue(s, sh, o) })),
  ].sort((a, b) => b.v - a.v)[0];
}

type Reposition = Extract<ActionChoice, { type: 'barrelRoll' | 'boost' }>;

/** Switches for experiments: `reposition` lets the AI barrel roll and boost. */
export const AI_OPTIONS = { reposition: true };

/**
 * Expected damage `me` takes this round from the enemies that can still shoot it in `st` (each enemy split
 * across the targets it has). `unmoved`: weight for enemies that have not moved yet this round, whose
 * positions are not final (1 counts them fully, as token choice always has).
 */
function threatsTo(st: GameState, sh: ShipState, unmoved = 1) {
  const waiting = st.phase === 'engagement' ? new Set(st.queue.slice(st.queueIndex + 1)) : null;
  const moved = movedThisRound(st);
  const threats = activeShips(st).filter((e) => e.owner !== sh.owner && (!waiting || waiting.has(e.id))).flatMap((e) => {
    const ts = legalTargets(st, e);
    const atMe = ts.filter((t) => t.targetId === sh.id);
    const weight = moved.has(e.id) ? 1 : unmoved;
    return atMe.length && weight ? [{ e, atMe, share: weight / new Set(ts.map((t) => t.targetId)).size }] : [];
  });
  return (me: ShipState) => threats.reduce((a, { e, atMe, share }) => a + share * Math.max(...atMe.map((t) => attackOdds(e, me, t, st).expected)), 0);
}

/** Ships whose position is final for this round: all of them outside Activation, else those that have moved. */
function movedThisRound(st: GameState): Set<string> {
  if (st.phase !== 'activation') return new Set(st.ships.map((x) => x.id));
  return new Set(st.queue.slice(0, st.queueIndex));
}

/** The best shot `a` has in `st`, shots at enemies that have not moved yet weighted by `unmoved`. */
const bestShotWeighted = (st: GameState, a: ShipState, unmoved: number) => {
  const moved = movedThisRound(st);
  return Math.max(0, ...legalTargets(st, a).map((t) => {
    const d = st.ships.find((x) => x.id === t.targetId)!;
    return shotWorth(st, a, d, t) * (moved.has(d.id) ? 1 : unmoved);
  }));
};

/**
 * What a barrel roll or boost is worth, in the same units as a token: the better shot it gives this round
 * and the damage it avoids (enemies that have not moved yet counted at TOKEN_WEIGHTS.unmoved), plus the
 * linked action it allows, minus stress (red), a mine on the way, hugging the board edge, or ending where
 * every gentle move next round hits an obstacle.
 */
function repositionValue(s: GameState, sh: ShipState, o: Reposition): number {
  const W = TOKEN_WEIGHTS;
  const me: ShipState = { ...sh, pose: o.to };
  const moved: GameState = { ...s, ships: s.ships.map((x) => (x.id === sh.id ? me : x)) };
  let v = bestShotWeighted(moved, me, W.unmoved) - bestShotWeighted(s, sh, W.unmoved)
    + W.defense * (threatsTo(s, sh, W.unmoved)(sh) - threatsTo(moved, me, W.unmoved)(me));
  const def = shipType(sh).actions.find((a) => a.type === o.type);
  if (def?.red) v -= W.stress;
  // The linked action it opens (e.g. a red Evade after a roll), valued from the new position.
  if (def?.linked) {
    const follow = actionOptions(moved, me).filter((x) => x.type === def.linked!.type);
    const best = follow.length ? tokenChoice(moved, me, follow) : undefined;
    if (best) v += Math.max(0, best.v - (def.linked.red ? W.stress : 0));
  }
  const size = shipSize(sh);
  const path = [sh.pose, o.to].map((p) => basePolygon(p, size));
  if (s.devices.some((d) => d.kind === 'mine' && path.some((b) => polygonsOverlap(b, devicePolygon(d))))) v -= W.mine;
  const edge = Math.min(o.to.x, o.to.y, BOARD_SIZE - o.to.x, BOARD_SIZE - o.to.y);
  if (edge < 80) v -= (80 - edge) * W.edge;
  if (s.obstacles.length && ESCAPES.every((next) => obstacleCost(s, o.to, size, next) > 0)) v -= W.boxedIn;
  return v + actionBonus(sh, o.type);
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
  // Each enemy's most likely end position.
  const enemies = [...predictEnemies(s, sh.owner)].map(([id, ps]) => ({
    pose: ps.reduce((a, b) => (b.w > a.w ? b : a)).pose, size: shipSize(s.ships.find((x) => x.id === id)!),
  }));
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
    const predictions = predictEnemies(s, playerId);
    for (const sh of activeShips(s).filter((x) => x.owner === playerId)) {
      let best = -Infinity, bestIdx = legalDial(s, sh)[0];
      for (const i of legalDial(s, sh)) {
        const sc = scoreManeuver(s, sh, i, jitter, predictions);
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
