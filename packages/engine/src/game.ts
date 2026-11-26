import { Pose, basePolygon, convexHull, normalizeAngle, polygonDistance, polygonsOverlap, toWorld, vec } from './geometry';
import { BOARD_SIZE, Maneuver, maneuverFinalPose, maneuverPath, RANGE_BAND, STRAIGHT_UNIT } from './maneuvers';
import { OBSTACLE_RULES, PILOTS, SHIP_TYPES, UPGRADES } from './content';
import { cardDamage, upgradeOf, legalTargets, maxRangeBand, measureArc, rangeBetween, resolveAttack, rollAttack, shipPolygon, shipSize, shipType, sufferDamage } from './combat';
import { gainToken, recoverRecurringCharges, runTriggers, statBonus } from './effects';
import { actionAllowed, discardCard, effectiveManeuver, hasCard, newDamageDeck, repairableCards } from './damage';
import { nextFloat } from './rng';
import { allUpgrades, effectiveInitiative, hullOf } from './squad';
import type {
  ActionChoice, ActionType, Command, Decision, Device, DropChoice, GameState, GreenToken, Obstacle, ObstacleKind, Player, PlayerId, ShipState,
} from './types';

/** A pilot, the hull they fly (default: their usual one), where it starts, and bought upgrades. */
export interface SquadEntry { pilotId: string; shipType?: string; pose: Pose; upgrades?: string[] }
export interface GameSetup {
  seed: number;
  players: [Player, Player];
  squads: Record<PlayerId, SquadEntry[]>;
  obstacles?: Obstacle[];
  maxRounds?: number;
}

const clone = <T>(x: T): T => structuredClone(x);
const ship = (s: GameState, id: string) => {
  const r = s.ships.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown ship ${id}`);
  return r;
};

export function createGame(setup: GameSetup): GameState {
  const state: GameState = {
    version: 1, rng: setup.seed | 0, round: 0, maxRounds: setup.maxRounds ?? 12, phase: 'planning',
    players: setup.players, firstPlayer: setup.players[0].id, ships: [], obstacles: setup.obstacles ?? [],
    queue: [], queueIndex: 0, engagementInitiative: null, pending: null, log: [], winner: null, devices: [],
    damageDeck: [], damageDiscard: [],
  };
  state.damageDeck = newDamageDeck(state); // shuffled with the game's own RNG
  const fielded = new Map<string, number>(); // generic pilots flown more than once get numbered
  for (const p of setup.players) {
    setup.squads[p.id].forEach((e, i) => {
      const pilot = PILOTS[e.pilotId];
      const t = SHIP_TYPES[hullOf(e)];
      // Signature talents come with the pilot; they take talent slots ahead of bought upgrades.
      const ups = allUpgrades({ ...e, upgrades: e.upgrades ?? [] }).map((id) => UPGRADES[id]);
      const payload = statBonus(ups.map((u) => u.id), 'deviceCharges');
      const hull = t.hull + ups.reduce((a, u) => a + (u.stats?.hull ?? 0), 0);
      const shields = t.shields + ups.reduce((a, u) => a + (u.stats?.shields ?? 0), 0);
      const n = (fielded.get(pilot.id) ?? 0) + 1;
      fielded.set(pilot.id, n);
      state.ships.push({
        id: `${p.id}-${i}`, pilotId: pilot.id, name: n > 1 ? `${pilot.name} #${n}` : pilot.name, typeId: t.id, owner: p.id,
        initiative: effectiveInitiative(e), pose: e.pose, hull, shields, maxHull: hull, maxShields: shields,
        upgrades: ups.map((u) => ({ id: u.id, charges: (u.charges ?? 0) + (u.device ? payload : 0) })),
        ability: pilot.ability ? { id: pilot.id, charges: pilot.ability.charges ?? 0 } : null,
        stress: 0, focus: 0, evade: 0, calculate: 0, reinforce: null, disarmed: false, lock: null, jam: 0, ion: 0, turretArc: 'front', crits: [], dial: null, destroyed: false, removed: false,
      });
    });
  }
  startRound(state);
  return state;
}

/** How many obstacles of each kind a random board gets (generateObstacles). */
export const DEFAULT_OBSTACLE_MIX: Record<ObstacleKind, number> = { asteroid: 3, debris: 2, gas: 1 };

/**
 * A random board: `mix` obstacles of each kind in the middle of the table, kept apart from each other.
 * Asteroids are rocky blobs, debris fields long and thin, gas clouds big and round. Same seed, same board.
 */
export function generateObstacles(seedState: { rng: number }, mix: Partial<Record<ObstacleKind, number>> = DEFAULT_OBSTACLE_MIX): Obstacle[] {
  const shape: Record<ObstacleKind, { r: [number, number]; stretch: [number, number]; points: number; jag: number }> = {
    asteroid: { r: [28, 50], stretch: [1, 1], points: 8, jag: 0.35 },
    debris: { r: [45, 65], stretch: [0.35, 0.5], points: 10, jag: 0.25 },
    gas: { r: [50, 70], stretch: [0.8, 1], points: 12, jag: 0.15 },
  };
  const order = (Object.keys(mix) as ObstacleKind[]).flatMap((k) => Array<ObstacleKind>(mix[k] ?? 0).fill(k));
  const out: (Obstacle & { c: { x: number; y: number }; r: number })[] = [];
  for (const kind of order) {
    const sh = shape[kind];
    for (let tries = 0; tries < 300; tries++) {
      const r = sh.r[0] + nextFloat(seedState) * (sh.r[1] - sh.r[0]);
      const cx = 160 + nextFloat(seedState) * (BOARD_SIZE - 320);
      const cy = 230 + nextFloat(seedState) * (BOARD_SIZE - 460);
      const stretch = sh.stretch[0] + nextFloat(seedState) * (sh.stretch[1] - sh.stretch[0]);
      const turn = nextFloat(seedState) * Math.PI;
      const pts = Array.from({ length: sh.points }, (_, i) => {
        const a = (i / sh.points) * Math.PI * 2 + nextFloat(seedState) * 0.4;
        const rr = r * (1 - sh.jag / 2 + nextFloat(seedState) * sh.jag);
        const lx = Math.cos(a) * rr, ly = Math.sin(a) * rr * stretch;
        return vec(cx + lx * Math.cos(turn) - ly * Math.sin(turn), cy + lx * Math.sin(turn) + ly * Math.cos(turn));
      });
      // Keep a ship's width (and then some) between obstacles so there is always a way through.
      if (out.some((o) => Math.hypot(o.c.x - cx, o.c.y - cy) < o.r + r + 70)) continue;
      out.push({ id: `${kind}-${out.length}`, kind, polygon: convexHull(pts), c: { x: cx, y: cy }, r });
      break;
    }
  }
  return out.map(({ id, kind, polygon }) => ({ id, kind, polygon }));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const activeShips = (s: GameState) => s.ships.filter((x) => !x.destroyed);

/** A ship's dial entry as it must fly it now (damage cards can make it harder). */
export const maneuverFor = (sh: ShipState, dialIndex: number): Maneuver => effectiveManeuver(sh, shipType(sh).dial[dialIndex]);

/** Whether a ship carries a turret weapon (and so has the Rotate action and a turret arc). */
export const hasTurret = (sh: ShipState) =>
  shipType(sh).primaries.some((w) => w.arc === 'turret') || sh.upgrades.some((u) => UPGRADES[u.id].weapon?.arc === 'turret');

/** Ion tokens it takes to ionize a ship: 1 small, 2 medium, 3 large. */
export const ionThreshold = (sh: ShipState) => ({ small: 1, medium: 2, large: 3 })[shipType(sh).size];
export const isIonized = (sh: ShipState) => sh.ion >= ionThreshold(sh);

/** The white 1-straight an ionized ship flies instead of its dial. */
export const ION_MANEUVER: Maneuver = { bearing: 'straight', speed: 1, difficulty: 'white' };

/** Dial indices a ship may select this round (stressed ships cannot pick red). */
export function legalDial(s: GameState, sh: ShipState): number[] {
  return shipType(sh).dial.map((_, i) => (sh.stress > 0 && maneuverFor(sh, i).difficulty === 'red' ? -1 : i)).filter((i) => i >= 0);
}

export function inBounds(poly: { x: number; y: number }[]): boolean {
  return poly.every((p) => p.x >= 0 && p.x <= BOARD_SIZE && p.y >= 0 && p.y <= BOARD_SIZE);
}

function overlapsShips(s: GameState, sh: ShipState, pose: Pose): string[] {
  const poly = shipPolygon(sh, pose);
  return activeShips(s).filter((o) => o.id !== sh.id && polygonsOverlap(poly, shipPolygon(o))).map((o) => o.id);
}
function overlapsObstacles(s: GameState, sh: ShipState, poses: Pose[]): string[] {
  const hit = new Set<string>();
  for (const p of poses) {
    const poly = shipPolygon(sh, p);
    for (const o of s.obstacles) if (polygonsOverlap(poly, o.polygon)) hit.add(o.id);
  }
  return [...hit];
}

/** Resolve a maneuver against the table: bumps, obstacles, fleeing. Pure (does not mutate). */
export function resolveMovement(s: GameState, sh: ShipState, m: Maneuver) {
  const { path, finalRotation } = maneuverPath(sh.pose, shipSize(sh), m);
  const full = { ...path[path.length - 1], h: normalizeAngle(path[path.length - 1].h + finalRotation) };
  let final = full;
  let endIndex = path.length - 1;
  let partial = false;
  let bumped = overlapsShips(s, sh, full);
  if (bumped.length) {
    partial = true;
    endIndex = 0;
    for (let i = path.length - 2; i >= 0; i--) {
      const hit = overlapsShips(s, sh, path[i]);
      if (!hit.length) { endIndex = i; break; }
      bumped = hit;
    }
    final = path[endIndex];
  }
  const travelled = path.slice(0, endIndex + 1);
  const obstacles = overlapsObstacles(s, sh, travelled.concat([final]));
  const fled = !inBounds(shipPolygon(sh, final));
  const shown = partial ? travelled : path.concat([full]);
  return { path: downsample(shown, 24), final, partial, bumped, obstacles, fled };
}

function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i / (n - 1)) * (xs.length - 1))]);
}

/**
 * `ionized`: the ship just flew an ion maneuver, which leaves it only the Focus action.
 * `coordinated`: it is acting because another ship coordinated it, so it cannot coordinate in turn.
 */
export function actionOptions(s: GameState, sh: ShipState, ionized = false, coordinated = false): ActionChoice[] {
  const opts: ActionChoice[] = [{ type: 'none' }];
  for (const a of shipType(sh).actions) {
    if (!actionAllowed(sh, a.type) || (ionized && a.type !== 'focus')) continue;
    if (a.type === 'focus') opts.push({ type: 'focus' });
    if (a.type === 'evade') opts.push({ type: 'evade' });
    if (a.type === 'calculate') opts.push({ type: 'calculate' });
    if (a.type === 'reinforce') for (const side of ['front', 'rear'] as const) if (sh.reinforce !== side) opts.push({ type: 'reinforce', side });
    if (a.type === 'reload') for (const u of reloadable(sh)) opts.push({ type: 'reload', upgrade: u.id });
    if (a.type === 'coordinate' && !coordinated) for (const t of coordinateTargets(s, sh)) opts.push({ type: 'coordinate', targetId: t.id });
    if (a.type === 'lock') {
      for (const t of activeShips(s)) {
        if (t.owner === sh.owner || sh.lock === t.id) continue;
        const r = rangeBetween(sh, t);
        if (r !== null && r <= maxRangeBand()) opts.push({ type: 'lock', targetId: t.id });
      }
    }
    if (a.type === 'barrelRoll') {
      const size = shipSize(sh);
      const lateral = size + STRAIGHT_UNIT;
      const slide = size / 2 - 10;
      for (const dir of ['left', 'right'] as const) {
        for (const shift of [-1, 0, 1] as const) {
          const to = { ...toWorld(sh.pose, vec(shift * slide, (dir === 'left' ? 1 : -1) * lateral)), h: sh.pose.h };
          const sweep = [sh.pose, to];
          if (!overlapsShips(s, sh, to).length && !overlapsObstacles(s, sh, sweep).length && inBounds(shipPolygon(sh, to))) {
            opts.push({ type: 'barrelRoll', dir, shift, to });
          }
        }
      }
    }
    if (a.type === 'boost') {
      for (const bearing of ['straight', 'bankLeft', 'bankRight'] as const) {
        const m: Maneuver = { bearing, speed: 1, difficulty: 'white' };
        const { path } = maneuverPath(sh.pose, shipSize(sh), m);
        const to = maneuverFinalPose(sh.pose, shipSize(sh), m);
        if (!overlapsShips(s, sh, to).length && !overlapsObstacles(s, sh, path).length && inBounds(shipPolygon(sh, to))) {
          opts.push({ type: 'boost', bearing, to });
        }
      }
    }
  }
  // Jam: an enemy at range 1-2 inside one of this ship's firing arcs (a turret's included).
  if (!ionized && shipType(sh).actions.some((a) => a.type === 'jam') && actionAllowed(sh, 'jam')) {
    for (const t of jamTargets(s, sh)) opts.push({ type: 'jam', targetId: t.id });
  }
  // A turret upgrade adds the Rotate action: turn the turret arc to face another way.
  if (!ionized && hasTurret(sh) && actionAllowed(sh, 'rotateArc')) {
    for (const to of ['front', 'left', 'right', 'rear'] as const) if (to !== sh.turretArc) opts.push({ type: 'rotateArc', to });
  }
  if (!ionized) for (const card of repairableCards(sh)) opts.push({ type: 'repair', card });
  return opts;
}

/** Charges an upgrade starts the battle with (devices get the ship's bonus, e.g. Payload Expert). */
export const startingCharges = (sh: ShipState, id: string) =>
  (UPGRADES[id].charges ?? 0) + (UPGRADES[id].device ? statBonus(sh, 'deviceCharges') : 0);

/** Missiles, torpedoes and devices the Reload action could recover a charge on (each listed once). */
export function reloadable(sh: ShipState) {
  const seen = new Set<string>();
  return sh.upgrades.filter((u) => {
    const def = UPGRADES[u.id];
    const ordnance = (def.weapon && def.weapon.arc !== 'turret' && def.charges !== undefined) || def.device;
    if (!ordnance || u.charges >= startingCharges(sh, u.id) || seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });
}

/** The action-bar entry for an action type, if the ship has one. */
const actionDef = (sh: ShipState, type: ActionChoice['type']) => shipType(sh).actions.find((x) => x.type === type);

/**
 * The linked action a ship may perform after `done`, as a pending decision, or null. A linked action is
 * allowed even if the first action left the ship stressed (a red first action), but not after an ion maneuver.
 */
function linkedDecision(s: GameState, sh: ShipState, done: ActionChoice): Extract<Decision, { kind: 'action' }> | null {
  // Coordinate hands the turn to the coordinated ship instead; it has no link of its own.
  const link = done.type === 'none' || done.type === 'coordinate' ? undefined : actionDef(sh, done.type)?.linked;
  if (!link || sh.destroyed || !actionAllowed(sh, link.type)) return null;
  const options = actionOptions(s, sh).filter((o) => o.type === link.type);
  if (!options.length) return null;
  return { kind: 'action', playerId: sh.owner, shipId: sh.id, options: [{ type: 'none' }, ...options], linked: { from: done.type as ActionType, red: !!link.red } };
}

/** Range limit of Coordinate. */
export const COORDINATE_RANGE = 2;

/** The actions a coordinated ship may take: what it could do now, except Coordinate (no chains). */
export const coordinatedOptions = (s: GameState, t: ShipState) => actionOptions(s, t, isIonized(t), true);

/** Friendly ships at range 0-2 that could act if coordinated: not stressed, and with an action to take. */
export function coordinateTargets(s: GameState, sh: ShipState): ShipState[] {
  return activeShips(s).filter((t) => {
    if (t.owner !== sh.owner || t.id === sh.id || t.stress > 0) return false;
    const r = rangeBetween(sh, t);
    return r !== null && r <= COORDINATE_RANGE && coordinatedOptions(s, t).length > 1;
  });
}

/** The decision for a ship coordinated by `by`: its options (plus none). */
function coordinateDecision(s: GameState, t: ShipState, by: ShipState): Decision {
  const ionized = isIonized(t);
  return { kind: 'action', playerId: t.owner, shipId: t.id, options: coordinatedOptions(s, t), coordinated: { by: by.id }, ...(ionized ? { ionized } : {}) };
}

/** Hide information a given player should not see (opponent dials, RNG state). */
export function viewFor(s: GameState, playerId: PlayerId): GameState {
  const v = clone(s);
  v.rng = 0;
  v.damageDeck.sort(); // contents are public, order is not
  if (v.phase === 'planning') for (const sh of v.ships) if (sh.owner !== playerId) sh.dial = null;
  return v;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function apply(prev: GameState, cmd: Command): GameState {
  // Events are immutable once logged, so the log is shared structurally, not deep-cloned.
  const s = clone({ ...prev, log: [] as GameState['log'] });
  s.log = prev.log.slice();
  const d = s.pending;
  if (!d) throw new Error('Game is not waiting for input');

  if (cmd.type === 'setDials') {
    if (d.kind !== 'planning' || !d.waitingOn.includes(cmd.playerId)) throw new Error('Not expecting dials from this player');
    for (const sh of activeShips(s).filter((x) => x.owner === cmd.playerId)) {
      const idx = cmd.dials[sh.id];
      if (idx === undefined || !legalDial(s, sh).includes(idx)) throw new Error(`Illegal dial for ${sh.id}`);
      sh.dial = idx;
    }
    d.waitingOn = d.waitingOn.filter((p) => p !== cmd.playerId);
    if (d.waitingOn.length === 0) {
      s.pending = null;
      beginSystem(s);
    }
    return s;
  }

  if (cmd.type === 'drop') {
    if (d.kind !== 'system' || d.playerId !== cmd.playerId) throw new Error('Not expecting a drop');
    if (!d.options.some((o) => JSON.stringify(o) === JSON.stringify(cmd.choice))) throw new Error('Illegal drop');
    if (cmd.choice.type === 'drop') dropDevice(s, ship(s, d.shipId), cmd.choice.upgrade, cmd.choice.pose);
    s.pending = null;
    s.queueIndex++;
    continueSystem(s);
    return s;
  }

  if (cmd.type === 'action') {
    if (d.kind !== 'action' || d.playerId !== cmd.playerId) throw new Error('Not expecting an action');
    const legal = d.options.some((o) => JSON.stringify(o) === JSON.stringify(cmd.choice));
    if (!legal) throw new Error('Illegal action');
    const sh = ship(s, d.shipId);
    performAction(s, sh, cmd.choice, d.linked ? d.linked.red : !!actionDef(sh, cmd.choice.type)?.red, !!d.linked, d.coordinated?.by);
    // What comes next before the activation moves on: the linked action (a coordinated ship gets its link
    // too), or the ship this one just coordinated. Coordinated ships cannot coordinate again.
    const link = d.linked || d.ionized ? null : linkedDecision(s, sh, cmd.choice);
    let next: Decision | null = link && d.coordinated ? { ...link, coordinated: d.coordinated } : link;
    if (!next && cmd.choice.type === 'coordinate') next = coordinateDecision(s, ship(s, cmd.choice.targetId), sh);
    s.pending = next;
    if (s.pending) return s;
    s.queueIndex++;
    continueActivation(s);
    return s;
  }

  if (cmd.type === 'attack') {
    if (d.kind !== 'attack' || d.playerId !== cmd.playerId) throw new Error('Not expecting an attack');
    const attacker = ship(s, d.shipId);
    if (cmd.targetId !== null) {
      const want = cmd.weapon && cmd.weapon !== 'primary' ? cmd.weapon : undefined;
      const t = d.targets.find((x) => x.targetId === cmd.targetId && (x.weapon ?? undefined) === want);
      if (!t) throw new Error('Illegal target');
      const defender = ship(s, t.targetId);
      const mark = s.log.length;
      const r = resolveAttack(s, attacker, defender, t);
      const cards = s.log.splice(mark); // damage cards the shot dealt are logged after the shot itself
      s.log.push({ type: 'attack', attackerId: attacker.id, defenderId: defender.id, arc: t.arc, range: t.range, obstructed: t.obstructed, ...r }, ...cards);
      if (defender.hull <= 0) destroy(s, defender);
    }
    s.pending = null;
    s.queueIndex++;
    continueEngagement(s);
    return s;
  }
  throw new Error('Unknown command');
}

function destroy(s: GameState, sh: ShipState) {
  if (sh.destroyed) return;
  sh.destroyed = true;
  sh.lock = null;
  for (const o of s.ships) if (o.lock === sh.id) o.lock = null;
  s.log.push({ type: 'destroyed', shipId: sh.id });
}

function initiativeOrder(s: GameState, ascending: boolean): string[] {
  return [...activeShips(s)]
    .sort((a, b) => {
      if (a.initiative !== b.initiative) return ascending ? a.initiative - b.initiative : b.initiative - a.initiative;
      const fa = a.owner === s.firstPlayer ? 0 : 1, fb = b.owner === s.firstPlayer ? 0 : 1;
      return fa - fb || a.id.localeCompare(b.id);
    })
    .map((x) => x.id);
}

function startRound(s: GameState) {
  s.round++;
  s.phase = 'planning';
  s.log.push({ type: 'roundStart', round: s.round }, { type: 'phase', phase: 'planning' });
  for (const sh of s.ships) sh.dial = null;
  const waiting = s.players.map((p) => p.id).filter((p) => activeShips(s).some((x) => x.owner === p));
  s.pending = { kind: 'planning', waitingOn: waiting };
}

// ---------------------------------------------------------------------------
// System phase: ships with bombs or mines may drop one (lowest initiative first).
// ---------------------------------------------------------------------------

/** Device tokens are about the size of the real ones; drops use the 1-straight template. */
export const DEVICE_SIZE = 30;
export const devicePolygon = (d: { pose: Pose }) => basePolygon(d.pose, DEVICE_SIZE);

/** Where a dropped device lands: one straight template (40 mm) behind the ship's rear edge. */
export function dropPose(sh: ShipState): Pose {
  const back = shipSize(sh) / 2 + STRAIGHT_UNIT + DEVICE_SIZE / 2;
  return { x: sh.pose.x - Math.cos(sh.pose.h) * back, y: sh.pose.y - Math.sin(sh.pose.h) * back, h: sh.pose.h };
}

/** The drops a ship may make now: each loaded device, if its token would land on the table. */
export function dropOptions(s: GameState, sh: ShipState): DropChoice[] {
  const opts: DropChoice[] = [{ type: 'none' }];
  const pose = dropPose(sh);
  if (!inBounds(devicePolygon({ pose }))) return opts;
  const seen = new Set<string>();
  for (const u of sh.upgrades) {
    if (!UPGRADES[u.id].device || u.charges <= 0 || seen.has(u.id)) continue;
    seen.add(u.id);
    opts.push({ type: 'drop', upgrade: u.id, pose });
  }
  return opts;
}

function beginSystem(s: GameState) {
  s.phase = 'system';
  s.log.push({ type: 'phase', phase: 'system' });
  s.queue = initiativeOrder(s, true);
  s.queueIndex = 0;
  continueSystem(s);
}

function continueSystem(s: GameState) {
  while (s.queueIndex < s.queue.length) {
    const sh = ship(s, s.queue[s.queueIndex]);
    const options = sh.destroyed ? [] : dropOptions(s, sh);
    if (options.length > 1) {
      s.pending = { kind: 'system', playerId: sh.owner, shipId: sh.id, options };
      return;
    }
    s.queueIndex++;
  }
  beginActivation(s);
}

function dropDevice(s: GameState, sh: ShipState, upgrade: string, pose: Pose) {
  const u = upgradeOf(sh, upgrade);
  if (!u) return;
  u.charges--;
  const device: Device = { id: `dev-${s.round}-${s.devices.length}-${sh.id}`, upgrade, owner: sh.owner, kind: UPGRADES[upgrade].device!.kind, pose };
  s.devices.push(device);
  s.log.push({ type: 'deviceDropped', shipId: sh.id, device });
}

/** Ships within range 0-1 of a device token. */
const inBlast = (s: GameState, d: Device) =>
  activeShips(s).filter((x) => polygonDistance(devicePolygon(d), shipPolygon(x)).d <= RANGE_BAND);

/** Set a device off against `victims`; it leaves the table. Damage cards it deals are logged after it. */
function detonate(s: GameState, d: Device, victims: ShipState[]) {
  s.devices = s.devices.filter((x) => x.id !== d.id);
  const effect = UPGRADES[d.upgrade].device!.effect;
  const mark = s.log.length;
  const hits = victims.map((v) => {
    if (effect === 'ion') { v.ion += 3; return { shipId: v.id, shieldDamage: 0, hullDamage: 0, ion: 3 }; }
    if (effect === 'proton') return { shipId: v.id, ...sufferDamage(s, v, 0, 1) };
    const roll = rollAttack(s, 2);
    return { shipId: v.id, ...sufferDamage(s, v, roll.filter((f) => f === 'hit').length, roll.filter((f) => f === 'crit').length), roll };
  });
  const cards = s.log.splice(mark);
  s.log.push({ type: 'deviceDetonated', device: d, ships: hits }, ...cards);
  for (const v of victims) if (v.hull <= 0) destroy(s, v);
}

/** Mines a ship touches anywhere along `poses` detonate on it. */
function triggerMines(s: GameState, sh: ShipState, poses: Pose[]) {
  for (const d of s.devices.filter((x) => x.kind === 'mine')) {
    if (sh.destroyed) return;
    if (poses.some((p) => polygonsOverlap(shipPolygon(sh, p), devicePolygon(d)))) detonate(s, d, [sh]);
  }
}

function beginActivation(s: GameState) {
  s.phase = 'activation';
  s.log.push({ type: 'phase', phase: 'activation' });
  s.queue = initiativeOrder(s, true);
  s.queueIndex = 0;
  continueActivation(s);
}

function continueActivation(s: GameState) {
  while (s.queueIndex < s.queue.length) {
    const sh = ship(s, s.queue[s.queueIndex]);
    if (sh.destroyed || sh.dial === null) { s.queueIndex++; continue; }
    const ionized = isIonized(sh);
    const m = ionized ? ION_MANEUVER : maneuverFor(sh, sh.dial);
    if (ionized) {
      sh.ion = 0;
      s.log.push({ type: 'info', text: `${sh.name} is ionized and drifts 1 straight.` });
    }
    s.log.push({ type: 'dialRevealed', shipId: sh.id, maneuver: m });
    const mv = resolveMovement(s, sh, m);
    sh.pose = mv.final;
    s.log.push({ type: 'moved', shipId: sh.id, path: mv.path, final: mv.final, partial: mv.partial, bumped: mv.bumped, obstacles: mv.obstacles, fled: mv.fled });

    if (m.difficulty === 'red') { sh.stress++; s.log.push({ type: 'stress', shipId: sh.id, delta: 1 }); }
    if (m.difficulty === 'red' && !mv.partial) afterRedManeuver(s, sh);
    if (m.difficulty === 'blue' && sh.stress > 0) { sh.stress--; s.log.push({ type: 'stress', shipId: sh.id, delta: -1 }); }
    // House rule: colliding with a ship costs stress on top of the lost action, so pilots keep their distance.
    if (mv.partial && mv.bumped.length) { sh.stress += BUMP_STRESS; s.log.push({ type: 'stress', shipId: sh.id, delta: BUMP_STRESS }); }

    if (mv.fled) {
      s.log.push({ type: 'info', text: `${sh.name} fled the battlefield.` });
      destroy(s, sh);
      s.queueIndex++;
      continue;
    }
    for (const oid of mv.obstacles) obstacleContact(s, sh, s.obstacles.find((o) => o.id === oid)!);
    afterManeuver(s, sh, m, mv.obstacles.length > 0, ionized);
    triggerMines(s, sh, [...mv.path, mv.final]);
    if (sh.hull <= 0 || sh.destroyed) { destroy(s, sh); s.queueIndex++; continue; }

    const skip = mv.obstacles.some((oid) => OBSTACLE_RULES[s.obstacles.find((o) => o.id === oid)!.kind].skipAction);
    const canAct = !mv.partial && !skip && sh.stress === 0;
    if (canAct) {
      const options = actionOptions(s, sh, ionized);
      if (options.length > 1) {
        s.pending = { kind: 'action', playerId: sh.owner, shipId: sh.id, options, ...(ionized ? { ionized } : {}) };
        return;
      }
    }
    s.queueIndex++;
  }
  // End of the Activation phase: every bomb on the table goes off.
  for (const d of s.devices.filter((x) => x.kind === 'bomb')) detonate(s, d, inBlast(s, d));
  beginEngagement(s);
}

/**
 * A ship moved through or onto an obstacle: stress first, then 1 attack die and what it deals (OBSTACLE_RULES).
 * Damage cards it deals are logged after the obstacle event.
 */
function obstacleContact(s: GameState, sh: ShipState, o: Obstacle) {
  const rule = OBSTACLE_RULES[o.kind];
  if (rule.stress) sh.stress += rule.stress;
  const [face] = rollAttack(s, 1);
  const ev: Extract<GameState['log'][number], { type: 'obstacleHit' }> = {
    type: 'obstacleHit', shipId: sh.id, obstacleId: o.id, kind: o.kind, result: face, shieldDamage: 0, hullDamage: 0,
    ...(rule.stress ? { stress: rule.stress } : {}),
  };
  s.log.push(ev);
  const hit = rule.hitOn.includes(face) ? 1 : 0, crit = rule.critOn.includes(face) ? 1 : 0;
  if (hit || crit) Object.assign(ev, sufferDamage(s, sh, hit, crit));
  if (rule.ionOn.includes(face)) { sh.ion++; ev.ion = 1; }
}

/** Effects that reward fully executing a red maneuver (Elusive, Hotshot). */
function afterRedManeuver(s: GameState, sh: ShipState) {
  runTriggers(s, sh, 'redManeuverExecuted');
}

/** Damage cards that react to the maneuver a ship just flew. */
function afterManeuver(s: GameState, sh: ShipState, m: Maneuver, touchedObstacle: boolean, ionManeuver: boolean) {
  if (touchedObstacle && hasCard(sh, 'stunnedPilot')) {
    const ev: Extract<GameState['log'][number], { type: 'damageCard' }> = { type: 'damageCard', shipId: sh.id, card: 'stunnedPilot', what: 'triggered' };
    s.log.push(ev);
    cardDamage(s, sh, ev, 1);
  }
  if (m.bearing !== 'straight' && hasCard(sh, 'looseStabilizer')) {
    const ev: Extract<GameState['log'][number], { type: 'damageCard' }> = { type: 'damageCard', shipId: sh.id, card: 'looseStabilizer', what: 'triggered' };
    s.log.push(ev);
    discardCard(s, sh, 'looseStabilizer');
    cardDamage(s, sh, ev, 1);
    s.log.push({ type: 'damageCard', shipId: sh.id, card: 'looseStabilizer', what: 'discarded' });
  }
  if (ionManeuver && hasCard(sh, 'disabledPowerRegulator')) {
    discardCard(s, sh, 'disabledPowerRegulator');
    s.log.push({ type: 'damageCard', shipId: sh.id, card: 'disabledPowerRegulator', what: 'discarded' });
  }
}

/** House rule: stress a ship gains when its maneuver ends in a bump. */
export const BUMP_STRESS = 1;

/** Range limit of the Jam action (inside one of the jammer's firing arcs). Signal Jammer adds 1. */
export const JAM_RANGE = 2;
export const jamRange = (sh: ShipState) => JAM_RANGE + statBonus(sh, 'jamRange');

/** Enemies this ship could jam: at range 1-2 (1-3 with Signal Jammer) inside any of its firing arcs, turret included. */
export function jamTargets(s: GameState, sh: ShipState): ShipState[] {
  return activeShips(s).filter((t) => t.owner !== sh.owner && shipType(sh).primaries.some((w) => {
    const m = measureArc(s, sh, t, w.arc === 'turret' ? sh.turretArc : w.arc);
    return m !== null && m.range <= jamRange(sh);
  }));
}

/**
 * Jam: the target loses its Focus token, else Evade, Calculate, Reinforce, else the lock it holds. With none
 * of those it takes a jam token instead (at most one), which cancels the next token it would gain.
 */
function jam(s: GameState, from: ShipState, t: ShipState) {
  let effect: GreenToken | 'lock' | 'jammed';
  if (t.focus > 0) { t.focus--; effect = 'focus'; }
  else if (t.evade > 0) { t.evade--; effect = 'evade'; }
  else if (t.calculate > 0) { t.calculate--; effect = 'calculate'; }
  else if (t.reinforce) { t.reinforce = null; effect = 'reinforce'; }
  else if (t.lock) { t.lock = null; effect = 'lock'; }
  else { t.jam = 1; effect = 'jammed'; }
  s.log.push({ type: 'jam', shipId: from.id, targetId: t.id, effect });
}

/** `red`: the action costs a stress (a red action, or a red linked action). */
function performAction(s: GameState, sh: ShipState, a: ActionChoice, red: boolean, linked = false, coordinatedBy?: string) {
  if (a.type === 'none') return;
  if (a.type === 'lock') sh.lock = a.targetId;
  if (a.type === 'barrelRoll' || a.type === 'boost') { const from = sh.pose; sh.pose = a.to; triggerMines(s, sh, [from, a.to]); }
  if (a.type === 'rotateArc') sh.turretArc = a.to;
  if (a.type === 'reload') { const u = sh.upgrades.find((x) => x.id === a.upgrade)!; u.charges++; sh.disarmed = true; }
  s.log.push({ type: 'action', shipId: sh.id, action: a, ...(linked ? { linked } : {}), ...(coordinatedBy ? { coordinatedBy } : {}) });
  if (a.type === 'focus' || a.type === 'evade' || a.type === 'calculate') gainToken(s, sh, a.type);
  if (a.type === 'reinforce') gainToken(s, sh, 'reinforce', a.side);
  if (a.type === 'jam') jam(s, sh, s.ships.find((x) => x.id === a.targetId)!);
  if (a.type === 'repair') {
    discardCard(s, sh, a.card);
    s.log.push({ type: 'damageCard', shipId: sh.id, card: a.card, what: 'repaired' });
  }
  if (red) { sh.stress++; s.log.push({ type: 'stress', shipId: sh.id, delta: 1 }); }
  runTriggers(s, sh, 'actionPerformed', { action: a.type });
  if (hasCard(sh, 'woundedPilot')) {
    const [roll] = rollAttack(s, 1);
    const hurt = roll === 'hit' || roll === 'crit';
    if (hurt) sh.stress++;
    s.log.push({ type: 'damageCard', shipId: sh.id, card: 'woundedPilot', what: 'triggered', roll, stress: hurt ? 1 : 0 });
  }
}

/** Damage cards that act just before a ship engages. */
function beforeEngage(s: GameState, sh: ShipState) {
  if (hasCard(sh, 'consoleFire')) {
    const [roll] = rollAttack(s, 1);
    const ev: Extract<GameState['log'][number], { type: 'damageCard' }> = { type: 'damageCard', shipId: sh.id, card: 'consoleFire', what: 'triggered', roll };
    s.log.push(ev);
    if (roll === 'hit') cardDamage(s, sh, ev, 1);
  }
  if (hasCard(sh, 'disabledPowerRegulator')) {
    sh.ion++;
    s.log.push({ type: 'damageCard', shipId: sh.id, card: 'disabledPowerRegulator', what: 'triggered', ion: 1 });
  }
  if (sh.hull <= 0) destroy(s, sh);
}

function beginEngagement(s: GameState) {
  s.phase = 'engagement';
  s.log.push({ type: 'phase', phase: 'engagement' });
  for (const x of s.ships) if (x.destroyed) x.removed = true;
  s.queue = initiativeOrder(s, false);
  s.queueIndex = 0;
  s.engagementInitiative = null;
  continueEngagement(s);
}

function continueEngagement(s: GameState) {
  while (s.queueIndex < s.queue.length) {
    const sh = ship(s, s.queue[s.queueIndex]);
    if (s.engagementInitiative !== null && sh.initiative !== s.engagementInitiative) {
      // Initiative step finished: ships destroyed during it are now removed.
      for (const x of s.ships) if (x.destroyed) x.removed = true;
    }
    s.engagementInitiative = sh.initiative;
    // A ship destroyed earlier in this same initiative step still fires (simultaneous fire).
    if (sh.removed) { s.queueIndex++; continue; }
    if (!sh.destroyed) beforeEngage(s, sh);
    const targets = legalTargets(s, sh);
    if (targets.length) {
      s.pending = { kind: 'attack', playerId: sh.owner, shipId: sh.id, targets };
      return;
    }
    s.queueIndex++;
  }
  endPhase(s);
}

function endPhase(s: GameState) {
  s.phase = 'end';
  s.log.push({ type: 'phase', phase: 'end' });
  for (const sh of s.ships) {
    if (sh.destroyed) sh.removed = true;
    if (!sh.destroyed) { runTriggers(s, sh, 'endPhase'); recoverRecurringCharges(s, sh); }
    sh.focus = 0;
    sh.evade = 0;
    sh.calculate = 0;
    sh.reinforce = null;
    sh.disarmed = false;
    sh.jam = 0;
  }
  s.engagementInitiative = null;
  const alive = s.players.filter((p) => activeShips(s).some((x) => x.owner === p.id));
  if (alive.length <= 1 || s.round >= s.maxRounds) {
    s.phase = 'over';
    if (alive.length === 1) s.winner = alive[0].id;
    else if (alive.length === 0) s.winner = 'draw';
    else {
      const score = (p: PlayerId) => activeShips(s).filter((x) => x.owner === p).reduce((a, x) => a + x.hull + x.shields, 0);
      const [a, b] = s.players.map((p) => score(p.id));
      s.winner = a === b ? 'draw' : a > b ? s.players[0].id : s.players[1].id;
    }
    s.pending = null;
    s.log.push({ type: 'gameOver', winner: s.winner });
    return;
  }
  startRound(s);
}

export function pendingFor(s: GameState, playerId: PlayerId): Decision | null {
  const d = s.pending;
  if (!d) return null;
  if (d.kind === 'planning') return d.waitingOn.includes(playerId) ? d : null;
  return d.playerId === playerId ? d : null;
}

/** A standard skirmish: the two placeholder squads facing each other across a random board. */
export function quickSkirmish(seed: number): GameState {
  const obstacles = generateObstacles({ rng: seed ^ 0x5eed });
  const h1 = Math.PI / 2, h2 = -Math.PI / 2;
  return createGame({
    seed,
    players: [
      { id: 'p1', name: 'Coalition', faction: 'coalition' },
      { id: 'p2', name: 'Syndicate', faction: 'syndicate' },
    ],
    squads: {
      p1: [
        { pilotId: 'mara-venn', pose: { x: 220, y: 70, h: h1 } },
        { pilotId: 'tobin-reyes', pose: { x: 377, y: 70, h: h1 } },
        { pilotId: 'bram-holloway', pose: { x: 537, y: 70, h: h1 } },
        { pilotId: 'ilse-kord', pose: { x: 694, y: 70, h: h1 } },
      ],
      p2: [
        { pilotId: 'syl-ketch', pose: { x: 220, y: 844, h: h2 } },
        { pilotId: 'drav-okono', pose: { x: 377, y: 834, h: h2 } },
        { pilotId: 'rook-twelve', pose: { x: 537, y: 844, h: h2 } },
        { pilotId: 'grunt-seven', pose: { x: 694, y: 844, h: h2 } },
      ],
    },
    obstacles,
  });
}
