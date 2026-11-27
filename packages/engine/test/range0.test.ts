// Range 0 attacks follow the official rules: no attack dice added, the attacker cannot modify its dice, and
// the attacker cannot reduce, cancel or modify the defender's dice.
import { describe, expect, it } from 'vitest';
import { attackDiceFor, attackOdds, defenseDiceFor, resolveAttack } from '../src/combat';
import { RANGE_RULES } from '../src/combat';
import { UPGRADES } from '../src/content';
import { createGame } from '../src/game';
import type { GameState, ShipState, TargetInfo, UpgradeDef } from '../src/types';

const TEST: UpgradeDef[] = [
  { id: 't-plus-attack', name: '+1 attack', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'dice', when: 'attacking', dice: 'attack', delta: 1 }] },
  { id: 't-plus-defense', name: '+1 defense', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'dice', when: 'defending', dice: 'defense', delta: 1 }] },
];
for (const u of TEST) UPGRADES[u.id] = u;

const g = createGame({
  seed: 5,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: { a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: 0 } }], b: [{ pilotId: 'syl-ketch', pose: { x: 340, y: 300, h: Math.PI } }] },
});
const [baseA, baseD] = g.ships;
const up = (...ids: string[]) => ids.map((id) => ({ id, charges: UPGRADES[id].charges ?? 0 }));
const ship = (base: ShipState, x: Partial<ShipState>) => ({ ...base, focus: 0, evade: 0, calculate: 0, lock: null, crits: [], upgrades: [], ...x }) as ShipState;
const at = (range: number): TargetInfo => ({ targetId: baseD.id, arc: 'front', attack: 3, range, obstructed: false, bullseye: true });

describe('range 0 attacks (official rules)', () => {
  it('attack dice cannot be added, but can still be removed', () => {
    const a = ship(baseA, { upgrades: up('t-plus-attack') });
    expect(attackDiceFor(a, at(0), ship(baseD, {}))).toBe(3 + Math.min(0, RANGE_RULES.attack[0] ?? 0));
    expect(attackDiceFor(a, at(1), ship(baseD, {}))).toBe(3 + (RANGE_RULES.attack[1] ?? 0) + 1);
    expect(attackDiceFor({ ...a, crits: ['weaponsFailure'] }, at(0), ship(baseD, {}))).toBe(3 + Math.min(0, RANGE_RULES.attack[0] ?? 0) - 1);
  });

  it('the attacker cannot reduce the defender\'s dice; the defender can still add its own', () => {
    const a = ship(baseA, { upgrades: up('outmaneuver') }); // -1 defense die from outside the defender's arcs
    const d = ship(baseD, { upgrades: up('t-plus-defense') });
    const t0 = { ...at(0), bullseye: false };
    expect(defenseDiceFor(d, t0, a)).toBe(defenseDiceFor(d, t0) ); // Outmaneuver ignored
    expect(defenseDiceFor(d, t0)).toBe(3 + 1);
  });

  it('the attacker spends nothing: no focus, lock, calculate, reroll or evade cancelling', () => {
    const rng = { rng: 99, log: [], ships: [], phase: 'planning' } as unknown as GameState;
    for (let i = 0; i < 200; i++) {
      const a = ship(baseA, { focus: 1, calculate: 1, lock: baseD.id, upgrades: up('marksman', 'crack-shot') });
      const d = ship(baseD, { focus: 1, evade: 1, shields: 99, hull: 99 });
      const r = resolveAttack(rng, a, d, at(0));
      expect(r.spent.filter((x) => x.startsWith('attacker:'))).toEqual([]);
      expect(a.focus + a.calculate).toBe(2);
      expect(a.lock).toBe(baseD.id);
      expect(r.attackFinal).toEqual(r.attackRoll);
    }
  });

  it('the odds know it', () => {
    const a = ship(baseA, { focus: 1, lock: baseD.id, upgrades: up('marksman') });
    const d = ship(baseD, { focus: 1 });
    const odds = attackOdds(a, d, at(0));
    const bare = attackOdds(ship(baseA, {}), d, at(0));
    expect(odds.dist).toEqual(bare.dist); // the attacker's tokens and talents change nothing at range 0
    const rng = { rng: 4242, log: [], ships: [], phase: 'planning' } as unknown as GameState;
    const n = 40000, counts: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), at(0));
      const k = r.shieldDamage + r.hullDamage;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (let k = 0; k < Math.max(counts.length, odds.dist.length); k++) expect(Math.abs((counts[k] ?? 0) / n - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
    expect(attackOdds(a, d, at(1)).expected).toBeGreaterThan(attackOdds(ship(baseA, {}), d, at(1)).expected); // range 1: they do help
  });
});
