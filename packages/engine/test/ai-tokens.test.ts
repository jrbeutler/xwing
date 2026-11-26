import { describe, expect, it } from 'vitest';
import { AI_OPTIONS, bestToken } from '../src/ai';
import { legalTargets } from '../src/combat';
import type { Pose } from '../src/geometry';
import { actionOptions, createGame } from '../src/game';

/** Tobin (Kestrel: Focus, Lock, Barrel Roll) and a Wasp `gap` mm apart, base edge to base edge; `facing` false turns the Wasp away. */
const lineUp = (gap: number, upgrades: string[] = [], facing = true) => createGame({
  seed: 5,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: {
    a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 400, h: 0 }, upgrades }],
    b: [{ pilotId: 'syl-ketch', pose: { x: 300 + 40 + gap, y: 400, h: facing ? Math.PI : 0 } }],
  },
});
const choose = (g: ReturnType<typeof lineUp>) => bestToken(g, g.ships[0], actionOptions(g, g.ships[0]))?.type;

describe('AI token choice', () => {
  it('locks a target at range 3 so the torpedoes (4 dice against the lasers\' 3) can fire', () => {
    expect(choose(lineUp(200, ['proton-torpedoes']))).toBe('lock');
  });
  it('at range 2 the lasers already roll 4 dice, so focus beats a lock for the torpedoes', () => {
    expect(choose(lineUp(150, ['proton-torpedoes']))).toBe('focus');
  });
  it('takes focus when the enemy can shoot back and there is no ordnance', () => {
    expect(choose(lineUp(150))).toBe('focus');
  });
  it('locks for next round when nobody can shoot this round', () => {
    // The Wasp is in lock range but outside the Kestrel's arc, and faces away.
    const g = lineUp(150, [], false);
    g.ships[1].pose = { x: 300, y: 400 + 40 + 150, h: Math.PI / 2 };
    expect(choose(g)).toBe('lock');
  });
});

describe('AI barrel roll and boost', () => {
  /**
   * Tobin's Kestrel faces +x at (300, 400); the Wasp sits 150 mm ahead but `side` mm off to the left, just
   * outside the front arc, facing away. Both have moved this round (it is Tobin's action).
   */
  const flank = (side: number) => {
    const g = lineUp(150, [], false);
    g.ships[1].pose = { x: 490, y: 400 + side, h: Math.PI / 2 };
    g.phase = 'activation';
    g.queue = ['b-0', 'a-0'];
    g.queueIndex = 1;
    return g;
  };
  const options = (g: ReturnType<typeof lineUp>) => actionOptions(g, g.ships[0]);

  it('rolls to bring an enemy that has already moved into its arc', () => {
    const g = flank(240);
    expect(legalTargets(g, g.ships[0])).toEqual([]);
    const c = bestToken(g, g.ships[0], options(g));
    expect(c).toMatchObject({ type: 'barrelRoll', dir: 'left' });
    const rolled = { ...g.ships[0], pose: (c as { to: Pose }).to };
    expect(legalTargets({ ...g, ships: [rolled, g.ships[1]] }, rolled).map((t) => t.targetId)).toContain('b-0');
  });

  it('keeps a token when the shot is already there', () => {
    const g = flank(0);
    expect(legalTargets(g, g.ships[0]).length).toBeGreaterThan(0);
    expect(bestToken(g, g.ships[0], options(g))?.type).not.toMatch(/barrelRoll|boost/);
  });

  it('does not roll onto a mine', () => {
    const g = flank(240);
    const roll = options(g).find((o) => o.type === 'barrelRoll' && o.dir === 'left' && o.shift === 0) as { to: Pose };
    g.devices = [{ id: 'm', upgrade: 'proximity-mine', owner: 'b', kind: 'mine', pose: roll.to }];
    const c = bestToken(g, g.ships[0], options(g)) as { type: string; to?: Pose };
    if (c?.type === 'barrelRoll' || c?.type === 'boost') expect(c.to).not.toEqual(roll.to);
  });

  it('can be switched off', () => {
    const g = flank(240);
    AI_OPTIONS.reposition = false;
    try { expect(bestToken(g, g.ships[0], options(g))?.type ?? 'none').not.toMatch(/barrelRoll|boost/); }
    finally { AI_OPTIONS.reposition = true; }
  });
});
