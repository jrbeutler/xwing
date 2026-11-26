import { Pose, basePolygon, convexHull, normalizeAngle, polygonDistance, polygonsOverlap, toWorld, vec } from './geometry';
import { BOARD_SIZE, Maneuver, maneuverFinalPose, maneuverPath, RANGE_BAND, STRAIGHT_UNIT } from './maneuvers';
import { PILOTS, SHIP_TYPES, UPGRADES } from './content';
import { cardDamage, upgradeOf, legalTargets, maxRangeBand, measureArc, rangeBetween, resolveAttack, rollAttack, shipPolygon, shipSize, shipType, sufferDamage } from './combat';
import { actionAllowed, discardCard, effectiveManeuver, hasCard, newDamageDeck, repairableCards } from './damage';
import { nextFloat } from './rng';
import type {
  ActionChoice, Command, Decision, Device, DropChoice, GameState, Obstacle, Player, PlayerId, ShipState,
} from './types';

export interface SquadEntry { pilotId: string; pose: Pose; upgrades?: string[] }
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
    // Shuffled from its own seed so the dice sequence is unchanged by the deck.
    damageDeck: newDamageDeck({ rng: (setup.seed ^ 0xdec4) | 0 }), damageDiscard: [],
  };
  const fielded = new Map<string, number>(); // generic pilots flown more than once get numbered
  for (const p of setup.players) {
    setup.squads[p.id].forEach((e, i) => {
      const pilot = PILOTS[e.pilotId];
      const t = SHIP_TYPES[pilot.shipType];
      const ups = (e.upgrades ?? []).map((id) => UPGRADES[id]);
      const hull = t.hull + ups.reduce((a, u) => a + (u.stats?.hull ?? 0), 0);
      const shields = t.shields + ups.reduce((a, u) => a + (u.stats?.shields ?? 0), 0);
      const n = (fielded.get(pilot.id) ?? 0) + 1;
      fielded.set(pilot.id, n);
      state.ships.push({
        id: `${p.id}-${i}`, pilotId: pilot.id, name: n > 1 ? `${pilot.name} #${n}` : pilot.name, typeId: t.id, owner: p.id,
        initiative: pilot.initiative, pose: e.pose, hull, shields, maxHull: hull, maxShields: shields,
        upgrades: ups.map((u) => ({ id: u.id, charges: u.charges ?? 0 })),
        stress: 0, focus: 0, evade: 0, lock: null, jam: 0, ion: 0, turretArc: 'front', crits: [], dial: null, destroyed: false, removed: false,
      });
    });
  }
  startRound(state);
  return state;
}

/** Random convex asteroids in the middle of the board, kept apart from each other. */
export function generateAsteroids(seedState: { rng: number }, count = 5): Obstacle[] {
  const out: Obstacle[] = [];
  let tries = 0;
  while (out.length < count && tries++ < 500) {
    const cx = 200 + nextFloat(seedState) * (BOARD_SIZE - 400);
    const cy = 250 + nextFloat(seedState) * (BOARD_SIZE - 500);
    const r = 28 + nextFloat(seedState) * 22;
    const pts = Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2 + nextFloat(seedState) * 0.5;
      const rr = r * (0.75 + nextFloat(seedState) * 0.35);
      return vec(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    });
    const poly = convexHull(pts);
    const tooClose = out.some((o) => {
      const c = o.polygon.reduce((a, p) => ({ x: a.x + p.x / o.polygon.length, y: a.y + p.y / o.polygon.length }), { x: 0, y: 0 });
      return Math.hypot(c.x - cx, c.y - cy) < 150;
    });
    if (!tooClose) out.push({ id: `rock-${out.length}`, kind: 'asteroid', polygon: poly });
  }
  return out;
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

/** `ionized`: the ship just flew an ion maneuver, which leaves it only the Focus action. */
export function actionOptions(s: GameState, sh: ShipState, ionized = false): ActionChoice[] {
  const opts: ActionChoice[] = [{ type: 'none' }];
  for (const a of shipType(sh).actions) {
    if (!actionAllowed(sh, a.type) || (ionized && a.type !== 'focus')) continue;
    if (a.type === 'focus') opts.push({ type: 'focus' });
    if (a.type === 'evade') opts.push({ type: 'evade' });
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
    performAction(s, ship(s, d.shipId), cmd.choice);
    s.pending = null;
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
    for (const oid of mv.obstacles) {
      const [face] = rollAttack(s, 1);
      s.log.push({ type: 'obstacleHit', shipId: sh.id, obstacleId: oid, result: face });
      if (face === 'hit') sufferDamage(s, sh, 1, 0);
      if (face === 'crit') sufferDamage(s, sh, 0, 1);
    }
    afterManeuver(s, sh, m, mv.obstacles.length > 0, ionized);
    triggerMines(s, sh, [...mv.path, mv.final]);
    if (sh.hull <= 0 || sh.destroyed) { destroy(s, sh); s.queueIndex++; continue; }

    const canAct = !mv.partial && mv.obstacles.length === 0 && sh.stress === 0;
    if (canAct) {
      const options = actionOptions(s, sh, ionized);
      if (options.length > 1) {
        s.pending = { kind: 'action', playerId: sh.owner, shipId: sh.id, options };
        return;
      }
    }
    s.queueIndex++;
  }
  // End of the Activation phase: every bomb on the table goes off.
  for (const d of s.devices.filter((x) => x.kind === 'bomb')) detonate(s, d, inBlast(s, d));
  beginEngagement(s);
}

/** Talents that reward fully executing a red maneuver. */
function afterRedManeuver(s: GameState, sh: ShipState) {
  const elusive = upgradeOf(sh, 'elusive');
  if (elusive && elusive.charges < (UPGRADES.elusive.charges ?? 1)) {
    elusive.charges++;
    s.log.push({ type: 'upgrade', shipId: sh.id, upgrade: 'elusive', what: 'recovered' });
  }
  if (upgradeOf(sh, 'hotshot')) {
    s.log.push({ type: 'upgrade', shipId: sh.id, upgrade: 'hotshot', what: 'used' });
    gainToken(s, sh, 'focus');
  }
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

/** Range limit of the Jam action (inside one of the jammer's firing arcs). */
export const JAM_RANGE = 2;

/** Enemies this ship could jam: at range 1-2 (or touching) inside any of its firing arcs, turret included. */
export function jamTargets(s: GameState, sh: ShipState): ShipState[] {
  return activeShips(s).filter((t) => t.owner !== sh.owner && shipType(sh).primaries.some((w) => {
    const m = measureArc(s, sh, t, w.arc === 'turret' ? sh.turretArc : w.arc);
    return m !== null && m.range <= JAM_RANGE;
  }));
}

/** Give a ship a Focus or Evade token, unless a jam token cancels it. */
function gainToken(s: GameState, sh: ShipState, kind: 'focus' | 'evade') {
  if (sh.jam > 0) {
    sh.jam--;
    s.log.push({ type: 'jamSpent', shipId: sh.id, lost: kind });
    return;
  }
  sh[kind]++;
}

/**
 * Jam: the target loses its Focus token, else its Evade token, else the lock it holds. With none of
 * those it takes a jam token instead (at most one), which cancels the next Focus or Evade it would gain.
 */
function jam(s: GameState, from: ShipState, t: ShipState) {
  let effect: 'focus' | 'evade' | 'lock' | 'jammed';
  if (t.focus > 0) { t.focus--; effect = 'focus'; }
  else if (t.evade > 0) { t.evade--; effect = 'evade'; }
  else if (t.lock) { t.lock = null; effect = 'lock'; }
  else { t.jam = 1; effect = 'jammed'; }
  s.log.push({ type: 'jam', shipId: from.id, targetId: t.id, effect });
}

function performAction(s: GameState, sh: ShipState, a: ActionChoice) {
  if (a.type === 'none') return;
  const def = shipType(sh).actions.find((x) => x.type === a.type);
  if (a.type === 'lock') sh.lock = a.targetId;
  if (a.type === 'barrelRoll' || a.type === 'boost') { const from = sh.pose; sh.pose = a.to; triggerMines(s, sh, [from, a.to]); }
  if (a.type === 'rotateArc') sh.turretArc = a.to;
  s.log.push({ type: 'action', shipId: sh.id, action: a });
  if (a.type === 'focus' || a.type === 'evade') gainToken(s, sh, a.type);
  if (a.type === 'jam') jam(s, sh, s.ships.find((x) => x.id === a.targetId)!);
  if (a.type === 'repair') {
    discardCard(s, sh, a.card);
    s.log.push({ type: 'damageCard', shipId: sh.id, card: a.card, what: 'repaired' });
  }
  if (def?.red) { sh.stress++; s.log.push({ type: 'stress', shipId: sh.id, delta: 1 }); }
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
    sh.focus = 0;
    sh.evade = 0;
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

/** A standard skirmish: the two placeholder squads facing each other across asteroids. */
export function quickSkirmish(seed: number): GameState {
  const rocks = generateAsteroids({ rng: seed ^ 0x5eed }, 5);
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
    obstacles: rocks,
  });
}
