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
  const d = state.pending;
  if (state.phase === 'over' || !d) {
    scene.highlight(null);
    const won = state.winner === HUMAN;
    panel.innerHTML = `<h2>${state.winner === 'draw' ? 'Draw' : won ? 'Victory' : 'Defeat'}</h2>
      <p class="hint">Battle ended in round ${state.round}.</p><button class="go" id="again">New battle</button>`;
    document.getElementById('again')!.onclick = newGame;
    return;
  }
  if (d.kind === 'planning') return renderPlanning();
  if (d.kind === 'action') return renderAction(d.shipId, d.options);
  if (d.kind === 'attack') return renderAttack(d.shipId, d.targets);
}

function renderPlanning() {
  scene.highlight(null);
  const mine = state.ships.filter((s) => s.owner === HUMAN && !s.destroyed);
  panel.innerHTML = `<h2>Planning</h2><p class="hint">Choose a maneuver for each ship. Hover to preview. Blue clears stress, red adds it.</p>`;
  for (const s of mine) {
    const t = SHIP_TYPES[s.typeId];
    const legal = new Set(legalDial(state, s));
    const card = document.createElement('div');
    card.className = 'card' + (plan[s.id] !== undefined ? ' done' : '');
    card.innerHTML = `<h3>${s.name} <span class="hint">· ${t.name} · init ${s.initiative}</span></h3>
      <div class="stats">atk ${t.primaries.map((p) => `${p.attack}${p.arc === 'rear' ? 'R' : ''}`).join('/')} · agi ${t.agility} · hull ${s.hull}/${t.hull} · shields ${s.shields}/${t.shields}${s.stress ? ` · <span style="color:var(--red)">stressed</span>` : ''}</div>`;
    const dial = document.createElement('div');
    dial.className = 'dial';
    // Lay out like a physical dial: rows = speed, columns = bearing; reverse moves on their own row.
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
        b.onmouseenter = () => {
          scene.highlight(s.id);
          const { path } = maneuverPath(s.pose, sizeOf(s), m);
          scene.showGhost(sizeOf(s), [...path, maneuverFinalPose(s.pose, sizeOf(s), m)]);
        };
        b.onmouseleave = () => scene.clearGhost();
        b.onclick = () => { plan[s.id] = i; renderPlanning(); };
        dial.appendChild(b);
      }
    }
    card.appendChild(dial);
    panel.appendChild(card);
  }
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'Reveal dials & execute';
  go.disabled = mine.some((s) => plan[s.id] === undefined);
  go.onclick = () => {
    const dials = Object.fromEntries(mine.map((s) => [s.id, plan[s.id]]));
    plan = {};
    send({ type: 'setDials', playerId: HUMAN, dials });
  };
  panel.appendChild(go);
}

function renderAction(shipId: string, options: ActionChoice[]) {
  const s = shipById(shipId);
  scene.highlight(shipId);
  panel.innerHTML = `<h2>Action: ${s.name}</h2><p class="hint">Perform one action after moving.</p>`;
  for (const o of options) {
    const b = document.createElement('button');
    b.className = 'opt';
    b.textContent = actionText(o);
    b.onmouseenter = () => {
      if (o.type === 'barrelRoll' || o.type === 'boost') scene.showGhost(sizeOf(s), [s.pose, o.to]);
      if (o.type === 'lock') scene.showLine(s.pose, shipById(o.targetId).pose, 0xffd166);
    };
    b.onmouseleave = () => { scene.clearGhost(); scene.clearOverlay(); };
    b.onclick = () => send({ type: 'action', playerId: HUMAN, choice: o });
    panel.appendChild(b);
  }
}

function renderAttack(shipId: string, targets: { targetId: string; range: number; arc: string; attack: number; obstructed: boolean; bullseye: boolean }[]) {
  const s = shipById(shipId);
  scene.highlight(shipId);
  panel.innerHTML = `<h2>Attack: ${s.name}</h2><p class="hint">Range 1 adds an attack die; range 3 and obstruction add a defense die. Tokens are spent automatically.</p>`;
  for (const t of targets) {
    const e = shipById(t.targetId);
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<b>${e.name}</b> — range ${t.range}, ${t.arc} arc, ${t.attack + (t.range <= 1 ? 1 : 0)} dice` +
      `${t.obstructed ? ', obstructed' : ''}${t.bullseye ? ', bullseye' : ''}<br><span class="hint">hull ${e.hull} · shields ${e.shields} · agi ${SHIP_TYPES[e.typeId].agility}</span>`;
    b.onmouseenter = () => scene.showLine(s.pose, e.pose, 0xff5a5a);
    b.onmouseleave = () => scene.clearOverlay();
    b.onclick = () => send({ type: 'attack', playerId: HUMAN, targetId: t.targetId });
    panel.appendChild(b);
  }
  const hold = document.createElement('button');
  hold.className = 'opt';
  hold.textContent = 'Hold fire';
  hold.onclick = () => send({ type: 'attack', playerId: HUMAN, targetId: null });
  panel.appendChild(hold);
}

newGame();
