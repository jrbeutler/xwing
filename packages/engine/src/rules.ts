// Which rules are on. A skirmish plays everything; a mission (training especially) switches rules on one at a
// time through its Ruleset. The rules code asks `rulesOf(state)` instead of checking for a mission.
import type { Maneuver } from './maneuvers';
import type { ActionType, GameState, Ruleset } from './types';

export const ALL_ACTIONS: ActionType[] = [
  'focus', 'evade', 'lock', 'barrelRoll', 'boost', 'repair', 'rotateArc', 'jam', 'calculate', 'reinforce', 'reload', 'coordinate', 'recover',
];

/** Every rule on: skirmishes, and missions once training is done. */
export const FULL_RULES: Ruleset = {
  attacks: true, actions: ALL_ACTIONS, linkedActions: true, redManeuvers: true, specialManeuvers: true, damageCards: true,
};

export const rulesOf = (s: Pick<GameState, 'mission'>): Ruleset => s.mission?.ruleset ?? FULL_RULES;

/** K-turns, loops, rolls, stops and reverse maneuvers (off until a training mission teaches them). */
export const isSpecialManeuver = (m: Maneuver) =>
  m.bearing === 'kturn' || m.bearing === 'stop' || m.bearing.startsWith('sloop') || m.bearing.startsWith('troll') || m.bearing.startsWith('reverse');
