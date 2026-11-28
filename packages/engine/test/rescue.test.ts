// Ejection and rescue: escape pods where roster pilots go down, the medic ship's Recover, life support running
// out, the recovery phase after a win, captures after a loss, and the rescue missions they open in the campaign.
import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { actionOptions, apply, viewFor } from '../src/game';
import { buildAiSquad } from '../src/squad';
import { endMission, missionRoundEnd } from '../src/mission';
import {
  OPERATIONS, awaitingRescue, campaignOver, findCampaignMission, missionAsFlown, missionBoard, newCampaign, recordMission,
  type CampaignProgress,
} from '../src/campaign';
import { activeMedic, capturePods, expirePods, isMedic, podRoundsLeft, podsOut, POD_LIFE, recoverPod, shipDown } from '../src/rescue';
import { missionReport, type RosterPilot } from '../src/roster';
import { missionGame, TRAINING } from '../src/training';
import type { Command, GameState, ShipState } from '../src/types';

const game = (id = 'op1-raider-hunt', seed = 7) => missionGame(missionAsFlown(findCampaignMission(id)!, newCampaign('Rhea')).def, seed);
const roster = (g: GameState) => g.ships.filter((x) => x.rosterId);
const medic = (g: GameState) => g.ships.find(isMedic)!;
/** Shoot a ship down the way the rules would (destroyed, then its pilot ejects). */
const down = (g: GameState, sh: ShipState) => { sh.destroyed = true; sh.hull = 0; g.log.push({ type: 'destroyed', shipId: sh.id }); shipDown(g, sh); };

function playOut(g: GameState, steps = 6000): GameState {
  for (let n = 0; n < steps && g.phase !== 'over'; n++) {
    const d = g.pending!;
    const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
    g = apply(g, aiDecide({ ...viewFor(g, who), rng: g.rng }, who)! as Command);
  }
  return g;
}

describe('the medic ship', () => {
  it('flies with the squadron in every campaign mission, and only there', () => {
    for (const m of OPERATIONS.flatMap((o) => o.missions)) {
      const def = missionAsFlown(m, newCampaign('X')).def;
      expect(def.player.filter(isMedic), m.id).toHaveLength(1);
    }
    const g = game();
    expect(g.mission!.rescue).toBe(true);
    expect(medic(g)).toMatchObject({ typeId: 'medic', owner: 'p1' });
    expect(medic(g).rosterId).toBeUndefined();
    for (let seed = 1; seed < 30; seed++) {
      expect(buildAiSquad(seed, 100).ships.some((x) => x.shipType === 'medic' || x.pilotId === 'medic-droid')).toBe(false);
    }
  });

  it('is not one of the squadron\'s ships: with every fighter gone the mission is lost', () => {
    const g = game();
    for (const x of roster(g)) down(g, x);
    expect(missionRoundEnd(g)).toBe(true);
    expect(g.mission!.result).toBe('loss');
  });
});

describe('escape pods', () => {
  it('a roster pilot shot down ejects where the ship was; life support lasts POD_LIFE rounds after that one', () => {
    const g = game();
    const sh = roster(g)[0];
    down(g, sh);
    const [pod] = g.pods!;
    expect(pod).toMatchObject({ shipId: sh.id, rosterId: sh.rosterId, x: sh.pose.x, y: sh.pose.y, round: 1, status: 'out' });
    expect(podRoundsLeft(g, pod)).toBe(POD_LIFE + 1);
    for (let r = 1; r <= POD_LIFE; r++) { g.round = r; expirePods(g); expect(pod.status, `end of round ${r}`).toBe('out'); }
    g.round = 1 + POD_LIFE;
    expect(podRoundsLeft(g, pod)).toBe(1);
    expirePods(g);
    expect(pod.status).toBe('lost');
    expect(g.log.at(-1)).toMatchObject({ type: 'pod', what: 'lost' });
  });

  it('a ship that retreats takes its pilot home: no pod', () => {
    const g = game();
    const sh = roster(g)[0];
    sh.fled = 1;
    down(g, sh);
    expect(g.pods ?? []).toHaveLength(0);
  });

  it('the medic can Recover a pod at range 0-1, not one further away', () => {
    const g = game();
    const sh = roster(g)[0], md = medic(g);
    down(g, sh);
    const pod = g.pods![0];
    pod.x = md.pose.x + 200; pod.y = md.pose.y;
    expect(actionOptions(g, md).some((o) => o.type === 'recover')).toBe(false);
    pod.x = md.pose.x + 30 + 50; // base half-width 30, then 50 mm: inside range 1
    expect(actionOptions(g, md)).toContainEqual({ type: 'recover', podId: pod.id });
    expect(actionOptions(g, roster(g)[1]).some((o) => o.type === 'recover')).toBe(false); // only the medic
    recoverPod(g, md, pod.id);
    expect(pod).toMatchObject({ status: 'aboard', carrierId: md.id });
    expect(podsOut(g)).toHaveLength(0);
  });

  it('a destroyed medic drops its passengers back on the table, life support starting over', () => {
    const g = game();
    const md = medic(g);
    down(g, roster(g)[0]);
    recoverPod(g, md, g.pods![0].id);
    g.round = 3;
    down(g, md);
    expect(g.pods![0]).toMatchObject({ status: 'out', x: md.pose.x, y: md.pose.y, round: 3 });
    expect(g.pods![0].carrierId).toBeUndefined();
  });

  it('a lost mission captures every pod still out; pods aboard the medic are safe', () => {
    const g = game();
    const [a, b] = roster(g);
    down(g, a); down(g, b);
    recoverPod(g, medic(g), g.pods![0].id);
    endMission(g, 'loss');
    expect(g.pods!.map((p) => p.status)).toEqual(['aboard', 'captured']);
    const r = missionReport(g);
    expect(r.find((x) => x.pilotId === a.rosterId)!.outcome).toBe('rescued');
    expect(r.find((x) => x.pilotId === b.rosterId)!.outcome).toBe('captured');
  });
});

describe('the recovery phase', () => {
  it('a win with pods out waits: the enemy withdraws, the round limit no longer ends it, and the last pickup ends it', () => {
    const g = game();
    const sh = roster(g)[0];
    down(g, sh);
    endMission(g, 'win');
    expect(g.mission!.result).toBeNull();
    expect(g.mission!.recovery).toBe(true);
    expect(g.ships.filter((x) => x.owner === 'p2').every((x) => x.withdrawn && x.destroyed)).toBe(true);
    expect(g.log.at(-1)).toMatchObject({ type: 'recovery' });
    g.round = g.mission!.maxRounds;
    expect(missionRoundEnd(g)).toBe(false); // still going: the pod is out
    recoverPod(g, medic(g), g.pods![0].id);
    endMission(g, 'win');
    expect(g.mission!.result).toBe('win');
    expect(missionReport(g).find((x) => x.pilotId === sh.rosterId)!.outcome).toBe('rescued');
  });

  it('ends when the last pod runs out', () => {
    const g = game();
    down(g, roster(g)[0]);
    endMission(g, 'win');
    g.round = 1 + POD_LIFE;
    expirePods(g);
    expect(missionRoundEnd(g)).toBe(true);
    expect(g.mission!.result).toBe('win');
    expect(g.pods![0].status).toBe('lost');
  });

  it('no recovery phase without pods out, or without a medic', () => {
    const g = game();
    endMission(g, 'win');
    expect(g.mission!.result).toBe('win');
    const h = game();
    down(h, roster(h)[0]);
    down(h, medic(h));
    expect(activeMedic(h, 'p1')).toBeUndefined();
    endMission(h, 'win');
    expect(h.mission!.result).toBe('win');
    expect(h.mission!.recovery).toBeFalsy();
  });
});

describe('played out by the AI', () => {
  it('every pilot shot down has a pod, and no pod is left out at the end', () => {
    let pods = 0, saved = 0;
    for (const id of ['op1-raider-hunt', 'op2-hold-relay', 'op3-blockade', 'op4-assault']) {
      for (let seed = 1; seed <= 5; seed++) {
        const g = playOut(game(id, seed * 97));
        expect(g.phase, `${id} ${seed}`).toBe('over');
        for (const x of roster(g).filter((s) => s.destroyed && !s.fled)) expect(g.pods?.some((p) => p.shipId === x.id), `${id} ${seed} ${x.name}`).toBe(true);
        expect(podsOut(g), `${id} ${seed}`).toHaveLength(0);
        pods += g.pods?.length ?? 0;
        saved += g.pods?.filter((p) => p.status === 'aboard').length ?? 0;
      }
    }
    console.log(`pods: ${pods}, rescued by the medic: ${saved}`);
    expect(pods).toBeGreaterThan(0);
  }, 300000);
});

describe('captured pilots and rescue missions', () => {
  const capture = (p: CampaignProgress, ids: string[]): CampaignProgress => {
    const m = missionBoard(p)[0];
    return recordMission(p, m.id, 'loss', ids.map((id) => ({ pilotId: id, name: id, outcome: 'captured' as const, rounds: 5, of: 5, kills: 0, xp: 0 })));
  };
  const status = (p: CampaignProgress, id: string) => p.roster!.find((x) => x.id === id)!;

  it('the next board offers their rescue first; win it and they come home injured', () => {
    const p = capture(newCampaign('X'), ['pilot-0']);
    expect(awaitingRescue(p).map((x: RosterPilot) => x.id)).toEqual(['pilot-0']);
    const board = missionBoard(p);
    expect(board[0].id).toBe('rescue-1');
    expect(board.length).toBeGreaterThan(1);
    const { def, notes } = missionAsFlown(board[0], p);
    expect(notes[0]).toContain(status(p, 'pilot-0').name);
    expect(def.player.filter((e) => e.rosterId).map((e) => e.rosterId)).not.toContain('pilot-0');
    const next = recordMission(p, 'rescue-1', 'win');
    expect(status(next, 'pilot-0')).toMatchObject({ status: 'active', injuredUntil: 3 });
    expect(findCampaignMission('rescue-1')!.title).toBe('Prison Break');
  });

  it('lose the rescue, or fly something else, and they are lost', () => {
    const p = capture(newCampaign('X'), ['pilot-0']);
    expect(status(recordMission(p, 'rescue-1', 'loss'), 'pilot-0').status).toBe('lost');
    const other = missionBoard(p)[1];
    const skipped = recordMission(p, other.id, 'win');
    expect(status(skipped, 'pilot-0').status).toBe('lost');
    expect(missionBoard(skipped).some((m) => m.id.startsWith('rescue-'))).toBe(false);
  });

  it('a captured officer: the board is their rescue alone, flown by the wingmen; failing it ends the campaign', () => {
    const p = capture(newCampaign('X'), ['officer']);
    expect(missionBoard(p).map((m) => m.id)).toEqual(['rescue-1']);
    const { def } = missionAsFlown(missionBoard(p)[0], p);
    expect(def.player.filter((e) => e.rosterId).map((e) => e.rosterId)).not.toContain('officer');
    expect(def.player.some((e) => e.tags?.includes('officer'))).toBe(false); // a wingman flies the lead ship
    const freed = recordMission(p, 'rescue-1', 'win');
    expect(status(freed, 'officer')).toMatchObject({ status: 'active' });
    expect(status(freed, 'officer').injuredUntil).toBeUndefined(); // the officer flies on
    const failed = recordMission(p, 'rescue-1', 'loss');
    expect(status(failed, 'officer').status).toBe('lost');
    expect(campaignOver(failed)).toBe(true);
    expect(missionBoard(failed)).toEqual([]);
  });

  it('capturePods only takes pods still out', () => {
    const g = game();
    down(g, roster(g)[0]);
    g.pods![0].status = 'lost';
    capturePods(g);
    expect(g.pods![0].status).toBe('lost');
  });
});

describe('the medic lesson (training 9)', () => {
  const lesson = () => missionGame(TRAINING.find((m) => m.id === 'training-9')!, 3, { officer: 'Rhea' });

  it('starts with three pods on the table, each with its own life support, and the cadet flying the medic', () => {
    const g = lesson();
    expect(g.mission!.rescue).toBe(true);
    expect(g.pods!.map((p) => [p.status, podRoundsLeft(g, p)])).toEqual([['out', 3], ['out', 7], ['out', 10]]);
    expect(medic(g)).toMatchObject({ name: 'Rhea', tags: ['medic', 'officer'] });
    expect(g.mission!.objectives[0]).toMatchObject({ kind: 'recover', progress: 0, of: 3 });
  });

  it('each pickup moves the objective on; all three win it', () => {
    let g = lesson();
    for (const p of g.pods!) { recoverPod(g, medic(g), p.id); g.log.push({ type: 'pod', what: 'recovered', pod: { ...p } }); }
    g = apply(g, aiDecide({ ...viewFor(g, 'p1'), rng: g.rng }, 'p1')! as Command); // any command: the mission scans the log
    expect(g.mission!.objectives[0]).toMatchObject({ status: 'done', progress: 3 });
    expect(g.mission!.result).toBe('win');
  });

  it('a pod running out fails it; with no fighters, only losing the medic loses the mission otherwise', () => {
    const g = lesson();
    g.round = 3;
    expirePods(g);
    expect(missionRoundEnd(g)).toBe(true);
    expect(g.mission!.result).toBe('loss');
    const h = lesson();
    expect(missionRoundEnd(h)).toBe(false); // no fighters is not a loss by itself
    down(h, medic(h));
    expect(missionRoundEnd(h)).toBe(true);
    expect(h.mission!.result).toBe('loss');
  });
});
