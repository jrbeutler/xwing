import { describe, expect, it } from 'vitest';
import { PILOTS, SHIP_TYPES, UPGRADES } from '../src/content';
import { attackOdds, defenseDiceFor, sufferDamage } from '../src/combat';
import { createGame } from '../src/game';
import { BASE_SIZE } from '../src/maneuvers';
import {
  autoDeploy, buildAiSquad, canDeployAt, effectiveInitiative, fitsSlots, freeSlots, hullOf, shipSlots, signatureTalents, squadCost, upgradeCost, upgradeOptions, validateSquad,
  type Squad,
} from '../src/squad';

const ship = (pilotId: string, upgrades: string[] = [], shipType?: string) => ({ pilotId, upgrades, shipType });

describe('points and slots', () => {
  it('costs hull plus pilot plus upgrades, with upgrades priced by base size', () => {
    expect(upgradeCost('shield-booster', ship('tobin-reyes'))).toBe(5);
    expect(upgradeCost('shield-booster', ship('drav-okono'))).toBe(7);
    expect(upgradeCost('shield-booster', ship('tobin-reyes', [], 'bulwark'))).toBe(7); // the hull sets the size
    expect(squadCost({ ships: [ship('tobin-reyes', ['shield-booster']), ship('drav-okono')] })).toBe(19 + 12 + 5 + 28 + 12);
    expect(squadCost({ ships: [ship('tobin-reyes', [], 'wasp')] })).toBe(17 + 12);
  });

  it('gives pilots talent slots by initiative: none below 3, one at 3-4, two at 5+', () => {
    const talents = (pilotId: string, hull?: string) => shipSlots(ship(pilotId, [], hull)).filter((x) => x === 'talent').length;
    expect(talents('grunt-seven')).toBe(0);
    expect(talents('tobin-reyes')).toBe(1);
    expect(talents('mara-venn')).toBe(2);
    expect(talents('mara-venn', 'kestrel')).toBe(2); // any fighter hull
  });

  it('signature talents take a slot', () => {
    expect(signatureTalents(ship('tobin-reyes'))).toEqual(['marksman']);
    expect(freeSlots(ship('tobin-reyes'))).not.toContain('talent');
    expect(freeSlots(ship('mara-venn')).filter((x) => x === 'talent')).toHaveLength(1);
    expect(fitsSlots(ship('tobin-reyes', ['hotshot']))).toBe(false);
    expect(fitsSlots(ship('mara-venn', ['hotshot']))).toBe(true);
    expect(fitsSlots(ship('mara-venn', ['elusive']))).toBe(false); // already has it
  });

  it('only lets pilots learn talents from their specialty', () => {
    expect(fitsSlots(ship('tessa-varn', ['steady-gunner']))).toBe(true);
    expect(fitsSlots(ship('tessa-varn', ['hotshot']))).toBe(false);
    expect(fitsSlots(ship('mara-venn', ['steady-gunner']))).toBe(false);
    expect(upgradeOptions(ship('mara-venn')).filter((u) => UPGRADES[u].slot === 'talent').every((u) => UPGRADES[u].classes!.includes('fighter'))).toBe(true);
  });

  it('flying outside your specialty costs 1 initiative, and can cost a talent slot', () => {
    expect(hullOf(ship('mara-venn'))).toBe('wasp');
    expect(effectiveInitiative(ship('mara-venn', [], 'wayfarer'))).toBe(4);
    expect(effectiveInitiative(ship('mara-venn', [], 'kestrel'))).toBe(5);
    expect(signatureTalents(ship('mara-venn', [], 'wayfarer'))).toEqual(['elusive']); // 1 slot left, still hers
    expect(signatureTalents(ship('syl-ketch', [], 'anvil'))).toEqual([]); // initiative 2: no slot for Hotshot
    expect(effectiveInitiative(ship('grunt-seven', [], 'bulwark'))).toBe(1); // never below 1
  });

  it('fits upgrades into matching free slots, no duplicates', () => {
    expect(fitsSlots(ship('tobin-reyes', ['shield-booster']))).toBe(true);
    expect(fitsSlots(ship('tobin-reyes', ['shield-booster', 'hull-plating']))).toBe(false); // one modification slot
    expect(fitsSlots(ship('drav-okono', ['shield-booster', 'hull-plating']))).toBe(true); // two
    expect(fitsSlots(ship('drav-okono', ['shield-booster', 'shield-booster']))).toBe(false);
    expect(upgradeOptions(ship('tobin-reyes', ['shield-booster'])).map((u) => UPGRADES[u].slot)).not.toContain('modification');
    // No talent slot below initiative 3: with the modification taken, only the Wasp's sensor slot is left.
    expect(new Set(upgradeOptions(ship('grunt-seven', ['shield-booster'])).map((u) => UPGRADES[u].slot))).toEqual(new Set(['sensor']));
  });
});

describe('squad legality', () => {
  it('accepts a legal squad', () => {
    expect(validateSquad({ ships: [ship('mara-venn'), ship('tobin-reyes', ['hull-plating']), ship('rook-twelve')] })).toEqual([]);
  });

  it('flags budget, empty squads, repeated named pilots and bad slots', () => {
    expect(validateSquad({ ships: [] })).toContain('Add at least one ship.');
    expect(validateSquad({ ships: [ship('drav-okono'), ship('hauler-three'), ship('hauler-three'), ship('mara-venn')] }, 100)[0]).toMatch(/Over budget/);
    expect(validateSquad({ ships: [ship('mara-venn'), ship('mara-venn')] })).toContain('Mara Venn can only fly once.');
    expect(validateSquad({ ships: [ship('grunt-seven'), ship('grunt-seven')] })).toEqual([]); // generic pilots repeat
    expect(validateSquad({ ships: [ship('mara-venn')] }, 100, new Set(['mara-venn']))).toContain('Mara Venn can only fly once.');
    expect(validateSquad({ ships: [ship('tobin-reyes', ['hull-plating', 'shield-booster'])] })[0]).toMatch(/do not fit/);
  });
});

describe('AI squad builder', () => {
  it('always builds a legal squad near the budget', () => {
    for (const budget of [50, 75, 100, 150]) {
      for (let seed = 1; seed <= 40; seed++) {
        const q = buildAiSquad(seed, budget);
        expect(validateSquad(q, budget)).toEqual([]);
        expect(budget - squadCost(q)).toBeLessThan(17); // never leaves enough for another (cheapest) ship
      }
    }
  });

  it('is deterministic and avoids named pilots already taken', () => {
    expect(buildAiSquad(9)).toEqual(buildAiSquad(9));
    const taken = new Set(Object.values(PILOTS).filter((p) => p.unique).map((p) => p.id));
    const q = buildAiSquad(3, 100, taken);
    expect(q.ships.every((s) => !PILOTS[s.pilotId].unique)).toBe(true);
    expect(validateSquad(q, 100, taken)).toEqual([]);
  });
});

describe('deployment', () => {
  it('spreads a full squad inside the setup area without overlaps', () => {
    const q: Squad = { ships: ['drav-okono', 'hauler-three', 'hauler-three', 'mara-venn', 'grunt-seven', 'grunt-seven', 'rook-twelve', 'vale-nine'].map((p) => ship(p)) };
    for (const side of ['near', 'far'] as const) {
      const poses = autoDeploy(q, side);
      const placed: { pose: typeof poses[0]; size: number }[] = [];
      q.ships.forEach((s, i) => {
        const size = BASE_SIZE[SHIP_TYPES[hullOf(s)].size];
        expect(canDeployAt(poses[i], size, side, placed)).toBe(true);
        placed.push({ pose: poses[i], size });
      });
    }
  });

  it('rejects poses outside the setup area or on top of another ship', () => {
    expect(canDeployAt({ x: 400, y: 60, h: Math.PI / 2 }, 40, 'near')).toBe(true);
    expect(canDeployAt({ x: 400, y: 150, h: Math.PI / 2 }, 40, 'near')).toBe(false);
    expect(canDeployAt({ x: 400, y: 60, h: Math.PI / 2 }, 40, 'far')).toBe(false);
    expect(canDeployAt({ x: 400, y: 60, h: 0 }, 40, 'near', [{ pose: { x: 420, y: 60, h: 0 }, size: 40 }])).toBe(false);
  });
});

describe('upgrades in play', () => {
  const game = (upgrades: string[]) => createGame({
    seed: 1,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: 'tobin-reyes', pose: { x: 300, y: 60, h: Math.PI / 2 }, upgrades }], b: [{ pilotId: 'grunt-seven', pose: { x: 300, y: 850, h: -Math.PI / 2 } }] },
  });

  it('Hull Plating and Shield Booster raise starting stats', () => {
    const [h] = game(['hull-plating']).ships;
    expect([h.hull, h.maxHull]).toEqual([5, 5]);
    const [s] = game(['shield-booster']).ships;
    expect([s.shields, s.maxShields]).toEqual([3, 3]);
  });

  it('Stealth Coating adds a defense die until the ship first takes damage', () => {
    const g = game(['stealth-coating']);
    const [me, them] = g.ships;
    const t = { targetId: me.id, arc: 'front' as const, attack: 3, range: 2, obstructed: false, bullseye: false };
    expect(defenseDiceFor(me, t)).toBe(3); // agility 2 + 1
    expect(attackOdds(them, me, t).defenseDice).toBe(3);
    sufferDamage(g, me, 1, 0);
    expect(defenseDiceFor(me, t)).toBe(2);
    expect(g.log.at(-1)).toMatchObject({ type: 'upgrade', upgrade: 'stealth-coating', what: 'spent' });
  });

  it('numbers a generic pilot flown more than once', () => {
    const g = createGame({
      seed: 1,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: {
        a: [{ pilotId: 'grunt-seven', pose: { x: 200, y: 60, h: 0 } }, { pilotId: 'grunt-seven', pose: { x: 400, y: 60, h: 0 } }],
        b: [{ pilotId: 'grunt-seven', pose: { x: 300, y: 850, h: 0 } }],
      },
    });
    expect(g.ships.map((s) => s.name)).toEqual(['Grunt Seven', 'Grunt Seven #2', 'Grunt Seven #3']);
  });
});

describe('Javelin Interceptor (A-wing stats)', () => {
  it('has the A-wing dial: 17 maneuvers incl. red loops at 3, 5-straight and a red 5 K-turn', () => {
    const d = SHIP_TYPES.javelin.dial;
    expect(d).toHaveLength(17);
    expect(d.filter((m) => m.bearing === 'sloopLeft' || m.bearing === 'sloopRight').map((m) => `${m.speed}${m.difficulty}`)).toEqual(['3red', '3red']);
    expect(d.find((m) => m.bearing === 'straight' && m.speed === 5)?.difficulty).toBe('blue');
    expect(d.find((m) => m.bearing === 'kturn')).toMatchObject({ speed: 5, difficulty: 'red' });
    expect(d.filter((m) => m.speed === 2).every((m) => m.difficulty === 'blue')).toBe(true);
  });
});
