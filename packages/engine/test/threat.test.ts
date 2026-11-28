// Rising threat and mission templates: the enemy hardens with the campaign's stage and the crew's experience,
// and templates build sound, playable missions from a few parameters.
import { describe, expect, it } from 'vitest';
import { aiDecide } from '../src/index';
import { shipPolygon } from '../src/combat';
import { apply, viewFor } from '../src/game';
import { polygonDistance, polygonsOverlap } from '../src/geometry';
import { OPERATIONS, missionAsFlown, newCampaign, type CampaignMission, type CampaignProgress } from '../src/campaign';
import { applyThreat, threatLevel } from '../src/threat';
import { TEMPLATES, type TemplateBase } from '../src/templates';
import { missionGame } from '../src/training';
import type { Command, GameState } from '../src/types';

function playOut(g: GameState, steps = 6000): GameState {
  for (let n = 0; n < steps && g.phase !== 'over'; n++) {
    const d = g.pending!;
    const who = d.kind === 'planning' ? d.waitingOn[0] : d.playerId;
    g = apply(g, aiDecide({ ...viewFor(g, who), rng: g.rng }, who)! as Command);
  }
  return g;
}

/** No ship starts on an obstacle, another ship or off the table; no buoy sits in an obstacle. */
function expectSound(g: GameState, label: string) {
  for (const s of g.ships) {
    const poly = shipPolygon(s, s.pose);
    expect(poly.every((p) => p.x >= 0 && p.x <= 914 && p.y >= 0 && p.y <= 914), `${label}: ${s.name} on the table`).toBe(true);
    for (const o of g.obstacles) expect(polygonsOverlap(poly, o.polygon), `${label}: ${s.name} on ${o.id}`).toBe(false);
    for (const t of g.ships) if (t !== s) expect(polygonsOverlap(poly, shipPolygon(t, t.pose)), `${label}: ${s.name} on ${t.name}`).toBe(false);
  }
  for (const mk of g.mission!.markers) for (const o of g.obstacles) {
    expect(polygonDistance(o.polygon, [{ x: mk.x, y: mk.y }]).d, `${label}: ${mk.id} in ${o.id}`).toBeGreaterThan(mk.r + 20);
  }
}

describe('threat level', () => {
  it('rises a level every two missions, and with the crew\'s experience', () => {
    const rookie = { initiative: 1, talents: [] as string[] }, officer = { initiative: 2, talents: [] as string[], officer: true };
    expect(threatLevel(0, [officer, rookie])).toBe(0);
    expect([1, 2, 3, 4, 5].map((n) => threatLevel(n, [officer, rookie]))).toEqual([0, 1, 1, 2, 2]);
    expect(threatLevel(0, [{ ...officer, initiative: 4 }, { ...rookie, initiative: 2, talents: ['marksman'] }])).toBe(2); // 2 + 1 + 1 = 4 points
  });

  it('each level hardens the force a step', () => {
    const enemy = missionAsFlown(OPERATIONS[0].missions[1], newCampaign('X')).def.enemy; // raider hunt: 3 call-signs
    const at = (lvl: number) => applyThreat(enemy, lvl).enemy;
    expect(applyThreat(enemy, 0)).toEqual({ enemy, notes: [] });
    expect(at(1).map((e) => e.initiative ?? 1)).toEqual([2, 1, 1]);
    expect(at(2).map((e) => e.initiative)).toEqual([3, 2, 2]);
    expect(at(3)).toHaveLength(4);
    expect(at(3)[3]).toMatchObject({ name: 'Reinforcement 1', shipType: enemy[2].shipType });
    expect(at(4)[0].talents).toEqual(['marksman']);
    expect(at(5).every((e) => (e.upgrades ?? []).length === 1)).toBe(true);
    expect(at(6)).toHaveLength(5);
    expect(at(7).map((e) => e.initiative)).toEqual([4, 3, 3, 3, 3]);
    expect(applyThreat(enemy, 3).notes[0]).toMatch(/^Threat 3: .*extra ship/);
  });

  it('a campaign mission flown later, or by veterans, meets a harder force (and the briefing says so)', () => {
    const m = OPERATIONS[0].missions[1];
    const later: CampaignProgress = { ...newCampaign('X'), history: [1, 2, 3, 4].map(() => ({ op: 'op-1', mission: m.id, result: 'win' as const })) };
    const { def, notes } = missionAsFlown(m, later);
    expect(def.enemy[0].initiative).toBe(3);
    expect(notes.some((n) => n.startsWith('Threat 2'))).toBe(true);
    expect(missionAsFlown(m, newCampaign('X')).notes.some((n) => n.startsWith('Threat'))).toBe(false);
  });

  it('every campaign mission stays sound with the most the threat adds', () => {
    for (const m of OPERATIONS.flatMap((o) => o.missions)) {
      const def = missionAsFlown(m, newCampaign('X')).def;
      expectSound(missionGame({ ...def, enemy: applyThreat(def.enemy, 9).enemy }, 1), m.id);
    }
  });
});

const story = (id: string, seed: number): TemplateBase => ({
  id, number: 5, title: id, summary: '', stakes: '', intro: '', difficulty: 2, seed,
  outcome: { win: { flags: [], text: '' }, loss: { flags: [], text: '' } },
});
const built = (seed: number): CampaignMission[] => [
  TEMPLATES.strike(story('strike', seed)),
  TEMPLATES.escort({ ...story('escort', seed), cargo: 'the tender Lark' }),
  TEMPLATES.defend({ ...story('defend', seed), rounds: 6 }),
  TEMPLATES.recon({ ...story('recon', seed), buoys: 3 }),
  TEMPLATES.duel({ ...story('duel', seed), ace: { pilotId: 'kira-solace' } }),
  TEMPLATES.rescue(story('rescue', seed)),
];

describe('mission templates', () => {
  it('build sound missions, with and without the threat, on many tables', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const m of built(seed * 7919)) {
        const def = missionAsFlown(m, newCampaign('X')).def;
        expectSound(missionGame(def, 1), `${m.id} seed ${seed}`);
        expectSound(missionGame({ ...def, enemy: applyThreat(def.enemy, 9).enemy }, 1), `${m.id} seed ${seed} threat`);
        if (m.id === 'recon') expect(m.markers, `recon seed ${seed}`).toHaveLength(3);
      }
    }
  });

  it('each one names its objective and its forces as asked', () => {
    const [strike, escort, , recon, duel] = built(11);
    expect(strike.enemy.find((e) => e.tags?.includes('target'))).toMatchObject({ shipType: 'bulwark', name: 'Gunship' });
    expect(escort.player[0]).toMatchObject({ shipType: 'wayfarer', name: 'tender Lark', tags: ['cargo'] });
    expect(recon.player.every((e) => e.shipType === 'javelin')).toBe(true);
    expect(duel.enemy[0]).toMatchObject({ pilotId: 'kira-solace', tags: ['ace'] });
  });

  it('every template plays to a result, and can be won', () => {
    for (const m of built(4242)) {
      const def = missionAsFlown(m, newCampaign('X')).def;
      let wins = 0;
      for (let seed = 1; seed <= 12 && (seed <= 6 || !wins); seed++) {
        const g = playOut(missionGame(def, seed * 131));
        expect(g.phase, `${m.id} seed ${seed}`).toBe('over');
        if (g.mission!.result === 'win') wins++;
      }
      console.log(`${m.id}: ${wins} wins`);
      expect(wins, m.id).toBeGreaterThan(0);
    }
  }, 600000);
});

describe('a whole campaign, flown by the AI', () => {
  it('runs from start to end with the squadron, threat, rescues and the hangar all in play', async () => {
    const { missionBoard, recordMission, campaignOver, prepareCrew, withRoster } = await import('../src/campaign');
    const { missionReport, promote, learnTalent, canPromote, canLearnTalent, talentOptions } = await import('../src/roster');
    const lines: string[] = [];
    for (let run = 1; run <= 3; run++) {
      let p: CampaignProgress = newCampaign('Sim');
      for (let guard = 0; guard < 12 && !campaignOver(p); guard++) {
        // Spend XP greedily: initiative first, then a talent.
        let roster = withRoster(p).roster;
        for (const x of roster) {
          while (canPromote(roster.find((y) => y.id === x.id)!)) roster = promote(roster, x.id);
          const now = roster.find((y) => y.id === x.id)!;
          if (canLearnTalent(now)) roster = learnTalent(roster, x.id, talentOptions(now)[0]);
        }
        p = { ...p, roster };
        const m = missionBoard(p)[0];
        const prep = prepareCrew(m, p);
        p = prep.progress;
        const { def, notes } = missionAsFlown(m, p, prep.crew);
        const g = playOut(missionGame(def, run * 1000 + guard));
        expect(g.phase).toBe('over');
        const won = g.mission!.result === 'win' ? 'win' : 'loss';
        p = recordMission(p, m.id, won, missionReport(g));
        const threat = notes.find((n) => n.startsWith('Threat'))?.slice(0, 8) ?? 'Threat 0';
        lines.push(`run ${run} #${guard + 1} ${m.id} ${won} ${threat} lost:${withRoster(p).roster.filter((x) => x.status === 'lost').length}`);
      }
      expect(campaignOver(p)).toBe(true);
    }
    console.log(lines.join('\n'));
  }, 900000);
});
