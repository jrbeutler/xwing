// Cannon, crew, gunner, droid and sensor upgrades, and the effect hooks they use.
import { describe, expect, it } from 'vitest';
import { attackOdds, defenseDiceFor, legalTargets, resolveAttack } from '../src/combat';
import { UPGRADES } from '../src/content';
import { actionBar } from '../src/effects';
import { actionOptions, apply, coordinateTargets, createGame, legalDial, maneuverFor, viewFor, type SquadEntry } from '../src/game';
import { SHIP_TYPES } from '../src/content';
import type { GameState, ShipState, TargetInfo } from '../src/types';

const players: [{ id: string; name: string; faction: string }, { id: string; name: string; faction: string }] =
  [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }];
const game = (a: SquadEntry[], b: SquadEntry[], extra: Partial<Parameters<typeof createGame>[0]> = {}) =>
  createGame({ seed: 11, players, squads: { a, b }, ...extra });
const up = (...ids: string[]) => ids.map((id) => ({ id, charges: UPGRADES[id].charges ?? 0 }));

function simulate(a: ShipState, d: ShipState, t: TargetInfo, n: number) {
  const rng = { rng: 777, log: [], ships: [], phase: 'planning' } as unknown as GameState;
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
    const k = r.shieldDamage + r.hullDamage;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts.map((c) => (c ?? 0) / n);
}
const expectOddsMatch = (a: ShipState, d: ShipState, t: TargetInfo) => {
  const odds = attackOdds(a, d, t);
  const sim = simulate(a, d, t, 40000);
  for (let k = 0; k < Math.max(sim.length, odds.dist.length); k++) expect(Math.abs((sim[k] ?? 0) - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
};

describe('slots on the existing ships', () => {
  it('fighters get droids, cannons and sensors; medium ships crew and gunners', () => {
    expect(SHIP_TYPES.kestrel.slots).toEqual(expect.arrayContaining(['cannon', 'droid']));
    expect(SHIP_TYPES.wasp.slots).toContain('sensor');
    expect(SHIP_TYPES.javelin.slots).toEqual(expect.arrayContaining(['droid', 'sensor']));
    expect(SHIP_TYPES.anvil.slots).toEqual(expect.arrayContaining(['droid', 'gunner']));
    expect(SHIP_TYPES.bulwark.slots).toEqual(expect.arrayContaining(['cannon', 'crew', 'gunner', 'sensor']));
    expect(SHIP_TYPES.wayfarer.slots).toEqual(expect.arrayContaining(['crew', 'gunner', 'sensor']));
  });
  it('every new slot has upgrades to put in it', () => {
    for (const slot of ['cannon', 'crew', 'gunner', 'droid', 'sensor']) {
      expect(Object.values(UPGRADES).filter((u) => u.slot === slot).length, slot).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('cannons', () => {
  // A Kestrel at the centre facing +x and a Wasp `dx` ahead (`dy` to the side).
  const duel = (cannon: string, dx: number, dy = 0) =>
    game([{ pilotId: 'tobin-reyes', pose: { x: 300, y: 450, h: 0 }, upgrades: [cannon] }], [{ pilotId: 'syl-ketch', pose: { x: 300 + dx, y: 450 + dy, h: Math.PI } }]);
  const shots = (g: GameState, id: string) => legalTargets(g, g.ships[0]).filter((t) => t.weapon === id);

  it('a heavy laser cannon only fires at range 2-3 into the bullseye', () => {
    expect(shots(duel('heavy-laser-cannon', 200), 'heavy-laser-cannon')).toMatchObject([{ attack: 4, bullseye: true }]);
    expect(shots(duel('heavy-laser-cannon', 200, 60), 'heavy-laser-cannon')).toHaveLength(0); // in arc, not in the bullseye
    expect(shots(duel('heavy-laser-cannon', 80), 'heavy-laser-cannon')).toHaveLength(0); // range 1
  });

  it('cannons have no charges: they never run out', () => {
    const g = duel('ion-cannon', 200);
    const t = shots(g, 'ion-cannon')[0];
    expect(t).toMatchObject({ attack: 3 });
    for (let i = 0; i < 5; i++) resolveAttack(g, g.ships[0], { ...g.ships[1], hull: 99, shields: 99 }, t);
    expect(shots(g, 'ion-cannon')).toHaveLength(1);
  });

  it('the autocannon makes the defender roll 1 fewer die, and only with the autocannon', () => {
    const g = duel('autocannon', 120);
    const [a, d] = g.ships;
    const t = shots(g, 'autocannon')[0];
    expect(defenseDiceFor(d, t, a)).toBe(defenseDiceFor(d, { ...t, weapon: undefined }, a) - 1);
    expectOddsMatch(a, d, t);
  });
});

describe('gunners', () => {
  // A Bulwark with a dorsal turret facing front, and a Wasp ahead at range 1.
  const bulwark = (upgrades: string[]) => game(
    [{ pilotId: 'drav-okono', pose: { x: 300, y: 450, h: 0 }, upgrades: ['dorsal-turret', ...upgrades] }],
    [{ pilotId: 'syl-ketch', pose: { x: 380, y: 450, h: Math.PI } }],
  );

  it('Gunnery Chief turns a focus result into a hit on turret attacks, and the odds know it', () => {
    const g = bulwark(['gunnery-chief']);
    const [a, d] = g.ships;
    const t = legalTargets(g, a).find((x) => x.weapon === 'dorsal-turret')!;
    expectOddsMatch(a, d, t);
    expectOddsMatch({ ...a, focus: 1 }, d, t);
    const plain = attackOdds({ ...a, upgrades: up('dorsal-turret') }, d, t).expected;
    expect(attackOdds(a, d, t).expected).toBeGreaterThan(plain + 0.2);
    const primary = legalTargets(g, a).find((x) => !x.weapon)!;
    expect(attackOdds(a, d, primary).expected).toBeCloseTo(attackOdds({ ...a, upgrades: up('dorsal-turret') }, d, primary).expected, 9);
  });

  it('Second Gunner: a miss gives one bonus attack with a different turret weapon', () => {
    const s = bulwark(['second-gunner']);
    const [a] = s.ships;
    // Three Weapons Failures: no attack dice at all, so every shot misses.
    a.crits = ['weaponsFailure', 'weaponsFailure', 'weaponsFailure'];
    s.pending = { kind: 'attack', playerId: 'a', shipId: a.id, targets: legalTargets(s, a) };
    s.queue = [a.id, s.ships[1].id];
    s.queueIndex = 0;
    s.phase = 'engagement';
    const next = apply(s, { type: 'attack', playerId: 'a', targetId: s.ships[1].id });
    expect(next.pending).toMatchObject({ kind: 'attack', shipId: a.id, bonus: { source: 'second-gunner' } });
    const bonus = next.pending as Extract<GameState['pending'], { kind: 'attack' }>;
    expect(bonus.targets.every((t) => t.weapon === 'dorsal-turret')).toBe(true);
    const after = apply(next, { type: 'attack', playerId: 'a', targetId: s.ships[1].id, weapon: 'dorsal-turret' });
    expect(after.log.some((e) => e.type === 'upgrade' && e.upgrade === 'second-gunner')).toBe(true);
    // The bonus attack missed too, but there is no second bonus.
    expect(after.pending?.kind === 'attack' && after.pending.shipId === a.id).toBe(false);
  });
});

describe('crew', () => {
  it('Tactical Officer adds Coordinate and reaches range 3', () => {
    const g = game([
      { pilotId: 'tessa-varn', pose: { x: 300, y: 300, h: 0 }, upgrades: ['tactical-officer'] },
      { pilotId: 'grunt-seven', shipType: 'wasp', pose: { x: 300, y: 520, h: 0 } }, // range 3
    ], [{ pilotId: 'syl-ketch', pose: { x: 800, y: 800, h: Math.PI } }]);
    const [w, friend] = g.ships;
    expect(actionBar(w).map((x) => x.type)).toContain('coordinate');
    expect(coordinateTargets(g, w).map((x) => x.id)).toEqual([friend.id]);
    expect(actionOptions(g, w)).toContainEqual({ type: 'coordinate', targetId: friend.id });
  });

  it('Combat Medic repairs the worst card once, in the End phase', () => {
    let g = game([{ pilotId: 'drav-okono', pose: { x: 300, y: 300, h: Math.PI / 2 }, upgrades: ['combat-medic'] }],
      [{ pilotId: 'syl-ketch', pose: { x: 800, y: 850, h: -Math.PI / 2 } }]);
    g.ships[0].crits = ['stunnedPilot', 'consoleFire'];
    const round = (s: GameState) => {
      s = apply(s, { type: 'setDials', playerId: 'a', dials: { [s.ships[0].id]: legalDial(s, s.ships[0])[0] } });
      s = apply(s, { type: 'setDials', playerId: 'b', dials: { [s.ships[1].id]: legalDial(s, s.ships[1])[0] } });
      for (let i = 0; i < 20 && s.pending && s.pending.kind !== 'planning'; i++) {
        const p = s.pending;
        if (p.kind === 'action') s = apply(s, { type: 'action', playerId: p.playerId, choice: { type: 'none' } });
        else if (p.kind === 'attack') s = apply(s, { type: 'attack', playerId: p.playerId, targetId: null });
        else if (p.kind === 'system') s = apply(s, { type: 'drop', playerId: p.playerId, choice: { type: 'none' } });
      }
      return s;
    };
    g = round(g);
    expect(g.ships[0].crits).toEqual(['stunnedPilot']); // Console Fire went first
    expect(g.log.some((e) => e.type === 'damageCard' && e.what === 'repaired' && e.card === 'consoleFire')).toBe(true);
    g = round(g);
    expect(g.ships[0].crits).toEqual(['stunnedPilot']); // no charge left
  });

  it('Intelligence Agent sees the nearest enemy dial for the rest of the round', () => {
    let g = game([{ pilotId: 'drav-okono', pose: { x: 300, y: 300, h: Math.PI / 2 }, upgrades: ['intelligence-agent'] }], [
      { pilotId: 'syl-ketch', pose: { x: 300, y: 520, h: -Math.PI / 2 } },
      { pilotId: 'grunt-seven', pose: { x: 700, y: 520, h: -Math.PI / 2 } },
    ]);
    const [, near, far] = g.ships;
    g = apply(g, { type: 'setDials', playerId: 'a', dials: { [g.ships[0].id]: legalDial(g, g.ships[0])[0] } });
    g = apply(g, { type: 'setDials', playerId: 'b', dials: { [near.id]: 2, [far.id]: 2 } });
    expect(g.log).toContainEqual({ type: 'dialPeeked', shipId: g.ships[0].id, targetId: near.id, upgrade: 'intelligence-agent' });
    const view = viewFor(g, 'a');
    const unmoved = (id: string) => view.ships.find((x) => x.id === id)!;
    if (g.phase === 'activation' && !g.log.some((e) => e.type === 'moved' && e.shipId === near.id)) expect(unmoved(near.id).dial).toBe(2);
    expect(unmoved(far.id).dial).toBeNull();
    expect(viewFor(g, 'b').ships[0].dial).toBeNull(); // the agent's own dial is still hidden from b
  });
});

describe('droids', () => {
  it('Repair Droid recovers a shield every round', () => {
    let g = game([{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: Math.PI / 2 }, upgrades: ['repair-droid'] }],
      [{ pilotId: 'syl-ketch', pose: { x: 800, y: 850, h: -Math.PI / 2 } }]);
    g.ships[0].shields = 0;
    for (let r = 0; r < 2; r++) {
      g = apply(g, { type: 'setDials', playerId: 'a', dials: { [g.ships[0].id]: legalDial(g, g.ships[0])[0] } });
      g = apply(g, { type: 'setDials', playerId: 'b', dials: { [g.ships[1].id]: legalDial(g, g.ships[1])[0] } });
      while (g.pending && g.pending.kind !== 'planning') {
        const p = g.pending;
        if (p.kind === 'action') g = apply(g, { type: 'action', playerId: p.playerId, choice: { type: 'none' } });
        else if (p.kind === 'attack') g = apply(g, { type: 'attack', playerId: p.playerId, targetId: null });
        else break;
      }
      expect(g.ships[0].shields).toBe(r + 1);
    }
  });

  it('Patch Droid lets Repair fix cards that are not repairable', () => {
    const g = game([{ pilotId: 'tobin-reyes', pose: { x: 300, y: 300, h: 0 }, upgrades: ['patch-droid'] }],
      [{ pilotId: 'syl-ketch', pose: { x: 800, y: 850, h: 0 } }]);
    g.ships[0].crits = ['damagedEngine'];
    expect(actionOptions(g, g.ships[0])).toContainEqual({ type: 'repair', card: 'damagedEngine' });
    g.ships[0].upgrades = [];
    expect(actionOptions(g, g.ships[0])).not.toContainEqual({ type: 'repair', card: 'damagedEngine' });
  });

  it('Nav Droid flies red banks and turns as white, so a stressed ship can pick them', () => {
    const g = game([{ pilotId: 'rook-twelve', pose: { x: 300, y: 300, h: 0 }, upgrades: ['nav-droid'] }],
      [{ pilotId: 'syl-ketch', pose: { x: 800, y: 850, h: 0 } }]);
    const sh = g.ships[0];
    const dial = SHIP_TYPES.anvil.dial;
    const redTurn = dial.findIndex((m) => m.bearing === 'turnLeft' && m.difficulty === 'red');
    const redK = dial.findIndex((m) => m.bearing === 'kturn' && m.difficulty === 'red');
    expect(maneuverFor(sh, redTurn).difficulty).toBe('white');
    expect(maneuverFor(sh, redK).difficulty).toBe('red');
    sh.stress = 1;
    expect(legalDial(g, sh)).toContain(redTurn);
    expect(legalDial(g, sh)).not.toContain(redK);
  });
});

describe('sensors', () => {
  const duel = (upgrades: string[]) =>
    game([{ pilotId: 'tobin-reyes', pose: { x: 300, y: 450, h: 0 }, upgrades }], [{ pilotId: 'syl-ketch', pose: { x: 500, y: 450, h: Math.PI } }]);

  it('Fire-Control System keeps the lock after rerolling with it', () => {
    const g = duel(['fire-control-system']);
    const [a, d] = g.ships;
    const t = legalTargets(g, a)[0];
    let rerolled = 0;
    for (let i = 0; i < 50; i++) {
      const me = { ...structuredClone(a), lock: d.id };
      const r = resolveAttack(g, me, { ...structuredClone(d), hull: 99, shields: 99 }, t);
      expect(me.lock).toBe(d.id);
      expect(r.spent).not.toContain('attacker:lock');
      if (r.spent.includes('attacker:fire-control-system')) rerolled++;
    }
    expect(rerolled).toBeGreaterThan(10);
    const plain = { ...structuredClone(a), upgrades: [], lock: d.id };
    for (let i = 0; i < 50 && plain.lock; i++) resolveAttack(g, plain, { ...structuredClone(d), hull: 99, shields: 99 }, t);
    expect(plain.lock).toBeNull(); // without it, the first reroll spends the lock
    expectOddsMatch({ ...a, lock: d.id }, d, t);
  });

  it('Targeting Computer adds Calculate', () => {
    const g = duel(['targeting-computer']);
    expect(actionOptions(g, g.ships[0])).toContainEqual({ type: 'calculate' });
    expect(actionOptions(duel([]), duel([]).ships[0])).not.toContainEqual({ type: 'calculate' });
  });

  it('Collision Scanner keeps the action after hitting an asteroid', () => {
    const run = (upgrades: string[]) => {
      let g = game([{ pilotId: 'tobin-reyes', pose: { x: 300, y: 450, h: 0 }, upgrades }], [{ pilotId: 'syl-ketch', pose: { x: 300, y: 880, h: 0 } }], {
        obstacles: [{ id: 'rock', kind: 'asteroid', polygon: [{ x: 330, y: 420 }, { x: 360, y: 420 }, { x: 360, y: 480 }, { x: 330, y: 480 }] }],
      });
      const straight = SHIP_TYPES.kestrel.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 1);
      g = apply(g, { type: 'setDials', playerId: 'a', dials: { [g.ships[0].id]: straight } });
      g = apply(g, { type: 'setDials', playerId: 'b', dials: { [g.ships[1].id]: straight } });
      // The enemy (lower initiative) moves first and acts: let it pass.
      while (g.pending?.kind === 'action' && g.pending.playerId === 'b') g = apply(g, { type: 'action', playerId: 'b', choice: { type: 'none' } });
      return g;
    };
    expect(run(['collision-scanner']).pending).toMatchObject({ kind: 'action', shipId: 'a-0' });
    const without = run([]).pending;
    expect(without?.kind === 'action' && without.shipId === 'a-0').toBe(false);
  });
});
