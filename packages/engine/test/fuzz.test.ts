import { expect, it } from 'vitest';
import { createGame, apply, aiDecide, legalDial, buildAiSquad, autoDeploy, generateAsteroids, generateObstacles, viewFor } from '../src/index';
import type { GameState, Command } from '../src/types';

const pick = <T,>(xs: T[], r: () => number) => xs[Math.floor(r() * xs.length)];

// Plays random squads where one side picks random legal choices exactly as the UI offers them (legalDial,
// pending options/targets) against the AI. Any command the engine then refuses would freeze the client.
it('random human vs AI never gets an offered move refused', () => {
  const failures: string[] = [];
  let games = 0, rounds = 0;
  for (let seed = 1; seed <= 200; seed++) {
    let x = seed * 9301 + 49297; const r = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    const p1 = buildAiSquad(seed * 7), p2 = buildAiSquad(seed * 13 + 1);
    const near = autoDeploy(p1, 'near'), far = autoDeploy(p2, 'far');
    let g: GameState = createGame({
      seed,
      players: [{ id: 'p1', name: 'A', faction: 'coalition' }, { id: 'p2', name: 'B', faction: 'syndicate' }],
      squads: {
        p1: p1.ships.map((s, i) => ({ pilotId: s.pilotId, upgrades: s.upgrades, pose: near[i] })),
        p2: p2.ships.map((s, i) => ({ pilotId: s.pilotId, upgrades: s.upgrades, pose: far[i] })),
      },
      // Half the boards are the classic asteroid field, half the mixed board (asteroids, debris, gas).
      obstacles: seed % 2 ? generateObstacles({ rng: seed ^ 0x5eed }) : generateAsteroids({ rng: seed ^ 0x5eed }, 5),
    });
    games++;
    for (let n = 0; n < 3000 && g.phase !== 'over'; n++) {
      const d = g.pending;
      if (!d) { failures.push(`seed ${seed} r${g.round}: no pending decision but not over (phase ${g.phase})`); break; }
      const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
      let cmd: Command;
      if (who === 'p2') cmd = aiDecide({ ...viewFor(g, 'p2'), rng: g.rng }, 'p2')!;
      else if (d.kind === 'planning') {
        const dials: Record<string, number> = {};
        for (const s of g.ships.filter((s) => s.owner === 'p1' && !s.destroyed)) dials[s.id] = pick(legalDial(g, s), r);
        cmd = { type: 'setDials', playerId: 'p1', dials };
      } else if (d.kind === 'action') cmd = { type: 'action', playerId: 'p1', choice: pick(d.options, r) } as Command;
      else if (d.kind === 'attack') { const t = pick([...d.targets, null], r); cmd = { type: 'attack', playerId: 'p1', targetId: t ? t.targetId : null, ...(t && (t as any).weapon ? { weapon: (t as any).weapon } : {}) } as Command; }
      else cmd = { type: 'drop', playerId: 'p1', choice: pick((d as any).options, r) } as any;
      try { const before = g.round; g = apply(g, cmd); if (g.round !== before) rounds++; }
      catch (e) {
        const extra = d.kind === 'planning' ? ' ' + JSON.stringify(Object.fromEntries(g.ships.filter((s) => s.owner === 'p1' && !s.destroyed).map((s) => [s.id, { stress: s.stress, ion: (s as any).ion, crits: (s as any).damage?.map?.((c: any) => c.card ?? c) }]))) : '';
        failures.push(`seed ${seed} r${g.round} ${who} ${d.kind}: ${(e as Error).message}${extra}`);
        break;
      }
    }
  }
  expect(games).toBe(200);
  expect(rounds).toBeGreaterThan(500);
  expect(failures).toEqual([]);
}, 120000);
