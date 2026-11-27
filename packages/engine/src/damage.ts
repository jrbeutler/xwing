// Critical damage: a deck of face-up damage cards dealt when a critical hit reaches a ship's hull.
// Card mechanics follow the X-Wing 2nd edition damage deck; the wording here is our own. Effects are
// small queries (dice counts, maneuver difficulty, allowed actions) and triggers that the rules call
// at fixed moments, so a card is one entry below plus the hook it uses.
import type { Maneuver, Difficulty } from './maneuvers';
import { nextInt } from './rng';
import type { ActionType, GameState, ShipState } from './types';

export type DamageCardId =
  | 'directHit' | 'panickedPilot' | 'blindedPilot' | 'woundedPilot' | 'stunnedPilot'
  | 'consoleFire' | 'damagedEngine' | 'weaponsFailure' | 'hullBreach' | 'structuralDamage'
  | 'damagedSensorArray' | 'looseStabilizer' | 'disabledPowerRegulator' | 'fuelLeak';

export interface DamageCardDef {
  id: DamageCardId;
  title: string;
  /** Short tag for ship labels. */
  tag: string;
  text: string;
  copies: number;
  /** Has "Action: repair this card". */
  repairable: boolean;
}

const card = (id: DamageCardId, title: string, tag: string, copies: number, repairable: boolean, text: string): DamageCardDef =>
  ({ id, title, tag, copies, repairable, text });

/** The 33-card deck. */
export const DAMAGE_CARDS: Record<DamageCardId, DamageCardDef> = {
  directHit: card('directHit', 'Direct Hit!', 'HIT', 5, false, 'Take 1 more damage, then discard this card.'),
  panickedPilot: card('panickedPilot', 'Panicked Pilot', 'PANIC', 2, false, 'Gain 2 stress, then discard this card.'),
  blindedPilot: card('blindedPilot', 'Blinded Pilot', 'BLIND', 2, true, 'Your attacks cannot spend focus or a lock to improve your shots.'),
  woundedPilot: card('woundedPilot', 'Wounded Pilot', 'WOUND', 2, true, 'After you perform an action, 50% chance to gain 1 stress.'),
  stunnedPilot: card('stunnedPilot', 'Stunned Pilot', 'STUN', 2, false, 'After you move, if you touched an asteroid, take 1 damage.'),
  consoleFire: card('consoleFire', 'Console Fire', 'FIRE', 2, true, 'Before you engage, 38% chance to take 1 damage.'),
  damagedEngine: card('damagedEngine', 'Damaged Engine', 'ENGINE', 2, false, 'Your turns are one step harder (blue → white → red).'),
  weaponsFailure: card('weaponsFailure', 'Weapons Failure', 'WEAPONS', 2, true, 'Fire 1 fewer shot per attack.'),
  hullBreach: card('hullBreach', 'Hull Breach', 'BREACH', 2, true, 'Damage you take from hits counts as crits instead.'),
  structuralDamage: card('structuralDamage', 'Structural Damage', 'FRAME', 2, false, 'Get 1 fewer dodge when defending.'),
  damagedSensorArray: card('damagedSensorArray', 'Damaged Sensor Array', 'SENSORS', 2, true, 'The only actions you can perform are Focus and Repair.'),
  looseStabilizer: card('looseStabilizer', 'Loose Stabilizer', 'STABLZR', 2, true, 'After you fly anything but a straight, take 1 damage and discard this card.'),
  disabledPowerRegulator: card('disabledPowerRegulator', 'Disabled Power Regulator', 'POWER', 2, false, 'Before you engage, gain an ion token. After you fly an ion maneuver, discard this card.'),
  fuelLeak: card('fuelLeak', 'Fuel Leak', 'FUEL', 4, true, 'After a crit damages your hull, take 1 more damage and discard this card.'),
};

/** A freshly shuffled damage deck (draws come off the end). */
export function newDamageDeck(s: { rng: number }): DamageCardId[] {
  const deck = Object.values(DAMAGE_CARDS).flatMap((c) => Array<DamageCardId>(c.copies).fill(c.id));
  shuffle(s, deck);
  return deck;
}

function shuffle<T>(s: { rng: number }, xs: T[]) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = nextInt(s, i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

/** Draw a card, reshuffling the discard pile into a new deck when it runs out. */
export function drawDamageCard(s: GameState): DamageCardId | null {
  if (!s.damageDeck.length && s.damageDiscard.length) {
    s.damageDeck = s.damageDiscard;
    s.damageDiscard = [];
    shuffle(s, s.damageDeck);
  }
  return s.damageDeck.pop() ?? null;
}

// ---------------------------------------------------------------------------
// Queries the rules ask while a card is face up
// ---------------------------------------------------------------------------

export const hasCard = (sh: ShipState, id: DamageCardId) => sh.crits.includes(id);
const count = (sh: ShipState, id: DamageCardId) => sh.crits.filter((c) => c === id).length;

/** Dice removed from this ship's attacks. */
export const attackDicePenalty = (sh: ShipState) => count(sh, 'weaponsFailure');
/** Dice removed from this ship's defense rolls. */
export const defenseDicePenalty = (sh: ShipState) => count(sh, 'structuralDamage');
/** Whether this ship may spend focus / a lock to modify its attack dice. */
export const canModifyAttack = (sh: ShipState) => !hasCard(sh, 'blindedPilot');

const HARDER: Record<Difficulty, Difficulty> = { blue: 'white', white: 'red', red: 'red' };
/** A dial entry as this ship must fly it now (Damaged Engine makes turns harder). */
export function effectiveManeuver(sh: ShipState, m: Maneuver): Maneuver {
  let difficulty = m.difficulty;
  if (m.bearing === 'turnLeft' || m.bearing === 'turnRight') {
    for (let i = 0; i < count(sh, 'damagedEngine'); i++) difficulty = HARDER[difficulty];
  }
  return difficulty === m.difficulty ? m : { ...m, difficulty };
}

/** Whether a ship-card action is still available (Damaged Sensor Array allows only Focus). */
export const actionAllowed = (sh: ShipState, type: ActionType) => !hasCard(sh, 'damagedSensorArray') || type === 'focus';

/** Distinct face-up cards this ship could repair with an action. */
export const repairableCards = (sh: ShipState): DamageCardId[] =>
  [...new Set(sh.crits)].filter((c) => DAMAGE_CARDS[c].repairable);

/** Face-up cards from most to least harmful, for effects that repair "a card" of their own choosing. */
export const REPAIR_PRIORITY: DamageCardId[] = [
  'consoleFire', 'hullBreach', 'fuelLeak', 'weaponsFailure', 'blindedPilot', 'structuralDamage', 'damagedEngine',
  'damagedSensorArray', 'disabledPowerRegulator', 'woundedPilot', 'looseStabilizer', 'stunnedPilot', 'panickedPilot', 'directHit',
];
/** The face-up card a repair effect fixes first, or undefined if the ship has none. */
export const worstCard = (sh: ShipState): DamageCardId | undefined => REPAIR_PRIORITY.find((c) => sh.crits.includes(c)) ?? sh.crits[0];

/** Remove one copy of a face-up card from a ship to the discard pile. */
export function discardCard(s: GameState, sh: ShipState, id: DamageCardId) {
  const i = sh.crits.indexOf(id);
  if (i < 0) return;
  sh.crits.splice(i, 1);
  s.damageDiscard.push(id);
}
