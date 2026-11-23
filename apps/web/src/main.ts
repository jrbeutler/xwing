import {
  BASE_SIZE, SHIP_TYPES, aiDecide, apply, legalDial, maneuverFinalPose, maneuverLabel, maneuverPath, quickSkirmish,
  viewFor, type ActionChoice, type Bearing, type Command, type GameEvent, type GameState, type ShipState,
} from '@xw/engine';
import { BattleScene } from './scene';

const HUMAN = 'p1';
const AI = 'p2';

const scene = new BattleScene(document.getElementById('viewport')!);
const panel = document.getElementById('panel')!;
const logEl = document.getElementById('log')!;
const roundEl = document.getElementById('round')!;
const phaseEl = document.getElementById('phase')!;

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
  panel.innerHTML = '<p class="hint">Resolving…</p>';
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
async function present() {
  while (shown < state.log.length) {
    const e = state.log[shown++];
    const text = describe(e);
    if (text) {
      const div = document.createElement('div');
      div.innerHTML = text;
      if (e.type === 'attack' || e.type === 'destroyed' || e.type === 'roundStart') div.className = 'hl';
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }
    await animate(e);
  }
  scene.syncShips(state.ships);
  roundEl.textContent = `Round ${state.round}`;
  phaseEl.textContent = state.phase;
}

async function animate(e: GameEvent) {
  switch (e.type) {
    case 'phase': phaseEl.textContent = e.phase; return;
    case 'roundStart': roundEl.textContent = `Round ${e.round}`; return;
    case 'moved':
      scene.highlight(e.shipId);
      await scene.animatePath(e.shipId, e.path, e.final, 500 + e.path.length * 15);
      if (e.partial) await scene.floatText(e.shipId, 'BUMP', 'p2c');
      return;
    case 'action':
      if (e.action.type === 'barrelRoll' || e.action.type === 'boost') {
        const v = scene.ships.get(e.shipId);
        if (v) {
          const from = { x: v.root.position.x + 457, y: -v.root.position.z + 457, h: v.root.rotation.y };
          await scene.animatePath(e.shipId, [from, e.action.to], e.action.to, 400);
        }
      }
      return;
    case 'attack': {
      scene.highlight(e.attackerId);
      await scene.laser(e.attackerId, e.defenderId, shipById(e.attackerId).owner === 'p1' ? 0xff3b3b : 0x3bff6b);
      const dmg = e.shieldDamage + e.hullDamage;
      await scene.floatText(e.defenderId, dmg ? `−${dmg}${e.crits ? ' ✸' : ''}` : 'MISS', dmg ? 'p2c' : 'p1c');
      return;
    }
    case 'obstacleHit':
      await scene.floatText(e.shipId, e.result === 'hit' || e.result === 'crit' ? 'ROCK −1' : 'ROCK', 'p2c');
      return;
    case 'destroyed':
      await scene.explode(e.shipId);
      return;
  }
}

function dice(faces: string[]) {
  const sym: Record<string, string> = { hit: '✹', crit: '✸', focus: '◉', blank: '·', evade: '◆' };
  return faces.map((f) => sym[f]).join('');
}

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
    case 'obstacleHit': return `${nameHtml(e.shipId)} hits an asteroid: ${e.result}`;
    case 'attack':
      return `${nameHtml(e.attackerId)} → ${nameHtml(e.defenderId)} (r${e.range} ${e.arc}${e.obstructed ? ', obstructed' : ''}) ` +
        `atk ${dice(e.attackRoll)}→${dice(e.attackFinal)} def ${dice(e.defenseRoll)}→${dice(e.defenseFinal)} ` +
        `<b>${e.shieldDamage + e.hullDamage ? `${e.shieldDamage} shield, ${e.hullDamage} hull` : 'no damage'}</b>`;
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
  scene.clearGhost();
  scene.clearOverlay();
  scene.clearChips();
  mode = null;
  const d = state.pending;
  if (state.phase === 'over' || !d) {
    scene.highlight(null);
    const won = state.winner === HUMAN;
    panel.innerHTML = `<h2>${state.winner === 'draw' ? 'Draw' : won ? 'Victory' : 'Defeat'}</h2>
      <p class="hint">Battle ended in round ${state.round}.</p><button class="go" id="again">New battle</button>`;
    document.getElementById('again')!.onclick = newGame;
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
}

function refreshBoard() {
  scene.highlight(selected);
  scene.setPlanned(
    myShips()
      .filter((s) => plan[s.id] !== undefined && s.id !== selected)
      .map((s) => ({ size: sizeOf(s), poses: ghostPoses(s, plan[s.id]), color: DIFF_COLOR[maneuverOf(s, plan[s.id]).difficulty] })),
  );
  const cand = document.getElementById('cand');
  if (!selected) {
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
  if (!candidate) {
    scene.clearGhost();
    if (cand) cand.innerHTML = `<p class="hint">Move the pointer toward a dot to steer ${s.name}.</p>`;
    return;
  }
  const i = candidate.group[candidate.flip];
  const m = maneuverOf(s, i);
  const alt = candidate.group.length > 1 ? candidate.group[(candidate.flip + 1) % candidate.group.length] : null;
  const flipHint = alt !== null ? `<div class="hint">F / Flip: ${BEARING_NAME[maneuverOf(s, alt).bearing]}</div>` : '';
  scene.showGhost(sizeOf(s), ghostPoses(s, i), DIFF_COLOR[m.difficulty], `${maneuverName(s, i)}${flipHint}`);
  if (cand) {
    cand.innerHTML = `<div class="cand-row"><span>${maneuverName(s, i)} <span class="hint">(${m.difficulty})</span></span>
      ${alt !== null ? '<button class="opt mini" id="flip">Flip</button>' : ''}
      <button class="opt mini confirm" id="confirm">Set</button></div>`;
    document.getElementById('flip')?.addEventListener('click', flip);
    document.getElementById('confirm')!.addEventListener('click', commit);
  }
}

function candidateAt(pt: { x: number; y: number } | null) {
  if (!selected || !pt) return;
  const s = shipById(selected);
  let best: SnapGroup | null = null, bestD = SNAP_RADIUS;
  for (const g of snapGroups(s)) {
    const d = Math.hypot(g.pos.x - pt.x, g.pos.y - pt.y);
    if (d < bestD) { bestD = d; best = g; }
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
interface BoardMode {
  hover?(e: PointerEvent): void;
  click(e: PointerEvent): void;
  key?(e: KeyboardEvent): void;
}
let mode: BoardMode | null = null;

const canvas = scene.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  lastPointer = e.pointerType;
  updateControls();
  pointerDown = { x: e.clientX, y: e.clientY, moved: false };
  if (!busy && mode && e.pointerType !== 'mouse') mode.hover?.(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 6) pointerDown.moved = true;
  if (busy || !mode) return;
  if (e.pointerType === 'mouse' ? !pointerDown : !!pointerDown) mode.hover?.(e);
});
canvas.addEventListener('pointerup', (e) => {
  const down = pointerDown;
  pointerDown = null;
  if (busy || !mode || !down || down.moved) return; // a drag: camera move (mouse) or preview (touch)
  mode.click(e);
});
addEventListener('keydown', (e) => { if (!busy && mode) mode.key?.(e); });

const planningMode: BoardMode = {
  hover(e) { if (selected) candidateAt(scene.boardPoint(e.clientX, e.clientY)); },
  click(e) {
    const picked = scene.pickShip(e.clientX, e.clientY);
    const mine = picked && shipById(picked).owner === HUMAN ? picked : null;
    if (mine && mine !== selected) return selectShip(mine);
    if (selected) {
      candidateAt(scene.boardPoint(e.clientX, e.clientY));
      if (candidate) commit(); else selectShip(null);
    }
  },
  key(e) {
    if (e.key === 'f' || e.key === 'F') flip();
    if (e.key === 'Escape') selectShip(null);
    if (e.key === 'Enter') { if (candidate) commit(); else executePlan(); }
  },
};

function renderPlanning() {
  const mine = myShips();
  panel.innerHTML = `<h2>Planning</h2><p class="hint">Click a ship, then move the pointer: the ghost snaps to each maneuver it can fly.
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
    panel.appendChild(card);
  }
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'Reveal dials & execute';
  go.disabled = mine.some((s) => plan[s.id] === undefined);
  go.onclick = executePlan;
  panel.appendChild(go);
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
    if (cand && (cand.type === 'barrelRoll' || cand.type === 'boost')) {
      scene.showGhost(sizeOf(s), [s.pose, cand.to], ACTION_COLOR[cand.type], actionText(cand));
    } else scene.clearGhost();
    if (cand?.type === 'lock') {
      scene.showLine(s.pose, shipById(cand.targetId).pose, ACTION_COLOR.lock, `Lock ${shipById(cand.targetId).name}`);
    } else scene.clearOverlay();
  };
  const pick = (e: PointerEvent): ActionChoice | null => {
    const picked = scene.pickShip(e.clientX, e.clientY);
    const lock = locks.find((l) => l.targetId === picked);
    if (lock) return lock;
    const pt = scene.boardPoint(e.clientX, e.clientY);
    if (!pt) return null;
    let best: Spot | null = null, bestD = ACTION_SNAP;
    for (const o of spots) {
      const d = Math.hypot(o.to.x - pt.x, o.to.y - pt.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
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
  panel.innerHTML = `<h2>Action: ${s.name}</h2><p class="hint">On the board: ${parts.length ? parts.join(', ') + ', or ' : ''}use the buttons under the ship.</p>`;
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = actionText(o);
    b.onmouseenter = () => { cand = o; show(); };
    b.onmouseleave = () => { cand = null; show(); };
    b.onclick = () => choose(o);
    panel.appendChild(b);
  }
  show();
}

// ---------------------------------------------------------------------------
// Attacks on the board: valid targets get a red ring; click one to fire.
// ---------------------------------------------------------------------------
type Target = { targetId: string; range: number; arc: string; attack: number; obstructed: boolean; bullseye: boolean };
const targetText = (t: Target) =>
  `${shipById(t.targetId).name}: range ${t.range}, ${t.attack + (t.range <= 1 ? 1 : 0)} dice${t.obstructed ? ', obstructed' : ''}${t.bullseye ? ', bullseye' : ''}`;

function renderAttack(shipId: string, targets: Target[]) {
  const s = shipById(shipId);
  let cand: Target | null = null;
  const fire = (t: Target | null) => send({ type: 'attack', playerId: HUMAN, targetId: t ? t.targetId : null });

  const show = () => {
    scene.setRings({ [s.id]: GREEN, ...Object.fromEntries(targets.map((t) => [t.targetId, RED])) });
    if (cand) scene.showLine(s.pose, shipById(cand.targetId).pose, RED, targetText(cand));
    else scene.clearOverlay();
  };
  const pick = (e: PointerEvent): Target | null => {
    const picked = scene.pickShip(e.clientX, e.clientY);
    const hit = targets.find((t) => t.targetId === picked);
    if (hit) return hit;
    // Small models are fiddly to hit, so also accept a click near a target's base.
    const pt = scene.boardPoint(e.clientX, e.clientY);
    if (!pt) return null;
    let best: Target | null = null, bestD = 40;
    for (const t of targets) {
      const p = shipById(t.targetId).pose;
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };
  mode = {
    hover(e) { const c = pick(e); if (c !== cand) { cand = c; show(); } },
    click(e) { const c = pick(e); if (c) fire(c); },
    key(e) { if (e.key === 'Escape') fire(null); },
  };
  scene.showChips(s.pose, [{ label: 'Hold fire', cls: 'hold', onClick: () => fire(null) }]);

  panel.innerHTML = `<h2>Attack: ${s.name}</h2><p class="hint">Click a <b style="color:#ff5a5a">red-ringed</b> enemy to fire.
    Range 1 adds an attack die; range 3 and obstruction add a defense die. Tokens are spent automatically.</p>`;
  for (const t of targets) {
    const e = shipById(t.targetId);
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<b>${e.name}</b>: range ${t.range}, ${t.arc} arc, ${t.attack + (t.range <= 1 ? 1 : 0)} dice` +
      `${t.obstructed ? ', obstructed' : ''}${t.bullseye ? ', bullseye' : ''}<br><span class="hint">hull ${e.hull} · shields ${e.shields} · agi ${SHIP_TYPES[e.typeId].agility}</span>`;
    b.onmouseenter = () => { cand = t; show(); };
    b.onmouseleave = () => { cand = null; show(); };
    b.onclick = () => fire(t);
    panel.appendChild(b);
  }
  const hold = document.createElement('button');
  hold.className = 'opt';
  hold.textContent = 'Hold fire';
  hold.onclick = () => fire(null);
  panel.appendChild(hold);
  show();
}

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
