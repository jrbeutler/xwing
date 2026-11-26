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
let ionTotal = 0;
function simulate(a: ShipState, d: ShipState, t: TargetInfo, n: number) {
  const rng = { rng: 12345, log: [] } as unknown as GameState;
  const counts: number[] = [];
  ionTotal = 0;
  for (let i = 0; i < n; i++) {
    const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
    const k = r.shieldDamage + r.hullDamage; // damage dealt (ion weapons deal at most 1)
    ionTotal += r.ion ?? 0;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts.map((c) => (c ?? 0) / n);
}

const target = (range: number, obstructed = false, bullseye = false): TargetInfo =>
  ({ targetId: baseD.id, arc: 'front', attack: 3, range, obstructed, bullseye });
const up = (...ids: string[]) => ids.map((id) => ({ id, charges: 1 }));
const ordnance = (weapon: string, attack: number, range: number, bullseye = false): TargetInfo =>
  ({ targetId: baseD.id, arc: 'front', attack, range, obstructed: false, bullseye, weapon });

const cases: { name: string; a: Partial<ShipState>; d: Partial<ShipState>; t: TargetInfo }[] = [
  { name: 'no tokens, range 2', a: {}, d: {}, t: target(2) },
  { name: 'range 1 bonus die', a: {}, d: {}, t: target(1) },
  { name: 'range 3 + obstructed', a: {}, d: {}, t: target(3, true) },
  { name: 'attacker focus', a: { focus: 1 }, d: {}, t: target(2) },
  { name: 'lock without focus rerolls blanks and focus', a: { lock: baseD.id }, d: {}, t: target(2) },
  { name: 'lock with focus rerolls blanks only', a: { lock: baseD.id, focus: 1 }, d: {}, t: target(2) },
  { name: 'defender focus and evade', a: { focus: 1 }, d: { focus: 1, evade: 1 }, t: target(2) },
  { name: 'evade token is wasted when every die already shows an evade', a: { focus: 1 }, d: { evade: 1 }, t: target(1) },
  { name: 'Weapons Failure: one fewer attack die', a: { focus: 1, crits: ['weaponsFailure'] }, d: {}, t: target(2) },
  { name: 'Structural Damage: one fewer defense die', a: {}, d: { evade: 1, crits: ['structuralDamage'] }, t: target(3) },
  { name: 'Blinded Pilot: tokens cannot modify the attack', a: { focus: 1, lock: baseD.id, crits: ['blindedPilot'] }, d: { focus: 1 }, t: target(1) },
  { name: 'Marksman rerolls a blank in the bullseye', a: { upgrades: up('marksman') }, d: {}, t: target(2, false, true) },
  { name: 'Marksman does nothing outside the bullseye', a: { upgrades: up('marksman') }, d: {}, t: target(2) },
  { name: 'Marksman then lock: no die rerolled twice', a: { upgrades: up('marksman'), lock: baseD.id }, d: {}, t: target(2, false, true) },
  { name: 'Marksman + lock + focus', a: { upgrades: up('marksman'), lock: baseD.id, focus: 1 }, d: { focus: 1 }, t: target(1, false, true) },
  { name: 'Crack Shot cancels an evade', a: { upgrades: up('crack-shot'), focus: 1 }, d: { evade: 1 }, t: target(2, false, true) },
  { name: 'Elusive rerolls a defense die', a: { focus: 1 }, d: { upgrades: up('elusive') }, t: target(2) },
  { name: 'Elusive with focus and evade tokens', a: { focus: 1, lock: baseD.id }, d: { upgrades: up('elusive'), focus: 1, evade: 1 }, t: target(3) },
  { name: 'all talents at once', a: { upgrades: up('marksman', 'crack-shot'), lock: baseD.id, focus: 1 }, d: { upgrades: up('elusive', 'stealth-coating'), focus: 1, evade: 1 }, t: target(2, true, true) },
  { name: 'Blinded Pilot stops Marksman and Crack Shot', a: { upgrades: up('marksman', 'crack-shot'), crits: ['blindedPilot'], focus: 1 }, d: { evade: 1 }, t: target(2, false, true) },
  { name: 'Proton Torpedoes (4 dice, no range bonus)', a: { upgrades: up('proton-torpedoes'), lock: baseD.id }, d: { evade: 1 }, t: ordnance('proton-torpedoes', 4, 3) },
  { name: 'Ion Torpedoes: at most 1 damage', a: { upgrades: up('ion-torpedoes'), lock: baseD.id, focus: 1 }, d: {}, t: ordnance('ion-torpedoes', 4, 2) },
  { name: 'Rocket Pods at range 1 (no primary bonus die)', a: { upgrades: up('rocket-pods'), focus: 1 }, d: { focus: 1 }, t: ordnance('rocket-pods', 3, 1) },
  { name: 'Marksman does not apply to ordnance', a: { upgrades: up('marksman', 'concussion-missiles'), lock: baseD.id }, d: {}, t: ordnance('concussion-missiles', 3, 2, true) },
  { name: 'Dorsal Turret (2 dice, no range bonus)', a: { upgrades: [{ id: 'dorsal-turret', charges: 0 }], focus: 1 }, d: { focus: 1 }, t: { ...ordnance('dorsal-turret', 2, 1), arc: 'left' } },
  { name: 'Ion Cannon Turret', a: { upgrades: [{ id: 'ion-turret', charges: 0 }], focus: 1 }, d: {}, t: { ...ordnance('ion-turret', 3, 2), arc: 'rear' } },
  { name: 'Steady Gunner rerolls on a turret attack', a: { upgrades: [{ id: 'steady-gunner', charges: 0 }, { id: 'dorsal-turret', charges: 0 }], lock: baseD.id }, d: {}, t: { ...ordnance('dorsal-turret', 2, 2), arc: 'left' } },
  { name: 'Steady Gunner with a turret primary', a: { upgrades: up('steady-gunner'), focus: 1 }, d: { focus: 1 }, t: { ...target(2), turret: true } },
  { name: 'Steady Gunner does nothing on a front-arc attack', a: { upgrades: up('steady-gunner') }, d: {}, t: target(2, false, true) },
  { name: 'Ordnance Specialist rerolls with a missile', a: { upgrades: up('ordnance-specialist', 'concussion-missiles'), lock: baseD.id }, d: {}, t: ordnance('concussion-missiles', 3, 2) },
  { name: 'Ordnance Specialist does nothing on a primary attack', a: { upgrades: up('ordnance-specialist') }, d: {}, t: target(2, false, true) },
  { name: 'everything', a: { focus: 1, lock: baseD.id }, d: { focus: 1, evade: 1 }, t: target(3, true) },
];

describe('attackOdds matches resolveAttack', () => {
  for (const c of cases) {
    it(c.name, () => {
      const a = { ...baseA, focus: 0, lock: null, crits: [], upgrades: [], ...c.a } as ShipState;
      const d = { ...baseD, focus: 0, evade: 0, crits: [], upgrades: [], ...c.d } as ShipState;
      const odds = attackOdds(a, d, c.t);
      expect(odds.dist.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      const sim = simulate(a, d, c.t, 40000);
      for (let k = 0; k < Math.max(sim.length, odds.dist.length); k++) {
        expect(Math.abs((sim[k] ?? 0) - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
      }
      expect(Math.abs(ionTotal / 40000 - odds.ion)).toBeLessThan(0.02); // expected ion tokens
    });
  }

  it('kill chance counts damage reaching shields + hull', () => {
    const d = { ...baseD, shields: 0, hull: 1, focus: 0, evade: 0 } as ShipState;
    const o = attackOdds({ ...baseA, focus: 0, lock: null } as ShipState, d, target(2));
    expect(o.kill).toBeCloseTo(o.hit, 12);
  });
});
