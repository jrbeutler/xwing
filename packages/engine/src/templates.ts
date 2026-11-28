// Mission templates (docs/MISSIONS.md, "The longer campaign"): build a whole campaign mission from a few
// parameters, so later acts don't need every mission laid out by hand. Each template knows its table, forces,
// objectives and a default briefing; the caller brings the story (titles, summary, stakes, outcome, flags).
// The rescue mission for captured pilots is one of them.
import type { CampaignMission } from './campaign';
import { PILOTS } from './content';
import { generateObstacles, type SquadEntry } from './game';
import { polygonDistance } from './geometry';
import { OFFICER_TAG } from './training';
import { FULL_RULES } from './rules';
import { nextFloat } from './rng';
import type { Marker, ObstacleKind, Zone } from './types';

const N = Math.PI / 2, S = -Math.PI / 2;
const at = (x: number, y: number, h: number) => ({ x, y, h });
const FAR_EDGE: Zone = { id: 'far-edge', label: 'Far edge', x0: 0, y0: 830, x1: 914, y1: 914 };

/** Spread `n` ships across an edge. */
export const spread = (n: number): number[] => ({ 1: [457], 2: [380, 540], 3: [300, 457, 614], 4: [220, 380, 540, 700], 5: [140, 300, 457, 614, 774] } as Record<number, number[]>)[n]
  ?? Array.from({ length: n }, (_, i) => Math.round(((i + 1) * 914) / (n + 1)));

/** The call-sign pilot who flies a hull (players' seats and enemy ships alike). */
const CALLSIGN: Record<string, string> = { kestrel: 'vale-nine', wasp: 'grunt-seven', javelin: 'lance-four', anvil: 'rook-twelve', bulwark: 'hauler-three', wayfarer: 'scout-two' };
const ship = (hull: string, x: number, y: number, h: number, name: string, extra: Partial<SquadEntry> = {}): SquadEntry =>
  ({ pilotId: CALLSIGN[hull] ?? 'grunt-seven', shipType: hull, pose: at(x, y, h), name, ...extra });

/** What every template needs: the story around the mission. */
export interface TemplateBase {
  id: string;
  /** The operation number it is flown in. */
  number: number;
  title: string;
  summary: string;
  stakes: string;
  intro: string;
  difficulty: 1 | 2 | 3;
  /** Seeds the table (obstacles, buoys). */
  seed: number;
  outcome: CampaignMission['outcome'];
  /** Replaces the template's own briefing. */
  briefing?: string[];
  needs?: string[];
  needsAny?: string[];
  extras?: CampaignMission['extras'];
  /** The squadron's hulls: the officer flies the first. Default two Kestrels. */
  hulls?: string[];
  /** The opposition's hulls, on the far edge (the first leads). Default per template. */
  enemy?: string[];
  /** Obstacles on the table. Default three asteroids. */
  obstacles?: Partial<Record<ObstacleKind, number>>;
  maxRounds?: number;
}

/** The parts every template fills the same way. */
function mission(b: TemplateBase, teaches: string, rest: Pick<CampaignMission, 'briefing' | 'objectives'> & Partial<CampaignMission>, enemyDefault: string[]): CampaignMission {
  const hulls = b.hulls ?? ['kestrel', 'kestrel'];
  const xs = spread(hulls.length);
  const player = hulls.map((h, i) => ship(h, xs[i], 60, N, i ? (i === 1 ? 'Wingmate' : `Wing ${i + 1}`) : 'Officer', i ? {} : { tags: [OFFICER_TAG] }));
  const enemyHulls = b.enemy ?? enemyDefault;
  const ex = spread(enemyHulls.length);
  const enemy = enemyHulls.map((h, i) => ship(h, ex[i], 854, S, `Raider ${i + 1}`));
  return {
    number: b.number, id: b.id, title: b.title, teaches, difficulty: b.difficulty, ruleset: FULL_RULES,
    summary: b.summary, stakes: b.stakes, intro: b.intro, outcome: b.outcome,
    ...(b.needs ? { needs: b.needs } : {}), ...(b.needsAny ? { needsAny: b.needsAny } : {}), ...(b.extras ? { extras: b.extras } : {}),
    obstacles: generateObstacles({ rng: b.seed }, b.obstacles ?? { asteroid: 3 }),
    player, enemy, maxRounds: b.maxRounds ?? 12,
    ...rest,
    briefing: b.briefing ?? rest.briefing,
  };
}

/** Strike: destroy a named target (by default a Bulwark gunship) behind its escorts. */
export function strike(b: TemplateBase & { target?: { hull: string; name: string } }): CampaignMission {
  const target = b.target ?? { hull: 'bulwark', name: 'Gunship' };
  const m = mission(b, 'Strike', {
    briefing: [`Destroy the ${target.name}. Its escorts will try to stop you; you don't have to finish them.`],
    objectives: [{ id: 'target', label: `Destroy the ${target.name}`, kind: 'destroy', tag: 'target' }],
  }, ['wasp', 'wasp']);
  // The target sits in the middle of the far edge, its escorts either side.
  const xs = spread(m.enemy.length + 1), mid = Math.floor(xs.length / 2);
  const slots = xs.filter((_, i) => i !== mid);
  const escorts = m.enemy.map((e, i) => ({ ...e, pose: { ...e.pose, x: slots[i] } }));
  return { ...m, enemy: [ship(target.hull, xs[mid], 854, S, target.name, { tags: ['target'] }), ...escorts] };
}

/** Escort: get a freighter (a Wayfarer) off the far edge, and keep it alive. */
export function escort(b: TemplateBase & { cargo?: string }): CampaignMission {
  const cargo = b.cargo ?? 'the freighter';
  const m = mission(b, 'Escort', {
    briefing: [`Get ${cargo} off the far edge. If it is destroyed, the mission fails.`],
    objectives: [
      { id: 'escort', label: `Get ${cargo} to the far edge`, kind: 'reach', zone: 'far-edge', tag: 'cargo' },
      { id: 'protect', label: `${cargo[0].toUpperCase()}${cargo.slice(1)} must survive`, kind: 'protect', tag: 'cargo' },
    ],
    zones: [FAR_EDGE],
  }, ['wasp', 'javelin']);
  // The freighter starts in the middle of the home edge; the fighters spread either side of it.
  const n = m.player.length, xs = n === 1 ? [300] : n === 2 ? [310, 604] : spread(n + 1).filter((x) => x !== 457);
  const player = m.player.map((e, i) => ({ ...e, pose: { ...e.pose, x: xs[i] ?? e.pose.x } }));
  return { ...m, player: [ship('wayfarer', 457, 70, N, cargo.replace(/^the /, ''), { tags: ['cargo'] }), ...player] };
}

/** Defend: hold out until the end of a round against a bigger force. */
export function defend(b: TemplateBase & { rounds?: number }): CampaignMission {
  const rounds = b.rounds ?? 6;
  return mission(b, 'Defend', {
    briefing: [`Hold until the end of round ${rounds}. You don't have to win the fight, only still be flying.`],
    objectives: [{ id: 'hold', label: `Survive until the end of round ${rounds}`, kind: 'survive', rounds }],
    maxRounds: rounds,
  }, ['wasp', 'javelin', 'wasp']);
}

/** Recon: fly through sensor buoys in order while the enemy hunts you. Javelins by default. */
export function recon(b: TemplateBase & { buoys?: number }): CampaignMission {
  const count = b.buoys ?? 3;
  const base = mission({ ...b, hulls: b.hulls ?? ['javelin', 'javelin'] }, 'Scouting', {
    briefing: [`Fly through the ${count} buoys in order with any of your ships.`],
    objectives: [{ id: 'buoys', label: `Fly through the ${count} buoys`, kind: 'course', markers: Array.from({ length: count }, (_, i) => `b${i + 1}`) }],
  }, ['wasp', 'wasp']);
  // Buoys well clear of the obstacles and of each other, flown roughly from the home edge outwards.
  const rng = { rng: b.seed ^ 0x2b0e };
  const markers: Marker[] = [];
  for (let tries = 0; markers.length < count && tries < 500; tries++) {
    const x = 150 + nextFloat(rng) * 614, y = 300 + nextFloat(rng) * 420;
    if (base.obstacles.some((o) => polygonDistance(o.polygon, [{ x, y }]).d < 26 + 40)) continue;
    if (markers.some((mk) => Math.hypot(mk.x - x, mk.y - y) < 170)) continue;
    markers.push({ id: '', label: '', x, y, r: 26 });
  }
  markers.sort((a, c) => a.y - c.y).forEach((mk, i) => { mk.id = `b${i + 1}`; mk.label = String(i + 1); });
  return { ...base, markers };
}

/** Duel: the enemy's ace (a named pilot) and a wingman; destroy the ace. */
export function duel(b: TemplateBase & { ace: { pilotId: string; hull?: string; name?: string } }): CampaignMission {
  const ace = b.ace;
  const name = ace.name ?? PILOTS[ace.pilotId].name;
  const m = mission(b, 'Duel', {
    briefing: [`${name} leads this patrol. Destroy ${name}; the wingman doesn't matter.`],
    objectives: [{ id: 'ace', label: `Destroy ${name}`, kind: 'destroy', tag: 'ace' }],
  }, ['wasp']);
  const hull = ace.hull ?? PILOTS[ace.pilotId].ship;
  const xs = spread(m.enemy.length + 1);
  return { ...m, enemy: [{ pilotId: ace.pilotId, shipType: hull, pose: at(xs[0], 854, S), name, tags: ['ace'] }, ...m.enemy.map((e, i) => ({ ...e, pose: { ...e.pose, x: xs[i + 1] } }))] };
}

/** Rescue: break captured pilots out of a prison barge by destroying its guards. */
export function rescue(b: TemplateBase): CampaignMission {
  return mission({ ...b, hulls: b.hulls ?? ['kestrel', 'kestrel', 'kestrel'] }, 'Rescue', {
    briefing: ['Destroy the barge\'s guards. With its escort gone the barge surrenders, and the prisoners come home with your medic.'],
    objectives: [{ id: 'guards', label: 'Destroy the barge\'s guards', kind: 'destroy' }],
    maxRounds: 10,
  }, ['wasp', 'javelin']);
}

/** Every template, for tests and tools. */
export const TEMPLATES = { strike, escort, defend, recon, duel, rescue };
