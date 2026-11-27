// The campaign after training: every path through it offers boards of 2-4 missions, results set flags and move
// the campaign on, earlier results change the forces, and every mission can be played to a result.
import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { shipPolygon } from '../src/combat';
import { apply, viewFor } from '../src/game';
import { polygonDistance, polygonsOverlap } from '../src/geometry';
import {
  OPERATIONS, campaignOver, currentOperation, missionAsFlown, missionBoard, newCampaign, recordMission,
  type CampaignMission, type CampaignProgress,
} from '../src/campaign';
import { missionGame, OFFICER_TAG, TRAINING } from '../src/training';
import type { Command, GameState } from '../src/types';

function playOut(g: GameState, steps = 5000): GameState {
  for (let n = 0; n < steps && g.phase !== 'over'; n++) {
    const d = g.pending!;
    const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
    g = apply(g, aiDecide({ ...viewFor(g, who), rng: g.rng }, who)! as Command);
  }
  return g;
}

/** Every campaign that can be played: each mission on each board, won or lost. */
function allPaths(): CampaignProgress[] {
  const out: CampaignProgress[] = [];
  const walk = (p: CampaignProgress) => {
    if (campaignOver(p)) { out.push(p); return; }
    for (const m of missionBoard(p)) for (const r of ['win', 'loss'] as const) walk(recordMission(p, m.id, r));
  };
  walk(newCampaign('Test'));
  return out;
}

describe('campaign boards', () => {
  it('every path offers 2-4 missions on every board, and every mission is offered on some path', () => {
    const seen = new Set<string>();
    const walk = (p: CampaignProgress) => {
      if (campaignOver(p)) return;
      const board = missionBoard(p);
      expect(board.length, `${currentOperation(p)!.id} with ${p.flags.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(board.length).toBeLessThanOrEqual(4);
      for (const m of board) {
        seen.add(m.id);
        for (const r of ['win', 'loss'] as const) walk(recordMission(p, m.id, r));
      }
    };
    walk(newCampaign('Test'));
    expect([...seen].sort()).toEqual(OPERATIONS.flatMap((o) => o.missions.map((m) => m.id)).sort());
    expect(allPaths().every((p) => p.history.length === OPERATIONS.length)).toBe(true);
  });

  it('a result sets its flags and moves on; a mission not on the board is ignored', () => {
    let p = newCampaign('Rhea');
    expect(currentOperation(p)!.id).toBe('op-1');
    p = recordMission(p, 'op1-listening-post', 'win');
    expect(p.flags).toEqual(['intel']);
    expect(currentOperation(p)!.id).toBe('op-2');
    expect(missionBoard(p).map((m) => m.id)).toContain('op2-depot-strike');
    expect(recordMission(p, 'op1-supply-run', 'win')).toBe(p); // the other op-1 missions went away
    expect(recordMission(p, 'op2-convoy-ambush', 'win')).toBe(p); // needs the supplies lost
  });

  it('earlier results add or remove ships', () => {
    const assault = OPERATIONS[3].missions.find((m) => m.id === 'op4-assault')!;
    const plain = missionAsFlown(assault, { ...newCampaign('X'), flags: [] });
    const backed = missionAsFlown(assault, { ...newCampaign('X'), flags: ['supplies', 'kord-rescued', 'raiders-bold'] });
    expect(plain.notes).toEqual([]);
    expect(backed.def.player.length).toBe(plain.def.player.length + 2);
    expect(backed.def.enemy.length).toBe(plain.def.enemy.length + 1);
    expect(backed.notes.length).toBe(3);
    const relay = OPERATIONS[1].missions.find((m) => m.id === 'op2-hold-relay')!;
    expect(missionAsFlown(relay, { ...newCampaign('X'), flags: ['raiders-thinned'] }).def.enemy.length).toBe(relay.enemy.length - 1);
  });
});

describe('the officer', () => {
  it('every mission has exactly one officer ship, flown under the officer\'s name', () => {
    const missions = [...TRAINING, ...OPERATIONS.flatMap((o) => o.missions)];
    for (const m of missions) {
      expect(m.player.filter((e) => e.tags?.includes(OFFICER_TAG)).length, m.id).toBe(1);
      const g = missionGame(m, 1, { officer: 'Rhea Sol' });
      expect(g.ships.filter((s) => s.name === 'Rhea Sol').length, m.id).toBe(1);
    }
  });
});

/** Each mission with no earlier results, and with every extra that applies to it. */
const variants = (m: CampaignMission) => {
  const all = [...new Set((m.extras ?? []).flatMap((x) => x.any))];
  return [missionAsFlown(m, { ...newCampaign('X'), flags: [] }).def, ...(all.length ? [missionAsFlown(m, { ...newCampaign('X'), flags: all }).def] : [])];
};

describe('campaign missions are sound', () => {
  for (const m of OPERATIONS.flatMap((o) => o.missions)) {
    it(`${m.id}: no ship starts on an obstacle, a marker or another ship`, () => {
      for (const def of variants(m)) {
        const g = missionGame(def, 1);
        for (const s of g.ships) {
          const poly = shipPolygon(s, s.pose);
          for (const o of g.obstacles) expect(polygonsOverlap(poly, o.polygon), `${s.name} on ${o.id}`).toBe(false);
          for (const t of g.ships) if (t !== s) expect(polygonsOverlap(poly, shipPolygon(t, t.pose)), `${s.name} on ${t.name}`).toBe(false);
        }
        for (const mk of g.mission!.markers) for (const o of g.obstacles) {
          expect(polygonDistance(o.polygon, [{ x: mk.x, y: mk.y }]).d, `${mk.id} in ${o.id}`).toBeGreaterThan(mk.r + 20);
        }
      }
    });
  }
});

describe('every campaign mission plays to a result', () => {
  for (const m of OPERATIONS.flatMap((o) => o.missions)) {
    it(`${m.id} (difficulty ${m.difficulty})`, () => {
      for (const def of variants(m)) {
        let wins = 0;
        const n = 8;
        for (let seed = 1; seed <= n; seed++) {
          const g = playOut(missionGame(def, seed * 131));
          expect(g.phase, `seed ${seed}`).toBe('over');
          expect(g.mission!.result).not.toBeNull();
          if (g.mission!.result === 'win') wins++;
        }
        expect(wins, `${m.id} with ${def.player.length} v ${def.enemy.length}`).toBeGreaterThan(0);
        console.log(`${m.id} ${def.player.length}v${def.enemy.length}: ${wins}/${n} wins with the AI flying for the player`);
      }
    }, 240000);
  }
});
