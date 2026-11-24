import { describe, expect, it } from 'vitest';
import { attackOdds, resolveAttack } from '../src/combat';
import { createGame } from '../src/game';
import type { GameState, ShipState, TargetInfo } from '../src/types';

const game = createGame({
  seed: 7,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: 0 } }],
    b: [{ pilotId: 'syl-ketch', pose: { x: 500, y: 300, h: Math.PI } }],
  },
});
const [baseA, baseD] = game.ships;

/** Fraction of `n` real resolveAttack rolls with each damage total, for comparison with attackOdds. */
function simulate(a: ShipState, d: ShipState, t: TargetInfo, n: number) {
  const rng = { rng: 12345 } as GameState;
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
    const k = r.hits + r.crits;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts.map((c) => (c ?? 0) / n);
}

const target = (range: number, obstructed = false): TargetInfo =>
  ({ targetId: baseD.id, arc: 'front', attack: 3, range, obstructed, bullseye: false });

const cases: { name: string; a: Partial<ShipState>; d: Partial<ShipState>; t: TargetInfo }[] = [
  { name: 'no tokens, range 2', a: {}, d: {}, t: target(2) },
  { name: 'range 1 bonus die', a: {}, d: {}, t: target(1) },
  { name: 'range 3 + obstructed', a: {}, d: {}, t: target(3, true) },
  { name: 'attacker focus', a: { focus: 1 }, d: {}, t: target(2) },
  { name: 'lock without focus rerolls blanks and focus', a: { lock: baseD.id }, d: {}, t: target(2) },
  { name: 'lock with focus rerolls blanks only', a: { lock: baseD.id, focus: 1 }, d: {}, t: target(2) },
  { name: 'defender focus and evade', a: { focus: 1 }, d: { focus: 1, evade: 1 }, t: target(2) },
  { name: 'evade token is wasted when every die already shows an evade', a: { focus: 1 }, d: { evade: 1 }, t: target(1) },
  { name: 'everything', a: { focus: 1, lock: baseD.id }, d: { focus: 1, evade: 1 }, t: target(3, true) },
];

describe('attackOdds matches resolveAttack', () => {
  for (const c of cases) {
    it(c.name, () => {
      const a = { ...baseA, focus: 0, lock: null, ...c.a } as ShipState;
      const d = { ...baseD, focus: 0, evade: 0, ...c.d } as ShipState;
      const odds = attackOdds(a, d, c.t);
      expect(odds.dist.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      const sim = simulate(a, d, c.t, 40000);
      for (let k = 0; k < Math.max(sim.length, odds.dist.length); k++) {
        expect(Math.abs((sim[k] ?? 0) - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
      }
    });
  }

  it('kill chance counts damage reaching shields + hull', () => {
    const d = { ...baseD, shields: 0, hull: 1, focus: 0, evade: 0 } as ShipState;
    const o = attackOdds({ ...baseA, focus: 0, lock: null } as ShipState, d, target(2));
    expect(o.kill).toBeCloseTo(o.hit, 12);
  });
});
