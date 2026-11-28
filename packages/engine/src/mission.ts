// Mission play (docs/MISSIONS.md): objectives, scripted messages and the result. The rules code runs the
// battle as usual; after each command `missionScan` reads the new events and moves the mission on, and the
// End phase asks `missionRoundEnd` instead of the skirmish's last-player-standing rule.
import { shipPolygon } from './combat';
import type { Pose } from './geometry';
import { capturePods, holdForRecovery, isMedic } from './rescue';
import type { GameEvent, GameState, Marker, MissionState, Objective, ObjectiveState, PlayerId, ShipState, Zone } from './types';

/** What a game needs to be a mission: everything in MissionState except its progress. */
export type MissionSetup = Omit<MissionState, 'objectives' | 'fired' | 'result' | 'scanned'> & { objectives: Objective[] };

export function startMission(m: MissionSetup): MissionState {
  return {
    ...structuredClone(m),
    objectives: m.objectives.map((o) => ({ ...o, status: 'open', progress: 0, of: objectiveSize(o) })),
    fired: [],
    result: null,
    scanned: 0,
  };
}

const objectiveSize = (o: Objective) => (o.kind === 'course' ? o.markers.length : o.kind === 'reach' ? o.count ?? 1 : o.kind === 'survive' ? o.rounds : 1);

const hasTag = (sh: ShipState, tag?: string) => !tag || !!sh.tags?.includes(tag);
const mine = (m: MissionState, sh: ShipState) => sh.owner === m.player;
/** The player's fighting ships: the medic ship flies with them but never counts for objectives or the result. */
const fighting = (m: MissionState, sh: ShipState) => mine(m, sh) && !isMedic(sh);

/** Whether a ship's base at `pose` touches a marker (any part of the base within the marker's radius). */
export function touchesMarker(sh: ShipState, pose: Pose, mk: Marker): boolean {
  const poly = shipPolygon(sh, pose);
  let pos = 0, neg = 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    if (ex * (mk.y - a.y) - ey * (mk.x - a.x) >= 0) pos++; else neg++; // inside: same side of every edge
    const t = Math.max(0, Math.min(1, ((mk.x - a.x) * ex + (mk.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    best = Math.min(best, Math.hypot(a.x + ex * t - mk.x, a.y + ey * t - mk.y));
  }
  return pos === poly.length || neg === poly.length || best <= mk.r;
}

export const inZone = (z: Zone, p: { x: number; y: number }) => p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1;

/** Mark an objective's progress (logging it) and fire the triggers waiting for it to be done. */
function setProgress(s: GameState, o: ObjectiveState, progress: number, status = o.status) {
  if (progress === o.progress && status === o.status) return;
  o.progress = progress;
  o.status = status;
  s.log.push({ type: 'objective', id: o.id, status, progress, of: o.of });
  if (status === 'done') fire(s, (t) => 'objectiveDone' in t.on && t.on.objectiveDone === o.id);
}

function fire(s: GameState, when: (t: MissionState['triggers'][number]) => boolean) {
  const m = s.mission!;
  m.triggers.forEach((t, i) => {
    if (m.fired.includes(i) || !when(t)) return;
    m.fired.push(i);
    s.log.push({ type: 'message', ...t.message });
  });
}

/**
 * End the mission: the game is over, won or lost by the player. A win with escape pods still out waits for
 * the recovery phase to end first; a loss captures the pods still out.
 */
export function endMission(s: GameState, result: 'win' | 'loss') {
  const m = s.mission!;
  if (m.result) return;
  if (result === 'win' && holdForRecovery(s)) return;
  if (result === 'loss') capturePods(s);
  m.result = result;
  s.phase = 'over';
  s.pending = null;
  const other: PlayerId | 'draw' = s.players.find((p) => p.id !== m.player)?.id ?? 'draw';
  s.winner = result === 'win' ? m.player : other;
  s.log.push({ type: 'gameOver', winner: s.winner, mission: result });
}

/** Won once every objective but `protect` is done and none has failed. */
function checkResult(s: GameState) {
  const m = s.mission!;
  if (m.result) return;
  // The recovery phase: already won; it ends (as a win) once no pods are left out for the medic.
  if (m.recovery) return endMission(s, 'win');
  if (m.objectives.some((o) => o.status === 'failed')) return endMission(s, 'loss');
  if (!s.ships.some((x) => fighting(m, x) && !x.destroyed)) return endMission(s, 'loss');
  if (m.objectives.every((o) => o.kind === 'protect' || o.status === 'done')) endMission(s, 'win');
}

/** A player ship ended a move (or a boost or barrel roll) along `poses`: course and reach objectives. */
function afterMove(s: GameState, sh: ShipState, poses: Pose[]) {
  const m = s.mission!;
  for (const o of m.objectives) {
    if (o.status !== 'open' || !hasTag(sh, o.tag)) continue;
    if (o.kind === 'course') {
      let k = o.progress;
      for (const p of poses) {
        while (k < o.markers.length) {
          const mk = m.markers.find((x) => x.id === o.markers[k]);
          if (!mk || !touchesMarker(sh, p, mk)) break;
          k++;
        }
      }
      setProgress(s, o, k, k >= o.of ? 'done' : 'open');
    }
    if (o.kind === 'reach') {
      const z = m.zones.find((x) => x.id === o.zone);
      const there = s.ships.filter((x) => fighting(m, x) && !x.destroyed && hasTag(x, o.tag) && z && inZone(z, x.pose)).length;
      if (there > o.progress) setProgress(s, o, Math.min(there, o.of), there >= o.of ? 'done' : 'open');
    }
  }
}

function afterDestroyed(s: GameState, sh: ShipState) {
  const m = s.mission!;
  for (const tag of sh.tags ?? []) fire(s, (t) => 'shipDestroyed' in t.on && t.on.shipDestroyed === tag);
  for (const o of m.objectives) {
    if (o.status !== 'open') continue;
    if (o.kind === 'protect' && mine(m, sh) && hasTag(sh, o.tag)) setProgress(s, o, 0, 'failed');
    if (o.kind === 'destroy' && !mine(m, sh)) {
      const targets = s.ships.filter((x) => !mine(m, x) && hasTag(x, o.tag));
      const down = targets.filter((x) => x.destroyed).length;
      o.of = targets.length;
      setProgress(s, o, down, down >= targets.length ? 'done' : 'open');
    }
  }
}

/** Read the events logged since the last scan and move the mission on (objectives, messages, the result). */
export function missionScan(s: GameState) {
  const m = s.mission;
  if (!m || m.result) return;
  const from = m.scanned, end = s.log.length; // events this pushes are not scanned again
  m.scanned = end;
  const ship = (id: string) => s.ships.find((x) => x.id === id);
  const firstFor = (id: string | undefined, what: string) => {
    const sh = id ? ship(id) : undefined;
    if (sh && mine(m, sh)) fire(s, (t) => 'first' in t.on && t.on.first === what);
  };
  for (let i = from; i < end && !m.result; i++) {
    const e: GameEvent = s.log[i];
    if (e.type === 'roundStart') fire(s, (t) => 'roundStart' in t.on && t.on.roundStart === e.round);
    if (e.type === 'stress' && e.delta > 0) firstFor(e.shipId, 'stress');
    if (e.type === 'damageCard' && e.what === 'dealt') firstFor(e.shipId, 'damageCard');
    if (e.type === 'obstacleHit') firstFor(e.shipId, 'obstacleHit');
    if (e.type === 'attack') {
      firstFor(e.attackerId, 'attack');
      if (e.shieldDamage + e.hullDamage > 0) firstFor(e.attackerId, 'hit');
    }
    if (e.type === 'action' && e.action.type === 'lock') firstFor(e.shipId, 'lock');
    if (e.type === 'moved') { const sh = ship(e.shipId); if (sh && fighting(m, sh)) afterMove(s, sh, [...e.path, e.final]); }
    if (e.type === 'action' && (e.action.type === 'barrelRoll' || e.action.type === 'boost')) {
      const sh = ship(e.shipId);
      if (sh && fighting(m, sh)) afterMove(s, sh, [e.action.to]);
    }
    if (e.type === 'destroyed') { const sh = ship(e.shipId); if (sh) afterDestroyed(s, sh); }
    checkResult(s);
  }
}

/**
 * End of a round in a mission: `survive` objectives tick, the result is checked, and the mission is lost
 * once its last round ends unwon. True if the mission is over.
 */
export function missionRoundEnd(s: GameState): boolean {
  const m = s.mission!;
  missionScan(s); // catch up first: ships destroyed this round count before the round is judged
  if (m.result) return true;
  for (const o of m.objectives) {
    if (o.kind !== 'survive' || o.status !== 'open') continue;
    const alive = s.ships.some((x) => fighting(m, x) && !x.destroyed && hasTag(x, o.tag));
    if (alive) setProgress(s, o, Math.min(s.round, o.rounds), s.round >= o.rounds ? 'done' : 'open');
  }
  checkResult(s);
  // The round limit doesn't cut the recovery phase short: the pods' life support is its clock.
  if (!m.result && !m.recovery && s.round >= m.maxRounds) endMission(s, 'loss');
  return !!m.result;
}
