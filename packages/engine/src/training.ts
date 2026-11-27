// The training track (docs/MISSIONS.md): eight short missions, each teaching one idea, with the rules
// switched on one step at a time. Missions are data; `missionGame` turns one into a game.
import { generateObstacles, createGame, type SquadEntry } from './game';
import { ALL_ACTIONS, FULL_RULES } from './rules';
import type { AiProfile, GameState, Marker, Objective, Obstacle, Ruleset, Trigger, Zone } from './types';

/** A mission as written: briefing, rules, table, forces, objectives and coach tips. */
export interface MissionDef {
  id: string;
  /** Position in its track (1-based), shown as "Mission 3". */
  number: number;
  title: string;
  /** What it teaches, in a few words (the campaign list). */
  teaches: string;
  /** The briefing shown before the battle: the one new idea, in plain words. */
  briefing: string[];
  ruleset: Ruleset;
  obstacles: Obstacle[];
  zones?: Zone[];
  markers?: Marker[];
  /** The player's ships (`p1`, setting up on the near edge) and the opposition's (`p2`). */
  player: SquadEntry[];
  enemy: SquadEntry[];
  enemyAi?: AiProfile;
  objectives: Objective[];
  triggers?: Trigger[];
  maxRounds: number;
}

export const MISSION_PLAYERS = [
  { id: 'p1', name: 'Cadets', faction: 'coalition' },
  { id: 'p2', name: 'Opposition', faction: 'syndicate' },
] as const;

/** A game of a mission: the player is `p1`, the AI `p2`. */
export function missionGame(def: MissionDef, seed: number): GameState {
  return createGame({
    seed,
    players: [{ ...MISSION_PLAYERS[0] }, { ...MISSION_PLAYERS[1] }],
    squads: { p1: def.player, p2: def.enemy },
    obstacles: def.obstacles,
    mission: {
      id: def.id, player: 'p1', ruleset: def.ruleset, objectives: def.objectives, triggers: def.triggers ?? [],
      zones: def.zones ?? [], markers: def.markers ?? [], ai: { p2: def.enemyAi ?? 'standard' }, maxRounds: def.maxRounds,
    },
  });
}

const N = Math.PI / 2, S = -Math.PI / 2;
const at = (x: number, y: number, h: number) => ({ x, y, h });
const cadet = (x: number, y = 60, name = 'Cadet', extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: 'vale-nine', shipType: 'kestrel', pose: at(x, y, N), name, ...extra });
const tip = (on: Trigger['on'], title: string, text: string): Trigger => ({ on, message: { title, text } });

/** The rules switched on step by step. */
const MANEUVERS: Ruleset = { attacks: false, actions: [], linkedActions: false, redManeuvers: false, specialManeuvers: false, damageCards: false };
const ATTACKS: Ruleset = { ...MANEUVERS, attacks: true };
const TOKENS: Ruleset = { ...ATTACKS, actions: ['focus', 'evade'] };
const LOCKS: Ruleset = { ...TOKENS, actions: ['focus', 'evade', 'lock'] };
const REPOSITION: Ruleset = { ...LOCKS, actions: ['focus', 'evade', 'lock', 'barrelRoll', 'boost'], linkedActions: true, redManeuvers: true, specialManeuvers: true };
const DAMAGE: Ruleset = { ...REPOSITION, damageCards: true, actions: [...REPOSITION.actions, 'repair'] };

const FAR_EDGE: Zone = { id: 'far-edge', label: 'Far edge', x0: 0, y0: 830, x1: 914, y1: 914 };
const asteroids = (seed: number, n: number) => generateObstacles({ rng: seed }, { asteroid: n });

export const TRAINING: MissionDef[] = [
  {
    id: 'training-1', number: 1, title: 'Flight Course', teaches: 'The dial and maneuvers',
    briefing: [
      'Every round starts with Planning: you secretly set a maneuver on each ship\'s dial, then all ships move.',
      'Blue maneuvers are easy, white ones normal. The number is the speed: how far the ship flies.',
      'Fly through the five gates in order. Touching a gate with your base counts.',
    ],
    ruleset: MANEUVERS, obstacles: [],
    markers: [
      { id: 'g1', label: '1', x: 457, y: 250, r: 26 }, { id: 'g2', label: '2', x: 610, y: 430, r: 26 },
      { id: 'g3', label: '3', x: 640, y: 600, r: 26 }, { id: 'g4', label: '4', x: 450, y: 680, r: 26 },
      { id: 'g5', label: '5', x: 270, y: 520, r: 26 },
    ],
    player: [cadet(457)], enemy: [],
    objectives: [{ id: 'course', label: 'Fly through the gates in order', kind: 'course', markers: ['g1', 'g2', 'g3', 'g4', 'g5'] }],
    triggers: [
      tip({ roundStart: 1 }, 'Your dial', 'Click your ship, then move the pointer toward a dot: the ghost shows where that maneuver ends. Click to choose it, then Set move.'),
      tip({ roundStart: 2 }, 'Banks and turns', 'Banks curve gently (45°), turns sharply (90°). Turning near a gate is easier at low speed.'),
      tip({ objectiveDone: 'course' }, 'Course complete', 'Nicely flown. Next: shooting.'),
    ],
    maxRounds: 12,
  },
  {
    id: 'training-2', number: 2, title: 'Target Drones', teaches: 'Firing arcs, range and attacking',
    briefing: [
      'After everyone moves, ships attack in the Engagement phase. You can shoot ships inside your firing arc (the cone in front of your ship) out to range 4.',
      'Range matters: range 2 is the sweet spot (an extra attack die), range 1 costs you a die, at range 4 the target gets an extra defense die.',
      'Destroy the three drones. They fly slowly and never shoot back.',
    ],
    ruleset: ATTACKS, obstacles: [],
    player: [cadet(457)],
    // Slow, unshielded, agility-1 hulls: easy targets.
    enemy: [300, 457, 620].map((x, i) => ({ pilotId: 'rook-twelve', shipType: 'anvil', pose: at(x, i === 1 ? 620 : 540, S), name: `Drone ${i + 1}`, hull: 2, shields: 0, tags: ['drone'] })),
    enemyAi: 'drone',
    objectives: [{ id: 'drones', label: 'Destroy the drones', kind: 'destroy', tag: 'drone' }],
    triggers: [
      tip({ roundStart: 1 }, 'Line up a shot', 'When you pick a maneuver, the odds of hitting each drone from where you would end up appear over it.'),
      tip({ first: 'attack' }, 'Dice', 'Red dice attack, green dice defend. Each evade cancels one hit; what is left damages shields first, then hull.'),
    ],
    maxRounds: 15,
  },
  {
    id: 'training-3', number: 3, title: 'First Duel', teaches: 'Focus and Evade',
    briefing: [
      'After moving, each ship may perform one action. Two actions to start:',
      'Focus: in an attack or defense, turn all your focus (eye) results into hits or evades.',
      'Evade: add an evade result to your next defense roll.',
      'Your sparring partner shoots back. Destroy it.',
    ],
    ruleset: TOKENS, obstacles: [],
    // Both fly Wasps, which have Evade (the Kestrel does not).
    player: [{ pilotId: 'grunt-seven', shipType: 'wasp', pose: at(457, 60, N), name: 'Cadet' }],
    enemy: [{ pilotId: 'grunt-seven', shipType: 'wasp', pose: at(457, 854, S), name: 'Sparring Partner' }],
    objectives: [{ id: 'duel', label: 'Destroy the sparring partner', kind: 'destroy' }],
    triggers: [
      tip({ roundStart: 2 }, 'Which action?', 'Focus is the all-rounder. Evade is better when you will be shot but have no shot of your own.'),
    ],
    maxRounds: 12,
  },
  {
    id: 'training-4', number: 4, title: 'Wingmen', teaches: 'Lock and initiative',
    briefing: [
      'Ships move in initiative order, lowest first, and attack highest first. Ties go to you this time.',
      'Lock: pick an enemy. When you attack it, you may reroll any of your attack dice, which spends the lock. It lasts until you use it.',
      'Two against two. Destroy both enemy ships.',
    ],
    ruleset: LOCKS, obstacles: [],
    player: [cadet(380, 60, 'Cadet Kestrel'), { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(540, 60, N), name: 'Cadet Wasp' }],
    enemy: [{ pilotId: 'vale-nine', shipType: 'kestrel', pose: at(380, 854, S), name: 'Red Kestrel' }, { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(540, 854, S), name: 'Red Wasp' }],
    objectives: [{ id: 'wing', label: 'Destroy both enemy ships', kind: 'destroy' }],
    triggers: [tip({ first: 'lock' }, 'Locked on', 'The crosshair stays on that ship until you use the lock. A ship holds one lock at a time.')],
    maxRounds: 12,
  },
  {
    id: 'training-5', number: 5, title: 'Rock Field', teaches: 'Obstacles',
    briefing: [
      'Asteroids are dangerous: flying through or onto one rolls a die that can damage you, and you lose your action.',
      'They also block shots: an attack through an asteroid gives the defender an extra die.',
      'Fight through the field. Destroy both enemy ships.',
    ],
    ruleset: LOCKS, obstacles: asteroids(5505, 5),
    player: [cadet(380, 60, 'Cadet Kestrel'), { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(540, 60, N), name: 'Cadet Wasp' }],
    enemy: [{ pilotId: 'vale-nine', shipType: 'kestrel', pose: at(380, 854, S), name: 'Red Kestrel' }, { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(540, 854, S), name: 'Red Wasp' }],
    objectives: [{ id: 'rocks', label: 'Destroy both enemy ships', kind: 'destroy' }],
    triggers: [tip({ first: 'obstacleHit' }, 'Rock!', 'The maneuver ghost turns orange when a move would touch an asteroid. Check it before you set the dial.')],
    maxRounds: 12,
  },
  {
    id: 'training-6', number: 6, title: 'Break Contact', teaches: 'Barrel roll, boost and stress',
    briefing: [
      'Barrel roll slides your ship sideways; boost pushes it a little further forward. Both dodge out of an enemy\'s arc.',
      'Red maneuvers and red actions give you a stress token. A stressed ship cannot act or fly red; a blue maneuver clears a stress.',
      'Special maneuvers like the K-turn (turn around) are red.',
      'Two fighters are on your tail. Get at least one of your ships off the far edge.',
    ],
    ruleset: REPOSITION, obstacles: [], zones: [FAR_EDGE],
    player: [
      { pilotId: 'lance-four', shipType: 'javelin', pose: at(380, 210, N), name: 'Runner 1', tags: ['runner'] },
      { pilotId: 'lance-four', shipType: 'javelin', pose: at(540, 210, N), name: 'Runner 2', tags: ['runner'] },
    ],
    enemy: [
      { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(380, 50, N), name: 'Hunter 1' },
      { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(540, 50, N), name: 'Hunter 2' },
    ],
    objectives: [{ id: 'escape', label: 'Reach the far edge', kind: 'reach', zone: 'far-edge', tag: 'runner', count: 1 }],
    triggers: [tip({ first: 'stress' }, 'Stressed', 'Until you clear it with a blue maneuver, this ship cannot take actions or fly red maneuvers.')],
    maxRounds: 8,
  },
  {
    id: 'training-7', number: 7, title: 'Attrition', teaches: 'Critical damage',
    briefing: [
      'A critical hit (the burst on a red die) that reaches the hull deals a damage card: a lasting problem such as a fire or a damaged engine.',
      'Some cards can be fixed with the Repair action. The card\'s effect is listed on the ship.',
      'Two against three. Destroy the enemy squadron.',
    ],
    ruleset: DAMAGE, obstacles: asteroids(7707, 3),
    player: [cadet(380, 60, 'Cadet One'), cadet(540, 60, 'Cadet Two')],
    enemy: [300, 457, 620].map((x, i) => ({ pilotId: 'grunt-seven', shipType: 'wasp', pose: at(x, 854, S), name: `Raider ${i + 1}` })),
    objectives: [{ id: 'squadron', label: 'Destroy the enemy squadron', kind: 'destroy' }],
    triggers: [tip({ first: 'damageCard' }, 'Damage card', 'Hover the red tag on the ship\'s label to read what it does. Repairable cards show a Repair button in the action ring.')],
    maxRounds: 12,
  },
  {
    id: 'training-8', number: 8, title: 'Escort', teaches: 'Upgrades and points',
    briefing: [
      'Ships carry upgrades that cost squad points: here, extra shields and armour (modifications).',
      'In a battle you build your own squad within a points budget. Later missions add weapons, crew and more.',
      'Escort the freighter Lumen off the far edge. If it is destroyed, the mission fails.',
    ],
    ruleset: escortRules(), obstacles: asteroids(8808, 3), zones: [FAR_EDGE],
    player: [
      { pilotId: 'scout-two', shipType: 'wayfarer', pose: at(457, 70, N), name: 'Lumen', tags: ['freighter'] },
      cadet(310, 60, 'Escort One', { upgrades: ['shield-booster'] }),
      cadet(604, 60, 'Escort Two', { upgrades: ['hull-plating'] }),
    ],
    enemy: [
      { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(300, 800, S), name: 'Raider 1' },
      { pilotId: 'lance-four', shipType: 'javelin', pose: at(457, 854, S), name: 'Raider 2' },
      { pilotId: 'grunt-seven', shipType: 'wasp', pose: at(614, 800, S), name: 'Raider 3' },
    ],
    objectives: [
      { id: 'escort', label: 'Get Lumen to the far edge', kind: 'reach', zone: 'far-edge', tag: 'freighter' },
      { id: 'protect', label: 'Lumen must survive', kind: 'protect', tag: 'freighter' },
    ],
    triggers: [tip({ roundStart: 1 }, 'The freighter', 'Lumen has a turret: it can shoot in any direction you turn it to with the Rotate action.')],
    maxRounds: 12,
  },
];

/** Escort teaches upgrades on top of everything so far, plus the freighter's own actions (Rotate, Calculate, Jam). */
function escortRules(): Ruleset {
  return { ...FULL_RULES, actions: ALL_ACTIONS.filter((a) => a !== 'reload' && a !== 'coordinate' && a !== 'reinforce') };
}
