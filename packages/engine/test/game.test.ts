import { describe, expect, it } from 'vitest';
import { createGame, quickSkirmish, apply, resolveMovement, viewFor } from '../src/game';
import { legalTargets, measureArc, resolveAttack } from '../src/combat';
import { aiDecide } from '../src/index';
import type { GameState } from '../src/types';

const duel = (p1: { x: number; y: number; h: number }, p2: { x: number; y: number; h: number }) =>
  createGame({
    seed: 42,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: 'tobin-reyes', pose: p1 }], b: [{ pilotId: 'ilse-kord', pose: p2 }] },
  });

describe('movement against the table', () => {
  it('bumps stop the ship touching the obstacle ship and flag a partial maneuver', () => {
    // ship ends at x=520 if unobstructed; blocker at 510 overlaps that spot
    const g = duel({ x: 400, y: 400, h: 0 }, { x: 510, y: 400, h: Math.PI });
    const me = g.ships[0];
    const mv = resolveMovement(g, me, { bearing: 'straight', speed: 2, difficulty: 'blue' });
    expect(mv.partial).toBe(true);
    expect(mv.bumped).toEqual(['b-0']);
    expect(mv.final.x).toBeLessThanOrEqual(470 + 1e-6);
    expect(mv.final.x).toBeGreaterThan(466);
  });

  it('ships may fly over others as long as they do not end overlapping', () => {
    const g = duel({ x: 400, y: 400, h: 0 }, { x: 460, y: 400, h: Math.PI });
    const mv = resolveMovement(g, g.ships[0], { bearing: 'straight', speed: 3, difficulty: 'blue' });
    expect(mv.partial).toBe(false);
  });

  it('leaving the board means fleeing', () => {
    const g = duel({ x: 880, y: 400, h: 0 }, { x: 100, y: 100, h: 0 });
    expect(resolveMovement(g, g.ships[0], { bearing: 'straight', speed: 1, difficulty: 'blue' }).fled).toBe(true);
  });
});

describe('arcs and range', () => {
  it('range bands measured base to base in arc', () => {
    const g = duel({ x: 100, y: 400, h: 0 }, { x: 290, y: 400, h: 0 });
    const [a, b] = g.ships;
    expect(measureArc(g, a, b, 'front')).toMatchObject({ range: 2, bullseye: true });
    expect(measureArc(g, b, a, 'front')).toBeNull();
    expect(legalTargets(g, b)).toHaveLength(0);
  });
  it('out of range beyond 300mm', () => {
    const g = duel({ x: 100, y: 400, h: 0 }, { x: 450, y: 400, h: 0 });
    expect(legalTargets(g, g.ships[0])).toHaveLength(0);
  });
});

describe('attacks', () => {
  it('damage goes to shields first and is deterministic for a seed', () => {
    const run = () => {
      const g = duel({ x: 100, y: 400, h: 0 }, { x: 160, y: 400, h: Math.PI });
      const [a, b] = g.ships;
      const t = legalTargets(g, a)[0];
      const r = resolveAttack(g, a, b, t);
      return { r, b: { hull: b.hull, shields: b.shields } };
    };
    const x = run(), y = run();
    expect(x).toEqual(y);
    expect(x.r.attackRoll).toHaveLength(4); // 3 + range-1 bonus
    if (x.r.hits + x.r.crits > 0) expect(x.b.shields).toBeLessThan(2);
  });
});

describe('full game loop', () => {
  const play = (seed: number): GameState => {
    let g = quickSkirmish(seed);
    let guard = 0;
    while (g.phase !== 'over' && guard++ < 2000) {
      const d = g.pending!;
      const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
      g = apply(g, aiDecide(viewForAi(g, who), who)!);
    }
    return g;
  };
  // AI decides from a redacted view but needs the real pending decision object.
  const viewForAi = (g: GameState, who: string) => ({ ...viewFor(g, who), rng: g.rng });

  it('AI vs AI finishes and is reproducible', () => {
    for (const seed of [1, 2, 3, 99]) {
      const a = play(seed), b = play(seed);
      expect(a.phase).toBe('over');
      expect(a.winner).not.toBeNull();
      expect(a.log.length).toBe(b.log.length);
      expect(a.winner).toBe(b.winner);
    }
  });

  it('hides opponent dials during planning', () => {
    let g = quickSkirmish(5);
    g = apply(g, aiDecide(g, 'p2')!);
    expect(g.ships.filter((s) => s.owner === 'p2').every((s) => s.dial !== null)).toBe(true);
    const v = viewFor(g, 'p1');
    expect(v.ships.filter((s) => s.owner === 'p2').every((s) => s.dial === null)).toBe(true);
    expect(v.rng).toBe(0);
  });

  it('rejects illegal commands', () => {
    const g = quickSkirmish(5);
    expect(() => apply(g, { type: 'attack', playerId: 'p1', targetId: null })).toThrow();
    expect(() => apply(g, { type: 'setDials', playerId: 'p1', dials: {} })).toThrow();
  });
});
