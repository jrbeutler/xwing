// Squad building: points, upgrade slots, legality, an AI squad builder, and deployment.
// The client's builder screen and the AI use the same rules from here.
import { polygonsOverlap, type Pose } from './geometry';
import { BASE_SIZE, BOARD_SIZE, RANGE_BAND } from './maneuvers';
import { PILOTS, SHIP_TYPES, UPGRADES } from './content';
import { basePolygon } from './geometry';
import { nextFloat } from './rng';
import type { SlotType } from './types';

/** A pilot in a hull. `shipType` defaults to the pilot's usual hull; `upgrades` are the bought ones only
 * (a pilot's signature talents come with the pilot and are not listed). */
export interface SquadShip { pilotId: string; shipType?: string; upgrades: string[] }
export interface Squad { ships: SquadShip[] }

export const DEFAULT_BUDGET = 100;
export const MAX_SHIPS = 8;

/** The hull a squad ship flies. */
export const hullOf = (s: Pick<SquadShip, 'pilotId' | 'shipType'>) => s.shipType ?? PILOTS[s.pilotId].ship;
/** Flying a hull outside the pilot's specialty. */
export const isOffClass = (s: Pick<SquadShip, 'pilotId' | 'shipType'>) => SHIP_TYPES[hullOf(s)].class !== PILOTS[s.pilotId].specialty;
/** The penalty for flying outside your specialty. */
export const OFF_CLASS_INITIATIVE = 1;
/** Initiative in this hull: one lower outside the pilot's specialty. */
export const effectiveInitiative = (s: Pick<SquadShip, 'pilotId' | 'shipType'>) =>
  Math.max(1, PILOTS[s.pilotId].initiative - (isOffClass(s) ? OFF_CLASS_INITIATIVE : 0));
/** Talent slots a pilot of this initiative has: none below 3, one at 3-4, two at 5+. */
export const talentSlotCount = (initiative: number) => (initiative >= 5 ? 2 : initiative >= 3 ? 1 : 0);

/** The pilot's signature talents that fit in this hull (off-class pilots can lose a slot, and the talent in it). */
export function signatureTalents(s: Pick<SquadShip, 'pilotId' | 'shipType'>): string[] {
  return (PILOTS[s.pilotId].talents ?? []).slice(0, talentSlotCount(effectiveInitiative(s)));
}

/** Every upgrade the ship flies with: signature talents first, then the bought ones. */
export const allUpgrades = (s: SquadShip) => [...signatureTalents(s), ...s.upgrades];

/** All slots of this pilot in this hull: the pilot's talent slots, then the hull's. */
export function shipSlots(s: Pick<SquadShip, 'pilotId' | 'shipType'>): SlotType[] {
  const talents: SlotType[] = Array(talentSlotCount(effectiveInitiative(s))).fill('talent');
  return [...talents, ...SHIP_TYPES[hullOf(s)].slots];
}

/** Whether the pilot can learn this upgrade (talents come from the pilot's specialty pool). */
export const canLearn = (upgradeId: string, pilotId: string) => {
  const u = UPGRADES[upgradeId];
  return u.slot !== 'talent' || !u.classes || u.classes.includes(PILOTS[pilotId].specialty);
};

export function upgradeCost(upgradeId: string, s: Pick<SquadShip, 'pilotId' | 'shipType'>): number {
  const c = UPGRADES[upgradeId].cost;
  return typeof c === 'number' ? c : c[SHIP_TYPES[hullOf(s)].size];
}

export const shipCost = (s: SquadShip) =>
  SHIP_TYPES[hullOf(s)].cost + PILOTS[s.pilotId].cost + s.upgrades.reduce((a, u) => a + upgradeCost(u, s), 0);
export const squadCost = (q: Squad) => q.ships.reduce((a, s) => a + shipCost(s), 0);

/** Slots still empty on a ship (after signature talents and bought upgrades), in slot order. */
export function freeSlots(s: SquadShip): SlotType[] {
  const free = shipSlots(s);
  for (const u of allUpgrades(s)) { const i = free.indexOf(UPGRADES[u]?.slot); if (i >= 0) free.splice(i, 1); }
  return free;
}

/** Whether the bought upgrades fit the slots left after signature talents (no duplicates, talents from the pool). */
export function fitsSlots(s: SquadShip): boolean {
  const all = allUpgrades(s);
  if (new Set(all).size !== all.length) return false;
  if (!s.upgrades.every((u) => UPGRADES[u] && canLearn(u, s.pilotId))) return false;
  const free = shipSlots(s);
  for (const u of all) {
    const i = free.indexOf(UPGRADES[u].slot);
    if (i < 0) return false;
    free.splice(i, 1);
  }
  return true;
}

/**
 * Problems that make a squad illegal (empty when it is fine to fly). `taken` lists unique pilots
 * already used elsewhere in the battle (named pilots appear at most once per battle).
 */
export function validateSquad(q: Squad, budget = DEFAULT_BUDGET, taken: Set<string> = new Set()): string[] {
  const out: string[] = [];
  if (!q.ships.length) out.push('Add at least one ship.');
  if (q.ships.length > MAX_SHIPS) out.push(`At most ${MAX_SHIPS} ships.`);
  const cost = squadCost(q);
  if (cost > budget) out.push(`Over budget: ${cost} / ${budget} points.`);
  const seen = new Set<string>();
  for (const s of q.ships) {
    const p = PILOTS[s.pilotId];
    if (!p) { out.push(`Unknown pilot ${s.pilotId}.`); continue; }
    if (!SHIP_TYPES[hullOf(s)]) { out.push(`Unknown ship ${s.shipType}.`); continue; }
    if (p.unique && (seen.has(p.id) || taken.has(p.id))) out.push(`${p.name} can only fly once.`);
    seen.add(p.id);
    if (s.upgrades.some((u) => !UPGRADES[u])) out.push(`${p.name} has an unknown upgrade.`);
    else if (!fitsSlots(s)) out.push(`${p.name}'s upgrades do not fit its slots.`);
  }
  return [...new Set(out)];
}

/** Upgrades that could go in one of this ship's free slots, affordable within `room` points. */
export function upgradeOptions(s: SquadShip, room = Infinity): string[] {
  const free = freeSlots(s);
  return Object.values(UPGRADES)
    .filter((u) => free.includes(u.slot) && !allUpgrades(s).includes(u.id) && canLearn(u.id, s.pilotId) && upgradeCost(u.id, s) <= room)
    .map((u) => u.id);
}

/**
 * The AI's squad: random pilots (each in a random hull of their specialty) until the budget is mostly
 * spent, then upgrades with what is left.
 * Deterministic for a seed. Skips unique pilots in `taken` (e.g. the player's).
 */
export function buildAiSquad(seed: number, budget = DEFAULT_BUDGET, taken: Set<string> = new Set()): Squad {
  const rng = { rng: seed | 0 };
  const pick = <T>(xs: T[]) => xs[Math.floor(nextFloat(rng) * xs.length)];
  const q: Squad = { ships: [] };
  const used = new Set(taken);
  const addShips = (keepForUpgrades: boolean) => {
    for (;;) {
      const room = budget - squadCost(q);
      // First pass: keep some points back for upgrades once the squad has a core of ships.
      const reserve = keepForUpgrades && q.ships.length >= 3 ? Math.min(room, budget * 0.15) : 0;
      const options = Object.values(PILOTS).filter((p) => !(p.unique && used.has(p.id))).flatMap((p) =>
        Object.values(SHIP_TYPES).filter((t) => t.class === p.specialty).map((t) => ({ pilotId: p.id, shipType: t.id, upgrades: [] as string[] })))
        .filter((s) => shipCost(s) <= room - reserve);
      if (!options.length || q.ships.length >= MAX_SHIPS) return;
      // Pick the pilot first, then a hull, so pilots with more hulls to choose from are not favoured.
      const pilot = pick([...new Set(options.map((o) => o.pilotId))]);
      const s = pick(options.filter((o) => o.pilotId === pilot));
      if (PILOTS[s.pilotId].unique) used.add(s.pilotId);
      q.ships.push(s);
    }
  };
  const addUpgrades = () => {
    for (let tries = 0; tries < 40; tries++) {
      const ship = pick(q.ships);
      const opts = upgradeOptions(ship, budget - squadCost(q));
      if (opts.length) ship.upgrades.push(pick(opts));
    }
  };
  addShips(true);
  addUpgrades();
  addShips(false); // spend anything the upgrades could not use on another ship
  addUpgrades();
  return q;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/** Which edge a player sets up on: 'near' (y = 0, facing +y) or 'far' (y = BOARD_SIZE, facing -y). */
export type Side = 'near' | 'far';
export const DEPLOY_DEPTH = RANGE_BAND; // setup area: within range 1 of your edge
export const sideHeading = (side: Side) => (side === 'near' ? Math.PI / 2 : -Math.PI / 2);

/** Can a base of `size` sit at `pose` for `side`: fully in the setup area and clear of `others`? */
export function canDeployAt(pose: Pose, size: number, side: Side, others: { pose: Pose; size: number }[] = []): boolean {
  const poly = basePolygon(pose, size);
  const [lo, hi] = side === 'near' ? [0, DEPLOY_DEPTH] : [BOARD_SIZE - DEPLOY_DEPTH, BOARD_SIZE];
  if (!poly.every((p) => p.x >= 0 && p.x <= BOARD_SIZE && p.y >= lo && p.y <= hi)) return false;
  return !others.some((o) => polygonsOverlap(poly, basePolygon(o.pose, o.size)));
}

/** Spread a squad evenly along its edge, inside the setup area. */
export function autoDeploy(q: Squad, side: Side): Pose[] {
  const n = q.ships.length;
  return q.ships.map((s, i) => {
    const size = BASE_SIZE[SHIP_TYPES[hullOf(s)].size];
    const inset = DEPLOY_DEPTH - size / 2 - 10;
    const x = (BOARD_SIZE * (i + 1)) / (n + 1);
    return { x, y: side === 'near' ? inset : BOARD_SIZE - inset, h: sideHeading(side) };
  });
}
