import { describe, expect, it } from 'vitest';
import { clipToArc, defenseDiceFor, legalTargets, resolveAttack, shipPolygon } from '../src/combat';
import { aiDecide } from '../src/index';
import { actionOptions, apply, createGame } from '../src/game';
import type { GameState, TargetInfo } from '../src/types';

/** A Bulwark (turret slot) at the centre facing +x, and a Wasp placed relative to it. */
const setup = (dx: number, dy: number, upgrades: string[] = ['dorsal-turret'], pilotA = 'drav-okono') => createGame({
  seed: 9,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: pilotA, pose: { x: 450, y: 450, h: 0 }, upgrades }],
    b: [{ pilotId: 'syl-ketch', pose: { x: 450 + dx, y: 450 + dy, h: Math.PI } }],
  },
});
const turretShots = (g: GameState) => legalTargets(g, g.ships[0]).filter((t) => t.weapon === 'dorsal-turret');

describe('turret arcs', () => {
  it('left and right arcs are the side wedges (board +y is the ship\'s left)', () => {
    const g = setup(0, 150);
    const [a, b] = g.ships;
    expect(clipToArc(a.pose, 'left', shipPolygon(b)).length).toBeGreaterThanOrEqual(3);
    expect(clipToArc(a.pose, 'right', shipPolygon(b)).length).toBeLessThan(3);
    expect(clipToArc(a.pose, 'front', shipPolygon(b)).length).toBeLessThan(3);
  });

  it('the turret only fires through the arc it faces, at range 1-2', () => {
    const g = setup(0, 150); // enemy on the left, range 2
    expect(turretShots(g)).toHaveLength(0); // turret faces front
    g.ships[0].turretArc = 'left';
    expect(turretShots(g)).toMatchObject([{ arc: 'left', weapon: 'dorsal-turret', bullseye: false }]);
    const far = setup(0, 280); // range 3
    far.ships[0].turretArc = 'left';
    expect(turretShots(far)).toHaveLength(0);
  });

  it('turrets have no charges: they can fire every time', () => {
    const g = setup(150, 0);
    const [a, d] = g.ships;
    const t = turretShots(g)[0];
    for (let i = 0; i < 4; i++) resolveAttack(g, a, { ...d, shields: 99, hull: 99 }, t);
    expect(turretShots(g)).toHaveLength(1);
  });

  it('Outmaneuver does not apply to turret shots', () => {
    // Attacker behind the defender, both facing +x: outside the defender's arcs.
    const g = createGame({
      seed: 1,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'drav-okono', pose: { x: 300, y: 450, h: 0 }, upgrades: ['dorsal-turret', 'outmaneuver'] }], b: [{ pilotId: 'syl-ketch', pose: { x: 450, y: 450, h: 0 } }] },
    });
    const [a, d] = g.ships;
    const base: TargetInfo = { targetId: d.id, arc: 'front', attack: 3, range: 1, obstructed: false, bullseye: false };
    expect(defenseDiceFor(d, base, a)).toBe(2); // primary front-arc: Outmaneuver bites
    expect(defenseDiceFor(d, { ...base, weapon: 'dorsal-turret' }, a)).toBe(3); // turret: it does not
  });
});

describe('the Rotate action', () => {
  it('is offered only to ships with a turret, for the three other facings', () => {
    const g = setup(150, 0);
    const rot = actionOptions(g, g.ships[0]).filter((o) => o.type === 'rotateArc').map((o) => (o as { to: string }).to);
    expect(rot.sort()).toEqual(['left', 'rear', 'right']);
    const plain = setup(150, 0, []);
    expect(actionOptions(plain, plain.ships[0]).some((o) => o.type === 'rotateArc')).toBe(false);
  });

  it('is blocked by Damaged Sensor Array and while ionized', () => {
    const g = setup(150, 0);
    g.ships[0].crits = ['damagedSensorArray'];
    expect(actionOptions(g, g.ships[0]).some((o) => o.type === 'rotateArc')).toBe(false);
    const h = setup(150, 0);
    expect(actionOptions(h, h.ships[0], true).some((o) => o.type === 'rotateArc')).toBe(false);
  });

  it('turns the turret when performed', () => {
    const g0 = setup(0, 150);
    const a = g0.ships[0];
    Object.assign(g0, { phase: 'activation', queue: [a.id], queueIndex: 0 });
    g0.pending = { kind: 'action', playerId: 'a', shipId: a.id, options: actionOptions(g0, a) };
    const g = apply(g0, { type: 'action', playerId: 'a', choice: { type: 'rotateArc', to: 'left' } });
    expect(g.ships[0].turretArc).toBe('left');
  });

  it('the AI turns its turret toward an enemy it cannot otherwise shoot', () => {
    const g = setup(0, -150); // enemy on the right, nothing in the front arc
    const a = g.ships[0];
    Object.assign(g, { phase: 'activation', queue: [a.id], queueIndex: 0 });
    g.pending = { kind: 'action', playerId: 'a', shipId: a.id, options: actionOptions(g, a) };
    expect(aiDecide(g, 'a')).toMatchObject({ type: 'action', choice: { type: 'rotateArc', to: 'right' } });
  });
});

describe('turret primary (Wayfarer, after the HWK-290)', () => {
  const ways = (dx: number, dy: number, upgrades: string[] = []) => createGame({
    seed: 9,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: {
      a: [{ pilotId: 'tessa-varn', pose: { x: 450, y: 450, h: 0 }, upgrades }],
      b: [{ pilotId: 'syl-ketch', pose: { x: 450 + dx, y: 450 + dy, h: Math.PI } }],
    },
  });
  const primary = (g: GameState) => legalTargets(g, g.ships[0]).filter((t) => !t.weapon);

  it('fires its primary through the turret arc, which Rotate turns (no upgrade needed)', () => {
    const g = ways(0, 280); // enemy on the left at range 3 (medium base: 30 + 20 + 230 mm)
    expect(primary(g)).toHaveLength(0);
    expect(actionOptions(g, g.ships[0]).some((o) => o.type === 'rotateArc')).toBe(true);
    g.ships[0].turretArc = 'left';
    expect(primary(g)).toMatchObject([{ arc: 'left', turret: true, bullseye: false, range: 3 }]);
  });

  it('keeps primary range bonuses but is not a front-arc attack', () => {
    const g = ways(60, 0); // dead ahead at range 1
    const [t] = primary(g);
    expect(t).toMatchObject({ arc: 'front', turret: true, bullseye: false, range: 1 });
    const r = resolveAttack(g, g.ships[0], { ...g.ships[1], shields: 99, hull: 99 }, t);
    expect(r.attackRoll).toHaveLength(3); // attack 2 + range-1 bonus
    const out = createGame({
      seed: 1,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'tessa-varn', pose: { x: 300, y: 450, h: 0 }, upgrades: ['outmaneuver'] }], b: [{ pilotId: 'syl-ketch', pose: { x: 450, y: 450, h: 0 } }] },
    });
    const [ot] = legalTargets(out, out.ships[0]);
    expect(defenseDiceFor(out.ships[1], ot, out.ships[0])).toBe(3); // Outmaneuver does not apply to turret shots
  });

  it('the AI turns a turret primary toward an enemy up to range 3', () => {
    const g = ways(0, -250); // enemy on the right at range 3
    const a = g.ships[0];
    Object.assign(g, { phase: 'activation', queue: [a.id], queueIndex: 0 });
    g.pending = { kind: 'action', playerId: 'a', shipId: a.id, options: actionOptions(g, a) };
    expect(aiDecide(g, 'a')).toMatchObject({ type: 'action', choice: { type: 'rotateArc', to: 'right' } });
  });

  it('carries missiles, torpedoes and a turret together', async () => {
    const { fitsSlots } = await import('../src/squad');
    expect(fitsSlots('tessa-varn', ['concussion-missiles', 'proton-torpedoes', 'dorsal-turret', 'proton-bomb', 'shield-booster'])).toBe(true);
  });
});
