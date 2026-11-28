// The campaign's squadron (docs/MISSIONS.md, "Roster, experience and rescue"): pilots who fly mission after
// mission, earn experience for coming home, and spend it in the hangar on initiative and talents. Pure
// functions over plain data; the campaign keeps the roster in its progress and the client saves it.
import { PILOTS, SHIP_TYPES, UPGRADES } from './content';
import type { SquadEntry } from './game';
import { hullOf, talentSlotCount } from './squad';
import { OFFICER_TAG } from './training';
import type { GameState } from './types';

export interface RosterPilot {
  id: string;
  name: string;
  /** The player's own officer: flies every mission. */
  officer?: boolean;
  initiative: number;
  /** Talents learned, in slot order. */
  talents: string[];
  /** Experience banked, not yet spent. */
  xp: number;
  kills: number;
  missions: number;
  status: 'active' | 'lost' | 'captured';
  /** Injured: can fly again from this mission (an index into the campaign's history). */
  injuredUntil?: number;
  /** The mission (history index) they joined before. */
  joined: number;
}

/** What each pilot earns (docs/MISSIONS.md). */
export const XP = { survived: 2, won: 1, kill: 1, officer: 1 } as const;
export const TALENT_COST = 4;
export const MAX_INITIATIVE = 6;
export const OFFICER_INITIATIVE = 2;
export const STARTING_WINGMEN = 3;

/** Call signs for wingmen and replacements, handed out in order. */
const NAMES = [
  'Dax Moreau', 'Lio Varga', 'Pell Ashby', 'Juno Kaire', 'Teo Brandt', 'Nia Okafor', 'Rusk Halden', 'Vera Lind',
  'Cal Oduya', 'Mika Sorn', 'Brin Tasker', 'Esme Quill', 'Hollis Dray', 'Ondra Vey', 'Sato Renn', 'Kael Imari',
  'Yara Fenn', 'Gideon Pryce', 'Lumi Haas', 'Ash Corvell', 'Tamsin Rook', 'Ilan Mercer', 'Zofia Strand', 'Nox Bellam',
];

/** Replacements arrive better trained as the war goes on: initiative 1 in Act I, 2 in Act II, 3 in Act III. */
export const replacementInitiative = (missionIndex: number) => (missionIndex < 4 ? 1 : missionIndex < 7 ? 2 : 3);

function recruit(n: number, missionIndex: number): RosterPilot {
  const name = NAMES[n % NAMES.length] + (n >= NAMES.length ? ` ${Math.floor(n / NAMES.length) + 1}` : '');
  return { id: `pilot-${n}`, name, initiative: replacementInitiative(missionIndex), talents: [], xp: 0, kills: 0, missions: 0, status: 'active', joined: missionIndex };
}

/** A new squadron: the officer and their first wingmen. */
export function startingRoster(officer: string): { roster: RosterPilot[]; recruited: number } {
  const roster: RosterPilot[] = [
    { id: 'officer', name: officer, officer: true, initiative: OFFICER_INITIATIVE, talents: [], xp: 0, kills: 0, missions: 0, status: 'active', joined: 0 },
  ];
  for (let i = 0; i < STARTING_WINGMEN; i++) roster.push(recruit(i, 0));
  return { roster, recruited: STARTING_WINGMEN };
}

/** Whether a pilot can fly the mission at this history index (alive, free, not recovering). */
export const canFly = (p: RosterPilot, missionIndex: number) => p.status === 'active' && (p.injuredUntil ?? 0) <= missionIndex;

/** Replacements join until there are enough pilots fit to fly `seats` ships. */
export function withReplacements(roster: RosterPilot[], recruited: number, missionIndex: number, seats: number) {
  const out = [...roster];
  let n = recruited;
  while (out.filter((p) => canFly(p, missionIndex)).length < seats) out.push(recruit(n++, missionIndex));
  return { roster: out, recruited: n };
}

/** Who flies if the player doesn't choose: the officer, then the best wingmen fit to fly. */
export function defaultCrew(roster: RosterPilot[], missionIndex: number, seats: number): string[] {
  const ready = roster.filter((p) => canFly(p, missionIndex));
  const officer = ready.filter((p) => p.officer);
  const rest = ready.filter((p) => !p.officer).sort((a, b) => b.initiative - a.initiative || b.xp + b.kills - (a.xp + a.kills));
  return [...officer, ...rest].slice(0, seats).map((p) => p.id);
}

/** The call-sign pilot card for a hull: roster pilots fly it with their own initiative and talents. */
function genericPilotFor(hull: string): string {
  const cls = SHIP_TYPES[hull].class;
  const all = Object.values(PILOTS).filter((p) => !p.unique && p.specialty === cls);
  return (all.find((p) => p.ship === hull) ?? all[0]).id;
}

/** Whether a player ship added by an earlier result is one the squadron flies (a call-sign fighter) or an ally. */
export const isSeat = (e: SquadEntry) => !PILOTS[e.pilotId].unique && SHIP_TYPES[hullOf(e)].class === 'fighter';

/**
 * The player's ships with roster pilots in the seats: the officer in the officer's ship, the rest in order.
 * Each seat keeps its hull and upgrades; the pilot brings their name, initiative and talents.
 */
export function crewShips(player: SquadEntry[], seats: number[], crew: RosterPilot[]): SquadEntry[] {
  const out = [...player];
  const officerSeat = seats.find((i) => player[i].tags?.includes(OFFICER_TAG));
  const officer = crew.find((p) => p.officer);
  const others = crew.filter((p) => p !== officer);
  const fill = (i: number, p: RosterPilot | undefined) => {
    if (!p) return;
    const e = player[i];
    out[i] = { ...e, pilotId: genericPilotFor(hullOf(e)), shipType: hullOf(e), name: p.name, initiative: p.initiative, talents: [...p.talents], rosterId: p.id };
  };
  if (officerSeat !== undefined) fill(officerSeat, officer);
  let k = 0;
  for (const i of seats) if (i !== officerSeat) fill(i, others[k++]);
  return out;
}

/** Kills per ship: the last ship to hit a ship (shot or bomb) gets the credit when it is destroyed. */
export function killCredits(s: GameState): Map<string, number> {
  const owner = new Map(s.ships.map((x) => [x.id, x.owner]));
  const lastHit = new Map<string, string>(), dropper = new Map<string, string>(), kills = new Map<string, number>();
  for (const e of s.log) {
    if (e.type === 'attack' && e.hullDamage + e.shieldDamage + (e.ion ?? 0) > 0) lastHit.set(e.defenderId, e.attackerId);
    if (e.type === 'deviceDropped') dropper.set(e.device.id, e.shipId);
    if (e.type === 'deviceDetonated') {
      const by = dropper.get(e.device.id);
      if (by) for (const h of e.ships) if (h.shipId !== by && h.hullDamage + h.shieldDamage > 0) lastHit.set(h.shipId, by);
    }
    if (e.type === 'destroyed') {
      const by = lastHit.get(e.shipId);
      const ship = s.ships.find((x) => x.id === e.shipId);
      if (by && !ship?.fled && owner.get(by) !== owner.get(e.shipId)) kills.set(by, (kills.get(by) ?? 0) + 1);
    }
  }
  return kills;
}

/** How one roster pilot's mission went. */
export interface PilotReport {
  pilotId: string;
  name: string;
  /** Home: on the table at the end. Retreated: flew off the table. Down: shot down. */
  outcome: 'home' | 'retreated' | 'down';
  /** Rounds flown, of the rounds the battle lasted. */
  rounds: number;
  of: number;
  kills: number;
  xp: number;
}

/**
 * Experience for each roster pilot in a finished mission. Coming home earns the survival XP (+1 for a win,
 * +1 for the officer); a retreat earns that share of it for the rounds flown; kills count in full either way;
 * a pilot shot down keeps only their kills.
 */
export function missionReport(s: GameState): PilotReport[] {
  const won = s.mission?.result === 'win';
  const kills = killCredits(s);
  const of = Math.max(1, s.round);
  return s.ships.filter((x) => x.rosterId).map((x) => {
    const outcome = x.fled ? 'retreated' : x.destroyed ? 'down' : 'home';
    const rounds = x.fled ?? of;
    const base = XP.survived + (won ? XP.won : 0) + (x.tags?.includes(OFFICER_TAG) ? XP.officer : 0);
    const k = kills.get(x.id) ?? 0;
    const earned = outcome === 'home' ? base : outcome === 'retreated' ? Math.round((base * rounds) / of) : 0;
    return { pilotId: x.rosterId!, name: x.name, outcome, rounds, of, kills: k, xp: earned + k * XP.kill };
  });
}

/**
 * The roster after a mission: XP and kills banked, missions counted. Until escape pods and the medic ship
 * arrive (the next build step), a pilot shot down survives injured and sits out the next mission; the officer
 * always flies.
 */
export function applyReport(roster: RosterPilot[], report: PilotReport[], missionIndex: number): RosterPilot[] {
  return roster.map((p) => {
    const r = report.find((x) => x.pilotId === p.id);
    if (!r) return p;
    const injured = r.outcome === 'down' && !p.officer;
    return { ...p, xp: p.xp + r.xp, kills: p.kills + r.kills, missions: p.missions + 1, ...(injured ? { injuredUntil: missionIndex + 2 } : {}) };
  });
}

// --- The hangar: spending experience ---------------------------------------------------------------

/** XP for the next initiative step: twice the new initiative. */
export const promoteCost = (p: RosterPilot) => 2 * (p.initiative + 1);
export const canPromote = (p: RosterPilot) => p.status === 'active' && p.initiative < MAX_INITIATIVE && p.xp >= promoteCost(p);

/** Talent slots still empty (one at initiative 3-4, two at 5+). */
export const freeTalentSlots = (p: RosterPilot) => Math.max(0, talentSlotCount(p.initiative) - p.talents.length);

/** Talents a fighter pilot could learn: their class's pool, less what they know. */
export const talentOptions = (p: RosterPilot) =>
  Object.values(UPGRADES).filter((u) => u.slot === 'talent' && (!u.classes || u.classes.includes('fighter')) && !p.talents.includes(u.id)).map((u) => u.id);

export const canLearnTalent = (p: RosterPilot, talent?: string) =>
  p.status === 'active' && freeTalentSlots(p) > 0 && p.xp >= TALENT_COST && (!talent || talentOptions(p).includes(talent));

const update = (roster: RosterPilot[], id: string, f: (p: RosterPilot) => RosterPilot | null) => {
  const p = roster.find((x) => x.id === id);
  const next = p && f(p);
  return next ? roster.map((x) => (x.id === id ? next : x)) : roster;
};

/** Spend XP on +1 initiative (unchanged if the pilot can't). */
export const promote = (roster: RosterPilot[], id: string) =>
  update(roster, id, (p) => (canPromote(p) ? { ...p, xp: p.xp - promoteCost(p), initiative: p.initiative + 1 } : null));

/** Spend XP on a talent for a free slot (unchanged if the pilot can't). */
export const learnTalent = (roster: RosterPilot[], id: string, talent: string) =>
  update(roster, id, (p) => (canLearnTalent(p, talent) ? { ...p, xp: p.xp - TALENT_COST, talents: [...p.talents, talent] } : null));
