// The campaign after training (docs/MISSIONS.md): operations, each a board of 2-4 missions. The player flies one
// mission per operation; the others go away. Win or lose, the result sets flags that decide which missions the
// next boards offer and what forces they bring. Missions are data, like the training track; this file has the
// operations and the few pure functions the client needs (the board, recording a result, a mission as flown).
import { generateObstacles, type SquadEntry } from './game';
import { FULL_RULES } from './rules';
import { OFFICER_TAG, type MissionDef } from './training';
import type { Zone } from './types';

/** A mission on a campaign board: a mission, plus what the board shows and what its result changes. */
export interface CampaignMission extends MissionDef {
  /** One line for the board. */
  summary: string;
  /** 1 easy, 2 fair, 3 hard. */
  difficulty: 1 | 2 | 3;
  /** What is at stake, for the board. */
  stakes: string;
  /** On the board only when every one of these flags is set. */
  needs?: string[];
  /** On the board only when any one of these flags is set. */
  needsAny?: string[];
  /** Flags set by the result, and what the debriefing says. */
  outcome: Record<'win' | 'loss', { flags: string[]; text: string }>;
  /** Forces that join (or stay away) when an earlier result set one of `any` (the briefing shows `note`). */
  extras?: { any: string[]; note: string; player?: SquadEntry[]; enemy?: SquadEntry[]; fewerEnemies?: number }[];
}

export interface Operation {
  id: string;
  number: number;
  title: string;
  /** Command's words above the board. `{officer}` is the officer's name. */
  intro: string;
  missions: CampaignMission[];
}

export interface CampaignRecord { op: string; mission: string; result: 'win' | 'loss' }
/** Where a campaign stands: the officer, the flags results have set, and the missions flown (one per operation). */
export interface CampaignProgress { officer: string; flags: string[]; history: CampaignRecord[] }

const N = Math.PI / 2, S = -Math.PI / 2;
const at = (x: number, y: number, h: number) => ({ x, y, h });
const FAR_EDGE: Zone = { id: 'far-edge', label: 'Far edge', x0: 0, y0: 830, x1: 914, y1: 914 };
const NEAR_EDGE: Zone = { id: 'near-edge', label: 'Home edge', x0: 0, y0: 0, x1: 914, y1: 84 };
const rocks = (seed: number, n: number) => generateObstacles({ rng: seed }, { asteroid: n });
const field = (seed: number) => generateObstacles({ rng: seed }, { asteroid: 2, debris: 1, gas: 1 });

/** The player's ships: the officer's Kestrel and friends. */
const lead = (x: number, extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: 'vale-nine', shipType: 'kestrel', pose: at(x, 60, N), name: 'Officer', ...extra, tags: [OFFICER_TAG, ...(extra.tags ?? [])] });
const wing = (x: number, name: string, extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: 'vale-nine', shipType: 'kestrel', pose: at(x, 60, N), name, ...extra });
/** The opposition, setting up on the far edge. */
const wasp = (x: number, name: string, extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: 'grunt-seven', shipType: 'wasp', pose: at(x, 854, S), name, ...extra });
const javelin = (x: number, name: string, extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: 'lance-four', shipType: 'javelin', pose: at(x, 854, S), name, ...extra });

/** Fields every campaign mission shares: the full rules, a number from its operation. */
const base = (op: number) => ({ number: op, ruleset: FULL_RULES });

export const OPERATIONS: Operation[] = [
  {
    id: 'op-1', number: 1, title: 'First Command',
    intro: 'Lieutenant {officer}, welcome to the Outer Reach. Syndicate raiders are hitting our supply lanes and we are stretched thin. Three jobs need doing and you have the pilots for one. Choose.',
    missions: [
      {
        ...base(1), id: 'op1-supply-run', title: 'Supply Run', teaches: 'Escort', difficulty: 1,
        summary: 'Escort a supply freighter across a lane the raiders watch.',
        stakes: 'The outpost\'s repair crews need these parts.',
        intro: 'The freighter Provision carries spares for the outpost. Two raiders are waiting for it. Get it through.',
        briefing: ['Provision has a turret but little armour. Keep the raiders busy and get it off the far edge.'],
        obstacles: rocks(1101, 3), zones: [FAR_EDGE],
        player: [
          { pilotId: 'scout-two', shipType: 'wayfarer', pose: at(457, 70, N), name: 'Provision', tags: ['cargo'] },
          lead(310), wing(604, 'Wingmate'),
        ],
        enemy: [wasp(330, 'Raider 1'), wasp(584, 'Raider 2')],
        objectives: [
          { id: 'escort', label: 'Get Provision to the far edge', kind: 'reach', zone: 'far-edge', tag: 'cargo' },
          { id: 'protect', label: 'Provision must survive', kind: 'protect', tag: 'cargo' },
        ],
        maxRounds: 12,
        outcome: {
          win: { flags: ['supplies'], text: 'Provision made it. The outpost\'s crews will have your ships patched and ready for the next fight.' },
          loss: { flags: ['supplies-lost'], text: 'The raiders took the cargo. Those parts will end up in Syndicate ships.' },
        },
      },
      {
        ...base(1), id: 'op1-raider-hunt', title: 'Raider Hunt', teaches: 'Destroy', difficulty: 2,
        summary: 'Catch a raider patrol in an asteroid field and destroy it.',
        stakes: 'Fewer raiders now means fewer guns later.',
        intro: 'A patrol of three is using the rocks to hide. Go in after them.',
        briefing: ['Three raiders, two Wasps and a fast Javelin, in an asteroid field. Destroy all three.'],
        obstacles: rocks(1202, 5),
        player: [lead(380), wing(540, 'Wingmate')],
        enemy: [wasp(300, 'Raider 1'), javelin(457, 'Raider 2'), wasp(614, 'Raider 3')],
        objectives: [{ id: 'hunt', label: 'Destroy the raider patrol', kind: 'destroy' }],
        maxRounds: 12,
        outcome: {
          win: { flags: ['raiders-thinned'], text: 'The patrol is gone. The Syndicate will have fewer pilots to send at you.' },
          loss: { flags: ['raiders-bold'], text: 'The raiders drove you off. Word spreads: the Syndicate is getting bolder.' },
        },
      },
      {
        ...base(1), id: 'op1-listening-post', title: 'Listening Post', teaches: 'Scouting', difficulty: 2,
        summary: 'Fly past three sensor buoys while raiders hunt you.',
        stakes: 'The buoys could find the raiders\' supply depot.',
        intro: 'Three old buoys still listen out here. Fly close and they will download what they heard. Do not stop to fight unless you must.',
        briefing: ['Fly through the three buoys in order with either ship. Two Wasps will try to stop you.'],
        obstacles: rocks(1306, 3),
        markers: [
          { id: 'b1', label: '1', x: 250, y: 380, r: 26 }, { id: 'b2', label: '2', x: 660, y: 520, r: 26 },
          { id: 'b3', label: '3', x: 400, y: 700, r: 26 },
        ],
        player: [lead(380, { pilotId: 'lance-four', shipType: 'javelin' }), wing(540, 'Wingmate', { pilotId: 'lance-four', shipType: 'javelin' })],
        enemy: [wasp(300, 'Hunter 1'), wasp(614, 'Hunter 2')],
        objectives: [{ id: 'buoys', label: 'Fly through the three buoys', kind: 'course', markers: ['b1', 'b2', 'b3'] }],
        maxRounds: 10,
        outcome: {
          win: { flags: ['intel'], text: 'The buoys heard plenty: the raiders run their supplies through a depot nearby. Now we can hit it.' },
          loss: { flags: ['blind'], text: 'No data. We still do not know where the raiders resupply.' },
        },
      },
    ],
  },
  {
    id: 'op-2', number: 2, title: 'Pressure',
    intro: 'Good work out there, {officer}. The Syndicate noticed you. Keep the pressure on before they regroup.',
    missions: [
      {
        ...base(2), id: 'op2-depot-strike', title: 'Depot Strike', teaches: 'Strike', difficulty: 2, needs: ['intel'],
        summary: 'Hit the raiders\' supply depot and destroy its two loaded bombers.',
        stakes: 'Without the depot the raiders run short of ordnance.',
        intro: 'The buoy data paid off. Two bombers are loading at the depot. They must not take off.',
        briefing: ['Destroy the two Anvil bombers. A Wasp flies cover for them; you do not have to kill it.'],
        obstacles: field(2101),
        player: [lead(380), wing(540, 'Wingmate', { pilotId: 'ilse-kord' })],
        enemy: [
          { pilotId: 'rook-twelve', shipType: 'anvil', pose: at(350, 854, S), name: 'Bomber 1', tags: ['bomber'] },
          { pilotId: 'rook-twelve', shipType: 'anvil', pose: at(564, 854, S), name: 'Bomber 2', tags: ['bomber'] },
          wasp(457, 'Cover'),
        ],
        objectives: [{ id: 'bombers', label: 'Destroy both bombers', kind: 'destroy', tag: 'bomber' }],
        maxRounds: 12,
        outcome: {
          win: { flags: ['depot-burned'], text: 'The depot burns. The raiders will be short of ordnance for a long time.' },
          loss: { flags: ['bombers-loose'], text: 'The bombers got away fully loaded. Expect them again.' },
        },
      },
      {
        ...base(2), id: 'op2-convoy-ambush', title: 'Take It Back', teaches: 'Interception', difficulty: 2, needs: ['supplies-lost'],
        summary: 'Catch the raider gunship carrying the stolen parts.',
        stakes: 'Recover what was lost on the supply run.',
        intro: 'The stolen parts are aboard a Bulwark gunship heading out. It is slow. Run it down.',
        briefing: ['The gunship took damage in the raid (5 hull, 1 shield). Destroy it before the round limit runs out. One Wasp escorts it.'],
        obstacles: rocks(2202, 3),
        player: [lead(300), wing(457, 'Wingmate', { pilotId: 'lance-four', shipType: 'javelin' }), wing(614, 'Second wing')],
        enemy: [
          { pilotId: 'hauler-three', shipType: 'bulwark', pose: at(457, 840, S), name: 'Gunship', hull: 5, shields: 1, tags: ['cargo'] },
          wasp(300, 'Escort'),
        ],
        objectives: [{ id: 'gunship', label: 'Destroy the gunship', kind: 'destroy', tag: 'cargo' }],
        maxRounds: 10,
        outcome: {
          win: { flags: ['supplies-recovered'], text: 'The parts are ours again, a little scorched. The outpost crews will make do.' },
          loss: { flags: [], text: 'The gunship got away with the parts. Let it go: there are bigger fights ahead.' },
        },
      },
      {
        ...base(2), id: 'op2-hold-relay', title: 'Hold the Relay', teaches: 'Survival', difficulty: 3,
        summary: 'Hold out against a bigger force until help arrives.',
        stakes: 'If the relay falls, we lose our long-range warning.',
        intro: 'Raiders are moving on the comms relay. Help is six rounds out. Keep them busy until then.',
        briefing: ['Keep at least one of your ships alive to the end of round 6. Four raiders are coming.'],
        obstacles: rocks(2303, 4),
        player: [lead(380), wing(540, 'Wingmate', { pilotId: 'ilse-kord' })],
        enemy: [wasp(260, 'Raider 1'), javelin(390, 'Raider 2'), javelin(524, 'Raider 3'), wasp(654, 'Raider 4')],
        extras: [{ any: ['raiders-thinned'], note: 'You thinned the raiders on your first hunt: one fewer ship comes at you.', fewerEnemies: 1 }],
        objectives: [{ id: 'hold', label: 'Survive until the end of round 6', kind: 'survive', rounds: 6 }],
        maxRounds: 6,
        outcome: {
          win: { flags: ['relay-held'], text: 'The relay held. We will see the next raid coming.' },
          loss: { flags: ['relay-lost'], text: 'The relay is gone. From here on, the raiders choose where we fight.' },
        },
      },
      {
        ...base(2), id: 'op2-sweep', title: 'Sweep the Lanes', teaches: 'Patrol', difficulty: 1,
        summary: 'Clear two raiders off a trade lane with three ships.',
        stakes: 'Safe lanes keep the outpost supplied.',
        intro: 'A straightforward job: two raiders are bothering traders. You have three ships. Clear the lane.',
        briefing: ['Destroy the two Wasps.'],
        obstacles: rocks(2404, 3),
        player: [lead(300), wing(457, 'Wingmate'), wing(614, 'Second wing', { pilotId: 'lance-four', shipType: 'javelin' })],
        enemy: [wasp(380, 'Raider 1'), wasp(540, 'Raider 2')],
        objectives: [{ id: 'sweep', label: 'Destroy both raiders', kind: 'destroy' }],
        maxRounds: 10,
        outcome: {
          win: { flags: ['lanes-clear'], text: 'The lane is clear and the traders are grateful. Some of them fly, too.' },
          loss: { flags: [], text: 'The raiders held the lane. The traders will wait.' },
        },
      },
    ],
  },
  {
    id: 'op-3', number: 3, title: 'Counterstrike',
    intro: '{officer}, the Syndicate is massing for a push. We hit them first, or we help those already caught in it.',
    missions: [
      {
        ...base(3), id: 'op3-blockade', title: 'Run the Blockade', teaches: 'Breakthrough', difficulty: 2,
        summary: 'Get two ships through a raider blockade.',
        stakes: 'Ships through the blockade can warn the stations beyond it.',
        intro: 'Three raiders hold the gap. Get two of your ships through and the stations past it get our warning.',
        briefing: ['Get two of your ships off the far edge. Destroying the blockade is optional.'],
        obstacles: field(3101), zones: [FAR_EDGE],
        player: [lead(300), wing(457, 'Wingmate', { pilotId: 'lance-four', shipType: 'javelin' }), wing(614, 'Second wing', { pilotId: 'lance-four', shipType: 'javelin' })],
        enemy: [wasp(300, 'Blockade 1', { pose: at(300, 760, S) }), wasp(457, 'Blockade 2', { pose: at(457, 760, S) }), wasp(614, 'Blockade 3', { pose: at(614, 760, S) })],
        objectives: [{ id: 'through', label: 'Get two ships to the far edge', kind: 'reach', zone: 'far-edge', count: 2 }],
        maxRounds: 10,
        outcome: {
          win: { flags: ['warned'], text: 'The stations are warned and arming. You will have help in the final fight.' },
          loss: { flags: [], text: 'The blockade held. The stations will fend for themselves.' },
        },
      },
      {
        ...base(3), id: 'op3-rescue', title: 'Downed Pilot', teaches: 'Rescue', difficulty: 3,
        summary: 'A damaged friendly fighter is limping home with raiders on its tail.',
        stakes: 'An experienced pilot, if you get them home.',
        intro: 'Captain Kord\'s fighter is crippled and heading for us with raiders closing. Bring her home.',
        briefing: ['Kord\'s Kestrel (3 hull, no shields) must reach your home edge. If it is destroyed, the mission fails.'],
        obstacles: rocks(3201, 3), zones: [NEAR_EDGE],
        player: [
          { pilotId: 'ilse-kord', shipType: 'kestrel', pose: at(457, 420, S), name: 'Kord', hull: 3, shields: 0, tags: ['survivor'] },
          lead(250), wing(664, 'Wingmate'),
        ],
        enemy: [wasp(380, 'Pursuer 1', { pose: at(380, 740, S) }), javelin(540, 'Pursuer 2', { pose: at(540, 740, S) })],
        extras: [{ any: ['relay-held'], note: 'The relay spotted the pursuit early and drew one pursuer off.', fewerEnemies: 1 }],
        objectives: [
          { id: 'home', label: 'Get Kord to your home edge', kind: 'reach', zone: 'near-edge', tag: 'survivor' },
          { id: 'kord', label: 'Kord must survive', kind: 'protect', tag: 'survivor' },
        ],
        maxRounds: 10,
        outcome: {
          win: { flags: ['kord-rescued'], text: 'Kord is home. Once she is patched up, she will fly with you.' },
          loss: { flags: [], text: 'Kord didn\'t make it. Her squadron will remember.' },
        },
      },
      {
        ...base(3), id: 'op3-ace', title: 'The Syndicate Ace', teaches: 'Duel', difficulty: 3, needsAny: ['raiders-bold', 'bombers-loose', 'relay-lost'],
        summary: 'The raiders\' best pilot is hunting for you. Meet her on your terms.',
        stakes: 'Kill the ace and the raiders lose their nerve.',
        intro: 'Syl Ketch, the Syndicate\'s favourite ace, has asked for you by name. She brings one wingman. So do you.',
        briefing: ['Destroy Syl Ketch. Her wingman is optional.'],
        obstacles: rocks(3303, 4),
        player: [lead(380), wing(540, 'Wingmate', { pilotId: 'ilse-kord' })],
        enemy: [wasp(380, 'Syl Ketch', { pilotId: 'syl-ketch', tags: ['ace'] }), wasp(540, 'Ketch\'s wingman')],
        objectives: [{ id: 'ace', label: 'Destroy Syl Ketch', kind: 'destroy', tag: 'ace' }],
        maxRounds: 12,
        outcome: {
          win: { flags: ['ace-down'], text: 'Ketch is down. The raiders\' nerve goes with her.' },
          loss: { flags: [], text: 'Ketch got the better of you this time. She will be at the final fight.' },
        },
      },
    ],
  },
  {
    id: 'op-4', number: 4, title: 'Showdown',
    intro: 'This is it, {officer}. The Syndicate is throwing everything it has left at the outpost. How we fight it is your call.',
    missions: [
      {
        ...base(4), id: 'op4-assault', title: 'Final Assault', teaches: 'All-out battle', difficulty: 3,
        summary: 'Meet the raiders head-on and destroy their squadron.',
        stakes: 'Win and the Outer Reach is safe.',
        intro: 'Their whole squadron, led by Mara Venn. Everything you have done out here comes down to this.',
        briefing: ['Destroy the raider squadron. What you did earlier in the campaign decides who flies with you, and against you.'],
        obstacles: field(4101),
        player: [lead(380, { upgrades: ['shield-booster'] }), wing(540, 'Wingmate', { upgrades: ['hull-plating'] })],
        enemy: [wasp(380, 'Mara Venn', { pilotId: 'mara-venn' }), javelin(540, 'Raider 2')],
        extras: [
          { any: ['supplies', 'supplies-recovered'], note: 'The outpost crews repaired a third fighter for you.', player: [wing(220, 'Repaired Kestrel')] },
          { any: ['kord-rescued'], note: 'Captain Kord flies with you.', player: [wing(694, 'Kord', { pilotId: 'ilse-kord' })] },
          { any: ['raiders-bold'], note: 'The raiders are bold after your first hunt: an extra Wasp joins them.', enemy: [wasp(220, 'Raider 3')] },
          { any: ['bombers-loose'], note: 'The bombers from the depot fly with them.', enemy: [{ pilotId: 'rook-twelve', shipType: 'anvil', pose: at(694, 854, S), name: 'Bomber' }] },
        ],
        objectives: [{ id: 'final', label: 'Destroy the raider squadron', kind: 'destroy' }],
        maxRounds: 14,
        outcome: {
          win: { flags: ['victory'], text: 'The Syndicate squadron is broken. The Outer Reach is safe, for now, and it is yours to watch over.' },
          loss: { flags: ['defeat'], text: 'The raiders won the day. The outpost will hold, barely, and the war out here is far from over.' },
        },
      },
      {
        ...base(4), id: 'op4-hold', title: 'Defend the Outpost', teaches: 'Last stand', difficulty: 2,
        summary: 'Hold the line in front of the outpost until its guns are ready.',
        stakes: 'Survive and the outpost\'s guns finish the raid.',
        intro: 'The outpost\'s big guns need eight rounds to power up. Keep the raiders off it until then.',
        briefing: ['Keep at least one of your ships alive to the end of round 8.'],
        obstacles: rocks(4202, 4),
        player: [lead(380), wing(540, 'Wingmate')],
        enemy: [wasp(300, 'Raider 1'), javelin(457, 'Raider 2'), wasp(614, 'Raider 3')],
        extras: [
          { any: ['warned'], note: 'The stations you warned sent a gunship.', player: [{ pilotId: 'hauler-three', shipType: 'bulwark', pose: at(457, 70, N), name: 'Station gunship' }] },
          { any: ['kord-rescued'], note: 'Captain Kord flies with you.', player: [wing(694, 'Kord', { pilotId: 'ilse-kord' })] },
          { any: ['ace-down'], note: 'With Ketch gone, one raider lost its nerve and stayed home.', fewerEnemies: 1 },
          { any: ['raiders-bold'], note: 'The raiders are bold: an extra Javelin joins them.', enemy: [javelin(220, 'Raider 4')] },
        ],
        objectives: [{ id: 'hold', label: 'Survive until the end of round 8', kind: 'survive', rounds: 8 }],
        maxRounds: 8,
        outcome: {
          win: { flags: ['victory'], text: 'The outpost\'s guns opened up and the raid broke against them. The Outer Reach is safe, for now.' },
          loss: { flags: ['defeat'], text: 'The raiders overran the defence. The outpost holds, barely, and the war out here is far from over.' },
        },
      },
    ],
  },
];

/** Earlier results' extras: ships added to either side, or the opposition's last ships left out. */
function applyExtras(m: CampaignMission, flags: string[]): { player: SquadEntry[]; enemy: SquadEntry[]; notes: string[] } {
  let player = [...m.player], enemy = [...m.enemy];
  const notes: string[] = [];
  for (const x of m.extras ?? []) {
    if (!x.any.some((f) => flags.includes(f))) continue;
    notes.push(x.note);
    if (x.player) player = [...player, ...x.player];
    if (x.fewerEnemies) enemy = enemy.slice(0, Math.max(1, enemy.length - x.fewerEnemies));
    if (x.enemy) enemy = [...enemy, ...x.enemy];
  }
  return { player, enemy, notes };
}

export const newCampaign = (officer: string): CampaignProgress => ({ officer, flags: [], history: [] });

/** The operation being fought: one per mission flown, undefined once the campaign is over. */
export const currentOperation = (p: CampaignProgress): Operation | undefined => OPERATIONS[p.history.length];

export const campaignOver = (p: CampaignProgress) => p.history.length >= OPERATIONS.length;

/** Whether a mission's flags let it on the board. */
export const available = (m: CampaignMission, flags: string[]) =>
  (m.needs ?? []).every((f) => flags.includes(f)) && (!m.needsAny || m.needsAny.some((f) => flags.includes(f)));

/** The current operation's board: the missions the campaign so far makes available. */
export function missionBoard(p: CampaignProgress): CampaignMission[] {
  return currentOperation(p)?.missions.filter((m) => available(m, p.flags)) ?? [];
}

export const findCampaignMission = (id: string) => OPERATIONS.flatMap((o) => o.missions).find((m) => m.id === id);

/** A board mission as it will be flown: earlier results add (or remove) ships. `notes` says what changed. */
export function missionAsFlown(m: CampaignMission, p: CampaignProgress): { def: MissionDef; notes: string[] } {
  const { player, enemy, notes } = applyExtras(m, p.flags);
  return { def: { ...m, player, enemy }, notes };
}

/** Record a flown mission: its flags are set, and the campaign moves on to the next operation. */
export function recordMission(p: CampaignProgress, missionId: string, result: 'win' | 'loss'): CampaignProgress {
  const op = currentOperation(p);
  const m = op?.missions.find((x) => x.id === missionId);
  if (!op || !m || !available(m, p.flags)) return p;
  return {
    ...p,
    flags: [...new Set([...p.flags, ...m.outcome[result].flags])],
    history: [...p.history, { op: op.id, mission: m.id, result }],
  };
}
