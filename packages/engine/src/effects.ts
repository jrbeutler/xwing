// Effect hooks: what upgrades do in play, described as data (UpgradeDef.effects) and interpreted here.
// The rules code asks "which effects apply now?" instead of checking for upgrades by id, so new talents,
// upgrades and (later) pilot abilities are content, not engine changes.
//
// Dice effects (dice counts, rerolls, cancelling evades) are interpreted twice, by resolveAttack and by
// attackOdds in combat.ts; both read them through the helpers below so they cannot drift apart.
import { UPGRADES } from './content';
import type { AttackCondition, Effect, GameState, ShipState, TriggerEvent, UpgradeState } from './types';

/** An effect in play, with the upgrade it comes from (whose charges it uses). */
export interface ActiveEffect<E extends Effect = Effect> { source: UpgradeState; effect: E }

type Kind = Effect['kind'];
type OfKind<K extends Kind> = Extract<Effect, { kind: K }>;

/** Every effect of a given kind on a ship, in the order its upgrades are fitted. */
export function effectsOf<K extends Kind>(sh: Pick<ShipState, 'upgrades'>, kind: K): ActiveEffect<OfKind<K>>[] {
  const out: ActiveEffect<OfKind<K>>[] = [];
  for (const source of sh.upgrades) {
    for (const effect of UPGRADES[source.id]?.effects ?? []) {
      if (effect.kind === kind) out.push({ source, effect: effect as OfKind<K> });
    }
  }
  return out;
}

/** Most charges the effect's upgrade can hold. */
export const maxCharges = (source: UpgradeState) => UPGRADES[source.id]?.charges ?? 0;

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
export function statBonus(upgrades: Pick<ShipState, 'upgrades'> | string[], stat: OfKind<'stat'>['stat']): number {
  const sh = Array.isArray(upgrades) ? { upgrades: upgrades.map((id) => ({ id, charges: 0 })) } : upgrades;
  return effectsOf(sh, 'stat').reduce((a, x) => a + (x.effect.stat === stat ? x.effect.delta : 0), 0);
}

/** The facts about one attack that AttackCondition tests (combat.ts builds it). */
export type AttackFacts = Required<AttackCondition>;

export const matches = (cond: AttackCondition | undefined, facts: AttackFacts) =>
  !cond || (Object.keys(cond) as (keyof AttackCondition)[]).every((k) => cond[k] === facts[k]);

/** Effects of `kind` on `sh` that apply to this attack: condition met and charge available. */
export function attackEffects<K extends 'rerollAttack' | 'rerollDefense' | 'cancelEvade'>(sh: ShipState, kind: K, facts: AttackFacts) {
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

/** Give a ship a Focus or Evade token, unless a jam token cancels it. */
export function gainToken(s: GameState, sh: ShipState, kind: 'focus' | 'evade') {
  if (sh.jam > 0) {
    sh.jam--;
    s.log.push({ type: 'jamSpent', shipId: sh.id, lost: kind });
    return;
  }
  sh[kind]++;
}

/** Fire every effect on `sh` triggered by `on`, in upgrade order. */
export function runTriggers(s: GameState, sh: ShipState, on: TriggerEvent) {
  for (const a of effectsOf(sh, 'trigger')) {
    const e = a.effect;
    if (e.on !== on || !charged(a)) continue;
    if (e.if?.shieldsBelowMax && !(sh.shields < sh.maxShields)) continue;
    if (e.if?.chargesBelowMax && !(a.source.charges < maxCharges(a.source))) continue;
    payFor(a);
    const ev: Extract<GameState['log'][number], { type: 'upgrade' }> = { type: 'upgrade', shipId: sh.id, upgrade: a.source.id, what: e.log };
    s.log.push(ev);
    for (const op of e.do) {
      if (op.op === 'gainFocus') { ev.focus = (ev.focus ?? 0) + 1; gainToken(s, sh, 'focus'); }
      if (op.op === 'recoverShield' && sh.shields < sh.maxShields) { ev.shields = (ev.shields ?? 0) + 1; sh.shields++; }
      if (op.op === 'recoverCharge' && a.source.charges < maxCharges(a.source)) a.source.charges++;
      if (op.op === 'loseCharges') a.source.charges = 0;
    }
  }
}
