import { describe, expect, it } from 'vitest';
import { attackDiceFor, attackOdds, defenseDiceFor, resolveAttack } from '../src/combat';
import { PILOTS } from '../src/content';
import { effectSource, effectsOf, recoverRecurringCharges, runTriggers } from '../src/effects';
import { apply, createGame } from '../src/game';
import type { ActionChoice, GameState, ShipState, TargetInfo } from '../src/types';

/** Pilot a (with optional hull) at `pa`, pilot b at `pb`. */
function duel(a: string, b: string, pa = { x: 300, y: 400, h: 0 }, pb = { x: 500, y: 400, h: Math.PI }, hullA?: string) {
  return createGame({
    seed: 11,
    players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
    squads: { a: [{ pilotId: a, shipType: hullA, pose: pa }], b: [{ pilotId: b, pose: pb }] },
  });
}
const shot = (defender: ShipState, range: number, extra: Partial<TargetInfo> = {}): TargetInfo =>
  ({ targetId: defender.id, arc: 'front', attack: 3, range, obstructed: false, bullseye: false, ...extra });

/** Perform one action as `shipId` (as if it were its turn) and return the game after. */
function doAction(g: GameState, shipId: string, choice: ActionChoice) {
  const sh = g.ships.find((x) => x.id === shipId)!;
  g.phase = 'activation';
  g.queue = [shipId];
  g.queueIndex = 0;
  g.pending = { kind: 'action', playerId: sh.owner, shipId, options: [{ type: 'none' }, choice] };
  return apply(g, { type: 'action', playerId: sh.owner, choice });
}
const used = (g: GameState, pilot: string) => g.log.filter((e) => e.type === 'upgrade' && e.upgrade === pilot && e.what === 'used');

describe('pilot abilities in play', () => {
  it('every named pilot has an ability and generic pilots do not', () => {
    for (const p of Object.values(PILOTS)) expect(!!p.ability, p.id).toBe(p.unique);
    const g = duel('mara-venn', 'grunt-seven');
    expect(g.ships[0].ability).toEqual({ id: 'mara-venn', charges: 0 });
    expect(g.ships[1].ability).toBeNull();
    expect(effectSource('mara-venn')).toMatchObject({ name: 'Long-Range Dodger', ability: true });
    expect(effectSource('marksman')).toMatchObject({ name: 'Marksman', ability: false });
  });

  it('abilities come with the pilot on any hull, before the upgrades', () => {
    const g = duel('tobin-reyes', 'grunt-seven', undefined, undefined, 'wasp');
    expect(effectsOf(g.ships[0], 'dice').map((x) => x.source.id)).toEqual(['tobin-reyes']);
    expect(effectsOf(g.ships[0], 'rerollAttack').map((x) => x.source.id)).toEqual(['marksman']);
  });
});

describe('dice abilities', () => {
  it('Mara Venn: +1 defense die at range 3-4 only', () => {
    const g = duel('tobin-reyes', 'mara-venn');
    const [a, d] = g.ships;
    expect(defenseDiceFor(d, shot(d, 2), a)).toBe(3);
    expect(defenseDiceFor(d, shot(d, 3), a)).toBe(4);
    expect(defenseDiceFor(d, shot(d, 4), a)).toBe(5); // plus the range-4 house-rule die
  });

  it('Tobin Reyes: +1 attack die on primary attacks against a stressed ship', () => {
    const g = duel('tobin-reyes', 'grunt-seven');
    const [a, d] = g.ships;
    expect(attackDiceFor(a, shot(d, 3), d)).toBe(3);
    d.stress = 1;
    expect(attackDiceFor(a, shot(d, 3), d)).toBe(4);
    expect(attackDiceFor(a, shot(d, 3, { weapon: 'proton-torpedoes', attack: 4 }), d)).toBe(4); // not ordnance
  });

  it("Kira Solace: +1 attack die from outside the defender's arcs", () => {
    const behind = duel('kira-solace', 'grunt-seven', { x: 300, y: 400, h: 0 }, { x: 450, y: 400, h: 0 });
    expect(attackDiceFor(behind.ships[0], shot(behind.ships[1], 3, { attack: 2 }), behind.ships[1])).toBe(3); // 2 + 1
    const headOn = duel('kira-solace', 'grunt-seven');
    expect(attackDiceFor(headOn.ships[0], shot(headOn.ships[1], 3, { attack: 2 }), headOn.ships[1])).toBe(2);
  });

  it('Bram Holloway: +1 die with missiles or torpedoes at range 3', () => {
    const g = duel('bram-holloway', 'grunt-seven');
    const [a, d] = g.ships;
    const torp = (range: number) => shot(d, range, { weapon: 'proton-torpedoes', attack: 4 });
    expect(attackDiceFor(a, torp(3), d)).toBe(5);
    expect(attackDiceFor(a, torp(2), d)).toBe(4);
    expect(attackDiceFor(a, shot(d, 3, { attack: 2 }), d)).toBe(2); // primary
  });

  it('attackOdds still matches resolveAttack with dice abilities on both sides', () => {
    const g = duel('tobin-reyes', 'mara-venn');
    const [a, d] = g.ships;
    d.stress = 1;
    a.focus = 1;
    const t = shot(d, 3);
    const odds = attackOdds(a, d, t);
    expect(odds.attackDice).toBe(4);
    expect(odds.defenseDice).toBe(4);
    const rng = { rng: 77, log: [] } as unknown as GameState;
    const counts: number[] = [];
    const n = 40000;
    for (let i = 0; i < n; i++) {
      const r = resolveAttack(rng, structuredClone(a), structuredClone({ ...d, shields: 99, hull: 99 }), t);
      const k = r.shieldDamage + r.hullDamage;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (let k = 0; k < Math.max(counts.length, odds.dist.length); k++) {
      expect(Math.abs((counts[k] ?? 0) / n - (odds.dist[k] ?? 0))).toBeLessThan(0.012);
    }
  });
});

describe('triggered abilities', () => {
  it('Ilse Kord: focus after taking damage, once per round, recharged in the End phase', () => {
    const g = duel('ilse-kord', 'grunt-seven');
    const sh = g.ships[0];
    runTriggers(g, sh, 'damaged');
    runTriggers(g, sh, 'damaged');
    expect(sh.focus).toBe(1);
    expect(sh.ability!.charges).toBe(0);
    expect(used(g, 'ilse-kord')).toEqual([{ type: 'upgrade', shipId: sh.id, upgrade: 'ilse-kord', what: 'used', focus: 1 }]);
    recoverRecurringCharges(g, sh);
    expect(sh.ability!.charges).toBe(1);
    expect(g.log.at(-1)).toEqual({ type: 'upgrade', shipId: sh.id, upgrade: 'ilse-kord', what: 'recovered' });
    const n = g.log.length;
    recoverRecurringCharges(g, sh); // already full: nothing
    expect(g.log.length).toBe(n);
  });

  it('Wren Tal: a damaging hit in the bullseye stresses the defender, once per round', () => {
    const g = duel('wren-tal', 'grunt-seven');
    const [a, d] = g.ships;
    const rng = { ...g, log: [] } as GameState;
    let stressed = 0, tries = 0;
    for (; tries < 50 && stressed === 0; tries++) {
      const dd = structuredClone({ ...d, shields: 99, hull: 99 });
      const r = resolveAttack(rng, a, dd, shot(d, 2, { bullseye: true }));
      if (r.shieldDamage + r.hullDamage > 0) { expect(dd.stress).toBe(1); stressed++; }
      else expect(dd.stress).toBe(0);
    }
    expect(stressed).toBe(1);
    expect(a.ability!.charges).toBe(0);
    // Charge spent: the next damaging hit does nothing.
    for (let i = 0; i < 20; i++) {
      const dd = structuredClone({ ...d, shields: 99, hull: 99 });
      resolveAttack(rng, a, dd, shot(d, 2, { bullseye: true }));
      expect(dd.stress).toBe(0);
    }
  });

  it('Wren Tal: no stress outside the bullseye', () => {
    const g = duel('wren-tal', 'grunt-seven');
    const [a, d] = g.ships;
    const rng = { ...g, log: [] } as GameState;
    for (let i = 0; i < 30; i++) {
      const dd = structuredClone({ ...d, shields: 99, hull: 99 });
      resolveAttack(rng, a, dd, shot(d, 2));
      expect(dd.stress).toBe(0);
    }
    expect(a.ability!.charges).toBe(1);
  });

  it('Syl Ketch: calculate after a Barrel Roll or Boost, not after Focus', () => {
    const roll = doAction(duel('syl-ketch', 'grunt-seven', { x: 300, y: 300, h: 0 }, { x: 700, y: 800, h: 0 }), 'a-0',
      { type: 'boost', bearing: 'straight', to: { x: 340, y: 300, h: 0 } });
    expect(used(roll, 'syl-ketch')).toEqual([{ type: 'upgrade', shipId: 'a-0', upgrade: 'syl-ketch', what: 'used', calculate: 1 }]);
    const focus = doAction(duel('syl-ketch', 'grunt-seven', { x: 300, y: 300, h: 0 }, { x: 700, y: 800, h: 0 }), 'a-0', { type: 'focus' });
    expect(used(focus, 'syl-ketch')).toEqual([]);
  });

  it('Tessa Varn: calculate after a Jam', () => {
    const g = doAction(duel('tessa-varn', 'grunt-seven'), 'a-0', { type: 'jam', targetId: 'b-0' });
    expect(used(g, 'tessa-varn')).toHaveLength(1);
    expect(used(g, 'tessa-varn')[0]).toMatchObject({ calculate: 1 });
  });

  it('Corin Hale: calculate after a Rotate', () => {
    const g = doAction(duel('corin-hale', 'grunt-seven'), 'a-0', { type: 'rotateArc', to: 'left' });
    expect(used(g, 'corin-hale')[0]).toMatchObject({ calculate: 1 });
  });

  it('Drav Okono: focus after a Coordinate', () => {
    const g0 = createGame({
      seed: 3,
      players: [{ id: 'a', name: 'A', faction: 'x' }, { id: 'b', name: 'B', faction: 'y' }],
      squads: {
        a: [{ pilotId: 'drav-okono', pose: { x: 300, y: 150, h: Math.PI / 2 } }, { pilotId: 'grunt-seven', pose: { x: 380, y: 150, h: Math.PI / 2 } }],
        b: [{ pilotId: 'lance-four', pose: { x: 700, y: 850, h: -Math.PI / 2 } }],
      },
    });
    const g = doAction(g0, 'a-0', { type: 'coordinate', targetId: 'a-1' });
    expect(used(g, 'drav-okono')[0]).toMatchObject({ focus: 1 });
    expect(g.ships[0].focus).toBe(1);
    expect(g.pending).toMatchObject({ kind: 'action', shipId: 'a-1', coordinated: { by: 'a-0' } });
  });
});
