// Baseline AI: one-ply lookahead. Scores each candidate maneuver by the position it
// produces against a naive prediction of enemy movement. Fast, beatable, good enough
// to test rules; later AIs can plug into the same `decide` contract.
import { Pose, dist, fwd } from './geometry';
import { BOARD_SIZE, maneuverFinalPose } from './maneuvers';
import { attackOdds, clipToArc, legalTargets, measureArc, shipPolygon, shipSize, shipType } from './combat';
import { UPGRADES } from './content';
import { activeShips, devicePolygon, inBounds, legalDial, maneuverFor, pendingFor } from './game';
import type { DamageCardId } from './damage';
import { basePolygon, polygonDistance, polygonsOverlap } from './geometry';
import { nextFloat } from './rng';
import type { ActionChoice, ArcName, Command, DropChoice, GameState, PlayerId, ShipState, TargetInfo } from './types';

function arcScore(fromPose: Pose, fromSize: number, toPoly: ReturnType<typeof shipPolygon>): number {
  const clipped = clipToArc(fromPose, 'front', toPoly);
  if (clipped.length < 3) return 0;
  const d = polygonDistance(basePolygon(fromPose, fromSize), clipped).d;
  if (d <= 100) return 30;
  if (d <= 200) return 25;
  if (d <= 300) return 12;
  return 0;
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
  let nearest = Infinity;
  for (const e of activeShips(s).filter((x) => x.owner !== sh.owner)) {
    const ep = predictEnemy(e);
    const eSize = shipSize(e);
    score += arcScore(pose, size, basePolygon(ep, eSize));
    score -= 0.6 * arcScore(ep, eSize, poly);
    nearest = Math.min(nearest, dist(pose, ep));
  }
  if (nearest < Infinity) score -= nearest * 0.03;
  if (m.difficulty === 'red') score -= 8;
  if (m.difficulty === 'blue' && sh.stress > 0) score += 10;
  return score + jitter() * 6;
}

/** Rotate the turret toward the closest enemy it could then shoot, if the current arc has none. */
function turretTurn(s: GameState, sh: ShipState, options: ActionChoice[]): ActionChoice | undefined {
  const rotations = options.filter((o): o is Extract<ActionChoice, { type: 'rotateArc' }> => o.type === 'rotateArc');
  // Reach of the turret: range 3 for a turret primary, else the turret upgrade's.
  const turretPrimary = shipType(sh).primaries.some((w) => w.arc === 'turret');
  const turret = turretPrimary ? { maxRange: 3 } : sh.upgrades.map((u) => UPGRADES[u.id].weapon).find((w) => w?.arc === 'turret');
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

  if (d.kind === 'action') {
    const sh = s.ships.find((x) => x.id === d.shipId)!;
    const hasShot = legalTargets(s, sh).length > 0;
    const pick = (t: string) => d.options.find((o) => o.type === t);
    const repair = (cards: DamageCardId[]) => d.options.find((o) => o.type === 'repair' && cards.includes(o.card));
    // Fix what hurts most right now: cards that cost hull first, then ones that blunt this turn's shot.
    const urgent = repair(['consoleFire', 'hullBreach', 'fuelLeak']);
    const blunted = hasShot ? repair(['blindedPilot', 'weaponsFailure']) : undefined;
    const choice = urgent ?? blunted
      ?? (hasShot ? pick('focus') ?? pick('lock') : repair(['damagedSensorArray', 'woundedPilot', 'looseStabilizer', 'weaponsFailure', 'blindedPilot'])
        ?? turretTurn(s, sh, d.options) ?? pick('evade') ?? pick('focus') ?? pick('lock'));
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
    const o = attackOdds(me, e, t);
    return o.expected + o.kill * 3 + o.ion * 0.6 - (e.hull + e.shields) * 0.05;
  };
  const best = [...d.targets].sort((a, b) => worth(b) - worth(a))[0];
  return { type: 'attack', playerId, targetId: best ? best.targetId : null, ...(best?.weapon ? { weapon: best.weapon } : {}) };
}
