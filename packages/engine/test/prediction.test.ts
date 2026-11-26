import { describe, expect, it } from 'vitest';
import { PREDICTION, predictEnemies, suggestManeuvers } from '../src/ai';
import { shipPolygon } from '../src/combat';
import { SHIP_TYPES } from '../src/content';
import { createGame, inBounds, ION_MANEUVER, legalDial, viewFor } from '../src/game';
import { maneuverFinalPose } from '../src/maneuvers';
import type { ShipState } from '../src/types';

/** Our Kestrel (a) and an enemy Wasp (b) at the given poses; predictions are from a's seat. */
const setup = (enemy: ShipState['pose'], us: ShipState['pose'] = { x: 450, y: 150, h: Math.PI / 2 }) => createGame({
  seed: 2,
  players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
  squads: { a: [{ pilotId: 'tobin-reyes', pose: us }], b: [{ pilotId: 'grunt-seven', pose: enemy }] },
});

describe('enemy maneuver prediction', () => {
  it('gives up to 3 likely end positions whose weights sum to 1, most likely first', () => {
    const g = setup({ x: 450, y: 750, h: -Math.PI / 2 });
    const ps = predictEnemies(g, 'a').get('b-0')!;
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.length).toBeLessThanOrEqual(PREDICTION.top);
    expect(ps.reduce((a, p) => a + p.w, 0)).toBeCloseTo(1, 9);
    for (let k = 1; k < ps.length; k++) expect(ps[k].w).toBeLessThanOrEqual(ps[k - 1].w);
  });

  it('knows an ionized ship will drift 1 straight', () => {
    const g = setup({ x: 450, y: 750, h: -Math.PI / 2 });
    g.ships[1].ion = 1;
    expect(predictEnemies(g, 'a').get('b-0')).toEqual([{ pose: maneuverFinalPose(g.ships[1].pose, 40, ION_MANEUVER), w: 1 }]);
  });

  it('never predicts a red maneuver for a stressed ship', () => {
    const g = setup({ x: 450, y: 750, h: -Math.PI / 2 });
    g.ships[1].stress = 1;
    const reds = SHIP_TYPES.wasp.dial.filter((m) => m.difficulty === 'red').map((m) => maneuverFinalPose(g.ships[1].pose, 40, m));
    for (const p of predictEnemies(g, 'a').get('b-0')!) expect(reds).not.toContainEqual(p.pose);
  });

  it('expects a ship near the edge to turn away rather than fly off the table', () => {
    // Heading straight for the right edge, 100 mm from it: the old guess (100 mm ahead) is off the board.
    const g = setup({ x: 814, y: 450, h: 0 });
    PREDICTION.mode = 'straight';
    try {
      const naive = predictEnemies(g, 'a').get('b-0')![0].pose;
      expect(inBounds(shipPolygon(g.ships[1], naive))).toBe(false);
    } finally { PREDICTION.mode = 'modeled'; }
    for (const p of predictEnemies(g, 'a').get('b-0')!) expect(inBounds(shipPolygon(g.ships[1], p.pose))).toBe(true);
  });

  it('expects an enemy to turn toward a target it can reach', () => {
    // The Wasp flies up the board; our Kestrel is off to its right. Most likely it turns or banks right, not straight on.
    const g = setup({ x: 300, y: 300, h: Math.PI / 2 }, { x: 560, y: 420, h: Math.PI });
    const top = predictEnemies(g, 'a').get('b-0')![0].pose;
    const straight = { x: 300, y: 400 };
    expect(Math.hypot(top.x - 560, top.y - 420)).toBeLessThan(Math.hypot(straight.x - 560, straight.y - 420));
  });
});

describe('move suggestions', () => {
  it('suggests a legal maneuver for each of the player\'s ships, and none for the enemy', () => {
    const g = setup({ x: 450, y: 750, h: -Math.PI / 2 });
    const sug = suggestManeuvers(viewFor(g, 'a'), 'a');
    expect(Object.keys(sug)).toEqual(['a-0']);
    expect(legalDial(g, g.ships[0])).toContain(sug['a-0'].dial);
  });

  it('is the same from the player\'s redacted view as from the full state (it never reads hidden dials)', () => {
    const g = setup({ x: 450, y: 750, h: -Math.PI / 2 });
    g.ships[1].dial = 3; // the opponent has set a dial
    expect(suggestManeuvers(viewFor(g, 'a'), 'a')).toEqual(suggestManeuvers(g, 'a'));
  });

  it('explains the expected shot: an ionized enemy drifting into the arc is a sure target', () => {
    // The enemy is ionized (we know it drifts 1 straight) and sits ahead of us, facing away.
    const g = setup({ x: 450, y: 520, h: Math.PI / 2 });
    g.ships[1].ion = 1;
    const sug = suggestManeuvers(g, 'a')['a-0'];
    expect(sug.shots[0]).toMatchObject({ shipId: 'b-0', chance: 1 });
    expect(sug.shots[0].range).toBeGreaterThanOrEqual(1);
    expect(sug.threats).toEqual([]); // it faces away
    expect(sug.obstacles).toEqual([]);
  });

  it('flags threats: an ionized enemy drifting toward us has us in its arc', () => {
    const g = setup({ x: 450, y: 560, h: -Math.PI / 2 });
    g.ships[1].ion = 1;
    const sug = suggestManeuvers(g, 'a')['a-0'];
    for (const t of sug.threats) expect(t.chance).toBeGreaterThanOrEqual(0.3);
    expect(sug.shots.length + sug.threats.length).toBeGreaterThan(0);
  });
});
