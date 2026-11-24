// Squad building: points, upgrade slots, legality, an AI squad builder, and deployment.
// The client's builder screen and the AI use the same rules from here.
import { polygonsOverlap, type Pose } from './geometry';
import { BASE_SIZE, BOARD_SIZE, RANGE_BAND } from './maneuvers';
import { PILOTS, SHIP_TYPES, UPGRADES } from './content';
import { basePolygon } from './geometry';
import { nextFloat } from './rng';
import type { SlotType } from './types';

export interface SquadShip { pilotId: string; upgrades: string[] }
export interface Squad { ships: SquadShip[] }

export const DEFAULT_BUDGET = 100;
export const MAX_SHIPS = 8;

const sizeOfPilot = (pilotId: string) => SHIP_TYPES[PILOTS[pilotId].shipType].size;

/** Slots this pilot's ship offers (talents need initiative 3+). */
export function pilotSlots(pilotId: string): SlotType[] {
  const p = PILOTS[pilotId];
  return SHIP_TYPES[p.shipType].slots.filter((s) => s !== 'talent' || p.initiative >= 3);
}

export function upgradeCost(upgradeId: string, pilotId: string): number {
  const c = UPGRADES[upgradeId].cost;
  return typeof c === 'number' ? c : c[sizeOfPilot(pilotId)];
}

export const shipCost = (s: SquadShip) => PILOTS[s.pilotId].cost + s.upgrades.reduce((a, u) => a + upgradeCost(u, s.pilotId), 0);
export const squadCost = (q: Squad) => q.ships.reduce((a, s) => a + shipCost(s), 0);

/** Whether these upgrades fit this pilot's slots (each upgrade takes one slot of its kind; no duplicates). */
export function fitsSlots(pilotId: string, upgrades: string[]): boolean {
  if (new Set(upgrades).size !== upgrades.length) return false;
  const free = [...pilotSlots(pilotId)];
  for (const u of upgrades) {
    const i = free.indexOf(UPGRADES[u]?.slot);
    if (i < 0) return false;
    free.splice(i, 1);
  }
  return true;
}

/** Slots still empty on a ship, in the ship's slot order. */
export function freeSlots(s: SquadShip): SlotType[] {
  const free = [...pilotSlots(s.pilotId)];
  for (const u of s.upgrades) { const i = free.indexOf(UPGRADES[u].slot); if (i >= 0) free.splice(i, 1); }
  return free;
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
    if (p.unique && (seen.has(p.id) || taken.has(p.id))) out.push(`${p.name} can only fly once.`);
    seen.add(p.id);
    if (s.upgrades.some((u) => !UPGRADES[u])) out.push(`${p.name} has an unknown upgrade.`);
    else if (!fitsSlots(s.pilotId, s.upgrades)) out.push(`${p.name}'s upgrades do not fit its slots.`);
  }
  return [...new Set(out)];
}

/** Upgrades that could go in one of this ship's free slots, affordable within `room` points. */
export function upgradeOptions(s: SquadShip, room = Infinity): string[] {
  const free = freeSlots(s);
  return Object.values(UPGRADES)
    .filter((u) => free.includes(u.slot) && !s.upgrades.includes(u.id) && upgradeCost(u.id, s.pilotId) <= room)
    .map((u) => u.id);
}

/**
 * The AI's squad: random pilots until the budget is mostly spent, then upgrades with what is left.
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
      const pilots = Object.values(PILOTS).filter((p) => p.cost <= room - reserve && !(p.unique && used.has(p.id)));
      if (!pilots.length || q.ships.length >= MAX_SHIPS) return;
      const p = pick(pilots);
      if (p.unique) used.add(p.id);
      q.ships.push({ pilotId: p.id, upgrades: [] });
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
    const size = BASE_SIZE[sizeOfPilot(s.pilotId)];
    const inset = DEPLOY_DEPTH - size / 2 - 10;
    const x = (BOARD_SIZE * (i + 1)) / (n + 1);
    return { x, y: side === 'near' ? inset : BOARD_SIZE - inset, h: sideHeading(side) };
  });
}
