// Baseline AI: one-ply lookahead. Scores each candidate maneuver by the position it
// produces against a naive prediction of enemy movement. Fast, beatable, good enough
// to test rules; later AIs can plug into the same `decide` contract.
import { Pose, dist, fwd } from './geometry';
import { BOARD_SIZE, maneuverFinalPose } from './maneuvers';
import { clipToArc, legalTargets, shipPolygon, shipSize, shipType } from './combat';
import { activeShips, inBounds, legalDial, maneuverFor, pendingFor } from './game';
import type { DamageCardId } from './damage';
import { basePolygon, polygonDistance, polygonsOverlap } from './geometry';
import { nextFloat } from './rng';
import type { Command, GameState, PlayerId, ShipState, TargetInfo } from './types';

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
        ?? pick('evade') ?? pick('focus') ?? pick('lock'));
    return { type: 'action', playerId, choice: choice ?? { type: 'none' } };
  }

  // attack: prefer the most damaged target, then closer range
  const worth = (t: TargetInfo) => {
    const e = s.ships.find((x) => x.id === t.targetId)!;
    return -(e.hull + e.shields) * 10 - t.range * 3 + t.attack * 5;
  };
  const best = [...d.targets].sort((a, b) => worth(b) - worth(a))[0];
  return { type: 'attack', playerId, targetId: best ? best.targetId : null };
}
