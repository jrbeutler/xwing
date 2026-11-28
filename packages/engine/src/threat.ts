// Rising threat (docs/MISSIONS.md, "The longer campaign"): the Syndicate answers a veteran squadron with veterans of
// its own. A mission's threat level comes from how far into the campaign it is and how experienced the pilots
// flying it are; each level hardens the enemy force a step (initiative, extra ships, talents, upgrades).
import { PILOTS, SHIP_TYPES } from './content';
import type { SquadEntry } from './game';
import { hullOf } from './squad';
import { OFFICER_INITIATIVE, type RosterPilot } from './roster';

/** Where extra enemy ships can set up: the far edge, facing the player. */
const FAR_Y = 854;
const SPOTS = [457, 170, 744, 300, 614, 80, 834];

/**
 * The threat level of a campaign mission: one level per two missions flown, plus one per two points of the
 * crew's experience (initiative above where each pilot started, and each talent learned).
 */
export function threatLevel(missionIndex: number, crew: Pick<RosterPilot, 'initiative' | 'talents' | 'officer'>[]): number {
  const veterancy = crew.reduce((a, p) => a + Math.max(0, p.initiative - (p.officer ? OFFICER_INITIATIVE : 1)) + p.talents.length, 0);
  return Math.floor(missionIndex / 2) + Math.floor(veterancy / 2);
}

/** What each threat level adds, for the briefing. */
export const THREAT_STEPS = [
  '',
  'Their leader is a veteran (+1 initiative).',
  'Their pilots are seasoned (+1 initiative).',
  'They bring an extra ship.',
  'Their leader has a talent.',
  'Their ships carry upgrades.',
  'They bring a second extra ship.',
  'Their pilots are hardened (+1 initiative).',
];

const initiativeOf = (e: SquadEntry) => e.initiative ?? PILOTS[e.pilotId].initiative;
const withInitiative = (e: SquadEntry, add: number) => ({ ...e, initiative: Math.min(6, initiativeOf(e) + add) });

/** A talent the enemy leader's class can take (fighters: Marksman; others: their pool's first). */
const LEADER_TALENT: Record<string, string> = { fighter: 'marksman', bomber: 'marksman', freighter: 'steady-gunner' };

/** An extra enemy ship: a copy of the force's last ship, at a free spot on the far edge. */
function reinforcement(enemy: SquadEntry[], n: number): SquadEntry | null {
  const like = enemy[enemy.length - 1];
  if (!like) return null;
  const x = SPOTS.find((sx) => enemy.every((e) => Math.abs(e.pose.x - sx) >= 75 || Math.abs(e.pose.y - FAR_Y) >= 75));
  if (x === undefined) return null;
  const { tags: _drop, ...rest } = like; // a plain escort: objectives keyed to tags stay as written
  return { ...rest, pose: { x, y: FAR_Y, h: -Math.PI / 2 }, name: `Reinforcement ${n}` };
}

/** The enemy force at a threat level, and the briefing's lines about what changed. */
export function applyThreat(enemy: SquadEntry[], level: number): { enemy: SquadEntry[]; notes: string[] } {
  if (level <= 0 || !enemy.length) return { enemy, notes: [] };
  let out = enemy.map((e) => ({ ...e }));
  const steps: string[] = [];
  const step = (lvl: number, f: () => boolean | void) => { if (level >= lvl && f() !== false) steps.push(THREAT_STEPS[lvl]); };
  step(1, () => { out[0] = withInitiative(out[0], 1); });
  step(2, () => { out = out.map((e) => withInitiative(e, 1)); });
  step(3, () => { const r = reinforcement(out, 1); if (!r) return false; out.push(r); });
  step(4, () => {
    const t = LEADER_TALENT[SHIP_TYPES[hullOf(out[0])].class];
    out[0] = { ...out[0], talents: [...(out[0].talents ?? PILOTS[out[0].pilotId].talents ?? []), t] };
  });
  step(5, () => {
    out = out.map((e, i) => (SHIP_TYPES[hullOf(e)].slots.includes('modification') && !(e.upgrades ?? []).length
      ? { ...e, upgrades: [i % 2 ? 'shield-booster' : 'hull-plating'] } : e));
  });
  step(6, () => { const r = reinforcement(out, 2); if (!r) return false; out.push(r); });
  for (let lvl = 7; lvl <= level; lvl += 2) {
    out = out.map((e) => withInitiative(e, 1));
    if (lvl === 7) steps.push(THREAT_STEPS[7]);
  }
  return { enemy: out, notes: [`Threat ${level}: the Syndicate is sending its best. ${steps.join(' ')}`] };
}
