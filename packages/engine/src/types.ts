import type { Pose, Polygon } from './geometry';
import type { BaseSize, Maneuver } from './maneuvers';
import type { DamageCardId } from './damage';

export type PlayerId = string;
/** Firing arcs by facing: primaries use front/rear; a turret's arc can face any of the four. */
export type ArcName = 'front' | 'rear' | 'left' | 'right';
export type ActionType = 'focus' | 'evade' | 'lock' | 'barrelRoll' | 'boost' | 'repair' | 'rotateArc' | 'jam' | 'calculate' | 'reinforce' | 'reload' | 'coordinate';

/**
 * An action on a ship's action bar. `linked`: after performing it, the ship may perform this second action
 * (gaining a stress if it is red), even if the first action left it stressed.
 */
export interface ActionDef { type: ActionType; red?: boolean; linked?: { type: ActionType; red?: boolean } }

/** Kinds of upgrade slot a ship can have (power-ups go in matching slots). */
export type SlotType = 'talent' | 'modification' | 'missile' | 'torpedo' | 'turret' | 'device';

/** Ship classes. Pilots specialise in one; flying another class costs them initiative. */
export type ShipClass = 'fighter' | 'bomber' | 'freighter';

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
  /** Talents only: the pilot specialties that can learn it. */
  classes?: ShipClass[];
  /** What it does in play, as data the engine interprets (see effects.ts). */
  effects?: Effect[];
}

/**
 * What an attack looks like, for effects that only apply to some attacks. Every listed field must match.
 *   primary: a primary weapon (not a missile, torpedo or turret upgrade)
 *   turret: fired through a turret arc (a turret primary or a turret upgrade)
 *   bullseye: the defender is in the attacker's bullseye
 *   frontArc: a front-arc attack (not through a turret arc)
 *   outsideDefenderArcs: the attacker is outside every firing arc of the defender
 */
export interface AttackCondition { primary?: boolean; turret?: boolean; bullseye?: boolean; frontArc?: boolean; outsideDefenderArcs?: boolean }

/** Moments in the round that trigger effects. */
export type TriggerEvent =
  /** After the ship fully executes a red maneuver. */
  | 'redManeuverExecuted'
  /** In the End phase, for each ship still in play. */
  | 'endPhase'
  /** After the ship loses shields or hull. */
  | 'damaged';

/** What a triggered effect does to its ship. */
export type EffectOp =
  | { op: 'gainFocus' }
  | { op: 'recoverShield' }
  /** Recover 1 charge on the effect's own upgrade. */
  | { op: 'recoverCharge' }
  /** Lose every charge on the effect's own upgrade. */
  | { op: 'loseCharges' };

/**
 * An effect of an upgrade (later also of a pilot). `cost: 'charge'` spends one of the upgrade's charges each
 * time it is used (and needs one left); `needsCharge` needs a charge but does not spend it.
 */
export type Effect =
  /** Change how many dice are rolled while this ship attacks or defends: `dice` says which side's dice. */
  | { kind: 'dice'; when: 'attacking' | 'defending'; dice: 'attack' | 'defense'; delta: number; if?: AttackCondition; needsCharge?: boolean }
  /** While attacking: reroll up to `dice` attack dice (blanks first, then focus results). */
  | { kind: 'rerollAttack'; dice: number; if?: AttackCondition; cost?: 'charge' }
  /** While defending: reroll up to `dice` defense dice (blanks first, then focus results if it has no focus token). */
  | { kind: 'rerollDefense'; dice: number; if?: AttackCondition; cost?: 'charge' }
  /** While attacking: cancel 1 of the defender's evade results (only when it still leaves damage to stop). */
  | { kind: 'cancelEvade'; if?: AttackCondition; cost?: 'charge' }
  /** On `on`, if the conditions hold, log the upgrade as `log` and apply `do` in order. */
  | {
      kind: 'trigger'; on: TriggerEvent; do: EffectOp[]; log: 'used' | 'recovered' | 'spent';
      if?: { shieldsBelowMax?: boolean; chargesBelowMax?: boolean }; cost?: 'charge'; needsCharge?: boolean;
    }
  /** A flat bonus to a number the rules look up. */
  | { kind: 'stat'; stat: 'jamRange' | 'deviceCharges'; delta: number };

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
  class: ShipClass;
  /** Squad points for the hull; the pilot's own cost is added on top. */
  cost: number;
  primaries: PrimaryWeapon[];
  agility: number;
  hull: number;
  shields: number;
  actions: ActionDef[];
  dial: Maneuver[];
  /** Upgrade slots. Talent slots are not here: they belong to the pilot. */
  slots: Exclude<SlotType, 'talent'>[];
}

export interface PilotDef {
  id: string;
  name: string;
  /** The class of ship this pilot is trained for. Flying another class: -1 initiative. */
  specialty: ShipClass;
  /** The hull this pilot usually flies (the default when none is chosen). */
  ship: string;
  initiative: number;
  /** Squad points for the pilot, signature talents included; the hull's cost is added on top. */
  cost: number;
  /** Talents this pilot always has. Each takes one of the pilot's talent slots. */
  talents?: string[];
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
  /** Jam tokens: each cancels the next Focus or Evade token the ship would gain. Cleared in the End phase. */
  jam: number;
  /** Calculate tokens: each changes 1 focus result to a hit (attacking) or an evade (defending). Cleared in the End phase. */
  calculate: number;
  /** Reinforce token: the half of the ship it covers, or null. Cleared in the End phase. */
  reinforce: 'front' | 'rear' | null;
  /** Disarmed (after a Reload): cannot attack this round. Cleared in the End phase. */
  disarmed: boolean;
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
  | { type: 'rotateArc'; to: ArcName }
  | { type: 'jam'; targetId: string }
  | { type: 'calculate' }
  | { type: 'reinforce'; side: 'front' | 'rear' }
  /** Recover 1 charge on a missile, torpedo or device upgrade; the ship is disarmed for the round. */
  | { type: 'reload'; upgrade: string }
  /** A friendly ship at range 0-2 (not stressed) immediately performs an action. */
  | { type: 'coordinate'; targetId: string };

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
  | {
      kind: 'action'; playerId: PlayerId; shipId: string; options: ActionChoice[];
      /** This is the linked action offered after `from` (red: it costs a stress). */
      linked?: { from: ActionType; red: boolean };
      /** The ship flew an ion maneuver: Focus only, and no linked action. */
      ionized?: boolean;
      /** This ship is acting because the ship `by` coordinated it (not its own activation). */
      coordinated?: { by: string };
    }
  | { kind: 'attack'; playerId: PlayerId; shipId: string; targets: TargetInfo[] }
  | { kind: 'system'; playerId: PlayerId; shipId: string; options: DropChoice[] };

/** Tokens a ship gains from actions and loses in the End phase (jam takes them away). */
export type GreenToken = 'focus' | 'evade' | 'calculate' | 'reinforce';

export type AttackFace = 'hit' | 'crit' | 'focus' | 'blank';
export type DefenseFace = 'evade' | 'focus' | 'blank';

export type GameEvent =
  | { type: 'roundStart'; round: number }
  | { type: 'phase'; phase: Phase }
  | { type: 'dialRevealed'; shipId: string; maneuver: Maneuver }
  | { type: 'moved'; shipId: string; path: Pose[]; final: Pose; partial: boolean; bumped: string[]; obstacles: string[]; fled: boolean }
  | { type: 'stress'; shipId: string; delta: number }
  | { type: 'action'; shipId: string; action: ActionChoice; linked?: boolean; coordinatedBy?: string }
  | { type: 'obstacleHit'; shipId: string; obstacleId: string; result: AttackFace }
  | {
      type: 'attack'; attackerId: string; defenderId: string; arc: ArcName; range: number; obstructed: boolean;
      attackRoll: AttackFace[]; attackFinal: AttackFace[]; defenseRoll: DefenseFace[]; defenseFinal: DefenseFace[];
      spent: string[]; hits: number; crits: number; shieldDamage: number; hullDamage: number;
      /** Tokens the dice policy chose to keep although they could have changed a die ('attacker:focus' | 'attacker:lock'). */
      kept?: string[];
      /** Secondary weapon used (absent for the primary) and ion tokens it gave. */
      weapon?: string; ion?: number;
      /** The defender's reinforce token cancelled 1 hit or crit. */
      reinforced?: boolean;
    }
  | {
      /** A face-up damage card was dealt, triggered, or left the ship (repaired / discarded). */
      type: 'damageCard'; shipId: string; card: DamageCardId; what: 'dealt' | 'triggered' | 'repaired' | 'discarded';
      /** Damage, stress and ions this step caused, for the UI to animate. */
      shieldDamage?: number; hullDamage?: number; stress?: number; ion?: number; roll?: AttackFace;
    }
  /** An upgrade was used, spent or recovered; `focus` / `shields` say what it gave the ship (a jam may still cancel the focus). */
  | { type: 'upgrade'; shipId: string; upgrade: string; what: 'spent' | 'used' | 'recovered'; focus?: number; shields?: number }
  /** A jam landed: what the target lost (a token, its lock), or 'jammed' when it had nothing and took a jam token. */
  | { type: 'jam'; shipId: string; targetId: string; effect: GreenToken | 'lock' | 'jammed' }
  /** A jammed ship's jam token cancelled a token it was about to gain. */
  | { type: 'jamSpent'; shipId: string; lost: GreenToken }
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
