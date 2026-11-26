import { afterAll, describe, expect, it } from 'vitest';
import { attackDiceFor, attackOdds, defenseDiceFor, resolveAttack } from '../src/combat';
import { UPGRADES } from '../src/content';
import { effectsOf, runTriggers, statBonus } from '../src/effects';
import { createGame, jamRange } from '../src/game';
import type { GameState, ShipState, TargetInfo, UpgradeDef } from '../src/types';

// Test-only upgrades: effects the shipped content does not use yet (bigger rerolls, attack-dice changes,
// stacking), to show the hook layer handles them and that attackOdds still matches resolveAttack exactly.
const TEST: UpgradeDef[] = [
  { id: 't-reroll2', name: 'Reroll 2', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'rerollAttack', dice: 2 }] },
  { id: 't-defreroll2', name: 'Defense reroll 2', slot: 'modification', cost: 0, text: '', charges: 2, effects: [{ kind: 'rerollDefense', dice: 2, cost: 'charge' }] },
  { id: 't-cancel', name: 'Cancel', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'cancelEvade' }] },
  { id: 't-plus-attack', name: '+1 attack in bullseye', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'dice', when: 'attacking', dice: 'attack', delta: 1, if: { bullseye: true } }] },
  { id: 't-minus-attack', name: 'Attackers roll 1 fewer', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'dice', when: 'defending', dice: 'attack', delta: -1 }] },
  {
    id: 't-regen', name: 'Regen', slot: 'modification', cost: 0, text: '', charges: 2,
    effects: [{ kind: 'trigger', on: 'endPhase', cost: 'charge', if: { shieldsBelowMax: true }, do: [{ op: 'recoverShield' }, { op: 'gainFocus' }], log: 'used' }],
  },
  { id: 't-jam', name: 'Jam +2', slot: 'modification', cost: 0, text: '', effects: [{ kind: 'stat', stat: 'jamRange', delta: 2 }] },
];
for (const u of TEST) UPGRADES[u.id] = u;
afterAll(() => { for (const u of TEST) delete UPGRADES[u.id]; });

const game = createGame({
  seed: 7,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: 0 } }],
    b: [{ pilotId: 'syl-ketch', pose: { x: 500, y: 300, h: Math.PI } }],
  },
});
const [baseA, baseD] = game.ships;
const up = (...ids: string[]) => ids.map((id) => ({ id, charges: UPGRADES[id].charges ?? 0 }));
const target = (range: number, bullseye = false): TargetInfo => ({ targetId: baseD.id, arc: 'front', attack: 3, range, obstructed: false, bullseye });
const ship = (base: ShipState, x: Partial<ShipState>) => ({ ...base, focus: 0, evade: 0, lock: null, crits: [], upgrades: [], ...x }) as ShipState;

function simulate(a: ShipState, d: ShipState, t: TargetInfo, n: number) {
  const rng = { rng: 4242, log: [] } as unknown as GameState;
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
    const k = r.shieldDamage + r.hullDamage;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts.map((c) => (c ?? 0) / n);
}

describe('dice effects: attackOdds matches resolveAttack', () => {
  const cases: { name: string; a: Partial<ShipState>; d: Partial<ShipState>; t: TargetInfo }[] = [
    { name: 'reroll 2 attack dice', a: { upgrades: up('t-reroll2') }, d: {}, t: target(2) },
    { name: 'reroll 2 + lock + focus', a: { upgrades: up('t-reroll2'), lock: baseD.id, focus: 1 }, d: { focus: 1 }, t: target(2) },
    { name: 'reroll 2 stacked with Marksman (3 dice)', a: { upgrades: up('t-reroll2', 'marksman') }, d: {}, t: target(1, true) },
    { name: 'defender rerolls 2', a: { focus: 1 }, d: { upgrades: up('t-defreroll2') }, t: target(2) },
    { name: 'defender rerolls 2 with focus token', a: { focus: 1 }, d: { upgrades: up('t-defreroll2', 'elusive'), focus: 1 }, t: target(3) },
    { name: 'two cancel-evade effects', a: { upgrades: up('t-cancel', 'crack-shot') }, d: { evade: 1 }, t: target(2, true) },
    { name: '+1 attack die in the bullseye', a: { upgrades: up('t-plus-attack') }, d: {}, t: target(2, true) },
    { name: 'defender makes attackers roll 1 fewer', a: { focus: 1 }, d: { upgrades: up('t-minus-attack') }, t: target(2) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const a = ship(baseA, c.a), d = ship(baseD, c.d);
      const odds = attackOdds(a, d, c.t);
      expect(odds.dist.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      const sim = simulate(a, d, c.t, 40000);
      for (let k = 0; k < Math.max(sim.length, odds.dist.length); k++) {
        expect(Math.abs((sim[k] ?? 0) - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
      }
    });
  }

  it('attack dice effects follow their conditions and both ships', () => {
    const a = ship(baseA, { upgrades: up('t-plus-attack') }), d = ship(baseD, { upgrades: up('t-minus-attack') });
    expect(attackDiceFor(a, target(3, true), ship(baseD, {}))).toBe(4);
    expect(attackDiceFor(a, target(3, false), ship(baseD, {}))).toBe(3);
    expect(attackDiceFor(a, target(3, true), d)).toBe(3);
    expect(attackDiceFor(a, target(3, true))).toBe(3); // defender unknown: no effects
  });

  it('a charged reroll spends its charges and is logged per upgrade', () => {
    const rng = { rng: 1, log: [] } as unknown as GameState;
    let spentCharges = 0, uses = 0;
    for (let i = 0; i < 200; i++) {
      const d = ship(baseD, { upgrades: up('t-defreroll2'), shields: 99, hull: 99 });
      const r = resolveAttack(rng, ship(baseA, { focus: 1 }), d, target(2));
      if (r.spent.includes('defender:t-defreroll2')) { uses++; spentCharges += 2 - d.upgrades[0].charges; }
    }
    expect(uses).toBeGreaterThan(20);
    expect(spentCharges).toBe(uses); // one charge per use, whatever the number of dice
  });

  it('Stealth Coating adds a die only while charged', () => {
    const d = ship(baseD, { upgrades: up('stealth-coating') });
    expect(defenseDiceFor(d, target(2))).toBe(4);
    d.upgrades[0].charges = 0;
    expect(defenseDiceFor(d, target(2))).toBe(3);
  });
});

describe('triggers and stats', () => {
  it('runs every op of a trigger, pays its charge and reports what it gave', () => {
    const s = structuredClone(game);
    const sh = s.ships[0];
    sh.upgrades = up('t-regen');
    sh.shields = 0;
    runTriggers(s, sh, 'endPhase');
    expect(sh.shields).toBe(1);
    expect(sh.focus).toBe(1);
    expect(sh.upgrades[0].charges).toBe(1);
    expect(s.log.at(-1)).toEqual({ type: 'upgrade', shipId: sh.id, upgrade: 't-regen', what: 'used', shields: 1, focus: 1 });
    sh.shields = sh.maxShields;
    const n = s.log.length;
    runTriggers(s, sh, 'endPhase'); // shields full: condition fails, nothing happens
    expect(s.log.length).toBe(n);
    expect(sh.upgrades[0].charges).toBe(1);
  });

  it('does not fire for other events or without charges', () => {
    const s = structuredClone(game);
    const sh = s.ships[0];
    sh.upgrades = [{ id: 't-regen', charges: 0 }];
    sh.shields = 0;
    runTriggers(s, sh, 'endPhase');
    runTriggers(s, sh, 'redManeuverExecuted');
    expect(sh.shields).toBe(0);
  });

  it('stat bonuses add up, from ships or upgrade lists', () => {
    const sh = ship(baseA, { upgrades: up('signal-jammer', 't-jam') });
    expect(statBonus(sh, 'jamRange')).toBe(3);
    expect(jamRange(sh)).toBe(5);
    expect(statBonus(['payload-expert'], 'deviceCharges')).toBe(1);
    expect(statBonus([], 'deviceCharges')).toBe(0);
  });

  it('every shipped talent is described by effects', () => {
    for (const u of Object.values(UPGRADES)) {
      if (u.slot === 'talent') expect(u.effects?.length, u.id).toBeGreaterThan(0);
    }
    expect(effectsOf({ upgrades: up('elusive') }, 'trigger').map((x) => x.effect.on)).toEqual(['redManeuverExecuted']);
  });
});
