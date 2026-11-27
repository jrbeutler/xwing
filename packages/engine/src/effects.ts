// Effect hooks: what upgrades and pilot abilities do in play, described as data (UpgradeDef.effects,
// PilotDef.ability) and interpreted here. The rules code asks "which effects apply now?" instead of checking
// for upgrades or pilots by id, so new talents, upgrades and pilot abilities are content, not engine changes.
//
// Dice effects (dice counts, rerolls, cancelling evades) are interpreted twice, by resolveAttack and by
// attackOdds in combat.ts; both read them through the helpers below so they cannot drift apart.
import { PILOTS, SHIP_TYPES, UPGRADES } from './content';
import { discardCard, worstCard } from './damage';
import type { Maneuver } from './maneuvers';
import type { ActionDef, ActionType, AttackCondition, Effect, GameState, GreenToken, ShipState, TriggerEvent, UpgradeState } from './types';

/**
 * What an effect source is, by its id in play: an upgrade, or a pilot ability (whose id is the pilot's).
 * Clients use it to name sources in logs and to know their charges.
 */
export function effectSource(id: string): { name: string; text: string; charges?: number; recurring?: boolean; effects?: Effect[]; ability: boolean } | undefined {
  const u = UPGRADES[id];
  if (u) return { ...u, ability: false };
  const a = PILOTS[id]?.ability;
  return a ? { ...a, ability: true } : undefined;
}

/** An effect in play, with the upgrade or ability it comes from (whose charges it uses). */
export interface ActiveEffect<E extends Effect = Effect> { source: UpgradeState; effect: E }

type Kind = Effect['kind'];
type OfKind<K extends Kind> = Extract<Effect, { kind: K }>;

/** Every effect of a given kind on a ship: its pilot's ability first, then its upgrades in fitted order. */
export function effectsOf<K extends Kind>(sh: Pick<ShipState, 'upgrades'> & { ability?: UpgradeState | null }, kind: K): ActiveEffect<OfKind<K>>[] {
  const out: ActiveEffect<OfKind<K>>[] = [];
  for (const source of sh.ability ? [sh.ability, ...sh.upgrades] : sh.upgrades) {
    for (const effect of effectSource(source.id)?.effects ?? []) {
      if (effect.kind === kind) out.push({ source, effect: effect as OfKind<K> });
    }
  }
  return out;
}

/**
 * The ship's action bar: its hull's actions, then any its upgrades add (Tactical Officer's Coordinate,
 * Targeting Computer's Calculate) that the hull does not already have.
 */
export function actionBar(sh: Pick<ShipState, 'typeId' | 'upgrades' | 'ability'>): ActionDef[] {
  const bar = [...SHIP_TYPES[sh.typeId].actions];
  for (const a of effectsOf(sh, 'action')) if (!bar.some((x) => x.type === a.effect.action.type)) bar.push(a.effect.action);
  return bar;
}

/** A dial entry as the ship's upgrades make it fly (e.g. a Nav Droid's red banks and turns flown white). */
export function easedManeuver(sh: Pick<ShipState, 'upgrades' | 'ability'>, m: Maneuver): Maneuver {
  for (const a of effectsOf(sh, 'maneuverDifficulty')) {
    if (m.difficulty === a.effect.from && a.effect.bearings.includes(m.bearing)) return { ...m, difficulty: a.effect.to };
  }
  return m;
}

/** Most charges the effect's upgrade can hold. */
export const maxCharges = (source: UpgradeState) => effectSource(source.id)?.charges ?? 0;

/** Whether the effect's charge requirement is met (a charge to spend, or one it needs to be active). */
export const charged = (a: ActiveEffect) => {
  const e = a.effect as { cost?: 'charge'; needsCharge?: boolean };
  return !(e.cost === 'charge' || e.needsCharge) || a.source.charges > 0;
};

/** Spend the effect's charge, if it costs one. */
export const payFor = (a: ActiveEffect) => {
  if ((a.effect as { cost?: 'charge' }).cost === 'charge') a.source.charges--;
};

/** Sum of a stat bonus over a ship's upgrades (or a list of upgrade ids, before the ship exists). */
export function statBonus(upgrades: Pick<ShipState, 'upgrades' | 'ability'> | string[], stat: OfKind<'stat'>['stat']): number {
  const sh = Array.isArray(upgrades) ? { upgrades: upgrades.map((id) => ({ id, charges: 0 })) } : upgrades;
  return effectsOf(sh, 'stat').reduce((a, x) => a + (x.effect.stat === stat ? x.effect.delta : 0), 0);
}

/** The facts about one attack that AttackCondition tests (combat.ts builds it). */
export type AttackFacts = Required<Omit<AttackCondition, 'range'>> & { range: number };

export const matches = (cond: AttackCondition | undefined, facts: AttackFacts) =>
  !cond || (Object.keys(cond) as (keyof AttackCondition)[]).every((k) =>
    k === 'range' ? facts.range >= cond.range![0] && facts.range <= cond.range![1] : cond[k] === facts[k]);

/** Effects of `kind` on `sh` that apply to this attack: condition met and charge available. */
export function attackEffects<K extends 'rerollAttack' | 'rerollDefense' | 'cancelEvade' | 'changeAttack'>(sh: ShipState, kind: K, facts: AttackFacts) {
  return effectsOf(sh, kind).filter((a) => matches((a.effect as { if?: AttackCondition }).if, facts) && charged(a));
}

/**
 * Net change to the attack or defense dice of an attack from both ships' `dice` effects: the attacker's
 * (`when: 'attacking'`) and the defender's (`when: 'defending'`). Either ship may be missing (no effects).
 */
export function diceDelta(dice: 'attack' | 'defense', facts: AttackFacts, attacker?: ShipState, defender?: ShipState): number {
  let d = 0;
  for (const [sh, when] of [[attacker, 'attacking'], [defender, 'defending']] as const) {
    if (!sh) continue;
    for (const a of effectsOf(sh, 'dice')) {
      if (a.effect.when === when && a.effect.dice === dice && matches(a.effect.if, facts) && charged(a)) d += a.effect.delta;
    }
  }
  return d;
}

/** Ids of the sources whose `dice` effects change this attack (both ships), for logs. */
export function diceSources(facts: AttackFacts, attacker?: ShipState, defender?: ShipState): string[] {
  const out: string[] = [];
  for (const [sh, when] of [[attacker, 'attacking'], [defender, 'defending']] as const) {
    if (!sh) continue;
    for (const a of effectsOf(sh, 'dice')) {
      if (a.effect.when === when && matches(a.effect.if, facts) && charged(a) && !out.includes(a.source.id)) out.push(a.source.id);
    }
  }
  return out;
}

/** Give a ship a token (Reinforce: covering `side`), unless a jam token cancels it. */
export function gainToken(s: GameState, sh: ShipState, kind: GreenToken, side: 'front' | 'rear' = 'front') {
  if (sh.jam > 0) {
    sh.jam--;
    s.log.push({ type: 'jamSpent', shipId: sh.id, lost: kind });
    return;
  }
  if (kind === 'reinforce') sh.reinforce = side;
  else sh[kind]++;
}

/** What a trigger may need to know about the event: the action performed, or the attack and its defender. */
export interface TriggerContext { action?: ActionType; facts?: AttackFacts; defender?: ShipState }

/** Fire every effect on `sh` triggered by `on`, ability first, then upgrades in order. */
export function runTriggers(s: GameState, sh: ShipState, on: TriggerEvent, ctx: TriggerContext = {}) {
  for (const a of effectsOf(sh, 'trigger')) {
    const e = a.effect;
    if (e.on !== on || !charged(a)) continue;
    if (e.if?.shieldsBelowMax && !(sh.shields < sh.maxShields)) continue;
    if (e.if?.chargesBelowMax && !(a.source.charges < maxCharges(a.source))) continue;
    if (e.if?.hasDamageCard && !sh.crits.length) continue;
    if (e.if?.actions && !(ctx.action && e.if.actions.includes(ctx.action))) continue;
    if (e.if?.attack && !(ctx.facts && matches(e.if.attack, ctx.facts))) continue;
    if (e.do.some((op) => op.op === 'stressDefender') && !(ctx.defender && ctx.defender.hull > 0)) continue;
    payFor(a);
    const ev: Extract<GameState['log'][number], { type: 'upgrade' }> = { type: 'upgrade', shipId: sh.id, upgrade: a.source.id, what: e.log };
    s.log.push(ev);
    for (const op of e.do) {
      if (op.op === 'gainFocus') { ev.focus = (ev.focus ?? 0) + 1; gainToken(s, sh, 'focus'); }
      if (op.op === 'gainCalculate') { ev.calculate = (ev.calculate ?? 0) + 1; gainToken(s, sh, 'calculate'); }
      if (op.op === 'stressDefender') { ctx.defender!.stress++; s.log.push({ type: 'stress', shipId: ctx.defender!.id, delta: 1 }); }
      if (op.op === 'recoverShield' && sh.shields < sh.maxShields) { ev.shields = (ev.shields ?? 0) + 1; sh.shields++; }
      if (op.op === 'recoverCharge' && a.source.charges < maxCharges(a.source)) a.source.charges++;
      if (op.op === 'loseCharges') a.source.charges = 0;
      if (op.op === 'repairCard') {
        const card = worstCard(sh);
        if (card) { discardCard(s, sh, card); s.log.push({ type: 'damageCard', shipId: sh.id, card, what: 'repaired' }); }
      }
    }
  }
}

/** End phase: recurring charges come back, 1 per round, on upgrades and abilities alike. */
export function recoverRecurringCharges(s: GameState, sh: ShipState) {
  for (const source of sh.ability ? [sh.ability, ...sh.upgrades] : sh.upgrades) {
    const def = effectSource(source.id);
    if (!def?.recurring || source.charges >= maxCharges(source)) continue;
    source.charges++;
    s.log.push({ type: 'upgrade', shipId: sh.id, upgrade: source.id, what: 'recovered' });
  }
}
