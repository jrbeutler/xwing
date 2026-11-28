// The campaign's squadron: roster pilots fly the seats with their own numbers, retreats and kills feed their
// experience, injuries bench them, replacements fill the gaps, and the hangar spends what they earn.
import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { apply, viewFor } from '../src/game';
import { SHIP_TYPES } from '../src/content';
import { OPERATIONS, findCampaignMission, missionAsFlown, newCampaign, prepareCrew, recordMission, withRoster } from '../src/campaign';
import {
  TALENT_COST, applyReport, canPromote, freeTalentSlots, learnTalent, missionReport, promote, promoteCost, replacementInitiative,
  type RosterPilot,
} from '../src/roster';
import { missionGame, OFFICER_TAG } from '../src/training';
import type { Command, GameState } from '../src/types';

const mission = (id: string) => findCampaignMission(id)!;
const pilot = (over: Partial<RosterPilot> = {}): RosterPilot =>
  ({ id: 'p', name: 'P', initiative: 1, talents: [], xp: 0, kills: 0, missions: 0, status: 'active', joined: 0, ...over });

describe('the squadron', () => {
  it('starts with the officer at initiative 2 and three rookie wingmen', () => {
    const c = newCampaign('Rhea Sol');
    expect(c.roster!.map((p) => [p.name, p.initiative, !!p.officer])).toEqual([
      ['Rhea Sol', 2, true], [c.roster![1].name, 1, false], [c.roster![2].name, 1, false], [c.roster![3].name, 1, false],
    ]);
    expect(new Set(c.roster!.map((p) => p.name)).size).toBe(4);
  });

  it('old saves without a roster get the starting squadron', () => {
    const r = withRoster({ officer: 'Old', flags: [], history: [] });
    expect(r.roster).toHaveLength(4);
    expect(r.roster[0]).toMatchObject({ name: 'Old', officer: true });
  });

  it('roster pilots fly the seats with their own name, initiative and talents; the officer flies the officer\'s ship', () => {
    let c = newCampaign('Rhea');
    c = { ...c, roster: c.roster!.map((p) => (p.officer ? { ...p, initiative: 3, talents: ['marksman'] } : p)) };
    const { def } = missionAsFlown(mission('op1-raider-hunt'), c);
    const g = missionGame(def, 1);
    const officer = g.ships.find((s) => s.tags?.includes(OFFICER_TAG))!;
    expect(officer).toMatchObject({ name: 'Rhea', initiative: 3, rosterId: 'officer' });
    expect(officer.upgrades.map((u) => u.id)).toContain('marksman');
    const wing = g.ships.find((s) => s.owner === 'p1' && !s.tags?.includes(OFFICER_TAG))!;
    expect(wing).toMatchObject({ name: c.roster![1].name, initiative: 1, rosterId: c.roster![1].id });
  });

  it('a seat keeps its hull and upgrades', () => {
    const { def } = missionAsFlown(mission('op4-assault'), newCampaign('X'));
    expect(def.player[0]).toMatchObject({ shipType: 'kestrel', upgrades: ['shield-booster'], rosterId: 'officer' });
    const javelin = missionAsFlown(mission('op1-listening-post'), newCampaign('X')).def.player;
    expect(javelin.filter((e) => e.rosterId).map((e) => [e.shipType, e.pilotId])).toEqual([['javelin', 'lance-four'], ['javelin', 'lance-four']]);
  });

  it('ships added by earlier results: call-sign fighters are seats, named pilots and other classes stay allies', () => {
    const m = mission('op4-assault');
    const c = { ...newCampaign('X'), flags: ['supplies', 'kord-rescued'] };
    const { progress, seats } = prepareCrew(m, c);
    expect(seats).toBe(3); // two of the mission's own, plus the repaired Kestrel; Captain Kord is an ally
    const { def } = missionAsFlown(m, progress);
    expect(def.player.find((e) => e.name === 'Kord')).toMatchObject({ pilotId: 'ilse-kord' });
    expect(def.player.find((e) => e.name === 'Kord')!.rosterId).toBeUndefined();
    expect(def.player.filter((e) => e.rosterId)).toHaveLength(3);
  });

  it('the player can choose who flies', () => {
    const c = newCampaign('X');
    const pick = ['officer', c.roster![3].id];
    const { def } = missionAsFlown(mission('op1-raider-hunt'), c, pick);
    expect(def.player.filter((e) => e.rosterId).map((e) => e.rosterId)).toEqual(pick);
  });

  it('replacements join when too few pilots are fit to fly, better trained in later acts', () => {
    const c = newCampaign('X');
    const hurt = { ...c, roster: c.roster!.map((p) => (p.officer ? p : { ...p, injuredUntil: 2 })) };
    const { progress, crew } = prepareCrew(mission('op1-supply-run'), hurt);
    expect(progress.roster!.length).toBe(4 + 2); // three seats: the officer and two replacements
    expect(crew).toHaveLength(3);
    expect(crew.every((id) => !['pilot-0', 'pilot-1', 'pilot-2'].includes(id))).toBe(true);
    expect([0, 3, 4, 6, 7, 9].map(replacementInitiative)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

/** A finished mission, staged: the battle lasted `rounds`, and each roster ship came home, retreated or was shot down. */
function staged(result: 'win' | 'loss', rounds: number, fates: ('home' | number | 'down')[]): GameState {
  // 'down': shot down and picked up by the medic.
  const { def } = missionAsFlown(mission('op1-supply-run'), newCampaign('X'));
  const g = missionGame(def, 1);
  g.round = rounds;
  g.mission!.result = result;
  g.phase = 'over';
  // The officer first, then the wingmen in order.
  const crew = g.ships.filter((s) => s.rosterId).sort((a, b) => Number(b.rosterId === 'officer') - Number(a.rosterId === 'officer'));
  crew.forEach((s, i) => {
    const f = fates[i];
    if (f === 'down') {
      s.destroyed = true;
      (g.pods ??= []).push({ id: `pod-${i}`, shipId: s.id, name: s.name, rosterId: s.rosterId, owner: s.owner, x: 0, y: 0, round: 1, status: 'aboard' });
    }
    else if (typeof f === 'number') { s.destroyed = true; s.fled = f; }
  });
  return g;
}

describe('experience', () => {
  it('coming home earns 2, +1 for a win, +1 for the officer; kills add 1 each', () => {
    const g = staged('win', 8, ['home', 'home', 'down']);
    const enemy = g.ships.find((s) => s.owner === 'p2')!;
    const wing = g.ships.find((s) => s.rosterId && s.rosterId !== 'officer')!;
    g.log.push({ type: 'attack', attackerId: wing.id, defenderId: enemy.id, hullDamage: 2, shieldDamage: 0 } as never);
    g.log.push({ type: 'destroyed', shipId: enemy.id });
    const r = missionReport(g);
    expect(r.find((x) => x.pilotId === 'officer')).toMatchObject({ outcome: 'home', xp: 4, kills: 0 });
    expect(r.find((x) => x.pilotId === wing.rosterId)).toMatchObject({ outcome: 'home', xp: 4, kills: 1 });
    expect(r.find((x) => x.outcome === 'rescued')).toMatchObject({ xp: 0, kills: 0 });
  });

  it('a retreat earns the survival share for the rounds flown', () => {
    // The officer's share of 3 for 4 of 10 rounds rounds to 1; a wingman's share of 2 for 5 of 10 is 1.
    const r = missionReport(staged('loss', 10, [4, 5, 'home']));
    expect(r.find((x) => x.pilotId === 'officer')).toMatchObject({ outcome: 'retreated', rounds: 4, of: 10, xp: 1 });
    expect(r.filter((x) => x.pilotId !== 'officer').map((x) => [x.outcome, x.rounds, x.xp]).sort()).toEqual([['home', 10, 2], ['retreated', 5, 1]]);
  });

  it('banking it: XP, kills and missions counted; the rescued sit out the next mission (the officer never does), the lost are gone, the captured wait', () => {
    const roster = [pilot({ id: 'officer', officer: true }), pilot({ id: 'a' }), pilot({ id: 'b' }), pilot({ id: 'c' }), pilot({ id: 'd' })];
    const out = applyReport(roster, [
      { pilotId: 'officer', name: '', outcome: 'rescued', rounds: 3, of: 3, kills: 1, xp: 1 },
      { pilotId: 'a', name: '', outcome: 'home', rounds: 3, of: 3, kills: 2, xp: 5 },
      { pilotId: 'b', name: '', outcome: 'rescued', rounds: 3, of: 3, kills: 0, xp: 0 },
      { pilotId: 'c', name: '', outcome: 'lost', rounds: 3, of: 3, kills: 0, xp: 0 },
      { pilotId: 'd', name: '', outcome: 'captured', rounds: 3, of: 3, kills: 0, xp: 0 },
    ], 1);
    expect(out.map((p) => [p.xp, p.kills, p.missions, p.injuredUntil, p.status])).toEqual([
      [1, 1, 1, undefined, 'active'], [5, 2, 1, undefined, 'active'], [0, 0, 1, 3, 'active'], [0, 0, 1, undefined, 'lost'], [0, 0, 1, undefined, 'captured'],
    ]);
    expect(out[4].capturedAt).toBe(1);
  });

  it('recordMission banks the report into the roster', () => {
    const c = newCampaign('X');
    const op1 = OPERATIONS[0].missions[0];
    const next = recordMission(c, op1.id, 'win', [{ pilotId: 'officer', name: 'X', outcome: 'home', rounds: 5, of: 5, kills: 1, xp: 5 }]);
    expect(next.roster!.find((p) => p.officer)).toMatchObject({ xp: 5, kills: 1, missions: 1 });
    expect(next.history).toHaveLength(1);
  });
});

describe('retreating off the table', () => {
  it('in a mission, a ship that flies off the table has retreated: out of play, marked with the round', () => {
    const { def } = missionAsFlown(mission('op1-raider-hunt'), newCampaign('X'));
    const player = def.player.map((e, i) => (i === 0 ? { ...e, pose: { x: 380, y: 30, h: -Math.PI / 2 } } : e));
    let g = missionGame({ ...def, player }, 3);
    const straight = SHIP_TYPES.kestrel.dial.findIndex((m) => m.bearing === 'straight' && m.speed === 2);
    while (g.phase !== 'over' && g.round === 1) {
      const d = g.pending!;
      const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
      const cmd: Command = d.kind === 'planning' && who === 'p1'
        ? { type: 'setDials', playerId: 'p1', dials: Object.fromEntries(g.ships.filter((s) => s.owner === 'p1').map((s) => [s.id, straight])) }
        : aiDecide({ ...viewFor(g, who), rng: g.rng }, who)! as Command;
      g = apply(g, cmd);
    }
    const officer = g.ships.find((s) => s.rosterId === 'officer')!;
    expect(officer).toMatchObject({ destroyed: true, fled: 1 });
    expect(g.log.some((e) => e.type === 'info' && e.text.includes('retreated'))).toBe(true);
    expect(missionReport(g).find((r) => r.pilotId === 'officer')!.outcome).toBe('retreated');
  });
});

describe('the hangar', () => {
  it('initiative costs twice the new value, up to 6', () => {
    const p = pilot({ initiative: 2, xp: 7 });
    expect(promoteCost(p)).toBe(6);
    const after = promote([p], 'p')[0];
    expect(after).toMatchObject({ initiative: 3, xp: 1 });
    expect(promote([after], 'p')[0]).toBe(after); // not enough XP: unchanged
    expect(canPromote(pilot({ initiative: 6, xp: 99 }))).toBe(false);
  });

  it('talents cost 4 and need a free slot (one at initiative 3-4, two at 5+) from the fighter pool', () => {
    expect(freeTalentSlots(pilot({ initiative: 2 }))).toBe(0);
    const p = pilot({ initiative: 3, xp: 10 });
    expect(learnTalent([p], 'p', 'ordnance-specialist')[0]).toBe(p); // a bomber talent
    const one = learnTalent([p], 'p', 'marksman')[0];
    expect(one).toMatchObject({ talents: ['marksman'], xp: 10 - TALENT_COST });
    expect(learnTalent([one], 'p', 'elusive')[0]).toBe(one); // no free slot at initiative 3
    expect(freeTalentSlots({ ...one, initiative: 5 })).toBe(1);
  });
});
