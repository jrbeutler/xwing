// Missions: rulesets gate what is offered, objectives move on and decide the result, and every training
// mission can be played to a result (the AI flying both sides, the player's side drawn to its objectives).
import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { legalTargets } from '../src/combat';
import { actionOptions, apply, legalDial, maneuverFor, viewFor } from '../src/game';
import { touchesMarker } from '../src/mission';
import { isSpecialManeuver } from '../src/rules';
import { missionGame, TRAINING } from '../src/training';
import type { Command, GameState } from '../src/types';

const mission = (id: string) => TRAINING.find((m) => m.id === id)!;

/** Play a mission to the end with the AI on both sides. */
function playOut(g: GameState, steps = 4000): GameState {
  for (let n = 0; n < steps && g.phase !== 'over'; n++) {
    const d = g.pending!;
    const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
    const cmd: Command = aiDecide({ ...viewFor(g, who), rng: g.rng }, who)!;
    g = apply(g, cmd);
  }
  return g;
}

describe('rulesets', () => {
  it('mission 1 offers no red or special maneuvers, no actions and no attacks', () => {
    const g = missionGame(mission('training-1'), 1);
    const sh = g.ships[0];
    for (const i of legalDial(g, sh)) {
      const m = maneuverFor(sh, i);
      expect(m.difficulty).not.toBe('red');
      expect(isSpecialManeuver(m)).toBe(false);
    }
    expect(actionOptions(g, sh)).toEqual([{ type: 'none' }]);
    expect(legalTargets(g, sh)).toEqual([]);
  });

  it('mission 3 offers Focus and Evade only', () => {
    const g = missionGame(mission('training-3'), 1);
    expect(new Set(actionOptions(g, g.ships[0]).map((o) => o.type))).toEqual(new Set(['none', 'focus', 'evade']));
  });

  it('crits deal no damage cards until mission 7', () => {
    for (const m of TRAINING) expect(m.ruleset.damageCards, m.id).toBe(m.number >= 7);
  });
});

describe('objectives', () => {
  it('a flight course counts gates in order, touched by the base', () => {
    const g = missionGame(mission('training-1'), 1);
    const sh = g.ships[0];
    const [g1, g2] = g.mission!.markers;
    expect(touchesMarker(sh, { x: g1.x, y: g1.y - 40, h: Math.PI / 2 }, g1)).toBe(true); // base edge within the radius
    expect(touchesMarker(sh, { x: g1.x, y: g1.y - 80, h: Math.PI / 2 }, g1)).toBe(false);
    expect(touchesMarker(sh, { x: g2.x, y: g2.y, h: 0 }, g2)).toBe(true);
  });

  it('round 1 messages are logged when the mission starts', () => {
    const g = missionGame(mission('training-1'), 1);
    expect(g.log.some((e) => e.type === 'message' && e.title === 'Your dial')).toBe(true);
  });

  it('losing every ship loses the mission; a protected ship destroyed fails it', () => {
    let g = missionGame(mission('training-8'), 3);
    const lumen = g.ships.find((x) => x.tags?.includes('freighter'))!;
    lumen.hull = 1; lumen.shields = 0;
    g = playOut(g);
    expect(g.phase).toBe('over');
    expect(g.mission!.result).not.toBeNull();
    if (g.ships.find((x) => x.id === lumen.id)!.destroyed) {
      expect(g.mission!.result).toBe('loss');
      expect(g.mission!.objectives.find((o) => o.id === 'protect')!.status).toBe('failed');
    }
    expect(g.log.at(-1)).toMatchObject({ type: 'gameOver', mission: g.mission!.result });
  });
});

describe('every training mission plays to a result', () => {
  for (const m of TRAINING) {
    it(`${m.number}. ${m.title}`, () => {
      let wins = 0;
      const n = 12;
      for (let seed = 1; seed <= n; seed++) {
        const g = playOut(missionGame(m, seed * 101));
        expect(g.phase, `seed ${seed}`).toBe('over');
        expect(g.round).toBeLessThanOrEqual(m.maxRounds);
        expect(g.mission!.result).not.toBeNull();
        if (g.mission!.result === 'win') wins++;
      }
      // The flight course and the drones are near-certain wins; the fights are winnable.
      if (m.number <= 2) expect(wins).toBeGreaterThanOrEqual(n - 1);
      else expect(wins).toBeGreaterThan(0);
      console.log(`${m.id}: ${wins}/${n} wins with the AI flying for the player`);
    }, 120000);
  }
});
