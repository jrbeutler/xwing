import type { Pose, Polygon } from './geometry';
import type { BaseSize, Maneuver } from './maneuvers';
import type { DamageCardId } from './damage';

export type PlayerId = string;
/** Firing arcs by facing: primaries use front/rear; a turret's arc can face any of the four. */
export type ArcName = 'front' | 'rear' | 'left' | 'right';
export type ActionType = 'focus' | 'evade' | 'lock' | 'barrelRoll' | 'boost' | 'repair' | 'rotateArc';

export interface ActionDef { type: ActionType; red?: boolean }

/** Kinds of upgrade slot a ship can have (power-ups go in matching slots). */
export type SlotType = 'talent' | 'modification' | 'missile' | 'torpedo' | 'turret' | 'device';

export interface UpgradeDef {
  id: string;
  name: string;
  slot: SlotType;
  text: string;
  /** Points, either flat or by base size (bigger ships pay more for the same boost). */
  cost: number | Record<BaseSize, number>;
  /** Flat changes to starting stats. */
  stats?: { hull?: number; shields?: number };
  /** Starting charges, for upgrades that run out. */
  charges?: number;
  /** Secondary weapons (missiles, torpedoes): fired instead of the primary, one charge per shot. */
  weapon?: WeaponDef;
  /** Devices (bombs, mines): dropped behind the ship in the System phase, one charge each. */
  device?: DeviceDef;
}

export interface DeviceDef {
  /** Bombs detonate at the end of the Activation phase; mines when a ship moves through or onto them. */
  kind: 'bomb' | 'mine';
  /** 'proton': 1 crit to each ship at range 0-1. 'ion': 3 ion tokens to each. 'proximity': the ship rolls 2 attack dice. */
  effect: 'proton' | 'ion' | 'proximity';
}

/** A bomb or mine token on the table. */
export interface Device { id: string; upgrade: string; owner: PlayerId; kind: 'bomb' | 'mine'; pose: Pose }

export type DropChoice = { type: 'none' } | { type: 'drop'; upgrade: string; pose: Pose };

export interface WeaponDef {
  attack: number;
  minRange: number;
  maxRange: number;
  /** 'lock': the attacker must have a lock on the defender (the lock can still be spent to reroll). */
  requires?: 'lock';
  /** 'proton': change 1 hit to a crit. 'ion': 1 damage, every other hit becomes an ion token. */
  effect?: 'proton' | 'ion';
  /** 'turret': fires through the ship's turret arc (which the Rotate action turns); default: front arc. */
  arc?: 'turret';
}

/** An upgrade fitted to a ship in play, with its remaining charges. */
export interface UpgradeState { id: string; charges: number }
/** A primary weapon fires through a fixed arc, or ('turret') through the ship's rotatable turret arc. */
export interface PrimaryWeapon { arc: ArcName | 'turret'; attack: number }

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
  /** Upgrade slots (the talent slot is only open to pilots of initiative 3+). */
  slots: SlotType[];
}

export interface PilotDef {
  id: string;
  name: string;
  shipType: string;
  initiative: number;
  /** Squad points. */
  cost: number;
  /** Named pilots: at most one per battle. Generic pilots can be fielded several times. */
  unique: boolean;
}

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
  /** Starting hull and shields, including upgrades. */
  maxHull: number;
  maxShields: number;
  /** Fitted upgrades (power-ups) and their charges. */
  upgrades: UpgradeState[];
  stress: number;
  focus: number;
  evade: number;
  /** Id of the ship this ship has locked (one lock at a time). */
  lock: string | null;
  /** Ion tokens: an ionized ship flies a white 1-straight instead of its dial. */
  ion: number;
  /** Which way the ship's turret arc faces (ships with a turret upgrade). */
  turretArc: ArcName;
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
  | { type: 'repair'; card: DamageCardId }
  | { type: 'rotateArc'; to: ArcName };

export interface TargetInfo {
  targetId: string;
  arc: ArcName;
  attack: number;
  range: number;
  obstructed: boolean;
  bullseye: boolean;
  /** Upgrade id of the secondary weapon used; absent (or 'primary') for the primary weapon. */
  weapon?: string;
  /** Fired through the turret arc (a turret upgrade or a turret primary): not a front-arc attack. */
  turret?: boolean;
}

export type Decision =
  | { kind: 'planning'; waitingOn: PlayerId[] }
  | { kind: 'action'; playerId: PlayerId; shipId: string; options: ActionChoice[] }
  | { kind: 'attack'; playerId: PlayerId; shipId: string; targets: TargetInfo[] }
  | { kind: 'system'; playerId: PlayerId; shipId: string; options: DropChoice[] };

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
      /** Secondary weapon used (absent for the primary) and ion tokens it gave. */
      weapon?: string; ion?: number;
    }
  | {
      /** A face-up damage card was dealt, triggered, or left the ship (repaired / discarded). */
      type: 'damageCard'; shipId: string; card: DamageCardId; what: 'dealt' | 'triggered' | 'repaired' | 'discarded';
      /** Damage, stress and ions this step caused, for the UI to animate. */
      shieldDamage?: number; hullDamage?: number; stress?: number; ion?: number; roll?: AttackFace;
    }
  | { type: 'upgrade'; shipId: string; upgrade: string; what: 'spent' | 'used' | 'recovered' }
  | { type: 'deviceDropped'; shipId: string; device: Device }
  | {
      type: 'deviceDetonated'; device: Device;
      /** What it did to each ship caught by it (damage cards it dealt follow as damageCard events). */
      ships: { shipId: string; shieldDamage: number; hullDamage: number; ion?: number; roll?: AttackFace[] }[];
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
  /** Bomb and mine tokens on the table. */
  devices: Device[];
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
  | { type: 'attack'; playerId: PlayerId; targetId: string | null; weapon?: string }
  | { type: 'drop'; playerId: PlayerId; choice: DropChoice };
