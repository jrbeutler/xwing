import type { Pose, Polygon } from './geometry';
import type { BaseSize, Maneuver } from './maneuvers';
import type { DamageCardId } from './damage';

export type PlayerId = string;
export type ArcName = 'front' | 'rear';
export type ActionType = 'focus' | 'evade' | 'lock' | 'barrelRoll' | 'boost' | 'repair';

export interface ActionDef { type: ActionType; red?: boolean }
export interface PrimaryWeapon { arc: ArcName; attack: number }

export interface ShipType {
  id: string;
  name: string;
  size: BaseSize;
  primaries: PrimaryWeapon[];
  agility: number;
  hull: number;
  shields: number;
  actions: ActionDef[];
  dial: Maneuver[];
}

export interface PilotDef { id: string; name: string; shipType: string; initiative: number }

export interface ShipState {
  id: string;
  pilotId: string;
  name: string;
  typeId: string;
  owner: PlayerId;
  initiative: number;
  pose: Pose;
  hull: number;
  shields: number;
  stress: number;
  focus: number;
  evade: number;
  /** Id of the ship this ship has locked (one lock at a time). */
  lock: string | null;
  /** Ion tokens: an ionized ship flies a white 1-straight instead of its dial. */
  ion: number;
  /** Face-up damage cards (critical damage) in effect. */
  crits: DamageCardId[];
  /** Index into the ship type's dial; hidden from opponents during planning. */
  dial: number | null;
  destroyed: boolean;
  /** Destroyed ships linger until their initiative step ends (simultaneous fire). */
  removed: boolean;
}

export interface Obstacle { id: string; kind: 'asteroid'; polygon: Polygon }

export interface Player { id: PlayerId; name: string; faction: string }

export type ActionChoice =
  | { type: 'none' }
  | { type: 'focus' }
  | { type: 'evade' }
  | { type: 'lock'; targetId: string }
  | { type: 'barrelRoll'; dir: 'left' | 'right'; shift: -1 | 0 | 1; to: Pose }
  | { type: 'boost'; bearing: 'straight' | 'bankLeft' | 'bankRight'; to: Pose }
  | { type: 'repair'; card: DamageCardId };

export interface TargetInfo {
  targetId: string;
  arc: ArcName;
  attack: number;
  range: number;
  obstructed: boolean;
  bullseye: boolean;
}

export type Decision =
  | { kind: 'planning'; waitingOn: PlayerId[] }
  | { kind: 'action'; playerId: PlayerId; shipId: string; options: ActionChoice[] }
  | { kind: 'attack'; playerId: PlayerId; shipId: string; targets: TargetInfo[] };

export type AttackFace = 'hit' | 'crit' | 'focus' | 'blank';
export type DefenseFace = 'evade' | 'focus' | 'blank';

export type GameEvent =
  | { type: 'roundStart'; round: number }
  | { type: 'phase'; phase: Phase }
  | { type: 'dialRevealed'; shipId: string; maneuver: Maneuver }
  | { type: 'moved'; shipId: string; path: Pose[]; final: Pose; partial: boolean; bumped: string[]; obstacles: string[]; fled: boolean }
  | { type: 'stress'; shipId: string; delta: number }
  | { type: 'action'; shipId: string; action: ActionChoice }
  | { type: 'obstacleHit'; shipId: string; obstacleId: string; result: AttackFace }
  | {
      type: 'attack'; attackerId: string; defenderId: string; arc: ArcName; range: number; obstructed: boolean;
      attackRoll: AttackFace[]; attackFinal: AttackFace[]; defenseRoll: DefenseFace[]; defenseFinal: DefenseFace[];
      spent: string[]; hits: number; crits: number; shieldDamage: number; hullDamage: number;
    }
  | {
      /** A face-up damage card was dealt, triggered, or left the ship (repaired / discarded). */
      type: 'damageCard'; shipId: string; card: DamageCardId; what: 'dealt' | 'triggered' | 'repaired' | 'discarded';
      /** Damage, stress and ions this step caused, for the UI to animate. */
      shieldDamage?: number; hullDamage?: number; stress?: number; ion?: number; roll?: AttackFace;
    }
  | { type: 'destroyed'; shipId: string }
  | { type: 'gameOver'; winner: PlayerId | 'draw' }
  | { type: 'info'; text: string };

export type Phase = 'planning' | 'system' | 'activation' | 'engagement' | 'end' | 'over';

export interface GameState {
  version: 1;
  rng: number;
  round: number;
  maxRounds: number;
  phase: Phase;
  players: Player[];
  /** Player who wins initiative ties this game. */
  firstPlayer: PlayerId;
  ships: ShipState[];
  obstacles: Obstacle[];
  /** Face-down damage deck (draws come off the end) and its discard pile. */
  damageDeck: DamageCardId[];
  damageDiscard: DamageCardId[];
  queue: string[];
  queueIndex: number;
  /** Initiative currently resolving in engagement (for simultaneous fire). */
  engagementInitiative: number | null;
  pending: Decision | null;
  log: GameEvent[];
  winner: PlayerId | 'draw' | null;
}

export type Command =
  | { type: 'setDials'; playerId: PlayerId; dials: Record<string, number> }
  | { type: 'action'; playerId: PlayerId; choice: ActionChoice }
  | { type: 'attack'; playerId: PlayerId; targetId: string | null };
