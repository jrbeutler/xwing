// The way into the game: a start menu (Campaign or Skirmish), the campaign's mission list with progress saved
// in this browser, and each mission's briefing. Only the screens live here; main.ts plays the missions.
import { SHIP_TYPES, TRAINING, type MissionDef } from '@xw/engine';

const PROGRESS_KEY = 'xw-campaign';
interface Progress { done: string[]; skipped: boolean }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function loadProgress(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}') as Partial<Progress>;
    return { done: Array.isArray(p.done) ? p.done : [], skipped: !!p.skipped };
  } catch { return { done: [], skipped: false }; }
}
function saveProgress(p: Progress) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: progress lasts this visit */ }
}
/** Record a won mission. */
export function markDone(id: string) {
  const p = loadProgress();
  if (!p.done.includes(id)) p.done.push(id);
  saveProgress(p);
}
/** A mission can be played once every mission before it is done (or training was skipped). */
export const unlocked = (m: MissionDef, p = loadProgress()) => p.skipped || TRAINING.filter((x) => x.number < m.number).every((x) => p.done.includes(x.id));
/** The mission after this one, if any. */
export const nextMission = (m: MissionDef) => TRAINING.find((x) => x.number === m.number + 1);

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

/** The start menu: the campaign (the training track for now) or a skirmish (the squad builder). */
export function openStart(go: { campaign(): void; skirmish(): void }) {
  const p = loadProgress();
  const started = p.done.length > 0;
  const { root, close } = overlay('start', `
    <h1 class="menu-title">Squadron Tactics</h1>
    <p class="hint menu-sub">Starfighter battles, one maneuver at a time.</p>
    <div class="menu-choices">
      <button class="menu-choice primary" id="st-campaign">
        <b>${started ? 'Continue campaign' : 'Start campaign'}</b>
        <span>${started ? `Training: ${p.done.length} of ${TRAINING.length} missions done` : 'Learn to fly in eight short training missions, one new idea at a time.'}</span>
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

/** The campaign's missions: done, next up, or locked. */
export function openCampaign(go: { play(m: MissionDef): void; back(): void }) {
  const p = loadProgress();
  const next = TRAINING.find((m) => !p.done.includes(m.id) && unlocked(m, p));
  const row = (m: MissionDef) => {
    const done = p.done.includes(m.id), open = unlocked(m, p);
    const state = done ? 'done' : open ? 'open' : 'locked';
    return `<li class="mission ${state}${m === next ? ' next' : ''}">
      <span class="mission-no">${done ? '✓' : m.number}</span>
      <div class="mission-text"><b>${esc(m.title)}</b><span class="hint">${esc(m.teaches)}</span></div>
      ${open ? `<button class="${m === next ? 'go' : 'opt'} mini" data-play="${m.id}">${done ? 'Replay' : 'Play'}</button>` : '<span class="hint">Locked</span>'}
    </li>`;
  };
  const { root, close } = overlay('campaign', `
    <div class="setup-head"><h1>Campaign · Training</h1><button class="opt mini" id="cp-back">Back</button></div>
    <p class="hint">Each mission teaches one new rule. Win one to unlock the next.${p.skipped ? '' : ' Already know how to play? Skip ahead.'}</p>
    <ol class="mission-list">${TRAINING.map(row).join('')}</ol>
    ${p.skipped ? '' : '<div class="row"><button class="opt mini" id="cp-skip">Skip training (unlock every mission)</button></div>'}`);
  root.querySelector<HTMLButtonElement>('#cp-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#cp-skip')?.addEventListener('click', () => {
    if (!confirm('Unlock every training mission?')) return;
    saveProgress({ ...loadProgress(), skipped: true });
    close();
    openCampaign(go);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => {
    b.onclick = () => { close(); go.play(TRAINING.find((m) => m.id === b.dataset.play)!); };
  });
  (root.querySelector<HTMLButtonElement>('.mission.next [data-play]') ?? root.querySelector<HTMLButtonElement>('#cp-back'))!.focus();
}

/** A mission's briefing: the new idea, the objectives and the forces, then Begin. */
export function openBriefing(m: MissionDef, go: { begin(): void; back(): void }) {
  const ships = (xs: MissionDef['player']) => xs.map((s) => `${esc(s.name ?? s.pilotId)} <span class="hint">(${esc(SHIP_TYPES[s.shipType ?? 'kestrel']?.name ?? '')})</span>`).join(', ');
  const { root, close } = overlay('briefing', `
    <div class="briefing-card">
      <div class="finale-kicker">Training · Mission ${m.number}</div>
      <h1>${esc(m.title)}</h1>
      ${m.briefing.map((t) => `<p>${esc(t)}</p>`).join('')}
      <h3>Objectives</h3>
      <ul class="objective-list">${m.objectives.map((o) => `<li>${esc(o.label)}</li>`).join('')}</ul>
      <p class="hint">Your ships: ${ships(m.player)}${m.enemy.length ? `<br>Opposition: ${ships(m.enemy)}` : ''}<br>Round limit: ${m.maxRounds}</p>
      <div class="finale-buttons"><button class="opt" id="br-back">Back</button><button class="go" id="br-go">Begin</button></div>
    </div>`);
  root.querySelector<HTMLButtonElement>('#br-back')!.onclick = () => { close(); go.back(); };
  root.querySelector<HTMLButtonElement>('#br-go')!.onclick = () => { close(); go.begin(); };
  root.querySelector<HTMLButtonElement>('#br-go')!.focus();
}
