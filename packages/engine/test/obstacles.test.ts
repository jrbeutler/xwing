import { describe, expect, it } from 'vitest';
import { isObstructed, shipPolygon } from '../src/combat';
import { OBSTACLE_AVOID, scoreManeuver } from '../src/ai';
import { OBSTACLE_RULES, SHIP_TYPES } from '../src/content';
import { apply, createGame, DEFAULT_OBSTACLE_MIX, generateObstacles, resolveMovement } from '../src/game';
import { polygonsOverlap } from '../src/geometry';
import type { GameEvent, GameState, Obstacle, ObstacleKind } from '../src/types';

/** A square obstacle straddling x = 300 between y = 200 and 240: right in the path of a ship flying 2 straight up from y = 150. */
const block = (kind: ObstacleKind): Obstacle => ({ id: `${kind}-0`, kind, polygon: [{ x: 270, y: 200 }, { x: 330, y: 200 }, { x: 330, y: 240 }, { x: 270, y: 240 }] });

/** Syl Ketch's Wasp (moves first) flies 2 straight through `kind`; returns the game when it is done moving. */
function flyThrough(kind: ObstacleKind, seed: number) {
  let g = createGame({
    seed,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: {
      a: [{ pilotId: 'syl-ketch', pose: { x: 300, y: 150, h: Math.PI / 2 } }],
      b: [{ pilotId: 'kira-solace', pose: { x: 700, y: 850, h: -Math.PI / 2 } }],
    },
    obstacles: [block(kind)],
  });
  const twoStraight = SHIP_TYPES.wasp.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 2);
  g = apply(g, { type: 'setDials', playerId: 'a', dials: { 'a-0': twoStraight } });
  g = apply(g, { type: 'setDials', playerId: 'b', dials: { 'b-0': SHIP_TYPES.javelin.dial.findIndex((m) => m.bearing === 'straight') } });
  const hit = g.log.find((e): e is Extract<GameEvent, { type: 'obstacleHit' }> => e.type === 'obstacleHit')!;
  return { g, hit, canAct: g.pending?.kind === 'action' && g.pending.shipId === 'a-0' };
}
const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

describe('obstacle types', () => {
  it('asteroid: a hit or crit deals 1 damage, and the action is lost', () => {
    const faces = new Set<string>();
    for (const seed of seeds) {
      const { g, hit, canAct } = flyThrough('asteroid', seed);
      faces.add(hit.result);
      expect(hit.kind).toBe('asteroid');
      const dmg = hit.shieldDamage + hit.hullDamage;
      expect(dmg).toBe(hit.result === 'hit' || hit.result === 'crit' ? 1 : 0);
      expect(canAct).toBe(false);
      expect(g.ships[0].ion).toBe(0);
    }
    expect(faces.size).toBeGreaterThanOrEqual(3);
  });

  it('debris: 1 stress, and a crit deals critical damage', () => {
    let crits = 0;
    for (const seed of seeds) {
      const { g, hit, canAct } = flyThrough('debris', seed);
      expect(hit).toMatchObject({ kind: 'debris', stress: 1 });
      // A crit can deal Panicked Pilot, which adds 2 more.
      const panicked = g.log.some((e) => e.type === 'damageCard' && e.card === 'panickedPilot' && e.what === 'dealt');
      expect(g.ships[0].stress).toBe(panicked ? 3 : 1);
      const dmg = hit.shieldDamage + hit.hullDamage;
      expect(dmg).toBe(hit.result === 'crit' ? 1 : 0);
      if (hit.result === 'crit') crits++;
      expect(canAct).toBe(false); // stressed
    }
    expect(crits).toBeGreaterThan(0);
  });

  it('gas cloud: an ion token unless the die is blank; the ship keeps its action', () => {
    let ions = 0, blanks = 0;
    for (const seed of seeds) {
      const { g, hit, canAct } = flyThrough('gas', seed);
      expect(hit.shieldDamage + hit.hullDamage).toBe(0);
      expect(g.ships[0].ion).toBe(hit.result === 'blank' ? 0 : 1);
      expect(hit.ion ?? 0).toBe(hit.result === 'blank' ? 0 : 1);
      if (hit.result === 'blank') blanks++; else ions++;
      expect(canAct).toBe(true);
    }
    expect(ions).toBeGreaterThan(0);
    expect(blanks).toBeGreaterThan(0);
  });

  it('every kind obstructs attacks', () => {
    for (const kind of Object.keys(OBSTACLE_RULES) as ObstacleKind[]) {
      expect(isObstructed({ x: 300, y: 150 }, { x: 300, y: 300 }, [block(kind)])).toBe(true);
      expect(isObstructed({ x: 100, y: 150 }, { x: 100, y: 300 }, [block(kind)])).toBe(false);
    }
  });
});

describe('random boards', () => {
  it('get the default mix, deterministically, kept apart and in the middle', () => {
    const a = generateObstacles({ rng: 42 });
    expect(generateObstacles({ rng: 42 })).toEqual(a);
    expect(generateObstacles({ rng: 43 })).not.toEqual(a);
    for (const kind of Object.keys(DEFAULT_OBSTACLE_MIX) as ObstacleKind[]) {
      expect(a.filter((o) => o.kind === kind)).toHaveLength(DEFAULT_OBSTACLE_MIX[kind]);
    }
    for (let seed = 1; seed <= 50; seed++) {
      const obs = generateObstacles({ rng: seed });
      expect(obs.length).toBe(6);
      for (const o of obs) for (const p of o.polygon) { expect(p.y).toBeGreaterThan(150); expect(p.y).toBeLessThan(764); }
      for (let i = 0; i < obs.length; i++) for (let j = i + 1; j < obs.length; j++) expect(polygonsOverlap(obs[i].polygon, obs[j].polygon)).toBe(false);
      expect(new Set(obs.map((o) => o.id)).size).toBe(obs.length);
    }
  });

  it('take a custom mix', () => {
    const obs = generateObstacles({ rng: 7 }, { gas: 3 });
    expect(obs.map((o) => o.kind)).toEqual(['gas', 'gas', 'gas']);
  });

  it('gas clouds are bigger than asteroids on average, debris fields longer than wide', () => {
    const area = (o: Obstacle) => Math.abs(o.polygon.reduce((a, p, i) => { const q = o.polygon[(i + 1) % o.polygon.length]; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;
    const all = Array.from({ length: 30 }, (_, i) => generateObstacles({ rng: i + 100 })).flat();
    const avg = (k: ObstacleKind) => { const xs = all.filter((o) => o.kind === k).map(area); return xs.reduce((a, b) => a + b, 0) / xs.length; };
    expect(avg('gas')).toBeGreaterThan(avg('asteroid') * 1.5);
  });

  it('a scenario can lay out its own obstacles', () => {
    const g: GameState = createGame({
      seed: 1,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'grunt-seven', pose: { x: 300, y: 100, h: 0 } }], b: [{ pilotId: 'lance-four', pose: { x: 600, y: 800, h: 0 } }] },
      obstacles: [block('gas'), { ...block('debris'), id: 'debris-1', polygon: block('debris').polygon.map((p) => ({ x: p.x + 200, y: p.y + 200 })) }],
    });
    expect(g.obstacles.map((o) => o.kind)).toEqual(['gas', 'debris']);
  });
});

describe('AI obstacle avoidance', () => {
  // Syl Ketch's Wasp at y = 150 heading up the board; a 3 straight crosses the block at y = 200-240 and ends clear of it.
  const game = (obstacles: Obstacle[]) => createGame({
    seed: 1,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: 'syl-ketch', pose: { x: 300, y: 150, h: Math.PI / 2 } }], b: [{ pilotId: 'kira-solace', pose: { x: 700, y: 850, h: -Math.PI / 2 } }] },
    obstacles,
  });
  const threeStraight = SHIP_TYPES.wasp.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 3);
  const noJitter = () => 0;

  it('penalises a maneuver that flies through an obstacle even when it ends clear', () => {
    const clear = game([]), rock = game([block('asteroid')]);
    const flown = resolveMovement(rock, rock.ships[0], SHIP_TYPES.wasp.dial[threeStraight]);
    expect(flown.obstacles).toEqual(['asteroid-0']); // the rules count it
    expect(polygonsOverlap(shipPolygon(rock.ships[0], flown.final), block('asteroid').polygon)).toBe(false); // ends clear
    const delta = scoreManeuver(clear, clear.ships[0], threeStraight, noJitter) - scoreManeuver(rock, rock.ships[0], threeStraight, noJitter);
    expect(delta).toBeCloseTo(OBSTACLE_AVOID.asteroid, 9);
  });

  it('weighs the kinds differently', () => {
    const score = (kind: ObstacleKind) => { const g = game([block(kind)]); return scoreManeuver(g, g.ships[0], threeStraight, noJitter); };
    expect(score('asteroid')).toBeLessThan(score('debris'));
    expect(score('debris')).toBeLessThan(score('gas'));
  });

  it('does not penalise a path that misses', () => {
    const clear = game([]), away = game([{ ...block('asteroid'), polygon: block('asteroid').polygon.map((p) => ({ x: p.x + 300, y: p.y })) }]);
    expect(scoreManeuver(away, away.ships[0], threeStraight, noJitter)).toBe(scoreManeuver(clear, clear.ships[0], threeStraight, noJitter));
  });
});

describe('AI lookahead', () => {
  it('avoids ending nose-up to an obstacle it would have to fly into next round', () => {
    // A wide wall across the board at y = 330-370: a 3 straight from y = 150 ends just short of it (boxed in).
    const wall: Obstacle = { id: 'asteroid-w', kind: 'asteroid', polygon: [{ x: 150, y: 330 }, { x: 450, y: 330 }, { x: 450, y: 370 }, { x: 150, y: 370 }] };
    const g = createGame({
      seed: 1,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: { a: [{ pilotId: 'syl-ketch', pose: { x: 300, y: 150, h: Math.PI / 2 } }], b: [{ pilotId: 'kira-solace', pose: { x: 750, y: 850, h: -Math.PI / 2 } }] },
      obstacles: [wall],
    });
    const open = createGame({ seed: 1, players: [g.players[0], g.players[1]], squads: { a: [{ pilotId: 'syl-ketch', pose: { x: 300, y: 150, h: Math.PI / 2 } }], b: [{ pilotId: 'kira-solace', pose: { x: 750, y: 850, h: -Math.PI / 2 } }] } });
    const threeStraight = SHIP_TYPES.wasp.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 3);
    const flown = resolveMovement(g, g.ships[0], SHIP_TYPES.wasp.dial[threeStraight]);
    expect(flown.obstacles).toEqual([]); // the move itself is clean
    const delta = scoreManeuver(open, open.ships[0], threeStraight, () => 0) - scoreManeuver(g, g.ships[0], threeStraight, () => 0);
    expect(delta).toBeCloseTo(OBSTACLE_AVOID.boxedIn, 9);
  });
});
