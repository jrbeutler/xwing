import { describe, expect, it } from 'vitest';
import { defenseDiceFor, inFiringArc } from '../src/combat';
import { apply, createGame } from '../src/game';
import { SHIP_TYPES } from '../src/content';
import type { GameState, ShipState, TargetInfo } from '../src/types';

const duel = (a: { pose: ShipState['pose']; upgrades?: string[] }, b: { pose: ShipState['pose']; upgrades?: string[] }, pilotA = 'tobin-reyes') =>
  createGame({
    seed: 3,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: pilotA, ...a }], b: [{ pilotId: 'syl-ketch', ...b }] },
  });

describe('Outmaneuver', () => {
  const t: TargetInfo = { targetId: 'b-0', arc: 'front', attack: 3, range: 2, obstructed: false, bullseye: false };

  it('costs the defender a die when the attacker is outside its arcs', () => {
    // A behind B: both face +x, A at the back.
    const g = duel({ pose: { x: 300, y: 400, h: 0 }, upgrades: ['outmaneuver'] }, { pose: { x: 450, y: 400, h: 0 } });
    const [a, b] = g.ships;
    expect(inFiringArc(b, a)).toBe(false);
    expect(defenseDiceFor(b, t, a)).toBe(2); // agility 3 - 1
    expect(defenseDiceFor(b, t)).toBe(3);
  });

  it('does nothing head-on or for rear-arc attacks', () => {
    const g = duel({ pose: { x: 300, y: 400, h: 0 }, upgrades: ['outmaneuver'] }, { pose: { x: 450, y: 400, h: Math.PI } });
    const [a, b] = g.ships;
    expect(inFiringArc(b, a)).toBe(true);
    expect(defenseDiceFor(b, t, a)).toBe(3);
    const behind = duel({ pose: { x: 300, y: 400, h: 0 }, upgrades: ['outmaneuver'] }, { pose: { x: 450, y: 400, h: 0 } });
    expect(defenseDiceFor(behind.ships[1], { ...t, arc: 'rear' }, behind.ships[0])).toBe(3);
  });
});

/** Fly one round: `dial` for player a (b flies its slowest straight), no actions, hold fire. */
function round(g: GameState, dial: number) {
  const slow = (sh: ShipState) => SHIP_TYPES[sh.typeId].dial.findIndex((m) => m.bearing === 'straight');
  g = apply(g, { type: 'setDials', playerId: 'a', dials: { [g.ships[0].id]: dial } });
  g = apply(g, { type: 'setDials', playerId: 'b', dials: { [g.ships[1].id]: slow(g.ships[1]) } });
  for (let k = 0; g.pending && g.pending.kind !== 'planning' && k < 20; k++) {
    const d = g.pending;
    g = d.kind === 'action' ? apply(g, { type: 'action', playerId: d.playerId, choice: { type: 'none' } })
      : apply(g, { type: 'attack', playerId: d.playerId, targetId: null });
  }
  return g;
}

describe('red-maneuver talents', () => {
  const kturn = SHIP_TYPES.kestrel.dial.findIndex((m) => m.bearing === 'kturn'); // red
  const straight = SHIP_TYPES.kestrel.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 1);
  const far = { pose: { x: 700, y: 800, h: -Math.PI / 2 } };

  it('Hotshot gains a focus after a red maneuver (but not a blue one)', () => {
    const g0 = duel({ pose: { x: 300, y: 300, h: Math.PI / 2 }, upgrades: ['hotshot'] }, far);
    let log = round(structuredClone(g0), straight).log;
    expect(log.some((e) => e.type === 'upgrade' && e.upgrade === 'hotshot')).toBe(false);
    log = round(g0, kturn).log;
    expect(log).toContainEqual(expect.objectContaining({ type: 'upgrade', upgrade: 'hotshot', what: 'used' }));
  });

  it('Elusive recovers its spent charge after a red maneuver', () => {
    const g0 = duel({ pose: { x: 300, y: 300, h: Math.PI / 2 }, upgrades: ['elusive'] }, far);
    g0.ships[0].upgrades[0].charges = 0;
    const g = round(g0, kturn);
    expect(g.ships[0].upgrades[0].charges).toBe(1);
  });
});
