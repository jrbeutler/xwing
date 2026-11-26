import { describe, expect, it } from 'vitest';
import { bestToken } from '../src/ai';
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
