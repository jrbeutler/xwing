import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { actionOptions, apply, createGame, jamTargets } from '../src/game';
import type { ActionChoice, GameState } from '../src/types';

/** A Wayfarer (turret arc, Jam) at the centre facing +x, and a Wasp placed relative to it. */
const setup = (dx: number, dy: number) => createGame({
  seed: 5,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'scout-two', pose: { x: 450, y: 450, h: 0 } }],
    b: [{ pilotId: 'syl-ketch', pose: { x: 450 + dx, y: 450 + dy, h: Math.PI } }],
  },
});
const jams = (g: GameState) => actionOptions(g, g.ships[0]).filter((o) => o.type === 'jam');

/** Put the game into the Wayfarer's action step and apply a jam on the Wasp. */
function jamNow(g: GameState): GameState {
  const choice: ActionChoice = { type: 'jam', targetId: g.ships[1].id };
  g.pending = { kind: 'action', playerId: 'a', shipId: g.ships[0].id, options: [{ type: 'none' }, choice] };
  g.phase = 'activation';
  g.queue = [g.ships[0].id];
  g.queueIndex = 0;
  return apply(g, { type: 'action', playerId: 'a', choice });
}
const jamEvent = (g: GameState) => g.log.find((e) => e.type === 'jam');

describe('jam', () => {
  it('only the Wayfarer has it, against enemies at range 1-2 in the arc its turret faces', () => {
    expect(jams(setup(150, 0))).toEqual([{ type: 'jam', targetId: 'b-0' }]); // ahead, range 2
    expect(jams(setup(260, 0))).toHaveLength(0); // range 3
    expect(jams(setup(0, 150))).toHaveLength(0); // on the left, turret faces front
    const left = setup(0, 150);
    left.ships[0].turretArc = 'left';
    expect(jamTargets(left, left.ships[0]).map((s) => s.id)).toEqual(['b-0']);
    // The Wasp has no Jam
    const g = setup(150, 0);
    expect(actionOptions(g, g.ships[1]).some((o) => o.type === 'jam')).toBe(false);
  });

  it('strips Focus first, then Evade, then the target\'s lock', () => {
    const g = setup(150, 0);
    Object.assign(g.ships[1], { focus: 1, evade: 1, lock: 'a-0' });
    let after = jamNow(structuredClone(g));
    expect(jamEvent(after)).toMatchObject({ shipId: 'a-0', targetId: 'b-0', effect: 'focus' });
    expect(after.ships[1]).toMatchObject({ focus: 0, evade: 1, lock: 'a-0', jam: 0 });

    Object.assign(g.ships[1], { focus: 0, evade: 1, lock: 'a-0' });
    after = jamNow(structuredClone(g));
    expect(after.ships[1]).toMatchObject({ evade: 0, lock: 'a-0' });

    Object.assign(g.ships[1], { focus: 0, evade: 0, lock: 'a-0' });
    after = jamNow(structuredClone(g));
    expect(jamEvent(after)!).toMatchObject({ effect: 'lock' });
    expect(after.ships[1].lock).toBeNull();
  });

  it('with nothing to strip the target is jammed: its next Focus is cancelled, and the token clears at End', () => {
    const g = setup(150, 0);
    const after = jamNow(g);
    expect(jamEvent(after)).toMatchObject({ effect: 'jammed' });
    expect(after.ships[1].jam).toBe(1);

    const w = structuredClone(after);
    w.pending = { kind: 'action', playerId: 'b', shipId: 'b-0', options: [{ type: 'none' }, { type: 'focus' }] };
    w.queue = ['b-0'];
    w.queueIndex = 0;
    const focused = apply(w, { type: 'action', playerId: 'b', choice: { type: 'focus' } });
    expect(focused.ships[1]).toMatchObject({ focus: 0, jam: 0 });
    expect(focused.log.some((e) => e.type === 'jamSpent' && e.shipId === 'b-0' && e.lost === 'focus')).toBe(true);
  });

  it('the AI jams an enemy holding tokens, and not one with nothing to lose', () => {
    const g = setup(150, 0);
    g.ships[1].evade = 1;
    const options = actionOptions(g, g.ships[0]);
    g.pending = { kind: 'action', playerId: 'a', shipId: 'a-0', options };
    expect(aiDecide(g, 'a')).toMatchObject({ choice: { type: 'jam', targetId: 'b-0' } });
    g.ships[1].evade = 0;
    expect(aiDecide(g, 'a')!).not.toMatchObject({ choice: { type: 'jam' } });
  });
});
