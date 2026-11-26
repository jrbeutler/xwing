import { describe, expect, it } from 'vitest';
import { attackDiceFor, defenseDiceFor, resolveAttack, sufferDamage } from '../src/combat';
import { DAMAGE_CARDS, newDamageDeck, type DamageCardId } from '../src/damage';
import { actionOptions, apply, createGame, legalDial, maneuverFor } from '../src/game';
import { SHIP_TYPES } from '../src/content';
import type { Bearing } from '../src/maneuvers';
import type { GameEvent, GameState, ShipState, TargetInfo } from '../src/types';

/** Two ships far apart (no shots), Kestrel for p1 and Wasp for p2. */
const duel = (p1 = { x: 200, y: 200, h: Math.PI / 2 }, p2 = { x: 700, y: 700, h: -Math.PI / 2 }, obstacles: GameState['obstacles'] = []) =>
  createGame({
    seed: 11,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: 'tobin-reyes', pose: p1 }], b: [{ pilotId: 'syl-ketch', pose: p2 }] },
    obstacles,
  });

const cardEvents = (log: GameEvent[]) => log.filter((e): e is Extract<GameEvent, { type: 'damageCard' }> => e.type === 'damageCard');
const dialIndex = (sh: ShipState, bearing: Bearing, speed: number) =>
  SHIP_TYPES[sh.typeId].dial.findIndex((m) => m.bearing === bearing && m.speed === speed);

const slowestStraight = (sh: ShipState) => {
  const dial = SHIP_TYPES[sh.typeId].dial;
  return dial.indexOf(dial.filter((m) => m.bearing === 'straight').sort((x, y) => x.speed - y.speed)[0]);
};

/** Play one round: both ships fly the given dial (default: slowest straight), skip actions, hold fire unless `fire`. */
function playRound(g: GameState, dials: Partial<Record<string, number>> = {}, action: (opts: any[]) => any = () => ({ type: 'none' }), fire = false) {
  const startLen = g.log.length;
  for (const pid of ['a', 'b']) {
    const sh = g.ships.find((x) => x.owner === pid)!;
    g = apply(g, { type: 'setDials', playerId: pid, dials: { [sh.id]: dials[sh.id] ?? slowestStraight(sh) } });
  }
  for (let guard = 0; g.pending && g.pending.kind !== 'planning' && guard < 20; guard++) {
    const d = g.pending;
    if (d.kind === 'action') g = apply(g, { type: 'action', playerId: d.playerId, choice: action(d.options) });
    else if (d.kind === 'attack') g = apply(g, { type: 'attack', playerId: d.playerId, targetId: fire ? d.targets[0].targetId : null });
  }
  return { g, events: g.log.slice(startLen) };
}

describe('damage deck', () => {
  it('has the 33 cards of the 2nd edition deck', () => {
    const deck = newDamageDeck({ rng: 1 });
    expect(deck).toHaveLength(33);
    for (const c of Object.values(DAMAGE_CARDS)) expect(deck.filter((x) => x === c.id)).toHaveLength(c.copies);
  });

  it('is shuffled deterministically from its seed', () => {
    expect(newDamageDeck({ rng: 5 })).toEqual(newDamageDeck({ rng: 5 }));
    expect(newDamageDeck({ rng: 5 })).not.toEqual(newDamageDeck({ rng: 6 }));
  });

  it('reshuffles the discard pile when the deck runs out', () => {
    const g = duel();
    const sh = g.ships[0];
    sh.shields = 0;
    g.damageDeck = [];
    g.damageDiscard = ['weaponsFailure'];
    sufferDamage(g, sh, 0, 1);
    expect(sh.crits).toEqual(['weaponsFailure']);
  });
});

describe('suffering damage', () => {
  it('shields take hits before crits; only crits reaching the hull deal cards', () => {
    const g = duel();
    const sh = g.ships[0]; // Kestrel: 2 shields, 4 hull
    g.damageDeck = ['weaponsFailure', 'structuralDamage'];
    const r = sufferDamage(g, sh, 1, 2); // hit → shield, crit → shield, crit → hull (card)
    expect(r).toEqual({ shieldDamage: 2, hullDamage: 1 });
    expect(sh.crits).toEqual(['structuralDamage']);
    sufferDamage(g, sh, 1, 0); // a plain hit on the hull deals no card
    expect(sh.crits).toEqual(['structuralDamage']);
    expect(sh.hull).toBe(2);
  });

  it('Direct Hit! deals one more damage and is discarded', () => {
    const g = duel();
    const sh = { ...g.ships[0], shields: 0 };
    g.damageDeck = ['directHit'];
    sufferDamage(g, sh, 0, 1);
    expect(sh.hull).toBe(2);
    expect(sh.crits).toEqual([]);
    expect(g.damageDiscard).toEqual(['directHit']);
    const [dealt] = cardEvents(g.log);
    expect(dealt).toMatchObject({ card: 'directHit', what: 'dealt', hullDamage: 1 });
  });

  it('Panicked Pilot adds 2 stress and is discarded', () => {
    const g = duel();
    const sh = { ...g.ships[0], shields: 0 };
    g.damageDeck = ['panickedPilot'];
    sufferDamage(g, sh, 0, 1);
    expect(sh.stress).toBe(2);
    expect(sh.crits).toEqual([]);
  });

  it('Hull Breach turns hits into crits', () => {
    const g = duel();
    const sh = { ...g.ships[0], shields: 0, crits: ['hullBreach' as DamageCardId] };
    g.damageDeck = ['structuralDamage', 'weaponsFailure'];
    sufferDamage(g, sh, 2, 0);
    expect(sh.crits).toEqual(['hullBreach', 'weaponsFailure', 'structuralDamage']);
  });

  it('Fuel Leak: the next crit to the hull costs 1 more damage, then it is discarded', () => {
    const g = duel();
    const sh = { ...g.ships[0], shields: 0, crits: ['fuelLeak' as DamageCardId] };
    g.damageDeck = ['structuralDamage'];
    sufferDamage(g, sh, 0, 1);
    expect(sh.hull).toBe(2);
    expect(sh.crits).toEqual(['structuralDamage']);
  });

  it('a destroyed ship is dealt no more cards', () => {
    const g = duel();
    const sh = { ...g.ships[0], shields: 0, hull: 1 };
    g.damageDeck = ['weaponsFailure'];
    sufferDamage(g, sh, 0, 1);
    expect(sh.hull).toBe(0);
    expect(sh.crits).toEqual([]);
  });

  it('an attack logs its damage cards after the attack event', () => {
    // Set up an attack decision directly and try dice seeds until a crit reaches the hull.
    for (let seed = 1; seed < 200; seed++) {
      const g0 = duel({ x: 400, y: 300, h: Math.PI / 2 }, { x: 400, y: 420, h: -Math.PI / 2 });
      const [a, d] = g0.ships;
      Object.assign(d, { shields: 0, hull: 9 });
      g0.damageDeck = Array(10).fill('structuralDamage');
      Object.assign(g0, { rng: seed, phase: 'engagement', queue: [a.id], queueIndex: 0, engagementInitiative: a.initiative });
      g0.pending = { kind: 'attack', playerId: a.owner, shipId: a.id, targets: [{ targetId: d.id, arc: 'front', attack: 3, range: 1, obstructed: false, bullseye: false }] };
      const g = apply(g0, { type: 'attack', playerId: a.owner, targetId: d.id });
      const i = g.log.findIndex((e) => e.type === 'damageCard');
      if (i < 0) continue;
      expect(g.log[i - 1].type).toBe('attack');
      return;
    }
    throw new Error('no crit in 200 seeds');
  });
});

describe('cards that change dice', () => {
  const g = duel();
  const [a, d] = g.ships;
  const t: TargetInfo = { targetId: d.id, arc: 'front', attack: 3, range: 2, obstructed: false, bullseye: false };

  it('Weapons Failure removes an attack die', () => {
    expect(attackDiceFor(a, t)).toBe(4); // attack 3 + range-2 sweet spot
    expect(attackDiceFor({ ...a, crits: ['weaponsFailure'] }, t)).toBe(3);
    const r = resolveAttack({ ...g }, { ...a, crits: ['weaponsFailure'] }, { ...d, shields: 99, hull: 99 }, t);
    expect(r.attackRoll).toHaveLength(3);
  });

  it('Structural Damage removes a defense die', () => {
    expect(defenseDiceFor(d, t)).toBe(3);
    expect(defenseDiceFor({ ...d, crits: ['structuralDamage'] }, t)).toBe(2);
  });

  it('Blinded Pilot keeps focus and lock unspent', () => {
    const blind = { ...a, focus: 1, lock: d.id, crits: ['blindedPilot' as DamageCardId] };
    for (let i = 0; i < 20; i++) {
      const r = resolveAttack({ ...g, rng: i }, blind, { ...d, shields: 99, hull: 99 }, t);
      expect(r.spent.filter((x) => x.startsWith('attacker'))).toEqual([]);
      expect(r.attackFinal).toEqual(r.attackRoll);
    }
  });
});

describe('cards that change maneuvers and actions', () => {
  it('Damaged Engine makes turns one step harder, so a stressed ship loses them', () => {
    const g = duel();
    const sh = { ...g.ships[0], crits: ['damagedEngine' as DamageCardId] };
    const turn = dialIndex(sh, 'turnLeft', 2); // white on the Kestrel
    const bank = dialIndex(sh, 'bankLeft', 2);
    expect(maneuverFor(g.ships[0], turn).difficulty).toBe('white');
    expect(maneuverFor(sh, turn).difficulty).toBe('red');
    expect(maneuverFor(sh, bank)).toEqual(SHIP_TYPES.kestrel.dial[bank]);
    expect(legalDial(g, { ...sh, stress: 1 })).not.toContain(turn);
  });

  it('Damaged Sensor Array leaves only Focus and Repair', () => {
    const g = duel();
    const sh = { ...g.ships[0], crits: ['damagedSensorArray' as DamageCardId] };
    const types = new Set(actionOptions(g, sh).map((o) => o.type));
    expect([...types].sort()).toEqual(['focus', 'none', 'repair']);
  });

  it('Repair removes a repairable card to the discard pile', () => {
    const g0 = duel();
    g0.ships[0].crits = ['weaponsFailure', 'structuralDamage'];
    const opts = actionOptions(g0, g0.ships[0]);
    expect(opts.filter((o) => o.type === 'repair')).toEqual([{ type: 'repair', card: 'weaponsFailure' }]); // Structural Damage cannot be repaired
    const { g, events } = playRound(g0, {}, (o) => o.find((x: any) => x.type === 'repair') ?? { type: 'none' });
    expect(g.ships[0].crits).toEqual(['structuralDamage']);
    expect(g.damageDiscard).toContain('weaponsFailure');
    expect(cardEvents(events)).toContainEqual(expect.objectContaining({ card: 'weaponsFailure', what: 'repaired' }));
  });
});

describe('triggered cards', () => {
  it('Console Fire rolls before engaging', () => {
    const g0 = duel();
    g0.ships[0].crits = ['consoleFire'];
    const { events } = playRound(g0);
    expect(cardEvents(events)).toContainEqual(expect.objectContaining({ card: 'consoleFire', what: 'triggered' }));
  });

  it('Loose Stabilizer costs 1 damage after a non-straight move, then is discarded', () => {
    const g0 = duel();
    const sh = g0.ships[0];
    sh.crits = ['looseStabilizer'];
    sh.shields = 0;
    const straight = playRound(structuredClone(g0)).g;
    expect(straight.ships[0].crits).toEqual(['looseStabilizer']);
    const { g } = playRound(g0, { [sh.id]: dialIndex(sh, 'bankLeft', 2) });
    expect(g.ships[0].crits).toEqual([]);
    expect(g.ships[0].hull).toBe(3);
  });

  it('Stunned Pilot costs 1 damage after touching an asteroid', () => {
    const rock = { id: 'r', kind: 'asteroid' as const, polygon: [{ x: 180, y: 250 }, { x: 220, y: 250 }, { x: 220, y: 270 }, { x: 180, y: 270 }] };
    const g0 = duel(undefined, undefined, [rock]);
    g0.ships[0].crits = ['stunnedPilot'];
    const { events } = playRound(g0, { [g0.ships[0].id]: dialIndex(g0.ships[0], 'straight', 2) });
    expect(cardEvents(events)).toContainEqual(expect.objectContaining({ card: 'stunnedPilot', what: 'triggered' }));
  });

  it('Wounded Pilot rolls after each action', () => {
    const g0 = duel();
    g0.ships[0].crits = ['woundedPilot'];
    const { events } = playRound(g0, {}, (o) => o.find((x: any) => x.type === 'focus') ?? { type: 'none' });
    expect(cardEvents(events)).toContainEqual(expect.objectContaining({ card: 'woundedPilot', what: 'triggered' }));
  });

  it('Disabled Power Regulator ionizes the ship; its next move is a 1-straight, then the card goes', () => {
    const g0 = duel();
    const sh = g0.ships[0];
    sh.crits = ['disabledPowerRegulator'];
    let { g } = playRound(g0);
    expect(g.ships[0].ion).toBe(1);
    const before = g.ships[0].pose;
    let opts: any[] = [];
    ({ g } = playRound(g, { [sh.id]: dialIndex(sh, 'bankLeft', 2) }, (o) => { opts = o; return { type: 'none' }; }));
    expect(g.ships[0].pose.h).toBeCloseTo(before.h); // flew straight, not the bank
    expect(g.ships[0].pose.y - before.y).toBeCloseTo(40 + 40, 0); // speed 1 plus a small base length
    expect(g.ships[0].crits).toEqual([]);
    expect(new Set(opts.map((o) => o.type))).toEqual(new Set(['none', 'focus']));
  });
});
