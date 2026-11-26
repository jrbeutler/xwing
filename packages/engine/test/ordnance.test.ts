import { describe, expect, it } from 'vitest';
import { attackDiceFor, defenseDiceFor, legalTargets, resolveAttack } from '../src/combat';
import { apply, createGame, isIonized } from '../src/game';
import type { GameState, ShipState, TargetInfo } from '../src/types';

/** Attacker (Tobin, Kestrel) facing a Wasp `gap` mm ahead, base edge to base edge. */
const lineUp = (gap: number, upgrades: string[], defender = 'syl-ketch') => createGame({
  seed: 5,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 400, h: 0 }, upgrades }],
    b: [{ pilotId: defender, pose: { x: 300 + 40 + gap, y: 400, h: Math.PI } }],
  },
});
const weapons = (g: GameState) => legalTargets(g, g.ships[0]).map((t) => t.weapon ?? 'primary').sort();

describe('which weapons can fire', () => {
  it('torpedoes need a lock, a charge and range 2-3', () => {
    const g = lineUp(150, ['proton-torpedoes']); // range 2
    expect(weapons(g)).toEqual(['primary']); // no lock yet
    g.ships[0].lock = g.ships[1].id;
    expect(weapons(g)).toEqual(['primary', 'proton-torpedoes']);
    g.ships[0].upgrades.at(-1)!.charges = 0;
    expect(weapons(g)).toEqual(['primary']);
    const close = lineUp(50, ['proton-torpedoes']); // range 1
    close.ships[0].lock = close.ships[1].id;
    expect(weapons(close)).toEqual(['primary']);
  });

  it('rocket pods fire at range 1-2 without a lock', () => {
    expect(weapons(lineUp(50, ['rocket-pods']))).toEqual(['primary', 'rocket-pods']);
    expect(weapons(lineUp(250, ['rocket-pods']))).toEqual(['primary']); // range 3
  });

  it('secondary weapons get no range bonuses', () => {
    const g = lineUp(250, []);
    const [a, d] = g.ships;
    const t = (weapon?: string, range = 2): TargetInfo => ({ targetId: d.id, arc: 'front', attack: 3, range, obstructed: false, bullseye: false, weapon });
    expect(attackDiceFor(a, t())).toBe(4);
    expect(attackDiceFor(a, t('rocket-pods'))).toBe(3);
    expect(defenseDiceFor(d, t(undefined, 4))).toBe(4); // the long-range defense die is for primary shots
    expect(defenseDiceFor(d, t('proton-torpedoes', 4))).toBe(3);
  });
});

describe('firing ordnance', () => {
  const shot = (weapon: string, attack: number): TargetInfo => ({ targetId: 'b-0', arc: 'front', attack, range: 2, obstructed: false, bullseye: false, weapon });

  it('spends a charge per shot', () => {
    const g = lineUp(150, ['concussion-missiles']);
    const [a, d] = g.ships;
    resolveAttack(g, a, d, shot('concussion-missiles', 3));
    expect(a.upgrades.at(-1)!.charges).toBe(2);
  });

  it('Proton Torpedoes turn a hit into a crit', () => {
    for (let seed = 1; seed < 60; seed++) {
      const g = lineUp(150, ['proton-torpedoes']);
      g.rng = seed;
      const r = resolveAttack(g, g.ships[0], g.ships[1], shot('proton-torpedoes', 4));
      const rolledHit = r.attackRoll.includes('hit');
      if (rolledHit) expect(r.attackFinal.filter((f) => f === 'crit').length).toBeGreaterThan(r.attackRoll.filter((f) => f === 'crit').length);
    }
  });

  it('Ion Torpedoes deal 1 damage and turn the rest into ion tokens', () => {
    for (let seed = 1; seed < 200; seed++) {
      const g = lineUp(150, ['ion-torpedoes']);
      g.rng = seed;
      const [a, d] = g.ships;
      const before = d.hull + d.shields;
      const r = resolveAttack(g, a, d, shot('ion-torpedoes', 4));
      const through = r.hits + r.crits;
      if (through < 2) continue;
      expect(before - (d.hull + d.shields)).toBe(1);
      expect(r.ion).toBe(through - 1);
      expect(d.ion).toBe(through - 1);
      return;
    }
    throw new Error('no seed got 2+ results through');
  });

  it('ion tokens ionize by base size: 1 for small, 2 for medium', () => {
    const g = lineUp(150, [], 'drav-okono');
    const [small, medium] = g.ships;
    expect(isIonized({ ...small, ion: 1 })).toBe(true);
    expect(isIonized({ ...medium, ion: 1 })).toBe(false);
    expect(isIonized({ ...medium, ion: 2 })).toBe(true);
  });

  it('the attack command fires the chosen weapon', () => {
    const g0 = lineUp(150, ['rocket-pods']);
    const [a, d] = g0.ships;
    Object.assign(g0, { phase: 'engagement', queue: [a.id], queueIndex: 0, engagementInitiative: a.initiative });
    g0.pending = { kind: 'attack', playerId: 'a', shipId: a.id, targets: legalTargets(g0, a) };
    const g = apply(g0, { type: 'attack', playerId: 'a', targetId: d.id, weapon: 'rocket-pods' });
    const ev = g.log.find((e) => e.type === 'attack');
    expect(ev).toMatchObject({ weapon: 'rocket-pods' });
    expect((ev as { attackRoll: unknown[] }).attackRoll).toHaveLength(3);
    expect(g.ships[0].upgrades.at(-1)!.charges).toBe(1);
    expect(() => apply(g0, { type: 'attack', playerId: 'a', targetId: d.id, weapon: 'proton-torpedoes' })).toThrow('Illegal target');
  });
});
