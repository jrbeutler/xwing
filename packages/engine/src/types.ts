import type { Pose, Polygon } from './geometry';
import type { BaseSize, Bearing, Difficulty, Maneuver } from './maneuvers';
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
export type SlotType =
  | 'talent' | 'modification' | 'missile' | 'torpedo' | 'turret' | 'device'
  /** Front-arc secondary guns without charges. */
  | 'cannon'
  /** A second person aboard (medium ships): new actions and tricks. */
  | 'crew'
  /** A gunner: second chances with the ship's guns. */
  | 'gunner'
  /** A small ship's droid: repairs and flight help. */
  | 'droid'
  /** Locks and information. */
  | 'sensor';

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
  /** Charges come back: 1 per round in the End phase, up to the starting number. */
  recurring?: boolean;
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
 *   defenderStressed: the defender has at least 1 stress
 *   range: [min, max] range bands the attack's range must fall in
 *   weapon: fired with this upgrade (its id)
 */
export interface AttackCondition {
  primary?: boolean; turret?: boolean; bullseye?: boolean; frontArc?: boolean; outsideDefenderArcs?: boolean; defenderStressed?: boolean;
  range?: [number, number];
  weapon?: string;
}

/** Moments in the round that trigger effects. */
export type TriggerEvent =
  /** After the ship fully executes a red maneuver. */
  | 'redManeuverExecuted'
  /** In the End phase, for each ship still in play. */
  | 'endPhase'
  /** After the ship loses shields or hull. */
  | 'damaged'
  /** After the ship performs an action (the trigger's `actions` lists which). */
  | 'actionPerformed'
  /** After the ship's attack deals damage (the trigger's `attack` condition can narrow it). */
  | 'attackHit';

/** What a triggered effect does to its ship. */
export type EffectOp =
  | { op: 'gainFocus' }
  | { op: 'gainCalculate' }
  /** The defender of the attack that triggered this ('attackHit') gains 1 stress. */
  | { op: 'stressDefender' }
  | { op: 'recoverShield' }
  /** Recover 1 charge on the effect's own upgrade. */
  | { op: 'recoverCharge' }
  /** Lose every charge on the effect's own upgrade. */
  | { op: 'loseCharges' }
  /** Repair the ship's worst face-up damage card (any card, repairable or not). */
  | { op: 'repairCard' };

/**
 * An effect of an upgrade or a pilot ability. `cost: 'charge'` spends one of its source's charges each time it
 * is used (and needs one left); `needsCharge` needs a charge but does not spend it.
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
      if?: { shieldsBelowMax?: boolean; chargesBelowMax?: boolean; hasDamageCard?: boolean; actions?: ActionType[]; attack?: AttackCondition };
      cost?: 'charge'; needsCharge?: boolean;
    }
  /** A flat bonus to a number the rules look up. */
  | { kind: 'stat'; stat: StatName; delta: number }
  /** Adds an action to the ship's action bar (if it does not have it already). */
  | { kind: 'action'; action: ActionDef }
  /** While attacking: change up to `dice` focus results to hits, without spending anything. */
  | { kind: 'changeAttack'; dice: number; if?: AttackCondition }
  /**
   * After an attack that deals no damage, the ship may make a bonus attack with a different weapon through
   * its turret arc (once per Engagement phase).
   */
  | { kind: 'bonusAttack' }
  /** Dial entries with these bearings and difficulty `from` are flown as `to` instead. */
  | { kind: 'maneuverDifficulty'; bearings: Bearing[]; from: Difficulty; to: Difficulty }
  /** At the start of the Activation phase, see the dial of the nearest enemy at range 1 to `range`. */
  | { kind: 'peekDial'; range: number };

/**
 * Numbers and switches the rules look up (sum of `stat` effects). jamRange: +range bands for Jam.
 * deviceCharges: extra charges on each bomb and mine. repairAny (1 = on): the Repair action can fix any
 * face-up card. keepActionOnObstacle (1 = on): touching an obstacle never costs the ship its action.
 * coordinateRange: +range bands for Coordinate. keepLock (1 = on): rerolling with a lock does not spend it.
 */
export type StatName = 'jamRange' | 'deviceCharges' | 'repairAny' | 'keepActionOnObstacle' | 'coordinateRange' | 'keepLock';

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
  /** Only at a target in the ship's bullseye. */
  bullseyeOnly?: boolean;
  /**
   * How clients draw its shots. Default: ion weapons 'ion' (torpedoes stay 'torpedo'), torpedoes 'torpedo',
   * missiles 'missile', turrets 'laser'.
   */
  look?: ShotLook;
}

/** The kinds of shot a client draws (see docs/VFX.md). */
export type ShotLook = 'laser' | 'ion' | 'missile' | 'rockets' | 'torpedo';

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
  /** Named pilots' own ability, flown on any hull. Its id in play (logs, charges) is the pilot's id. */
  ability?: AbilityDef;
}

/** A pilot ability: effects like an upgrade's, with its own charges. */
export interface AbilityDef { name: string; text: string; charges?: number; recurring?: boolean; effects: Effect[] }

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
  /** The pilot's ability and its charges (id = pilot id), or null for pilots without one. */
  ability: UpgradeState | null;
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
  /** Ion tokens: an ionized ship flies a blue 1-bank or 1-straight toward its dial's direction instead (ionManeuverFor). */
  ion: number;
  /** Which way the ship's turret arc faces (ships with a turret upgrade). */
  turretArc: ArcName;
  /** Face-up damage cards (critical damage) in effect. */
  crits: DamageCardId[];
  /** Index into the ship type's dial; hidden from opponents during planning. */
  dial: number | null;
  /** Players who may see this ship's dial this round although it is not theirs (an upgrade peeked at it). */
  dialSeenBy?: PlayerId[];
  destroyed: boolean;
  /** Destroyed ships linger until their initiative step ends (simultaneous fire). */
  removed: boolean;
}

/** Obstacle types. What each does to a ship that moves through or onto it is in OBSTACLE_RULES (content.ts). */
export type ObstacleKind = 'asteroid' | 'debris' | 'gas';
export interface Obstacle { id: string; kind: ObstacleKind; polygon: Polygon }

/** What one kind of obstacle does to a ship that moves through or lands on it; all obstacles also obstruct attacks. */
export interface ObstacleRule {
  name: string;
  text: string;
  /** Stress gained on contact (before the die). */
  stress: number;
  /** Results of the 1 attack die rolled on contact that deal 1 hit / 1 crit / 1 ion token. */
  hitOn: AttackFace[];
  critOn: AttackFace[];
  ionOn: AttackFace[];
  /** The ship skips its action this round. */
  skipAction: boolean;
}

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
  /** `bonus`: a bonus attack (e.g. a gunner's after a miss), not the ship's own attack for the round. */
  | { kind: 'attack'; playerId: PlayerId; shipId: string; targets: TargetInfo[]; bonus?: { source: string } }
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
  /** A ship moved through or onto an obstacle: the die it rolled and what it suffered. */
  | {
      type: 'obstacleHit'; shipId: string; obstacleId: string; kind: ObstacleKind; result: AttackFace;
      shieldDamage: number; hullDamage: number; stress?: number; ion?: number;
    }
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
      /** Upgrades and pilot abilities (ids) that changed how many dice were rolled. */
      diceBy?: string[];
    }
  | {
      /** A face-up damage card was dealt, triggered, or left the ship (repaired / discarded). */
      type: 'damageCard'; shipId: string; card: DamageCardId; what: 'dealt' | 'triggered' | 'repaired' | 'discarded';
      /** Damage, stress and ions this step caused, for the UI to animate. */
      shieldDamage?: number; hullDamage?: number; stress?: number; ion?: number; roll?: AttackFace;
    }
  /**
   * An upgrade or pilot ability (`upgrade` is its id: an upgrade id or the pilot's id) was used, spent or
   * recovered; `focus` / `calculate` / `shields` say what it gave the ship (a jam may still cancel a token).
   */
  | { type: 'upgrade'; shipId: string; upgrade: string; what: 'spent' | 'used' | 'recovered'; focus?: number; calculate?: number; shields?: number }
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
  /** A ship's upgrade showed it another ship's dial (the view of that ship's player keeps the dial). */
  | { type: 'dialPeeked'; shipId: string; targetId: string; upgrade: string }
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
