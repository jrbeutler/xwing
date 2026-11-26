import { describe, expect, it } from 'vitest';
import { defenseDiceFor, inFiringArc } from '../src/combat';
import { apply, createGame, jamTargets } from '../src/game';
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
    g0.ships[0].upgrades.at(-1)!.charges = 0;
    const g = round(g0, kturn);
    expect(g.ships[0].upgrades.at(-1)!.charges).toBe(1);
  });
});

describe('pilot talents and classes', () => {
  const players = [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }] as [any, any];
  const two = (a: { pilotId: string; shipType?: string; upgrades?: string[] }, b = { pilotId: 'grunt-seven' }) =>
    createGame({ seed: 4, players, squads: { a: [{ ...a, pose: { x: 300, y: 300, h: 0 } }], b: [{ ...b, pose: { x: 600, y: 600, h: Math.PI } }] } });

  it('signature talents come with the pilot, ahead of bought upgrades', () => {
    expect(two({ pilotId: 'tobin-reyes', upgrades: ['shield-booster'] }).ships[0].upgrades.map((u) => u.id)).toEqual(['marksman', 'shield-booster']);
  });

  it('a pilot can fly any hull; outside their class they lose 1 initiative', () => {
    const own = two({ pilotId: 'mara-venn', shipType: 'javelin' }).ships[0];
    expect([own.typeId, own.initiative]).toEqual(['javelin', 5]);
    const off = two({ pilotId: 'syl-ketch', shipType: 'wayfarer' }).ships[0];
    expect([off.typeId, off.initiative, off.upgrades.length]).toEqual(['wayfarer', 2, 0]); // Hotshot lost with the slot
  });

  it('Payload Expert adds a charge to each device', () => {
    const g = two({ pilotId: 'bram-holloway', upgrades: ['proton-bomb', 'proximity-mine'] });
    expect(g.ships[0].upgrades.map((u) => u.charges)).toEqual([0, 3, 3]);
    expect(two({ pilotId: 'rook-twelve', upgrades: ['proton-bomb'] }).ships[0].upgrades[0].charges).toBe(2);
  });

  it('Damage Control recovers 1 shield once, in the End phase', () => {
    const g0 = two({ pilotId: 'drav-okono' });
    g0.ships[0].shields = 1;
    let g = round(g0, SHIP_TYPES.bulwark.dial.findIndex((m) => m.bearing === 'straight'));
    expect(g.ships[0].shields).toBe(2);
    expect(g.log).toContainEqual(expect.objectContaining({ type: 'upgrade', upgrade: 'damage-control', what: 'used' }));
    g.ships[0].shields = 1;
    g = round(g, SHIP_TYPES.bulwark.dial.findIndex((m) => m.bearing === 'straight'));
    expect(g.ships[0].shields).toBe(1); // spent
  });

  it('Damage Control waits until shields are down', () => {
    const g = round(two({ pilotId: 'drav-okono' }), SHIP_TYPES.bulwark.dial.findIndex((m) => m.bearing === 'straight'));
    expect(g.ships[0].upgrades[0].charges).toBe(1);
  });

  it('Signal Jammer lets the Jam action reach range 3', () => {
    const at = (pilotId: string) => {
      const g = createGame({ seed: 5, players, squads: {
        a: [{ pilotId, pose: { x: 450, y: 450, h: 0 } }],
        b: [{ pilotId: 'syl-ketch', pose: { x: 710, y: 450, h: Math.PI } }], // range 3 ahead
      } });
      return jamTargets(g, g.ships[0]).length;
    };
    expect(at('scout-two')).toBe(0);
    expect(at('tessa-varn')).toBe(1);
  });
});
