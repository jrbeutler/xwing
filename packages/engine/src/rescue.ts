// Ejection and rescue (docs/MISSIONS.md, "Ejection, the medic ship and rescue"). In a campaign mission the
// player's side has a medic ship. When a roster pilot's ship is destroyed they eject: an escape pod lands where
// the ship was, with POD_LIFE rounds of life support. The medic takes pods aboard with the Recover action;
// pods that run out are lost, and pods still out when the mission is lost are captured.
import { RANGE_RULES, shipPolygon } from './combat';
import { polygonDistance } from './geometry';
import type { GameState, Pod, PlayerId, ShipState } from './types';

/** The medic ship carries this tag. */
export const MEDIC_TAG = 'medic';
/** Rounds of life support after the round a pilot ejects. */
export const POD_LIFE = 3;

export const isMedic = (sh: Pick<ShipState, 'tags'>) => !!sh.tags?.includes(MEDIC_TAG);

/** Pods still waiting on the table. */
export const podsOut = (s: GameState, owner?: PlayerId) => (s.pods ?? []).filter((p) => p.status === 'out' && (!owner || p.owner === owner));

/** Rounds of life support a pod has left, this one included (1 = it is lost at the end of this round). */
export const podRoundsLeft = (s: Pick<GameState, 'round'>, p: Pod) => p.round + POD_LIFE - s.round + 1;

/** The player's medic, if it is still on the table. */
export const activeMedic = (s: GameState, owner: PlayerId) => s.ships.find((x) => x.owner === owner && isMedic(x) && !x.destroyed);

/** Pods the medic could take aboard now: its own side's, at range 0-1 of its base. */
export function recoverablePods(s: GameState, sh: ShipState): Pod[] {
  if (!isMedic(sh)) return [];
  const poly = shipPolygon(sh);
  return podsOut(s, sh.owner).filter((p) => polygonDistance(poly, [{ x: p.x, y: p.y }]).d <= RANGE_RULES.edges[0]);
}

const event = (s: GameState, what: 'ejected' | 'recovered' | 'lost' | 'captured', pod: Pod, by?: string) =>
  s.log.push({ type: 'pod', what, pod: { ...pod }, ...(by ? { by } : {}) });

/**
 * A ship of the player's was destroyed in a rescue mission: its pilot ejects (roster pilots only). A destroyed
 * medic drops the pilots it was carrying back onto the table, their life support starting over.
 */
export function shipDown(s: GameState, sh: ShipState) {
  const m = s.mission;
  if (!m?.rescue || sh.owner !== m.player || sh.fled) return; // a retreat takes its pilot (and passengers) home
  s.pods ??= [];
  if (isMedic(sh)) {
    for (const p of s.pods.filter((x) => x.status === 'aboard' && x.carrierId === sh.id)) {
      Object.assign(p, { status: 'out', x: sh.pose.x, y: sh.pose.y, round: s.round });
      delete p.carrierId;
      event(s, 'ejected', p);
    }
    return;
  }
  if (!sh.rosterId) return;
  const pod: Pod = { id: `pod-${s.pods.length + 1}`, shipId: sh.id, name: sh.name, rosterId: sh.rosterId, owner: sh.owner, x: sh.pose.x, y: sh.pose.y, round: s.round, status: 'out' };
  s.pods.push(pod);
  event(s, 'ejected', pod);
}

/** The Recover action: the pod is aboard and safe (unless the medic is destroyed before the end). */
export function recoverPod(s: GameState, sh: ShipState, podId: string) {
  const p = (s.pods ?? []).find((x) => x.id === podId);
  if (!p || p.status !== 'out') return;
  p.status = 'aboard';
  p.carrierId = sh.id;
  event(s, 'recovered', p, sh.id);
}

/** End of a round: pods whose life support has run out are lost. */
export function expirePods(s: GameState) {
  for (const p of podsOut(s)) if (podRoundsLeft(s, p) <= 1) { p.status = 'lost'; event(s, 'lost', p); }
}

/** The mission was lost: every pod still out is captured. */
export function capturePods(s: GameState) {
  for (const p of podsOut(s)) { p.status = 'captured'; event(s, 'captured', p); }
}

/**
 * The player won: if pods are still out and the medic can reach them, the recovery phase begins (the enemy's
 * remaining ships withdraw, the medic picks up what it can). True while the mission should go on.
 */
export function holdForRecovery(s: GameState): boolean {
  const m = s.mission;
  if (!m?.rescue || !podsOut(s, m.player).length || !activeMedic(s, m.player)) return false;
  if (!m.recovery) {
    m.recovery = true;
    const withdrawn = s.ships.filter((x) => x.owner !== m.player && !x.destroyed);
    for (const x of withdrawn) { x.withdrawn = true; x.destroyed = true; x.removed = true; x.lock = null; }
    for (const x of s.ships) if (x.lock && withdrawn.some((w) => w.id === x.lock)) x.lock = null;
    s.log.push({ type: 'recovery', withdrawn: withdrawn.map((x) => x.id) });
  }
  return true;
}
