import {
  BASE_SIZE, SHIP_TYPES, aiDecide, apply, attackOdds, legalTargets, legalDial, maneuverFinalPose, maneuverLabel, maneuverPath, quickSkirmish,
  viewFor, type ActionChoice, type Pose, type Bearing, type Command, type GameEvent, type GameState, type ShipState,
} from '@xw/engine';
import { BattleScene } from './scene';

const HUMAN = 'p1';
const AI = 'p2';

const scene = new BattleScene(document.getElementById('viewport')!);
const panel = document.getElementById('panel')!;
const logEl = document.getElementById('log')!;
const roundEl = document.getElementById('round')!;
const phaseEl = document.getElementById('phase')!;
// The panel holds a compact bar (phones) and the full detail view (desktop, or the phone's pull-up sheet).
const bar = document.createElement('div');
bar.className = 'bar';
const detail = document.createElement('div');
detail.className = 'detail';
panel.append(bar, detail);
const ticker = document.createElement('button');
ticker.id = 'ticker';
ticker.setAttribute('aria-label', 'Show battle log');
document.body.appendChild(ticker);
ticker.onclick = () => logEl.classList.toggle('open');
const viewBtn = document.createElement('button');
viewBtn.id = 'viewbtn';
viewBtn.setAttribute('aria-label', 'Toggle overview');
document.getElementById('hud')!.appendChild(viewBtn);
viewBtn.onclick = () => { userOverview = !userOverview; applyCamera(); };
const speedBtn = document.createElement('button');
speedBtn.id = 'speedbtn';
speedBtn.setAttribute('aria-label', 'Animation speed');
document.getElementById('hud')!.appendChild(speedBtn);
const setSpeed = (v: number) => {
  scene.speed = v;
  speedBtn.textContent = `${v}×`;
  try { localStorage.setItem('xw-speed', String(v)); } catch { /* storage unavailable */ }
};
speedBtn.onclick = () => setSpeed(scene.speed === 1 ? 2 : 1);
try { setSpeed(localStorage.getItem('xw-speed') === '2' ? 2 : 1); } catch { setSpeed(1); }

let state: GameState;
let shown = 0; // index of the next log event to present
let plan: Record<string, number> = {};
let busy = false;

const GLYPH: Record<Bearing, string> = {
  straight: '↑', bankLeft: '↖', bankRight: '↗', turnLeft: '↰', turnRight: '↱', kturn: '⤸',
  sloopLeft: '⤺', sloopRight: '⤻', trollLeft: '↶', trollRight: '↷', stop: '■',
  reverseStraight: '↓', reverseBankLeft: '↙', reverseBankRight: '↘',
};

const shipById = (id: string) => state.ships.find((s) => s.id === id)!;
const sizeOf = (s: ShipState) => BASE_SIZE[SHIP_TYPES[s.typeId].size];
const nameHtml = (id: string) => { const s = shipById(id); return `<span class="${s.owner}c">${s.name}</span>`; };

function newGame() {
  state = quickSkirmish((Math.random() * 1e9) | 0);
  shown = 0;
  plan = {};
  logEl.innerHTML = '';
  roundShots = [];
  hideRecap();
  disp = structuredClone(state.ships);
  scene.clearShips();
  scene.setObstacles(state.obstacles);
  scene.syncShips(state.ships);
  pump();
}

/** Send a human command, then let the AI act until a human decision is needed. */
async function send(cmd: Command) {
  if (busy) return;
  mode = null;
  scene.clearChips();
  scene.clearGhost();
  scene.clearOverlay();
  scene.setMarkers([]);
  state = apply(state, cmd);
  await pump();
}

async function pump() {
  busy = true;
  detail.innerHTML = '<p class="hint">Resolving…</p>';
  setBar({ status: '<span class="hint">Resolving…</span>' });
  applyCamera();
  try {
    for (;;) {
      await present();
      const d = state.pending;
      if (!d) break;
      const aiTurn = d.kind === 'planning' ? d.waitingOn.includes(AI) : d.playerId === AI;
      if (!aiTurn) break;
      // The AI sees the same redacted view a network client would (RNG kept for its private jitter seed).
      state = apply(state, aiDecide({ ...viewFor(state, AI), rng: state.rng }, AI)!);
    }
  } finally {
    busy = false;
  }
  render();
}

// ---------------------------------------------------------------------------
// Event presentation
// ---------------------------------------------------------------------------
// What the board currently shows. Events are applied to it one by one as they animate,
// so health markers drop the moment a shot lands, not when the whole round is done.
let disp: ShipState[] = [];
const dispShip = (id: string) => disp.find((x) => x.id === id);
const relabel = (id: string) => { const d = dispShip(id); if (d) scene.refreshLabel(d); };

/** One-line summaries of this round's shots, shown as a recap when the next round starts. */
let roundShots: string[] = [];
let recapRound = 0;

function logLine(e: GameEvent) {
  const text = describe(e);
  if (!text) return;
  const div = document.createElement('div');
  div.innerHTML = text;
  if (e.type === 'attack' || e.type === 'destroyed' || e.type === 'roundStart') div.className = 'hl';
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  ticker.innerHTML = text;
}

async function present() {
  while (shown < state.log.length) {
    const e = state.log[shown++];
    scene.skipping = false; // a tap skips one event's animation at a time
    // Attack results are logged after the shots land, so the log never spoils the outcome.
    const late = e.type === 'attack' || e.type === 'destroyed';
    if (!late) logLine(e);
    await animate(e);
    if (late) logLine(e);
  }
  scene.skipping = false;
  scene.syncShips(state.ships);
  disp = structuredClone(state.ships);
  roundEl.textContent = `Round ${state.round}`;
  phaseEl.textContent = state.phase;
}

async function animate(e: GameEvent) {
  switch (e.type) {
    case 'phase':
      phaseEl.textContent = e.phase;
      if (e.phase === 'end') for (const d of disp) { d.focus = 0; d.evade = 0; relabel(d.id); }
      return;
    case 'roundStart':
      roundEl.textContent = `Round ${e.round}`;
      if (roundShots.length) showRecap(recapRound, roundShots);
      roundShots = [];
      recapRound = e.round;
      return;
    case 'moved': {
      scene.highlight(e.shipId);
      scene.showArcs([]);
      scene.setOdds({});
      await scene.animatePath(e.shipId, e.path, e.final, 500 + e.path.length * 15);
      const d = dispShip(e.shipId);
      if (d) d.pose = e.final;
      if (e.partial) await scene.floatText(e.shipId, 'BUMP', 'p2c');
      return;
    }
    case 'stress': {
      const d = dispShip(e.shipId);
      if (d) { d.stress += e.delta; relabel(e.shipId); }
      return;
    }
    case 'action': {
      const d = dispShip(e.shipId);
      if (e.action.type === 'barrelRoll' || e.action.type === 'boost') {
        const from = d?.pose ?? e.action.to;
        await scene.animatePath(e.shipId, [from, e.action.to], e.action.to, 400);
        if (d) d.pose = e.action.to;
      }
      if (d) {
        if (e.action.type === 'focus') d.focus++;
        if (e.action.type === 'evade') d.evade++;
        if (e.action.type === 'lock') d.lock = e.action.targetId;
        relabel(e.shipId);
      }
      return;
    }
    case 'attack':
      await showAttack(e);
      return;
    case 'obstacleHit': {
      const hit = e.result === 'hit' || e.result === 'crit';
      const d = dispShip(e.shipId);
      if (hit && d) {
        if (d.shields > 0) { d.shields--; void scene.shieldFlash(e.shipId); } else { d.hull--; void scene.sparks(e.shipId); void scene.shake(e.shipId); }
        relabel(e.shipId);
      }
      await scene.floatText(e.shipId, hit ? 'ASTEROID −1' : 'ASTEROID', 'p2c');
      return;
    }
    case 'destroyed': {
      const name = shipById(e.shipId).name;
      roundShots.push(`<b>${nameHtml(e.shipId)} destroyed</b>`);
      showBanner(`<span class="who">${name}</span><b>DESTROYED</b>`, shipById(e.shipId).owner === HUMAN ? 'incoming big' : 'big');
      await scene.explode(e.shipId);
      await scene.wait(500);
      return;
    }
  }
}

type AttackEvent = Extract<GameEvent, { type: 'attack' }>;

/** Plain-language outcome of an attack (no dice). */
function attackOutcome(e: AttackEvent) {
  const dmg = e.shieldDamage + e.hullDamage;
  const rolled = e.attackFinal.filter((f) => f === 'hit' || f === 'crit').length;
  const parts = [e.shieldDamage ? `${e.shieldDamage} shield` : '', e.hullDamage ? `${e.hullDamage} hull` : ''].filter(Boolean);
  if (!dmg) return { word: rolled ? 'EVADED' : 'MISS', detail: rolled ? 'no damage' : 'all shots missed', cls: 'miss' };
  if (e.crits > 0 && e.hullDamage > 0) return { word: 'CRITICAL HIT', detail: parts.join(' · '), cls: 'crit' };
  return { word: 'HIT', detail: parts.join(' · '), cls: 'hit' };
}

async function showAttack(e: AttackEvent) {
  const a = shipById(e.attackerId), d = shipById(e.defenderId);
  const incoming = d.owner === HUMAN;
  const color = a.owner === HUMAN ? 0xff4d4d : 0x52ff7a;
  const ap = dispShip(a.id)?.pose ?? a.pose, dp = dispShip(d.id)?.pose ?? d.pose;

  // 1. Who shoots whom
  scene.setRings({ [a.id]: GREEN, [d.id]: RED });
  scene.showArcs([a.id]);
  scene.setOdds({});
  if (compact) framePoints([ap, dp], 150, 350);
  scene.showLine(ap, dp, incoming ? RED : 0xffd166, `${a.name} → ${d.name}`);
  await scene.wait(compact ? 650 : 450);
  scene.clearOverlay();

  // 2. Bolts: one per die rolled; the ones that got through hit, the rest streak past.
  const landed = e.hits + e.crits;
  const total = Math.max(landed, Math.min(5, e.attackFinal.length));
  const order = Array.from({ length: total }, (_, i) => i < landed);
  for (let i = order.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const units = e.shieldDamage + e.hullDamage;
  const target = dispShip(d.id);
  let hitNo = 0;
  const flights: Promise<void>[] = [];
  for (let i = 0; i < order.length; i++) {
    const hit = order[i];
    const end = scene.boltEnd(a.id, d.id, hit, i);
    if (!end) continue;
    const n = hit ? hitNo++ : -1;
    flights.push(scene.bolt(a.id, end, color).then(() => {
      if (!hit) return;
      const crit = n >= e.hits; // crits are applied after hits
      if (n < e.shieldDamage) {
        if (target) target.shields--;
        void scene.shieldFlash(d.id);
      } else if (n < units) {
        if (target) target.hull--;
        void scene.sparks(d.id, crit ? 0xffd27a : 0xffa040, crit ? 40 : 26, crit);
        void scene.shake(d.id, crit ? 450 : 300, crit ? 5 : 3);
      } else {
        void scene.sparks(d.id); // overkill on a ship that is already finished
      }
      relabel(d.id);
    }));
    await scene.wait(110);
  }
  await Promise.all(flights);

  // Spent tokens leave the labels
  const ad = dispShip(a.id);
  for (const t of e.spent) {
    if (t === 'attacker:focus' && ad) ad.focus--;
    if (t === 'attacker:lock' && ad) ad.lock = null;
    if (t === 'defender:focus' && target) target.focus--;
    if (t === 'defender:evade' && target) target.evade--;
  }
  relabel(a.id);
  relabel(d.id);

  // 3. Result
  const o = attackOutcome(e);
  if (o.cls === 'miss' && o.word === 'EVADED') void scene.dodge(d.id);
  showBanner(`<span class="who">${a.name} → ${d.name}</span><b>${o.word}</b><span class="detail">${o.detail}</span>`,
    `${o.cls}${incoming ? ' incoming' : ''}`);
  roundShots.push(`${nameHtml(a.id)} → ${nameHtml(d.id)}: <b class="${o.cls}">${o.word === 'HIT' || o.word === 'CRITICAL HIT' ? o.detail : o.word.toLowerCase()}</b>`);
  await scene.wait(1100);
  scene.showArcs([]);
}

// ---------------------------------------------------------------------------
// Banner + round recap
// ---------------------------------------------------------------------------
const banner = document.createElement('div');
banner.id = 'banner';
banner.setAttribute('role', 'status');
banner.setAttribute('aria-live', 'polite');
document.body.appendChild(banner);
let bannerTimer = 0;
function showBanner(html: string, cls: string) {
  banner.className = cls;
  banner.innerHTML = html;
  void banner.offsetWidth; // restart the pop-in animation
  banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => banner.classList.remove('show'), 1600 / scene.speed);
}

const recap = document.createElement('div');
recap.id = 'recap';
recap.hidden = true;
document.body.appendChild(recap);
function showRecap(round: number, lines: string[]) {
  recap.innerHTML = `<div class="recap-head"><b>Round ${round} combat</b><button class="recap-close" aria-label="Close recap">Close</button></div>` +
    lines.map((l) => `<div>${l}</div>`).join('');
  recap.querySelector('.recap-close')!.addEventListener('click', hideRecap);
  recap.hidden = false;
}
function hideRecap() { recap.hidden = true; }

function describe(e: GameEvent): string | null {
  switch (e.type) {
    case 'roundStart': return `— Round ${e.round} —`;
    case 'dialRevealed': return `${nameHtml(e.shipId)} reveals ${maneuverLabel(e.maneuver)} (${e.maneuver.difficulty})`;
    case 'moved':
      if (e.fled) return `${nameHtml(e.shipId)} flew off the board`;
      if (e.partial) return `${nameHtml(e.shipId)} bumped ${e.bumped.map(nameHtml).join(', ')}`;
      return null;
    case 'stress': return e.delta > 0 ? `${nameHtml(e.shipId)} gains stress` : `${nameHtml(e.shipId)} clears stress`;
    case 'action': return e.action.type === 'none' ? null : `${nameHtml(e.shipId)} performs ${actionText(e.action)}`;
    case 'obstacleHit': return `${nameHtml(e.shipId)} clips an asteroid${e.result === 'hit' || e.result === 'crit' ? ': 1 damage' : ''}`;
    case 'attack': {
      const o = attackOutcome(e);
      return `${nameHtml(e.attackerId)} fires at ${nameHtml(e.defenderId)} (range ${e.range}${e.obstructed ? ', obstructed' : ''}): ` +
        `<b>${o.word === 'HIT' || o.word === 'CRITICAL HIT' ? `${o.word.toLowerCase()}, ${o.detail}` : o.word.toLowerCase()}</b>`;
    }
    case 'destroyed': return `💥 ${nameHtml(e.shipId)} destroyed`;
    case 'gameOver': return `<b>${e.winner === 'draw' ? 'Draw' : `${state.players.find((p) => p.id === e.winner)?.name} win`}</b>`;
    case 'info': return e.text;
    default: return null;
  }
}

function actionText(a: ActionChoice): string {
  switch (a.type) {
    case 'none': return 'no action';
    case 'focus': return 'Focus';
    case 'evade': return 'Evade';
    case 'lock': return `Lock on ${shipById(a.targetId).name}`;
    case 'barrelRoll': return `Barrel roll ${a.dir}${a.shift ? (a.shift > 0 ? ' (forward)' : ' (back)') : ''}`;
    case 'boost': return `Boost ${a.bearing === 'straight' ? 'straight' : a.bearing === 'bankLeft' ? 'left' : 'right'}`;
  }
}

// ---------------------------------------------------------------------------
// Decision panels
// ---------------------------------------------------------------------------
function render() {
  userOverview = false;
  renderDecision();
  applyCamera();
}

function renderDecision() {
  scene.clearGhost();
  scene.clearOverlay();
  scene.clearChips();
  scene.showArcs([]);
  scene.setOdds({});
  mode = null;
  const d = state.pending;
  if (state.phase === 'over' || !d) {
    scene.highlight(null);
    const won = state.winner === HUMAN;
    const title = state.winner === 'draw' ? 'Draw' : won ? 'Victory' : 'Defeat';
    detail.innerHTML = `<h2>${title}</h2>
      <p class="hint">Battle ended in round ${state.round}.</p><button class="go" id="again">New battle</button>`;
    document.getElementById('again')!.onclick = newGame;
    setBar({ status: `<b>${title}</b> <span class="hint">· round ${state.round}</span>`, buttons: [{ label: 'New battle', cls: 'primary', onClick: newGame }] });
    return;
  }
  if (d.kind === 'planning') {
    if (!selected || !shipById(selected) || shipById(selected).destroyed) {
      const first = myShips().find((s) => plan[s.id] === undefined);
      mode = planningMode;
      return selectShip(first ? first.id : null);
    }
    mode = planningMode;
    return renderPlanning();
  }
  scene.setPlanned([]);
  scene.setMarkers([]);
  if (d.kind === 'action') return renderAction(d.shipId, d.options);
  if (d.kind === 'attack') return renderAttack(d.shipId, d.targets);
}

// ---------------------------------------------------------------------------
// Planning: fly the ship on the board. Select a ship, move the pointer, and the
// ghost snaps to the nearest legal maneuver end position. Click/tap to commit.
// ---------------------------------------------------------------------------
const DIFF_COLOR = { blue: 0x4aa3ff, white: 0xe8eef8, red: 0xff5a5a } as const;
const BEARING_NAME: Record<Bearing, string> = {
  straight: 'straight', bankLeft: 'bank left', bankRight: 'bank right', turnLeft: 'turn left', turnRight: 'turn right',
  kturn: 'K-turn', sloopLeft: 'loop left', sloopRight: 'loop right', trollLeft: 'roll left', trollRight: 'roll right',
  stop: 'stop', reverseStraight: 'reverse', reverseBankLeft: 'reverse left', reverseBankRight: 'reverse right',
};
/** How far (mm) the pointer may be from a maneuver's end point and still snap to it. */
const SNAP_RADIUS = 140;

let selected: string | null = null;
let candidate: { group: number[]; flip: number } | null = null;
let lastPointer = 'mouse';
let pointerDown: { x: number; y: number; moved: boolean } | null = null;

interface SnapGroup { pos: { x: number; y: number }; idx: number[] }

/** Legal maneuvers grouped by end position (e.g. 4 straight and 4 K-turn end in the same spot). */
function snapGroups(s: ShipState): SnapGroup[] {
  const dial = SHIP_TYPES[s.typeId].dial;
  const groups: SnapGroup[] = [];
  for (const i of legalDial(state, s)) {
    const p = maneuverFinalPose(s.pose, sizeOf(s), dial[i]);
    const g = groups.find((x) => Math.hypot(x.pos.x - p.x, x.pos.y - p.y) < 2);
    if (g) g.idx.push(i); else groups.push({ pos: { x: p.x, y: p.y }, idx: [i] });
  }
  return groups;
}

const maneuverOf = (s: ShipState, i: number) => SHIP_TYPES[s.typeId].dial[i];
const maneuverName = (s: ShipState, i: number) => {
  const m = maneuverOf(s, i);
  return `<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span> ${BEARING_NAME[m.bearing]}`;
};
const ghostPoses = (s: ShipState, i: number) => {
  const m = maneuverOf(s, i);
  return [...maneuverPath(s.pose, sizeOf(s), m).path, maneuverFinalPose(s.pose, sizeOf(s), m)];
};
const myShips = () => state.ships.filter((s) => s.owner === HUMAN && !s.destroyed);

function updateControls() {
  // On touch, dragging steers the ship, so the camera must not rotate while one is selected.
  scene.controls.enableRotate = !(selected && lastPointer !== 'mouse');
}

function selectShip(id: string | null) {
  selected = id;
  candidate = null;
  if (id && plan[id] !== undefined) {
    const s = shipById(id);
    const g = snapGroups(s).find((x) => x.idx.includes(plan[id]));
    if (g) candidate = { group: g.idx, flip: g.idx.indexOf(plan[id]) };
  }
  updateControls();
  renderPlanning();
  applyCamera();
}

function refreshBoard() {
  scene.highlight(selected);
  scene.setPlanned(
    myShips()
      .filter((s) => plan[s.id] !== undefined && s.id !== selected)
      .map((s) => ({ size: sizeOf(s), poses: ghostPoses(s, plan[s.id]), color: DIFF_COLOR[maneuverOf(s, plan[s.id]).difficulty] })),
  );
  planningBar();
  const cand = document.getElementById('cand');
  if (!selected) {
    scene.showArcs([]);
    scene.setOdds({});
    scene.setMarkers([]);
    scene.clearGhost();
    if (cand) cand.innerHTML = '';
    return;
  }
  const s = shipById(selected);
  const groups = snapGroups(s);
  scene.setMarkers(groups.map((g) => ({
    ...g.pos,
    color: DIFF_COLOR[maneuverOf(s, g.idx[0]).difficulty],
    active: candidate?.group[0] === g.idx[0],
  })));
  // Firing arcs: from where the ship will end up once a move is picked, else from where it is now.
  scene.showArcs(candidate ? [] : [s.id]);
  if (candidate) {
    const poses = ghostPoses(s, candidate.group[candidate.flip]);
    showOddsFrom(s, poses[poses.length - 1], true);
  } else showOddsFrom(s, s.pose, true);
  if (!candidate) {
    scene.clearGhost();
    if (cand) cand.innerHTML = `<p class="hint">Move the pointer toward a dot to steer ${s.name}.</p>`;
    return;
  }
  const i = candidate.group[candidate.flip];
  const m = maneuverOf(s, i);
  const alt = candidate.group.length > 1 ? candidate.group[(candidate.flip + 1) % candidate.group.length] : null;
  const flipHint = alt !== null ? `<div class="hint">F / Flip: ${BEARING_NAME[maneuverOf(s, alt).bearing]}</div>` : '';
  scene.showGhost(sizeOf(s), ghostPoses(s, i), DIFF_COLOR[m.difficulty], `${maneuverName(s, i)}${flipHint}`, s.id);
  if (cand) {
    cand.innerHTML = `<div class="cand-row"><span>${maneuverName(s, i)} <span class="hint">(${m.difficulty})</span></span>
      ${alt !== null ? '<button class="opt mini" id="flip">Flip</button>' : ''}
      <button class="opt mini confirm" id="confirm">Set</button></div>`;
    document.getElementById('flip')?.addEventListener('click', flip);
    document.getElementById('confirm')!.addEventListener('click', commit);
  }
}

function candidateAt(p: P) {
  if (!selected) return;
  const s = shipById(selected);
  const pt = scene.boardPoint(p.clientX, p.clientY);
  let best: SnapGroup | null = null, bestD = Infinity;
  for (const g of snapGroups(s)) {
    // Nearest on screen wins; accept it within a finger-sized radius or SNAP_RADIUS on the table.
    const d = screenDist(p, g.pos.x, g.pos.y);
    const near = d < fingerPx(p) || (pt !== null && Math.hypot(g.pos.x - pt.x, g.pos.y - pt.y) < SNAP_RADIUS);
    if (near && d < bestD) { bestD = d; best = g; }
  }
  const same = best && candidate && candidate.group[0] === best.idx[0];
  if (!same) candidate = best ? { group: best.idx, flip: 0 } : null;
  refreshBoard();
}

function flip() {
  if (!candidate || candidate.group.length < 2) return;
  candidate.flip = (candidate.flip + 1) % candidate.group.length;
  refreshBoard();
}

function commit() {
  if (!selected || !candidate) return;
  lastCommit = { shipId: selected, prev: plan[selected] };
  plan[selected] = candidate.group[candidate.flip];
  const next = myShips().find((s) => plan[s.id] === undefined);
  selectShip(next ? next.id : null);
}

function executePlan() {
  const mine = myShips();
  if (mine.some((s) => plan[s.id] === undefined)) return;
  const dials = Object.fromEntries(mine.map((s) => [s.id, plan[s.id]]));
  plan = {};
  selected = null;
  candidate = null;
  lastCommit = null;
  hideRecap();
  scene.setPlanned([]);
  scene.setMarkers([]);
  updateControls();
  send({ type: 'setDials', playerId: HUMAN, dials });
}

// ---------------------------------------------------------------------------
// Board input. Each decision type installs a BoardMode; the canvas listeners just
// dispatch to it. Mouse previews on hover, touch previews while dragging, and a
// click/tap (no drag) commits.
// ---------------------------------------------------------------------------
/** The pointer position a mode works with (touch drags are lifted above the finger). */
type P = { clientX: number; clientY: number; pointerType: string };
interface BoardMode {
  press?(p: P): void;
  hover?(p: P): void;
  click(p: P): void;
  release?(p: P): void;
  key?(e: KeyboardEvent): void;
}
let mode: BoardMode | null = null;

/** Touch previews are aimed this far above the finger so the finger does not hide the ghost. */
const FINGER_OFFSET = 64;
const lift = (e: PointerEvent): P =>
  e.pointerType === 'mouse' ? e : { clientX: e.clientX, clientY: e.clientY - FINGER_OFFSET, pointerType: e.pointerType };
const fingerPx = (p: P) => (p.pointerType === 'mouse' ? 0 : 56);
const screenDist = (p: P, x: number, y: number) => {
  const q = scene.screenPoint(x, y);
  return Math.hypot(q.x - p.clientX, q.y - p.clientY);
};

const canvas = scene.renderer.domElement;
const touches = new Set<number>();
let multi = false; // a two-finger camera gesture is in progress
canvas.addEventListener('pointerdown', (e) => {
  if (busy) scene.skipping = true; // tap the board to skip the current animation
  touches.add(e.pointerId);
  lastPointer = e.pointerType;
  updateControls();
  if (touches.size > 1) { multi = true; if (pointerDown) pointerDown.moved = true; return; }
  multi = false;
  pointerDown = { x: e.clientX, y: e.clientY, moved: false };
  if (!busy && mode && e.pointerType !== 'mouse') { mode.press?.(e); mode.hover?.(lift(e)); }
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 8) pointerDown.moved = true;
  if (busy || !mode || multi) return;
  if (e.pointerType === 'mouse' ? !pointerDown : !!pointerDown) mode.hover?.(lift(e));
});
canvas.addEventListener('pointerup', (e) => {
  touches.delete(e.pointerId);
  const down = pointerDown;
  pointerDown = null;
  if (multi) { if (touches.size === 0) multi = false; return; }
  if (busy || !mode || !down) return;
  if (down.moved) {
    // Mouse drag = camera move. Touch drag = steering; lifting the finger may commit.
    if (e.pointerType !== 'mouse') mode.release?.(lift(e));
    return;
  }
  mode.click(e);
});
canvas.addEventListener('pointercancel', (e) => {
  touches.delete(e.pointerId);
  pointerDown = null;
  if (touches.size === 0) multi = false;
});
addEventListener('keydown', (e) => { if (!busy && mode) mode.key?.(e); });

const planningMode: BoardMode = {
  press(p) {
    // Pressing on another of your ships selects it, so you can drag straight out of it.
    const picked = scene.pickShip(p.clientX, p.clientY);
    if (picked && picked !== selected && shipById(picked).owner === HUMAN) selectShip(picked);
  },
  hover(p) { if (selected) candidateAt(p); },
  click(p) {
    const picked = scene.pickShip(p.clientX, p.clientY);
    const mine = picked && shipById(picked).owner === HUMAN ? picked : null;
    if (mine && mine !== selected) return selectShip(mine);
    if (selected) {
      candidateAt(p);
      if (candidate) commit(); else selectShip(null);
    }
  },
  release() { if (selected && candidate) commit(); },
  key(e) {
    if (e.key === 'f' || e.key === 'F') flip();
    if (e.key === 'Escape') selectShip(null);
    if (e.key === 'Enter') { if (candidate) commit(); else executePlan(); }
  },
};

// ---------------------------------------------------------------------------
// Phone layout: a compact bar (bottom when upright, side rail when sideways),
// a camera that frames the uncovered part of the screen, and a log ticker.
// ---------------------------------------------------------------------------
let compact = false;
let userOverview = false;
let lastCommit: { shipId: string; prev: number | undefined } | null = null;

function updateLayout() {
  const c = Math.min(innerWidth, innerHeight) < 560 || innerWidth < 760;
  const portrait = innerHeight >= innerWidth;
  const root = document.documentElement.classList;
  root.toggle('compact', c);
  root.toggle('portrait', c && portrait);
  root.toggle('landscape', c && !portrait);
  if (c !== compact) {
    compact = c;
    panel.classList.remove('expanded');
    logEl.classList.remove('open');
    if (!c) scene.resetView();
    if (state && !busy) renderDecision();
  }
  applyCamera(250);
}
addEventListener('resize', () => updateLayout());

/** Screen area covered by UI, so the camera can frame what is left. */
function uiInsets() {
  const r = panel.getBoundingClientRect();
  const top = Math.max(ticker.getBoundingClientRect().bottom, 40) + 6;
  return innerHeight >= innerWidth
    ? { top, bottom: innerHeight - r.top + 6, left: 0, right: 0 }
    : { top: 44, bottom: 0, left: 0, right: innerWidth - r.left + 6 };
}

function applyCamera(ms = 500) {
  if (!compact || !state) return;
  const d = state.pending;
  // Points of interest for the current decision; null = show the whole table.
  let pts: { x: number; y: number }[] | null = null;
  let minHalf = 150;
  if (!busy && d) {
    if (d.kind === 'planning' && selected) {
      const s = shipById(selected);
      const fx = Math.cos(s.pose.h), fy = Math.sin(s.pose.h);
      pts = [{ x: s.pose.x + fx * 110, y: s.pose.y + fy * 110 }];
      minHalf = 190;
    }
    if (d.kind === 'action') {
      const s = shipById(d.shipId);
      pts = [s.pose, ...d.options.flatMap((o) => (o.type === 'lock' ? [shipById(o.targetId).pose] : []))];
      minHalf = 130;
    }
    if (d.kind === 'attack') pts = [shipById(d.shipId).pose, ...d.targets.map((t) => shipById(t.targetId).pose)];
  }
  viewBtn.hidden = !pts;
  viewBtn.textContent = userOverview ? 'Zoom in' : 'Overview';
  if (pts && !userOverview) framePoints(pts, minHalf, ms);
  else scene.frameRect(457, 457, 465, 465, uiInsets(), 0.2, ms);
}

/** Frame a set of board points (with room for bases and labels) in the uncovered screen area. */
function framePoints(pts: { x: number; y: number }[], minHalf: number, ms: number) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 110; // room for bases and their (wide) labels around the outermost ships
  scene.frameRect((x0 + x1) / 2, (y0 + y1) / 2,
    Math.max(minHalf, (x1 - x0) / 2 + pad), Math.max(minHalf, (y1 - y0) / 2 + pad), uiInsets(), 0.35, ms);
}

interface BarButton { label: string; cls?: string; disabled?: boolean; onClick: () => void }
function setBar(o: { status: string; ships?: HTMLElement; buttons?: BarButton[] }) {
  bar.innerHTML = `<div class="bar-top"><div class="bar-status">${o.status}</div>
    <button class="bar-more" aria-label="Show details">Details</button></div>`;
  bar.querySelector('.bar-more')!.addEventListener('click', () => panel.classList.toggle('expanded'));
  if (o.ships) bar.appendChild(o.ships);
  if (o.buttons?.length) {
    const row = document.createElement('div');
    row.className = 'bar-buttons';
    for (const b of o.buttons) {
      const el = document.createElement('button');
      el.className = b.cls ?? '';
      el.innerHTML = b.label;
      el.disabled = !!b.disabled;
      el.onclick = b.onClick;
      row.appendChild(el);
    }
    bar.appendChild(row);
  }
}

const shortMove = (s: ShipState, i: number) => {
  const m = maneuverOf(s, i);
  return `<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span>`;
};

function undoCommit() {
  if (!lastCommit) return;
  const { shipId, prev } = lastCommit;
  if (prev === undefined) delete plan[shipId]; else plan[shipId] = prev;
  lastCommit = null;
  selectShip(shipId);
}

function planningBar() {
  if (!compact) return;
  const mine = myShips();
  const ships = document.createElement('div');
  ships.className = 'bar-ships';
  for (const s of mine) {
    const b = document.createElement('button');
    b.className = 'sc' + (s.id === selected ? ' active' : '') + (plan[s.id] !== undefined ? ' done' : '');
    b.innerHTML = `<span class="sc-name">${s.name.split(' ')[0]} <i>${s.initiative}</i></span>
      <span class="sc-move">${plan[s.id] !== undefined ? shortMove(s, plan[s.id]) : '<span class="hint">not set</span>'}</span>`;
    b.onclick = () => selectShip(s.id);
    ships.appendChild(b);
  }
  const buttons: BarButton[] = [];
  let status: string;
  if (!selected) {
    status = mine.every((s) => plan[s.id] !== undefined) ? 'All moves set.' : 'Tap a ship to plan its move.';
  } else {
    const s = shipById(selected);
    if (candidate) {
      const i = candidate.group[candidate.flip];
      status = `<b>${s.name.split(' ')[0]}</b>: ${maneuverName(s, i)}`;
      if (candidate.group.length > 1) buttons.push({ label: 'Flip', onClick: flip });
      if (plan[s.id] !== i) buttons.push({ label: 'Set', cls: 'primary', onClick: commit });
    } else {
      status = `<b>${s.name.split(' ')[0]}</b>: drag on the board to steer`;
    }
  }
  if (lastCommit) buttons.unshift({ label: 'Undo', onClick: undoCommit });
  buttons.push({ label: 'Execute', cls: 'go-btn', disabled: mine.some((s) => plan[s.id] === undefined), onClick: executePlan });
  setBar({ status, ships, buttons });
}

function renderPlanning() {
  const mine = myShips();
  detail.innerHTML = `<h2>Planning</h2><p class="hint">Click a ship, then move the pointer: the ghost snaps to each maneuver it can fly.
    Click to set it. <b>F</b> flips between moves that end in the same spot (e.g. straight / K-turn). Blue clears stress, red adds it.</p>`;
  for (const s of mine) {
    const t = SHIP_TYPES[s.typeId];
    const card = document.createElement('div');
    card.className = 'card' + (plan[s.id] !== undefined ? ' done' : '') + (s.id === selected ? ' active' : '');
    card.innerHTML = `<h3>${s.name} <span class="hint">· ${t.name} · init ${s.initiative}</span></h3>
      <div class="stats">atk ${t.primaries.map((p) => `${p.attack}${p.arc === 'rear' ? 'R' : ''}`).join('/')} · agi ${t.agility} · hull ${s.hull}/${t.hull} · shields ${s.shields}/${t.shields}${s.stress ? ` · <span style="color:var(--red)">stressed</span>` : ''}</div>
      <div class="planned">${plan[s.id] !== undefined ? maneuverName(s, plan[s.id]) : '<span class="hint">No maneuver set</span>'}</div>`;
    card.onclick = (e) => { if (!(e.target as HTMLElement).closest('details, button')) selectShip(s.id); };
    if (s.id === selected) {
      const cand = document.createElement('div');
      cand.id = 'cand';
      card.appendChild(cand);
    }
    card.appendChild(dialFallback(s));
    detail.appendChild(card);
  }
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'Reveal dials & execute';
  go.disabled = mine.some((s) => plan[s.id] === undefined);
  go.onclick = executePlan;
  detail.appendChild(go);
  refreshBoard();
}

/** The classic dial grid, kept as a collapsed fallback. */
function dialFallback(s: ShipState): HTMLElement {
  const t = SHIP_TYPES[s.typeId];
  const legal = new Set(legalDial(state, s));
  const det = document.createElement('details');
  det.innerHTML = '<summary class="hint">Show dial</summary>';
  const dial = document.createElement('div');
  dial.className = 'dial';
  const COLS: Bearing[][] = [
    ['sloopLeft', 'trollLeft', 'reverseBankLeft'], ['turnLeft'], ['bankLeft'],
    ['straight', 'stop', 'reverseStraight'], ['bankRight'], ['turnRight'], ['sloopRight', 'trollRight', 'kturn', 'reverseBankRight'],
  ];
  const rowKey = (m: { bearing: Bearing; speed: number }) => (m.bearing.startsWith('reverse') ? -1 : m.speed);
  const rows = [...new Set(t.dial.map(rowKey))].sort((a, b) => b - a);
  const usedCols = COLS.map((c, ci) => (t.dial.some((m) => c.includes(m.bearing)) ? ci : -1)).filter((c) => c >= 0);
  dial.style.gridTemplateColumns = `repeat(${usedCols.length}, 1fr)`;
  for (const r of rows) {
    for (const ci of usedCols) {
      const i = t.dial.findIndex((m) => rowKey(m) === r && COLS[ci].includes(m.bearing));
      if (i < 0) { dial.appendChild(document.createElement('span')); continue; }
      const m = t.dial[i];
      const b = document.createElement('button');
      b.innerHTML = `<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span>`;
      b.title = `${maneuverLabel(m)} (${m.difficulty})`;
      b.disabled = !legal.has(i);
      if (plan[s.id] === i) b.classList.add('sel');
      b.onclick = () => { selected = s.id; plan[s.id] = i; const next = myShips().find((x) => plan[x.id] === undefined); selectShip(next ? next.id : null); };
      dial.appendChild(b);
    }
  }
  det.appendChild(dial);
  return det;
}

// ---------------------------------------------------------------------------
// Actions on the board: click a spot to barrel roll / boost, click an enemy to
// lock, or use the chips under the ship for Focus / Evade / Skip.
// ---------------------------------------------------------------------------
type Spot = Extract<ActionChoice, { type: 'barrelRoll' | 'boost' }>;
type LockChoice = Extract<ActionChoice, { type: 'lock' }>;
const ACTION_COLOR = { barrelRoll: 0x7cf0c5, boost: 0x9be37c, lock: 0xffd166 } as const;
const GREEN = 0x7cf0c5, RED = 0xff5a5a;
/** How far (mm) the pointer may be from a barrel roll / boost spot and still snap. */
const ACTION_SNAP = 45;

function renderAction(shipId: string, options: ActionChoice[]) {
  const s = shipById(shipId);
  const spots = options.filter((o): o is Spot => o.type === 'barrelRoll' || o.type === 'boost');
  const locks = options.filter((o): o is LockChoice => o.type === 'lock');
  const simple = [...options.filter((o) => o.type === 'focus' || o.type === 'evade'), { type: 'none' } as ActionChoice];
  let cand: ActionChoice | null = null;
  const choose = (c: ActionChoice) => send({ type: 'action', playerId: HUMAN, choice: c });

  const show = () => {
    scene.setRings({ [s.id]: GREEN, ...Object.fromEntries(locks.map((l) => [l.targetId, ACTION_COLOR.lock])) });
    scene.setMarkers(spots.map((o) => ({ x: o.to.x, y: o.to.y, color: ACTION_COLOR[o.type], active: cand === o })));
    const repositioning = cand && (cand.type === 'barrelRoll' || cand.type === 'boost');
    scene.showArcs(repositioning ? [] : [s.id]);
    showOddsFrom(s, cand && (cand.type === 'barrelRoll' || cand.type === 'boost') ? cand.to : s.pose, true);
    if (cand && (cand.type === 'barrelRoll' || cand.type === 'boost')) {
      scene.showGhost(sizeOf(s), [s.pose, cand.to], ACTION_COLOR[cand.type], actionText(cand), s.id);
    } else scene.clearGhost();
    if (cand?.type === 'lock') {
      scene.showLine(s.pose, shipById(cand.targetId).pose, ACTION_COLOR.lock, `Lock ${shipById(cand.targetId).name}`);
    } else scene.clearOverlay();
    const who = `<b>${s.name.split(' ')[0]}</b>`;
    const boardHint = spots.length || locks.length ? 'tap a dot or ringed enemy, or pick below' : 'pick an action';
    const btns: BarButton[] = simple.map((o) => ({ label: o.type === 'none' ? 'Skip' : actionText(o), onClick: () => choose(o) }));
    if (cand && cand.type !== 'none' && cand.type !== 'focus' && cand.type !== 'evade') {
      const c = cand;
      btns.unshift({ label: 'Do it', cls: 'primary', onClick: () => choose(c) });
    }
    setBar({ status: cand ? `${who}: ${actionText(cand)}` : `${who}: ${boardHint}`, buttons: btns });
  };
  const pick = (p: P): ActionChoice | null => {
    const picked = scene.pickShip(p.clientX, p.clientY);
    const lock = locks.find((l) => l.targetId === picked);
    if (lock) return lock;
    const pt = scene.boardPoint(p.clientX, p.clientY);
    let best: Spot | null = null, bestD = Infinity;
    for (const o of spots) {
      const d = screenDist(p, o.to.x, o.to.y);
      const near = d < fingerPx(p) || (pt !== null && Math.hypot(o.to.x - pt.x, o.to.y - pt.y) < ACTION_SNAP);
      if (near && d < bestD) { bestD = d; best = o; }
    }
    if (best) return best;
    // Touch: also accept a tap near a lockable enemy's base.
    for (const l of locks) {
      const t = shipById(l.targetId).pose;
      if (screenDist(p, t.x, t.y) < fingerPx(p)) return l;
    }
    return null;
  };
  mode = {
    hover(e) { const c = pick(e); if (c !== cand) { cand = c; show(); } },
    click(e) { const c = pick(e); if (c) choose(c); },
    key(e) { if (e.key === 'Escape') choose({ type: 'none' }); },
  };
  scene.showChips(s.pose, simple.map((o) => ({
    label: o.type === 'none' ? 'Skip' : actionText(o), cls: o.type === 'none' ? 'skip' : '', onClick: () => choose(o),
  })));

  const parts = [
    spots.some((o) => o.type === 'barrelRoll') ? 'click a <b style="color:#7cf0c5">teal</b> dot to barrel roll' : '',
    spots.some((o) => o.type === 'boost') ? 'a <b style="color:#9be37c">green</b> dot to boost' : '',
    locks.length ? 'click a <b style="color:#ffd166">ringed enemy</b> to lock it' : '',
  ].filter(Boolean);
  detail.innerHTML = `<h2>Action: ${s.name}</h2><p class="hint">On the board: ${parts.length ? parts.join(', ') + ', or ' : ''}use the buttons under the ship.</p>`;
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = actionText(o);
    b.onmouseenter = () => { cand = o; show(); };
    b.onmouseleave = () => { cand = null; show(); };
    b.onclick = () => choose(o);
    detail.appendChild(b);
  }
  show();
}

// ---------------------------------------------------------------------------
// Attacks on the board: valid targets get a red ring; click one to fire.
// ---------------------------------------------------------------------------
type Target = { targetId: string; range: number; arc: string; attack: number; obstructed: boolean; bullseye: boolean };
const targetText = (t: Target) =>
  `${shipById(t.targetId).name}: range ${t.range}, ${t.attack + (t.range <= 1 ? 1 : 0)} dice${t.obstructed ? ', obstructed' : ''}${t.bullseye ? ', bullseye' : ''}`;

/** "62% hit · 1.4 dmg · 18% kill" for one attack, from the engine's exact odds. */
function oddsHtml(attacker: ShipState, t: Target): string {
  const o = attackOdds(attacker, shipById(t.targetId), t);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const cls = o.hit >= 0.66 ? 'hi' : o.hit >= 0.4 ? 'mid' : 'lo';
  return `<span class="${cls}"><b>${pct(o.hit)}</b> hit</span> · ${o.expected.toFixed(1)} dmg` +
    (o.kill >= 0.005 ? ` · <span class="kill">${pct(o.kill)} kill</span>` : '');
}

/**
 * Hit odds over every enemy `s` could shoot from `pose` (default: where it is). Used wherever its arc
 * is shown; while planning the enemies' current positions are used, so it is a preview.
 */
function showOddsFrom(s: ShipState, pose: Pose = s.pose, preview = false) {
  const me = { ...s, pose };
  scene.setOdds(Object.fromEntries(legalTargets(state, me).map((t) =>
    [t.targetId, `${preview ? '<span class="pv">if here</span> ' : ''}${oddsHtml(me, t)}`])));
}

function renderAttack(shipId: string, targets: Target[]) {
  const s = shipById(shipId);
  let cand: Target | null = null;
  const fire = (t: Target | null) => send({ type: 'attack', playerId: HUMAN, targetId: t ? t.targetId : null });

  const show = () => {
    scene.setRings({ [s.id]: GREEN, ...Object.fromEntries(targets.map((t) => [t.targetId, RED])) });
    scene.showArcs([s.id]);
    scene.setOdds(Object.fromEntries(targets.map((t) => [t.targetId, oddsHtml(s, t)])));
    if (cand) scene.showLine(s.pose, shipById(cand.targetId).pose, RED, targetText(cand));
    else scene.clearOverlay();
    const c = cand;
    const btns: BarButton[] = [];
    if (c) btns.push({ label: 'Fire', cls: 'primary', onClick: () => fire(c) });
    btns.push({ label: 'Hold fire', cls: 'danger', onClick: () => fire(null) });
    setBar({ status: c ? targetText(c) : `<b>${s.name.split(' ')[0]}</b>: tap a red-ringed enemy`, buttons: btns });
  };
  const pick = (p: P): Target | null => {
    const picked = scene.pickShip(p.clientX, p.clientY);
    const hit = targets.find((t) => t.targetId === picked);
    if (hit) return hit;
    // Small models are fiddly to hit, so also accept a click near a target's base.
    const pt = scene.boardPoint(p.clientX, p.clientY);
    let best: Target | null = null, bestD = Infinity;
    for (const t of targets) {
      const tp = shipById(t.targetId).pose;
      const d = screenDist(p, tp.x, tp.y);
      const near = d < fingerPx(p) || (pt !== null && Math.hypot(tp.x - pt.x, tp.y - pt.y) < 40);
      if (near && d < bestD) { bestD = d; best = t; }
    }
    return best;
  };
  mode = {
    hover(e) { const c = pick(e); if (c !== cand) { cand = c; show(); } },
    click(e) { const c = pick(e); if (c) fire(c); },
    key(e) { if (e.key === 'Escape') fire(null); },
  };
  scene.showChips(s.pose, [{ label: 'Hold fire', cls: 'hold', onClick: () => fire(null) }]);

  detail.innerHTML = `<h2>Attack: ${s.name}</h2><p class="hint">Click a <b style="color:#ff5a5a">red-ringed</b> enemy to fire.
    Range 1 adds an attack die; range 3 and obstruction add a defense die. Tokens are spent automatically.</p>`;
  for (const t of targets) {
    const e = shipById(t.targetId);
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<b>${e.name}</b>: range ${t.range}, ${t.arc} arc, ${t.attack + (t.range <= 1 ? 1 : 0)} dice` +
      `${t.obstructed ? ', obstructed' : ''}${t.bullseye ? ', bullseye' : ''}<br><span class="odds">${oddsHtml(s, t)}</span>` +
      `<br><span class="hint">hull ${e.hull} · shields ${e.shields} · agi ${SHIP_TYPES[e.typeId].agility}</span>`;
    b.onmouseenter = () => { cand = t; show(); };
    b.onmouseleave = () => { cand = null; show(); };
    b.onclick = () => fire(t);
    detail.appendChild(b);
  }
  const hold = document.createElement('button');
  hold.className = 'opt';
  hold.textContent = 'Hold fire';
  hold.onclick = () => fire(null);
  detail.appendChild(hold);
  show();
}

updateLayout();
newGame();

// Debug/test hook (also handy in the browser console).
(window as unknown as { __xw: unknown }).__xw = {
  scene,
  get state() { return state; },
  finalPose: (shipId: string, dialIndex: number) => {
    const s = shipById(shipId);
    return maneuverFinalPose(s.pose, sizeOf(s), SHIP_TYPES[s.typeId].dial[dialIndex]);
  },
};
