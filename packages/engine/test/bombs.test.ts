import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { apply, createGame, dropOptions, dropPose, isIonized } from '../src/game';
import { SHIP_TYPES } from '../src/content';
import type { GameEvent, GameState, ShipState } from '../src/types';

type Pose = ShipState['pose'];
/** Bram (Anvil, two device slots) for a, Syl (Wasp) for b; extra ships optional. */
const game = (bramPose: Pose, upgrades: string[], enemyPose: Pose, extra: { pilotId: string; pose: Pose }[] = []) => createGame({
  seed: 4,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'bram-holloway', pose: bramPose, upgrades }, ...extra],
    b: [{ pilotId: 'syl-ketch', pose: enemyPose }],
  },
});
const straightIdx = (sh: ShipState, speed = 1) => SHIP_TYPES[sh.typeId].dial.findIndex((m) => m.bearing === 'straight' && m.speed === speed);
const slowest = (sh: ShipState) => {
  const dial = SHIP_TYPES[sh.typeId].dial;
  return dial.indexOf(dial.filter((m) => m.bearing === 'straight').sort((x, y) => x.speed - y.speed)[0]);
};
/** Set every ship's dial (default: slowest straight). */
function dials(g: GameState, pick: Record<string, number> = {}) {
  for (const pid of ['a', 'b']) {
    const ds = Object.fromEntries(g.ships.filter((x) => x.owner === pid).map((x) => [x.id, pick[x.id] ?? slowest(x)]));
    g = apply(g, { type: 'setDials', playerId: pid, dials: ds });
  }
  return g;
}
/** Answer decisions until planning comes round again: `drop` picks system drops, actions/attacks pass. */
function finishRound(g: GameState, drop: (o: any[]) => any = () => ({ type: 'none' }), action: (o: any[]) => any = () => ({ type: 'none' })) {
  for (let k = 0; g.pending && g.pending.kind !== 'planning' && k < 40; k++) {
    const d = g.pending;
    if (d.kind === 'system') g = apply(g, { type: 'drop', playerId: d.playerId, choice: drop(d.options) });
    else if (d.kind === 'action') g = apply(g, { type: 'action', playerId: d.playerId, choice: action(d.options) });
    else if (d.kind === 'attack') g = apply(g, { type: 'attack', playerId: d.playerId, targetId: null });
  }
  return g;
}
const events = (g: GameState, type: string) => g.log.filter((e) => e.type === type) as Extract<GameEvent, { type: any }>[];
const dropFirst = (o: any[]) => o.find((x) => x.type === 'drop') ?? { type: 'none' };
const UP = Math.PI / 2;

describe('dropping devices', () => {
  it('lands one straight template behind the ship, on the table only', () => {
    const g = game({ x: 450, y: 300, h: UP }, ['proton-bomb'], { x: 450, y: 800, h: -UP });
    const p = dropPose(g.ships[0]);
    expect(p.x).toBeCloseTo(450);
    expect(p.y).toBeCloseTo(300 - 20 - 40 - 15);
    expect(dropOptions(g, g.ships[0]).map((o) => o.type)).toEqual(['none', 'drop']);
    const edge = game({ x: 450, y: 60, h: UP }, ['proton-bomb'], { x: 450, y: 800, h: -UP });
    expect(dropOptions(edge, edge.ships[0])).toEqual([{ type: 'none' }]); // token would be off the board
  });

  it('asks in the System phase only when someone can drop, and spends a charge', () => {
    const none = dials(game({ x: 450, y: 300, h: UP }, [], { x: 450, y: 800, h: -UP }));
    expect(none.pending?.kind).not.toBe('system');
    let g = dials(game({ x: 450, y: 300, h: UP }, ['proton-bomb'], { x: 450, y: 800, h: -UP }));
    expect(g.pending).toMatchObject({ kind: 'system', playerId: 'a' });
    g = apply(g, { type: 'drop', playerId: 'a', choice: dropFirst((g.pending as { options: any[] }).options) });
    expect(events(g, 'deviceDropped')).toHaveLength(1);
    expect(g.ships[0].upgrades.at(-1)!.charges).toBe(2); // 2 + 1 from Bram's Payload Expert, minus the drop
    expect(g.phase).toBe('activation');
  });
});

describe('bombs', () => {
  it('a Proton Bomb gives each ship at range 0-1 a crit at the end of Activation, friends included', () => {
    // Bram drops behind him; a friendly Kestrel sits right where the bomb lands, the enemy is far away.
    let g = game({ x: 450, y: 400, h: UP }, ['proton-bomb'], { x: 800, y: 800, h: -UP }, [{ pilotId: 'vale-nine', pose: { x: 380, y: 300, h: UP } }]);
    const friend = g.ships.find((x) => x.pilotId === 'vale-nine')!;
    const stop = { [friend.id]: straightIdx(friend, 1), [g.ships[0].id]: straightIdx(g.ships[0], 1) };
    g = finishRound(dials(g, stop), dropFirst);
    const boom = events(g, 'deviceDetonated')[0] as Extract<GameEvent, { type: 'deviceDetonated' }>;
    expect(boom.device.upgrade).toBe('proton-bomb');
    expect(boom.ships.map((x) => x.shipId)).toContain(friend.id);
    const f = g.ships.find((x) => x.id === friend.id)!;
    expect(f.shields + f.hull).toBe(2 + 4 - 1); // one crit, absorbed by a shield
    expect(g.devices).toHaveLength(0); // bombs leave the table
  });

  it('an Ion Bomb gives 3 ion tokens, ionizing a small ship', () => {
    let g = game({ x: 450, y: 400, h: UP }, ['ion-bomb'], { x: 450, y: 250, h: UP });
    g = finishRound(dials(g), dropFirst);
    const syl = g.ships[1];
    expect(syl.ion).toBe(3);
    expect(isIonized(syl)).toBe(true);
  });
});

describe('mines', () => {
  it('stays on the table and detonates on the ship that flies onto it', () => {
    // Syl starts behind Bram and flies straight into where the mine lands.
    let g = game({ x: 450, y: 450, h: UP }, ['proximity-mine'], { x: 450, y: 230, h: UP });
    g = finishRound(dials(g), dropFirst);
    expect(events(g, 'deviceDropped')).toHaveLength(1);
    // Drops happen in the System phase, before anyone moves, so Syl flies straight through it.
    const boom = events(g, 'deviceDetonated') as Extract<GameEvent, { type: 'deviceDetonated' }>[];
    expect(boom).toHaveLength(1);
    expect(boom[0].ships.map((x) => x.shipId)).toEqual([g.ships[1].id]);
    expect(boom[0].ships[0].roll).toHaveLength(2);
    expect(g.devices).toHaveLength(0);
  });

  it('stays put while nobody touches it', () => {
    let g = game({ x: 450, y: 450, h: UP }, ['proximity-mine'], { x: 800, y: 800, h: -UP });
    g = finishRound(dials(g), dropFirst);
    expect(events(g, 'deviceDetonated')).toHaveLength(0);
    expect(g.devices).toHaveLength(1);
  });

  it('a boost onto a mine sets it off', () => {
    // Mara's Wasp can boost; a mine sits just ahead of her.
    const w = createGame({
      seed: 2, players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'mara-venn', pose: { x: 450, y: 450, h: UP } }], b: [{ pilotId: 'syl-ketch', pose: { x: 450, y: 850, h: -UP } }] },
    });
    w.devices.push({ id: 'm', upgrade: 'proximity-mine', owner: 'b', kind: 'mine', pose: { x: 450, y: 525, h: UP } });
    const m = w.ships[0];
    Object.assign(w, { phase: 'activation', queue: [m.id], queueIndex: 0 });
    const boost = { type: 'boost', bearing: 'straight', to: { x: 450, y: 450 + 40 + 40, h: UP } } as const;
    w.pending = { kind: 'action', playerId: 'a', shipId: m.id, options: [{ type: 'none' }, boost] };
    const after = apply(w, { type: 'action', playerId: 'a', choice: boost });
    expect(events(after, 'deviceDetonated')).toHaveLength(1);
    expect(after.devices).toHaveLength(0);
  });
});

describe('AI drops', () => {
  it('drops a bomb when an enemy will be in the blast and no friend will', () => {
    // Enemy right behind Bram, flying toward him.
    const g = dials(game({ x: 450, y: 450, h: UP }, ['proton-bomb'], { x: 450, y: 260, h: UP }));
    expect(aiDecide(g, 'a')).toMatchObject({ type: 'drop', choice: { type: 'drop', upgrade: 'proton-bomb' } });
  });

  it('holds the bomb when a friend would be caught too', () => {
    const g0 = game({ x: 450, y: 450, h: UP }, ['proton-bomb'], { x: 450, y: 260, h: UP }, [{ pilotId: 'vale-nine', pose: { x: 380, y: 250, h: UP } }]);
    const friend = g0.ships.find((x) => x.pilotId === 'vale-nine')!;
    const g = dials(g0, { [friend.id]: straightIdx(friend, 1) });
    expect(aiDecide(g, 'a')).toMatchObject({ type: 'drop', choice: { type: 'none' } });
  });
});
