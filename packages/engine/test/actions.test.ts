import { describe, expect, it } from 'vitest';
import { attackOdds, legalTargets, reinforceCovers, resolveAttack } from '../src/combat';
import { SHIP_TYPES } from '../src/content';
import { aiDecide } from '../src/index';
import { actionOptions, apply, createGame, reloadable, startingCharges } from '../src/game';
import type { ActionChoice, Command, GameState, ShipState, TargetInfo } from '../src/types';

const straight = (typeId: string) => SHIP_TYPES[typeId].dial.findIndex((m) => m.bearing === 'straight');

/** Player a's ship (lower initiative, so it moves first) vs b's, far apart; returns the game at a's action. */
function atAction(a: { pilotId: string; shipType?: string; upgrades?: string[] }, b = { pilotId: 'kira-solace' }) {
  let g = createGame({
    seed: 5,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: {
      a: [{ ...a, pose: { x: 300, y: 150, h: Math.PI / 2 } }],
      b: [{ ...b, pose: { x: 600, y: 800, h: -Math.PI / 2 } }],
    },
  });
  g = apply(g, { type: 'setDials', playerId: 'a', dials: { [g.ships[0].id]: straight(g.ships[0].typeId) } });
  g = apply(g, { type: 'setDials', playerId: 'b', dials: { [g.ships[1].id]: straight(g.ships[1].typeId) } });
  if (g.pending?.kind === 'system') g = apply(g, { type: 'drop', playerId: 'a', choice: { type: 'none' } }); // bombers: drop nothing
  expect(g.pending).toMatchObject({ kind: 'action', shipId: 'a-0' });
  return g;
}
const act = (g: GameState, choice: ActionChoice) => apply(g, { type: 'action', playerId: 'a', choice });
const option = (g: GameState, type: string) => (g.pending as { options: ActionChoice[] }).options.find((o) => o.type === type)!;

describe('linked actions', () => {
  it('Barrel Roll links to a red Evade (Wasp)', () => {
    let g = atAction({ pilotId: 'syl-ketch' });
    g = act(g, option(g, 'barrelRoll'));
    expect(g.pending).toMatchObject({ kind: 'action', shipId: 'a-0', linked: { from: 'barrelRoll', red: true } });
    expect((g.pending as { options: ActionChoice[] }).options.map((o) => o.type)).toEqual(['none', 'evade']);
    g = act(g, { type: 'evade' });
    expect(g.ships[0]).toMatchObject({ evade: 1, stress: 1 });
    expect(g.log.filter((e) => e.type === 'action').at(-1)).toMatchObject({ type: 'action', action: { type: 'evade' }, linked: true });
    expect(g.pending).not.toMatchObject({ shipId: 'a-0', kind: 'action' }); // only one link
  });

  it('declining the linked action costs nothing', () => {
    let g = atAction({ pilotId: 'syl-ketch' });
    g = act(g, option(g, 'barrelRoll'));
    g = act(g, { type: 'none' });
    expect(g.ships[0]).toMatchObject({ evade: 0, stress: 0 });
  });

  it('actions without a link go straight on', () => {
    let g = atAction({ pilotId: 'syl-ketch' });
    g = act(g, { type: 'focus' });
    expect(g.pending).not.toMatchObject({ shipId: 'a-0', kind: 'action' });
  });

  it('Focus links to a white Rotate on the Wayfarer', () => {
    let g = atAction({ pilotId: 'scout-two' });
    g = act(g, { type: 'focus' });
    expect(g.pending).toMatchObject({ linked: { from: 'focus', red: false } });
    expect((g.pending as { options: ActionChoice[] }).options.filter((o) => o.type === 'rotateArc')).toHaveLength(3);
    g = act(g, { type: 'rotateArc', to: 'left' });
    expect(g.ships[0]).toMatchObject({ focus: 1, stress: 0, turretArc: 'left' });
  });

  it('no linked action after an ion maneuver', () => {
    let g = atAction({ pilotId: 'scout-two' });
    // Re-run the round with the Wayfarer ionized.
    g = createGame({
      seed: 5,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'scout-two', pose: { x: 300, y: 150, h: Math.PI / 2 } }], b: [{ pilotId: 'kira-solace', pose: { x: 600, y: 800, h: -Math.PI / 2 } }] },
    });
    g.ships[0].ion = 2; // a medium base is ionized by 2
    g = apply(g, { type: 'setDials', playerId: 'a', dials: { 'a-0': straight('wayfarer') } });
    g = apply(g, { type: 'setDials', playerId: 'b', dials: { 'b-0': straight('javelin') } });
    expect(g.pending).toMatchObject({ kind: 'action', shipId: 'a-0', ionized: true });
    g = act(g, { type: 'focus' });
    expect(g.pending).not.toMatchObject({ shipId: 'a-0', kind: 'action' });
  });

  it('the AI takes a red linked action only when it is worth the stress', () => {
    let g = atAction({ pilotId: 'syl-ketch' });
    g = act(g, option(g, 'barrelRoll'));
    // Far from any enemy, an Evade prevents nothing: not worth a stress.
    const cmd = aiDecide(g, 'a') as Extract<Command, { type: 'action' }>;
    expect(cmd.choice).toEqual({ type: 'none' });
  });
});

describe('Calculate, Reinforce and Reload actions', () => {
  it('Calculate gives a token, cleared in the End phase', () => {
    let g = atAction({ pilotId: 'scout-two' });
    g = act(g, { type: 'calculate' });
    expect(g.ships[0].calculate).toBe(1);
    expect(g.pending).not.toMatchObject({ shipId: 'a-0', kind: 'action' }); // no linked action from Calculate
    // Everyone else skips and holds fire: the End phase clears it.
    for (let k = 0; g.pending && g.pending.kind !== 'planning' && k < 10; k++) {
      const d = g.pending;
      g = d.kind === 'action' ? apply(g, { type: 'action', playerId: d.playerId, choice: { type: 'none' } })
        : apply(g, { type: 'attack', playerId: (d as { playerId: string }).playerId, targetId: null });
    }
    expect(g.round).toBe(2);
    expect(g.ships[0].calculate).toBe(0);
  });

  it('Reinforce covers the chosen half and the choice is offered both ways', () => {
    const g = atAction({ pilotId: 'hauler-three' });
    const sides = (g.pending as { options: ActionChoice[] }).options.filter((o) => o.type === 'reinforce');
    expect(sides).toEqual([{ type: 'reinforce', side: 'front' }, { type: 'reinforce', side: 'rear' }]);
    const g2 = act(g, sides[1]);
    expect(g2.ships[0].reinforce).toBe('rear');
  });

  it('Reload recovers a charge, disarms the ship and only offers spent ordnance', () => {
    const g = atAction({ pilotId: 'rook-twelve', upgrades: ['proton-bomb', 'concussion-missiles'] });
    const sh = g.ships[0];
    expect(reloadable(sh)).toEqual([]);
    expect(option(g, 'reload')).toBeUndefined();
    sh.upgrades.find((u) => u.id === 'concussion-missiles')!.charges = 1;
    const opts = actionOptions(g, sh).filter((o) => o.type === 'reload');
    expect(opts).toEqual([{ type: 'reload', upgrade: 'concussion-missiles' }]);
    (g.pending as { options: ActionChoice[] }).options = actionOptions(g, sh);
    const g2 = act(g, opts[0]);
    expect(g2.ships[0]).toMatchObject({ disarmed: true });
    expect(g2.ships[0].upgrades.find((u) => u.id === 'concussion-missiles')!.charges).toBe(2);
    expect(legalTargets(g2, { ...g2.ships[0], lock: 'b-0' })).toEqual([]);
  });

  it('device charges include Payload Expert', () => {
    const g = createGame({
      seed: 1, players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'bram-holloway', upgrades: ['proton-bomb'], pose: { x: 300, y: 150, h: 0 } }], b: [{ pilotId: 'kira-solace', pose: { x: 600, y: 800, h: 0 } }] },
    });
    const sh = g.ships[0];
    expect(startingCharges(sh, 'proton-bomb')).toBe(3);
    sh.upgrades.find((u) => u.id === 'proton-bomb')!.charges = 2;
    expect(reloadable(sh).map((u) => u.id)).toEqual(['proton-bomb']);
  });
});

// ---------------------------------------------------------------------------
// Dice: Calculate and Reinforce, odds against real rolls
// ---------------------------------------------------------------------------

const duel = createGame({
  seed: 7,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: 0 } }],
    b: [{ pilotId: 'hauler-three', pose: { x: 500, y: 300, h: Math.PI } }],
  },
});
const [baseA, baseD] = duel.ships;
const ship = (base: ShipState, x: Partial<ShipState>) => ({ ...base, focus: 0, evade: 0, calculate: 0, reinforce: null, lock: null, crits: [], upgrades: [], ...x }) as ShipState;
const target = (range: number, attack = 3): TargetInfo => ({ targetId: baseD.id, arc: 'front', attack, range, obstructed: false, bullseye: false });

function simulate(a: ShipState, d: ShipState, t: TargetInfo, n: number) {
  const rng = { rng: 999, log: [] } as unknown as GameState;
  const counts: number[] = [];
  const spent: Record<string, number> = {};
  let reinforced = 0;
  for (let i = 0; i < n; i++) {
    const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
    const k = r.shieldDamage + r.hullDamage;
    counts[k] = (counts[k] ?? 0) + 1;
    for (const x of r.spent) spent[x] = (spent[x] ?? 0) + 1;
    if (r.reinforced) reinforced++;
  }
  return { dist: counts.map((c) => (c ?? 0) / n), spent, reinforced };
}

describe('Calculate and Reinforce dice: attackOdds matches resolveAttack', () => {
  const cases: { name: string; a: Partial<ShipState>; d: Partial<ShipState>; t: TargetInfo }[] = [
    { name: 'attacker calculate', a: { calculate: 1 }, d: {}, t: target(2) },
    { name: 'attacker calculate + focus', a: { calculate: 1, focus: 1 }, d: {}, t: target(2) },
    { name: 'attacker calculate + lock + focus', a: { calculate: 1, focus: 1, lock: baseD.id }, d: { focus: 1 }, t: target(2) },
    { name: 'defender calculate', a: { focus: 1 }, d: { calculate: 1 }, t: target(2) },
    { name: 'defender calculate + focus + evade', a: { focus: 1 }, d: { calculate: 1, focus: 1, evade: 1 }, t: target(3, 4) },
    { name: 'reinforce front, attacker in front', a: { focus: 1 }, d: { reinforce: 'front' }, t: target(2, 4) },
    { name: 'reinforce rear, attacker in front: no effect', a: { focus: 1 }, d: { reinforce: 'rear' }, t: target(2, 4) },
    { name: 'everything', a: { calculate: 1, focus: 1, lock: baseD.id }, d: { calculate: 1, focus: 1, evade: 1, reinforce: 'front' }, t: target(2, 4) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const a = ship(baseA, c.a), d = ship(baseD, c.d);
      const odds = attackOdds(a, d, c.t);
      expect(odds.dist.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      const sim = simulate(a, d, c.t, 40000);
      for (let k = 0; k < Math.max(sim.dist.length, odds.dist.length); k++) {
        expect(Math.abs((sim.dist[k] ?? 0) - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
      }
    });
  }

  it('calculate is spent instead of focus on a single focus result', () => {
    const r = simulate(ship(baseA, { calculate: 1, focus: 1 }), ship(baseD, {}), target(2), 3000);
    expect(r.spent['attacker:calculate']).toBeGreaterThan(0);
    // Both are never needed on one attack: calculate takes a lone focus result, focus takes 2+.
    expect((r.spent['attacker:calculate'] ?? 0) + (r.spent['attacker:focus'] ?? 0)).toBeLessThanOrEqual(3000);
  });

  it('reinforce covers only the chosen half', () => {
    const front = ship(baseA, { pose: { x: 300, y: 300, h: 0 } });
    const behind = ship(baseA, { pose: { x: 700, y: 300, h: Math.PI } });
    const d = ship(baseD, { reinforce: 'front' }); // faces -x: front is toward x < 500
    expect(reinforceCovers(d, front)).toBe(true);
    expect(reinforceCovers(d, behind)).toBe(false);
    expect(reinforceCovers({ ...d, reinforce: 'rear' }, behind)).toBe(true);
    expect(reinforceCovers({ ...d, reinforce: null }, front)).toBe(false);
  });

  it('reinforce never cancels the only result', () => {
    const r = simulate(ship(baseA, {}), ship(baseD, { reinforce: 'front' }), target(3, 1), 4000); // 1 die
    expect(r.reinforced).toBe(0);
    const r2 = simulate(ship(baseA, { focus: 1 }), ship(baseD, { reinforce: 'front' }), target(2, 4), 4000);
    expect(r2.reinforced).toBeGreaterThan(1000);
  });
});
