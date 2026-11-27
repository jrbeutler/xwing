// Upgrade balance by simulation: how much one copy of an upgrade raises the win rate of an otherwise
// mirrored AI-vs-AI matchup, turned into points by comparing with reference upgrades whose cost we trust.
//
//   npx vite-node packages/engine/scripts/balance.ts -- [games per upgrade] [only-these,ids] [first seed]
//
// Each case puts the upgrade on a "host" ship that has the slot (on both sides the squads are otherwise
// identical generic pilots), swaps which side gets it every game, and counts draws as half a win.
import { aiDecide, apply, autoDeploy, createGame, generateObstacles, viewFor } from '../src/index';
import { upgradeCost } from '../src/squad';
import type { Command, GameState } from '../src/types';
import type { Squad, SquadShip } from '../src/squad';

interface Case { upgrade: string; host: SquadShip; reference?: boolean }
const ship = (pilotId: string, shipType: string, upgrades: string[] = []): SquadShip => ({ pilotId, shipType, upgrades });
const kestrel = (u: string[] = []) => ship('vale-nine', 'kestrel', u);
const javelin = (u: string[] = []) => ship('lance-four', 'javelin', u);
const anvil = (u: string[] = []) => ship('rook-twelve', 'anvil', u);
const bulwark = (u: string[] = []) => ship('hauler-three', 'bulwark', u);
const wayfarer = (u: string[] = []) => ship('scout-two', 'wayfarer', u);

/** Both sides fly the host (with `base` upgrades) plus these two. */
const FILLERS = [kestrel(), ship('grunt-seven', 'wasp')];

export const CASES: Case[] = [
  // References: modifications with settled costs.
  { upgrade: 'hull-plating', host: kestrel(), reference: true },
  { upgrade: 'shield-booster', host: kestrel(), reference: true },
  { upgrade: 'stealth-coating', host: kestrel(), reference: true },
  // Cannons.
  { upgrade: 'heavy-laser-cannon', host: kestrel() },
  { upgrade: 'ion-cannon', host: kestrel() },
  { upgrade: 'autocannon', host: kestrel() },
  // Crew.
  { upgrade: 'tactical-officer', host: wayfarer() },
  { upgrade: 'combat-medic', host: bulwark() },
  { upgrade: 'intelligence-agent', host: bulwark() },
  // Gunners (both sides carry a Dorsal Turret, so there is something to use them with).
  { upgrade: 'second-gunner', host: bulwark(['dorsal-turret']) },
  { upgrade: 'gunnery-chief', host: bulwark(['dorsal-turret']) },
  // Droids.
  { upgrade: 'repair-droid', host: kestrel() },
  { upgrade: 'patch-droid', host: kestrel() },
  { upgrade: 'nav-droid', host: anvil() },
  // Sensors.
  { upgrade: 'fire-control-system', host: javelin() },
  { upgrade: 'targeting-computer', host: javelin() },
  { upgrade: 'collision-scanner', host: javelin() },
];

/** Play one AI-vs-AI game to the end; returns the winner ('p1' | 'p2' | 'draw'). */
export function play(seed: number, p1: Squad, p2: Squad): string {
  const near = autoDeploy(p1, 'near'), far = autoDeploy(p2, 'far');
  let g: GameState = createGame({
    seed,
    players: [{ id: 'p1', name: 'A', faction: 'coalition' }, { id: 'p2', name: 'B', faction: 'syndicate' }],
    squads: {
      p1: p1.ships.map((s, i) => ({ ...s, pose: near[i] })),
      p2: p2.ships.map((s, i) => ({ ...s, pose: far[i] })),
    },
    obstacles: generateObstacles({ rng: seed ^ 0x5eed }),
  });
  for (let n = 0; n < 5000 && g.phase !== 'over'; n++) {
    const d = g.pending!;
    const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
    const cmd: Command = aiDecide({ ...viewFor(g, who), rng: g.rng }, who)!;
    g = apply(g, cmd);
  }
  return g.winner ?? 'draw';
}

/** Win rate of the side carrying the upgrade, over `games` games (alternating sides). */
export function measure(c: Case, games: number, seed0 = 1): { rate: number; se: number } {
  let score = 0;
  for (let i = 0; i < games; i++) {
    const withIt: Squad = { ships: [{ ...c.host, upgrades: [...c.host.upgrades, c.upgrade] }, ...FILLERS] };
    const without: Squad = { ships: [c.host, ...FILLERS] };
    const mine = i % 2 ? 'p2' : 'p1';
    const w = play(seed0 + i * 7919, mine === 'p1' ? withIt : without, mine === 'p1' ? without : withIt);
    score += w === 'draw' ? 0.5 : w === mine ? 1 : 0;
  }
  const rate = score / games;
  return { rate, se: Math.sqrt(Math.max(rate * (1 - rate), 0.01) / games) };
}

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args.length) {
  const games = Number(args[0]) || 200;
  const only = args[1] ? args[1].split(',') : undefined;
  const seed0 = Number(args[2]) || 1; // run several processes with different seeds and pool the results
  for (const c of CASES.filter((x) => !only || only.includes(x.upgrade))) {
    const t0 = Date.now();
    const r = measure(c, games, seed0);
    console.log(JSON.stringify({ upgrade: c.upgrade, cost: upgradeCost(c.upgrade, c.host), reference: !!c.reference, games, ...r, secs: (Date.now() - t0) / 1000 }));
  }
}
