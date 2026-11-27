// The way in: a start menu (Campaign or Skirmish), and the campaign's screens with progress saved in this browser:
// naming the officer, the training track, graduation, each operation's mission board, the end of the campaign,
// and every mission's briefing. Only the screens live here; main.ts plays the missions.
import {
  OPERATIONS, SHIP_TYPES, TRAINING, campaignOver, currentOperation, findCampaignMission, missionAsFlown, missionBoard,
  newCampaign, recordMission, type CampaignMission, type CampaignProgress, type MissionDef,
} from '@xw/engine';

const PROGRESS_KEY = 'xw-campaign';
/** Training progress, the officer's name, and the campaign after graduation (absent until then). */
interface Progress { done: string[]; skipped: boolean; officer: string; campaign: CampaignProgress | null }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') as Partial<Progress>;
    const c = p.campaign;
    return {
      done: Array.isArray(p.done) ? p.done : [], skipped: !!p.skipped, officer: typeof p.officer === 'string' ? p.officer : '',
      campaign: c && Array.isArray(c.flags) && Array.isArray(c.history) ? c : null,
    };
  } catch { return { done: [], skipped: false, officer: '', campaign: null }; }
}
function saveProgress(p: Progress) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: progress lasts this visit */ }
}
/** The officer's name, for their ship in every mission. */
export const officerName = () => loadProgress().officer || 'Cadet';
/** `{officer}` in command's lines becomes the officer's name. */
const named = (s: string) => esc(s).replace(/\{officer\}/g, esc(officerName()));

/** Record a won training mission. */
export function markDone(id: string) {
  const p = loadProgress();
  if (!p.done.includes(id)) p.done.push(id);
  saveProgress(p);
}
/** Record a flown campaign mission (once: the board then moves on). */
export function recordCampaign(id: string, result: 'win' | 'loss') {
  const p = loadProgress();
  if (p.campaign) saveProgress({ ...p, campaign: recordMission(p.campaign, id, result) });
}
/** A training mission can be played once every mission before it is done (or training was skipped). */
export const unlocked = (m: MissionDef, p = loadProgress()) => p.skipped || TRAINING.filter((x) => x.number < m.number).every((x) => p.done.includes(x.id));
/** The training mission after this one, if any. */
export const nextMission = (m: MissionDef) => (TRAINING.includes(m) ? TRAINING.find((x) => x.number === m.number + 1) : undefined);
const trainingDone = (p: Progress) => p.skipped || TRAINING.every((m) => p.done.includes(m.id));

/** A full-screen panel like the squad builder's; returns it and a function that removes it. */
function overlay(id: string, html: string) {
  document.getElementById(id)?.remove();
  const root = document.createElement('div');
  root.id = id;
  root.className = 'menu-screen';
  root.innerHTML = `<div class="menu-inner">${html}</div>`;
  document.body.appendChild(root);
  return { root, close: () => root.remove() };
}

/** The campaign button's second line: where the campaign stands. */
function campaignStatus(p: Progress) {
  if (p.campaign) {
    const op = currentOperation(p.campaign);
    return op ? `Lieutenant ${esc(p.officer)} · Operation ${op.number} of ${OPERATIONS.length}: ${esc(op.title)}` : 'Campaign complete. See how it ended, or start again.';
  }
  if (p.officer) return trainingDone(p) ? `Cadet ${esc(p.officer)} · training complete: take command` : `Cadet ${esc(p.officer)} · training: ${p.done.length} of ${TRAINING.length} missions done`;
  return 'Train as a new officer in eight short missions, then lead a squadron where every choice counts.';
}

/** The start menu: the campaign or a skirmish (the squad builder). */
export function openStart(go: { campaign(): void; skirmish(): void }) {
  const p = loadProgress();
  const { root, close } = overlay('start', `
    <h1 class="menu-title">Squadron Tactics</h1>
    <p class="hint menu-sub">Starfighter battles, one maneuver at a time.</p>
    <div class="menu-choices">
      <button class="menu-choice primary" id="st-campaign">
        <b>${p.officer ? 'Continue campaign' : 'Start campaign'}</b>
        <span>${campaignStatus(p)}</span>
      </button>
      <button class="menu-choice" id="st-skirmish">
        <b>Skirmish</b>
        <span>Build a squad and fight the AI, a friend on this device, or online.</span>
      </button>
    </div>`);
  root.querySelector<HTMLButtonElement>('#st-campaign')!.onclick = () => { close(); go.campaign(); };
  root.querySelector<HTMLButtonElement>('#st-skirmish')!.onclick = () => { close(); go.skirmish(); };
  root.querySelector<HTMLButtonElement>('#st-campaign')!.focus();
}

export interface CampaignNav {
  /** Brief a training mission. */
  train(m: MissionDef): void;
  /** Brief a mission from the board. */
  fly(m: CampaignMission): void;
  back(): void;
}

/** The campaign: whichever screen comes next (name, training, graduation, the board, or the end). */
export function openCampaign(go: CampaignNav) {
  const p = loadProgress();
  if (!p.officer) return openNaming(go);
  if (p.campaign) return campaignOver(p.campaign) ? openEnding(p, go) : openBoard(p, go);
  if (trainingDone(p)) return openGraduation(p, go);
  openTraining(go);
}

/** A new campaign starts by naming the officer. */
function openNaming(go: CampaignNav) {
  const { root, close } = overlay('campaign', `
    <div class="briefing-card">
      <div class="finale-kicker">Flight school · Enrolment</div>
      <h1>Name your officer</h1>
      <p class="quote">"Another cadet. Name, for the roster?"<span class="hint"> Commander Ress</span></p>
      <p>You fly as this officer in every mission: their ship carries the name.</p>
      <input id="cp-name" class="name-input" maxlength="24" placeholder="e.g. Rhea Sol" autocomplete="off">
      <div class="finale-buttons"><button class="opt" id="cp-back">Back</button><button class="go" id="cp-go" disabled>Enrol</button></div>
    </div>`);
  const input = root.querySelector<HTMLInputElement>('#cp-name')!, ok = root.querySelector<HTMLButtonElement>('#cp-go')!;
  input.oninput = () => { ok.disabled = !input.value.trim(); };
  const enrol = () => {
    const officer = input.value.trim().slice(0, 24);
    if (!officer) return;
    saveProgress({ ...loadProgress(), officer });
    close();
    openCampaign(go);
  };
  ok.onclick = enrol;
  input.onkeydown = (e) => { if (e.key === 'Enter') enrol(); };
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); go.back(); };
  input.focus();
}

/** The training track: done, next up, or locked. `replay`: opened from the board, to fly a lesson again. */
function openTraining(go: CampaignNav, replay = false) {
  const p = loadProgress();
  const next = replay ? undefined : TRAINING.find((m) => !p.done.includes(m.id) && unlocked(m, p));
  const row = (m: MissionDef) => {
    const done = p.done.includes(m.id), open = replay || unlocked(m, p);
    const state = done ? 'done' : open ? 'open' : 'locked';
    return `<li class="mission ${state}${m === next ? ' next' : ''}">
      <span class="mission-no">${done ? '✓' : m.number}</span>
      <div class="mission-text"><b>${esc(m.title)}</b><span class="hint">${esc(m.teaches)}</span></div>
      ${open ? `<button class="${m === next ? 'go' : 'opt'} mini" data-play="${m.id}">${done ? 'Replay' : 'Play'}</button>` : '<span class="hint">Locked</span>'}
    </li>`;
  };
  const { root, close } = overlay('campaign', `
    <div class="setup-head"><h1>Flight School</h1><button class="opt mini" id="cp-back">Back</button></div>
    <p class="hint">${replay ? 'Fly any lesson again. Replays don\'t change the campaign.'
      : `Cadet ${esc(p.officer)}: each mission teaches one new rule. Win it to unlock the next, and graduate after the eighth. Already know how to play? Skip ahead.`}</p>
    <ol class="mission-list">${TRAINING.map(row).join('')}</ol>
    ${replay ? '' : '<div class="row"><button class="opt mini" id="cp-skip">Skip training and graduate</button></div>'}`);
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); replay ? openCampaign(go) : go.back(); };
  root.querySelector<HTMLButtonElement>('#cp-skip')?.addEventListener('click', () => {
    if (!confirm('Skip the training missions and graduate now?')) return;
    saveProgress({ ...loadProgress(), skipped: true });
    close();
    openCampaign(go);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => {
    b.onclick = () => { close(); go.train(TRAINING.find((m) => m.id === b.dataset.play)!); };
  });
  (root.querySelector<HTMLButtonElement>('.mission.next [data-play]') ?? root.querySelector<HTMLButtonElement>('#cp-back'))!.focus();
}

/** Training is over: the cadet is commissioned and takes command. */
function openGraduation(p: Progress, go: CampaignNav) {
  const { root, close } = overlay('campaign', `
    <div class="briefing-card graduation">
      <div class="finale-kicker">Flight school · Graduation</div>
      <h1>Lieutenant ${esc(p.officer)}</h1>
      <p class="quote">"You came in a cadet and you leave an officer. The Outer Reach needs pilots who think. Go and lead some."<span class="hint"> Commander Ress</span></p>
      <p>From here on you command a squadron. Each operation offers two to four missions and you fly <b>one</b>: the rest go away.
        Win or lose, there is no second try. What happens shapes the missions that come next and who flies them.</p>
      <div class="finale-buttons"><button class="opt" id="cp-back">Back</button><button class="go" id="cp-go">Take command</button></div>
    </div>`);
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#cp-go')!.onclick = () => {
    saveProgress({ ...loadProgress(), campaign: newCampaign(p.officer) });
    close();
    openCampaign(go);
  };
  root.querySelector<HTMLButtonElement>('#cp-go')!.focus();
}

const pips = (n: number) => `<span class="pips" title="Difficulty ${n} of 3" aria-label="Difficulty ${n} of 3">${'●'.repeat(n)}${'○'.repeat(3 - n)}</span>`;
const resultMark = (r: 'win' | 'loss') => (r === 'win' ? '<span class="won">✓ won</span>' : '<span class="lost">✗ lost</span>');

/** What the campaign has flown so far: one line per operation. */
function historyHtml(c: CampaignProgress) {
  if (!c.history.length) return '';
  return `<details class="legend"><summary>Campaign so far</summary><ol class="history">${c.history.map((h) => {
    const m = findCampaignMission(h.mission)!;
    return `<li><b>${esc(m.title)}</b> ${resultMark(h.result)}<br><span class="hint">${esc(m.outcome[h.result].text)}</span></li>`;
  }).join('')}</ol></details>`;
}

/** The current operation's board: pick one mission. */
function openBoard(p: Progress, go: CampaignNav) {
  const c = p.campaign!, op = currentOperation(c)!;
  const card = (m: CampaignMission) => {
    const { notes } = missionAsFlown(m, c);
    return `<li class="board-card">
      <div class="board-head"><b>${esc(m.title)}</b>${pips(m.difficulty)}</div>
      <p>${esc(m.summary)}</p>
      <p class="hint">At stake: ${esc(m.stakes)}</p>
      ${notes.map((n) => `<p class="hint note">${esc(n)}</p>`).join('')}
      <button class="go mini" data-fly="${m.id}">Brief me</button>
    </li>`;
  };
  const { root, close } = overlay('campaign', `
    <div class="setup-head"><h1>Operation ${op.number}: ${esc(op.title)}</h1><button class="opt mini" id="cp-back">Back</button></div>
    <p class="quote">"${named(op.intro)}"<span class="hint"> Command</span></p>
    <p class="hint">Choose one mission. The others go away once you fly it.</p>
    <ul class="board">${missionBoard(c).map(card).join('')}</ul>
    ${historyHtml(c)}
    <div class="row"><button class="opt mini" id="cp-train">Flight school (replay a lesson)</button></div>`);
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#cp-train')!.onclick = () => { close(); openTraining(go, true); };
  root.querySelectorAll<HTMLButtonElement>('[data-fly]').forEach((b) => {
    b.onclick = () => { close(); go.fly(findCampaignMission(b.dataset.fly!)!); };
  });
  root.querySelector<HTMLButtonElement>('[data-fly]')?.focus();
}

/** Every operation flown: how the campaign ended, and a fresh start. */
function openEnding(p: Progress, go: CampaignNav) {
  const c = p.campaign!;
  const won = c.flags.includes('victory');
  const { root, close } = overlay('campaign', `
    <div class="briefing-card">
      <div class="finale-kicker">Campaign complete · ${c.history.filter((h) => h.result === 'win').length} of ${c.history.length} missions won</div>
      <h1>${won ? 'The Outer Reach is safe' : 'The fight goes on'}</h1>
      <p>${esc(findCampaignMission(c.history.at(-1)!.mission)!.outcome[c.history.at(-1)!.result].text)}</p>
      <ol class="history">${c.history.map((h) => `<li><b>${esc(findCampaignMission(h.mission)!.title)}</b> ${resultMark(h.result)}</li>`).join('')}</ol>
      <div class="finale-buttons"><button class="opt" id="cp-back">Back</button><button class="go" id="cp-new">New campaign</button></div>
    </div>`);
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#cp-new')!.onclick = () => {
    if (!confirm('Start a new campaign? Your officer keeps their training; the operations start over.')) return;
    saveProgress({ ...loadProgress(), campaign: newCampaign(p.officer) });
    close();
    openCampaign(go);
  };
  root.querySelector<HTMLButtonElement>('#cp-new')!.focus();
}

/** Extra lines for a campaign mission's briefing. */
export interface BriefingExtras { kicker: string; notes?: string[]; final?: boolean }

/** A mission's briefing: command's words, the idea, the objectives and the forces, then Begin. */
export function openBriefing(m: MissionDef, x: BriefingExtras, go: { begin(): void; back(): void }) {
  const officer = officerName();
  const ships = (xs: MissionDef['player']) => xs.map((s) => `${esc(s.tags?.includes('officer') ? officer : s.name ?? s.pilotId)} <span class="hint">(${esc(SHIP_TYPES[s.shipType ?? 'kestrel']?.name ?? '')})</span>`).join(', ');
  const { root, close } = overlay('briefing', `
    <div class="briefing-card">
      <div class="finale-kicker">${esc(x.kicker)}</div>
      <h1>${esc(m.title)}</h1>
      ${m.intro ? `<p class="quote">"${named(m.intro)}"<span class="hint"> ${x.final ? 'Command' : 'Commander Ress'}</span></p>` : ''}
      ${m.briefing.map((t) => `<p>${named(t)}</p>`).join('')}
      ${(x.notes ?? []).map((n) => `<p class="hint note">${esc(n)}</p>`).join('')}
      <h3>Objectives</h3>
      <ul class="objective-list">${m.objectives.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>
      <p class="hint">Your ships: ${ships(m.player)}${m.enemy.length ? `<br>Opposition: ${ships(m.enemy)}` : ''}<br>Round limit: ${m.maxRounds}</p>
      ${x.final ? '<p class="hint warn">You fly this mission once. Win or lose, the other missions on the board go away.</p>' : ''}
      <div class="finale-buttons"><button class="opt" id="br-back">Back</button><button class="go" id="br-go">${x.final ? 'Launch' : 'Begin'}</button></div>
    </div>`);
  root.querySelector<HTMLButtonElement>('#br-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#br-go')!.onclick = () => { close(); go.begin(); };
  root.querySelector<HTMLButtonElement>('#br-go')!.focus();
}

/** A board mission as it will be flown, with its briefing extras. */
export function campaignBriefing(m: CampaignMission): { def: MissionDef; extras: BriefingExtras } {
  const c = loadProgress().campaign ?? newCampaign(officerName());
  const op = OPERATIONS.find((o) => o.missions.includes(m))!;
  const { def, notes } = missionAsFlown(m, c);
  return { def, extras: { kicker: `Operation ${op.number} · ${op.title}`, notes, final: true } };
}
