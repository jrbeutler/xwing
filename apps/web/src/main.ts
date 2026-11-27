import {
  BASE_SIZE, DAMAGE_CARDS, DEPLOY_DEPTH, SHIP_TYPES, UPGRADES, aiDecide, apply, attackDiceFor, attackOdds, autoDeploy, isIonized, isPrimary, canDeployAt, createGame, generateObstacles, OBSTACLE_RULES,
  legalTargets, maneuverFor, legalDial, validateSquad, type Squad, maneuverFinalPose, maneuverLabel, maneuverPath,
  viewFor, effectSource, suggestManeuvers, type Suggestion, type ActionChoice, type ActionType, type DropChoice, type Pose, type TargetInfo, type ShotLook, type Bearing, type Command, type GameEvent, type GameState, type ShipState,
} from '@xw/engine';
import { BattleScene, SHOT_TIMING, toV3, type AttackAngle } from './scene';
import { openSetup, type BattleSetup } from './setup';
import { handoff, hideHandoff } from './handoff';
import { hostGame, joinGame, newCode, newSeatToken, normalizeCode, saveGuest, savedGuest, saveHost, savedHost, type Link, type Msg, type SavedHost } from './online';
import { openLobby, type LobbyUi } from './lobby';
import { ICONS } from './icons';
import type { RadialItem } from './scene';

const P1 = 'p1';
const P2 = 'p2';
const other = (id: string) => (id === P1 ? P2 : P1);
/** Against the AI, two people taking turns on one device, or two people online (see online.ts). */
let versus: 'ai' | 'human' | 'online' = 'ai';
/**
 * The player at the controls (and whose point of view the board shows). Always P1 against the AI; online,
 * P1 for the host and P2 for the guest.
 */
let me = P1;
/** Whether this device gives `id`'s commands (online, only our own seat; the other player is remote). */
const isHuman = (id: string) => (versus === 'online' ? id === me : id === P1 || versus === 'human');
const seatName = (id: string) => (versus === 'human' ? `Player ${id === P1 ? 1 : 2}` : versus === 'online' ? (id === me ? 'You' : 'Opponent') : id === P1 ? 'You' : 'AI');
const factionName = (id: string) => (id === P1 ? 'Coalition' : 'Syndicate');

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
// On phones the log is a sheet over the board: a tap on it (not a scroll) puts it away.
logEl.addEventListener('click', () => { if (compact) logEl.classList.remove('open'); });
const viewBtn = document.createElement('button');
viewBtn.id = 'viewbtn';
viewBtn.setAttribute('aria-label', 'Toggle overview');
document.getElementById('hud')!.appendChild(viewBtn);
/**
 * Phones: Overview shows the whole table; Recenter goes back to the game's own framing (following the
 * ship you are working with), after an overview or after you moved the camera yourself.
 */
viewBtn.onclick = () => {
  if (userOverview || camFree) { userOverview = false; camFree = false; } else userOverview = true;
  applyCamera();
};
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

/** Whose turn it is, when two people share the device. */
const seatEl = document.createElement('span');
seatEl.id = 'seat';
seatEl.hidden = true;
document.getElementById('hud')!.appendChild(seatEl);

let state: GameState;
/** Where we are: building squads, placing ships, or fighting. */
let stage: 'setup' | 'deploy' | 'battle' = 'setup';
let lastSetup: BattleSetup | null = null;
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

/** Open the squad builder (keeping the last opponent when coming back from deployment). */
function newGame(keep?: BattleSetup) {
  leaveOnline();
  hideFinale();
  hideHandoff();
  stage = 'setup';
  seatEl.hidden = true;
  mode = null;
  scene.setDeployZone(null);
  hideRecap();
  openSetup(startDeployment, keep);
}

// ---------------------------------------------------------------------------
// Deployment: both squads are spread along their edges; the player may move theirs
// within their setup area before the battle starts.
// ---------------------------------------------------------------------------
function startDeployment(setup: BattleSetup) {
  // Online: the lobby comes first; the host starts deployment once a friend has joined (hostAccept).
  if (setup.versus === 'online' && !net) return openOnlineLobby(setup);
  lastSetup = setup;
  versus = setup.versus;
  stage = 'deploy';
  const seed = (Math.random() * 1e9) | 0;
  const near = autoDeploy(setup.player, 'near'), far = autoDeploy(setup.opponent, 'far');
  state = createGame({
    seed,
    players: [{ id: P1, name: 'Coalition', faction: 'coalition' }, { id: P2, name: 'Syndicate', faction: 'syndicate' }],
    squads: {
      [P1]: setup.player.ships.map((s, i) => ({ pilotId: s.pilotId, shipType: s.shipType, upgrades: s.upgrades, pose: near[i] })),
      [P2]: setup.opponent.ships.map((s, i) => ({ pilotId: s.pilotId, shipType: s.shipType, upgrades: s.upgrades, pose: far[i] })),
    },
    // No scenario yet: a random mix of asteroids, debris fields and gas clouds.
    obstacles: generateObstacles({ rng: seed ^ 0x5eed }),
  });
  shown = 0;
  plan = {};
  logEl.innerHTML = '';
  roundShots = [];
  disp = structuredClone(state.ships);
  scene.clearShips();
  scene.setObstacles(state.obstacles);
  scene.syncShips(state.ships);
  scene.setDevices([]);
  roundEl.textContent = 'Setup';
  phaseEl.textContent = 'deployment';
  startDeploying(P1);
}

/** Hand deployment to `who` (both players deploy in turn when two are playing). */
function startDeploying(who: string) {
  carrying = null;
  mode = null;
  const go = () => {
    setSeat(who, true);
    scene.setDeployZone(deploySide());
    mode = deployMode;
    renderDeployment();
    applyCamera();
  };
  if (versus === 'human') handoff({ cls: who, title: `${seatName(who)} · ${factionName(who)}`, text: 'Place your ships in your setup area.', button: 'Deploy', onReady: go });
  else go();
}
const deploySide = () => (me === P1 ? 'near' : 'far') as 'near' | 'far';

/** The ship being moved during deployment, the last legal spot it had, and whether where it is now is legal. */
let carrying: string | null = null;
let carryFrom: Pose | null = null;
let carryValid = true;
const deployedOthers = (id: string) => state.ships.filter((x) => x.id !== id).map((x) => ({ pose: x.pose, size: sizeOf(x) }));

function renderDeployment() {
  const hint = compact ? 'Drag your ships along your edge.' : 'Click one of your ships to pick it up, move it, and click to put it down.';
  // With two players, Player 1 deploys first and hands over; Player 2's "done" starts the battle. Online,
  // both deploy at once and the battle starts when both are ready.
  const handsOver = versus === 'human' && me === P1;
  const online = versus === 'online';
  if (online && ready[net?.role === 'host' ? 'host' : 'guest']) return renderDeployWait();
  const goLabel = handsOver ? 'Done: Player 2 deploys' : online ? 'Ready' : 'Begin battle';
  const who = versus === 'human' ? `<span class="${me}c">${seatName(me)}</span>: ` : '';
  const them = online ? `Your opponent is deploying along the ${me === P1 ? 'far' : 'near'} edge${ready[net?.role === 'host' ? 'guest' : 'host'] ? ' and is ready' : ''}.`
    : versus === 'human' && me === P1 ? 'Player 2 deploys along the far edge next.' : 'The opponent has deployed along the far edge.';
  detail.innerHTML = `<h2>${who}Deployment</h2><p class="hint">${hint} Ships must sit inside your setup area (the lit strip) and not overlap.
    ${them}</p>
    <div class="row"><button class="opt mini" id="dp-auto">Auto-arrange</button><button class="opt mini" id="dp-back">Back to squad</button></div>
    <button class="go" id="dp-go">${goLabel}</button>`;
  document.getElementById('dp-auto')!.onclick = autoArrange;
  document.getElementById('dp-back')!.onclick = () => { if (!online || confirm('Leave this online game?')) newGame(lastSetup ?? undefined); };
  document.getElementById('dp-go')!.onclick = beginBattle;
  setBar({ status: carrying ? `Placing <b>${shipById(carrying).name}</b>` : `${who}Deploy: drag your ships, then ${handsOver ? 'hand over' : 'begin'}`, buttons: [
    { label: 'Auto', onClick: autoArrange },
    { label: handsOver ? 'Done' : online ? 'Ready' : 'Begin battle', cls: 'primary', onClick: beginBattle },
  ] });
}

function autoArrange() {
  const side = deploySide();
  // The squad as flown (pilots and hulls), from the game itself: online the guest has no setup for both sides.
  const mine: Squad = { ships: state.ships.filter((x) => x.owner === me).map((x) => ({ pilotId: x.pilotId, shipType: x.typeId, upgrades: [] })) };
  const poses = autoDeploy(mine, side);
  state.ships.filter((x) => x.owner === me).forEach((x, i) => { x.pose = poses[i]; });
  carrying = null;
  scene.setRings({});
  scene.syncShips(state.ships);
}

function beginBattle() {
  if (stage !== 'deploy') return;
  if (carrying) dropCarried();
  if (versus === 'human' && me === P1) return startDeploying(P2);
  if (versus === 'online') return onlineReady();
  stage = 'battle';
  mode = null;
  scene.setDeployZone(null);
  scene.setRings({});
  disp = structuredClone(state.ships);
  pump();
}

function moveCarried(p: P) {
  if (!carrying) return;
  const s = shipById(carrying);
  const pt = scene.boardPoint(p.clientX, p.clientY);
  if (!pt) return;
  const half = sizeOf(s) / 2;
  // Keep the base on the board and in the setup area; it may still overlap another ship (shown red).
  const [lo, hi] = deploySide() === 'near' ? [0, DEPLOY_DEPTH] : [914 - DEPLOY_DEPTH, 914];
  const pose = { x: Math.min(914 - half, Math.max(half, pt.x)), y: Math.min(hi - half, Math.max(lo + half, pt.y)), h: s.pose.h };
  carryValid = canDeployAt(pose, sizeOf(s), deploySide(), deployedOthers(s.id));
  s.pose = pose;
  scene.syncShips(state.ships);
  scene.setRings({ [s.id]: carryValid ? GREEN : RED });
}

function pickUp(id: string) {
  carrying = id;
  carryFrom = { ...shipById(id).pose };
  carryValid = true;
  scene.setRings({ [id]: GREEN });
  renderDeployment();
}

function dropCarried() {
  if (!carrying) return;
  if (!carryValid && carryFrom) { shipById(carrying).pose = carryFrom; scene.syncShips(state.ships); }
  carrying = null;
  scene.setRings({});
  renderDeployment();
}

/** Send a human command, then let the AI act until a human decision is needed. */
async function send(cmd: Command) {
  if (busy) return;
  mode = null;
  scene.clearChips();
  scene.clearGhost();
  scene.clearOverlay();
  scene.setMarkers([]);
  // Online guest: the host's browser runs the game; send it the command and wait for the updated view.
  if (net?.role === 'guest') {
    awaitingHost = true;
    net.link?.send({ t: 'cmd', cmd });
    renderDecision();
    return;
  }
  try {
    state = apply(state, cmd);
  } catch (err) {
    console.error('Command refused', cmd, err);
    render(); // put the controls back so the player can choose again
    return;
  }
  syncGuest();
  await pump();
}

async function pump() {
  busy = true;
  detail.innerHTML = '<p class="hint">Resolving…</p>';
  setBar({ status: '<span class="hint">Resolving…</span>' });
  applyCamera();
  try {
    for (;;) {
      try {
        await present();
      } catch (err) {
        // Never let a presentation glitch freeze the game: jump the board to the real state and carry on.
        console.error('Animation error; skipping to the current state', err);
        shown = state.log.length;
        scene.skipping = false;
        scene.syncShips(state.ships);
        disp = structuredClone(state.ships);
      }
      const d = state.pending;
      if (!d || versus !== 'ai') break;
      const aiTurn = d.kind === 'planning' ? d.waitingOn.includes(P2) : d.playerId === P2;
      if (!aiTurn) break;
      // The AI sees the same redacted view a network client would (RNG kept for its private jitter seed).
      state = apply(state, aiDecide({ ...viewFor(state, P2), rng: state.rng }, P2)!);
    }
  } finally {
    busy = false;
  }
  const next = nextSeat();
  // Planned moves are secret: before each player plans, the other is asked to look away.
  if (versus === 'human' && next && state.pending?.kind === 'planning') {
    scene.setPlanned([]);
    scene.setMarkers([]);
    scene.clearGhost();
    scene.clearChips();
    detail.innerHTML = '';
    setBar({ status: '' });
    handoff({
      cls: next, title: `${seatName(next)} · ${factionName(next)}`, button: 'Plan my moves',
      text: `Round ${state.round}: plan your maneuvers. ${seatName(other(next))}, look away until they are set.`,
      onReady: () => { setSeat(next, true); render(); },
    });
    return;
  }
  if (next && next !== me) {
    setSeat(next);
    showBanner(`<span class="who">${factionName(next)}</span><b>${seatName(next).toUpperCase()}</b>`, `turn ${next}`, 1100);
  }
  render();
}

/** The human who must act next, if any. */
function nextSeat(): string | null {
  const d = state.pending;
  if (!d) return null;
  const who = d.kind === 'planning' ? d.waitingOn.find(isHuman) : d.playerId;
  return who && isHuman(who) ? who : null;
}

/**
 * Give the controls to `who`. `turn`: also swing the camera round to look from their edge (done at the
 * hand-over screens, not for every ship in the activation and engagement phases, where it would spin back and forth).
 */
function setSeat(who: string, turn = false) {
  me = who;
  seatEl.hidden = versus === 'ai';
  seatEl.className = who;
  seatEl.innerHTML = versus === 'online' ? `Online ${net?.code ?? ''} <span>· ${factionName(who)}</span>` : `${seatName(who)} <span>· ${factionName(who)}</span>`;
  // Player 2 (or the online guest) looks up the board from the far edge.
  const facing = versus !== 'ai' && who === P2 ? -1 : 1;
  if ((turn || versus !== 'human') && scene.facing !== facing) {
    scene.facing = facing;
    scene.resetView(0);
  }
}

// ---------------------------------------------------------------------------
// Online play (see online.ts). The host's browser runs the game exactly as a local game and tells the
// guest's browser what it may see (viewFor). The guest sends its commands to the host, which checks them
// with the engine like any other command. Both deploy at the same time; the battle starts when both are ready.
// ---------------------------------------------------------------------------
let net: { role: 'host' | 'guest'; code: string; link: Link | null; seat: string; stop: () => void; budget: number } | null = null;
/** Online deployment: who has pressed Ready. */
let ready = { host: false, guest: false };
/** Guest: a command has gone to the host and its answer has not come back yet. */
let awaitingHost = false;
/** Host: how many log events the guest already has. */
let sentLog = 0;
/** Guest: trying to reconnect after the connection dropped. */
let reconnecting = false;

const netStatus = document.createElement('div');
netStatus.id = 'netstatus';
netStatus.hidden = true;
netStatus.setAttribute('role', 'status');
document.body.appendChild(netStatus);
const showNet = (text: string | null) => { netStatus.hidden = !text; netStatus.textContent = text ?? ''; };

/** A code from an invite link (?join=CODE): open the online lobby with it filled in. */
const inviteCode = normalizeCode(new URLSearchParams(location.search).get('join') ?? '');
if (inviteCode) { try { localStorage.setItem('xw-versus', JSON.stringify('online')); } catch { /* storage unavailable */ } }

function openOnlineLobby(setup: BattleSetup) {
  let hosting: { stop: () => void } | null = null;
  const sh = savedHost(), sg = savedGuest();
  const lobby = openLobby({
    host: async (ui) => {
      const code = newCode();
      const h = await hostGame(code, (link) => hostConnection(link, setup, ui));
      hosting = h;
      net = { role: 'host', code, link: null, seat: '', stop: h.stop, budget: setup.budget };
      ui.showCode(code);
    },
    join: async (code, ui) => {
      const seat = newSeatToken();
      await guestConnect(code, seat, setup.player, ui, { ...setup, opponent: { ships: [] } });
    },
    resumeHost: sh ? { code: sh.code, round: sh.state.round, run: (ui) => resumeHosting(sh, ui) } : undefined,
    rejoin: sg ? { code: sg.code, run: (ui) => guestConnect(sg.code, sg.seat, null, ui, { budget: setup.budget, versus: 'online', player: setup.player, opponent: { ships: [] }, hints: { you: sg.hints, them: false } }) } : undefined,
    cancel: () => { hosting?.stop(); hosting = null; net = null; },
    back: () => newGame(setup),
  }, { budget: setup.budget, joinCode: inviteCode || undefined });
  void lobby;
}

/** Host: a browser connected. Wait for its join (a new guest with a squad, or our guest coming back). */
function hostConnection(link: Link, setup: BattleSetup | null, ui: LobbyUi | null) {
  link.onClose = () => {
    if (net?.link === link) { net.link = null; if (stage !== 'setup') showNet('Your opponent disconnected. Waiting for them to come back…'); }
  };
  link.onMessage = (m) => {
    if (!net || net.role !== 'host') return;
    if (m.t === 'join') {
      if (net.seat && m.seat === net.seat) {
        // Our guest is back (reload or dropped connection): give it everything again.
        if (net.link && net.link !== link) net.link.close();
        net.link = link;
        showNet(null);
        syncGuest(true);
        return;
      }
      if (net.seat || !setup || !m.squad) {
        link.send({ t: 'reject', reason: net.seat ? 'This game already has two players.' : 'That game has ended.' });
        setTimeout(() => link.close(), 500);
        return;
      }
      const problems = validateSquad(m.squad, net.budget);
      if (problems.length) {
        link.send({ t: 'reject', reason: `Your squad doesn't fit this game: ${problems[0]}` });
        setTimeout(() => link.close(), 500);
        return;
      }
      net.seat = m.seat;
      net.link = link;
      ui?.close();
      ready = { host: false, guest: false };
      startDeployment({ ...setup, versus: 'online', opponent: m.squad });
      syncGuest(true);
      return;
    }
    if (net.link !== link) return; // a stale connection
    hostReceive(m);
  };
}

function hostReceive(m: Msg) {
  if (m.t === 'resync') return syncGuest(true);
  if (m.t === 'bye') { if (state.phase !== 'over') showNet('Your opponent left the game.'); saveHost(null); return; }
  if (m.t === 'deploy' && stage === 'deploy') {
    // Check the guest's placement like a local one: its own ships, inside its setup area, not overlapping.
    const theirs = state.ships.filter((x) => x.owner === P2);
    const placed: { pose: Pose; size: number }[] = [];
    for (const x of theirs) {
      const pose = m.poses[x.id];
      if (!pose || !canDeployAt(pose, sizeOf(x), 'far', placed)) { net!.link?.send({ t: 'refused', reason: 'That deployment is not legal.' }); return syncGuest(true); }
      placed.push({ pose, size: sizeOf(x) });
    }
    theirs.forEach((x) => { x.pose = m.poses[x.id]; });
    scene.syncShips(state.ships);
    ready.guest = true;
    syncGuest();
    if (ready.host) return startOnlineBattle();
    if (!carrying) renderDeployment();
    return;
  }
  if (m.t === 'cmd' && stage === 'battle') {
    const cmd = m.cmd;
    // The guest may only act for its own seat; the engine checks the rest.
    if (cmd.playerId !== P2) { net!.link?.send({ t: 'refused', reason: 'Not your seat.' }); return syncGuest(true); }
    try {
      state = apply(state, cmd);
    } catch (err) {
      net!.link?.send({ t: 'refused', reason: (err as Error).message });
      return syncGuest(true);
    }
    syncGuest();
    if (!busy) void pump();
  }
}

/** Host: send the guest its view and the log events it has not had yet (everything if `full`), and save the game. */
function syncGuest(full = false) {
  if (!net || net.role !== 'host' || stage === 'setup') return;
  // A finished game is not offered for resuming.
  if (state.phase === 'over') saveHost(null);
  else saveHost({ code: net.code, seat: net.seat, budget: net.budget, stage: stage === 'battle' ? 'battle' : 'deploy', state, ready, hints: !!lastSetup?.hints.you });
  if (!net.link) return;
  const from = full ? 0 : sentLog;
  const view = viewFor(state, P2);
  const events = state.log.slice(from);
  view.log = [];
  net.link.send({ t: 'sync', stage: stage === 'battle' ? 'battle' : 'deploy', view, from, events, budget: net.budget, ready });
  sentLog = state.log.length;
}

/** Ready pressed in online deployment. */
function onlineReady() {
  if (!net) return;
  if (net.role === 'host') {
    ready.host = true;
    syncGuest();
    if (ready.guest) return startOnlineBattle();
    return renderDeployWait();
  }
  const poses = Object.fromEntries(state.ships.filter((x) => x.owner === me).map((x) => [x.id, x.pose]));
  ready.guest = true;
  net.link?.send({ t: 'deploy', poses });
  renderDeployWait();
}

/** Deployment: we are ready; waiting for the other player. */
function renderDeployWait() {
  mode = null;
  scene.setDeployZone(null);
  scene.setRings({});
  detail.innerHTML = `<h2>Ready</h2><p class="hint">Waiting for your opponent to finish placing their ships…</p>`;
  setBar({ status: 'Ready. Waiting for your opponent to deploy…' });
}

/** Host: both ready. The battle starts here and the guest follows when the next sync arrives. */
function startOnlineBattle() {
  stage = 'battle';
  mode = null;
  scene.setDeployZone(null);
  scene.setRings({});
  disp = structuredClone(state.ships);
  syncGuest();
  void pump();
}

/** Guest: connect to `code` and join (with a squad, or as a returning player with none). */
async function guestConnect(code: string, seat: string, squad: Squad | null, ui: LobbyUi | null, setup: BattleSetup) {
  const { link, stop } = await joinGame(code);
  net = { role: 'guest', code, link, seat, stop, budget: setup.budget };
  lastSetup = setup;
  versus = 'online';
  saveGuest({ code, seat, hints: setup.hints.you });
  attachGuestLink(link, ui);
  link.send({ t: 'join', seat, squad });
}

function attachGuestLink(link: Link, ui: LobbyUi | null) {
  link.onClose = () => { if (net?.link === link) { net.link = null; void guestReconnect(); } };
  link.onMessage = (m) => {
    if (!net || net.role !== 'guest') return;
    if (m.t === 'reject') {
      saveGuest(null);
      const n = net;
      net = null;
      n.stop();
      if (ui) ui.status(m.reason, true); else { showNet(m.reason); }
      return;
    }
    if (m.t === 'refused') { awaitingHost = false; showBanner(`<b>REFUSED</b><span class="detail">${m.reason}</span>`, 'miss', 2000); if (!busy) render(); return; }
    if (m.t === 'bye') { if (state?.phase !== 'over') showNet('The host ended the game.'); saveGuest(null); return; }
    if (m.t === 'sync') { ui?.close(); ui = null; guestSync(m); }
  };
}

/** Guest: the connection dropped. Keep trying to get back in with the same seat. */
async function guestReconnect() {
  if (reconnecting || !net || net.role !== 'guest') return;
  reconnecting = true;
  showNet('Connection lost. Reconnecting…');
  for (let tries = 0; net && net.role === 'guest' && !net.link; tries++) {
    try {
      net.stop();
      const { link, stop } = await joinGame(net.code);
      if (!net) { stop(); break; }
      net.link = link;
      net.stop = stop;
      attachGuestLink(link, null);
      link.send({ t: 'join', seat: net.seat, squad: null });
      showNet(null);
    } catch {
      showNet(`Connection lost. Reconnecting… (the host must keep their game open)`);
      await new Promise((r) => setTimeout(r, Math.min(15000, 2000 + tries * 1000)));
    }
  }
  reconnecting = false;
}

/** Guest: a view (and new log events) from the host. */
function guestSync(m: Extract<Msg, { t: 'sync' }>) {
  const fresh = stage === 'setup';
  let log: GameEvent[];
  if (m.from === 0) log = m.events;
  else if (!fresh && m.from === state.log.length) log = state.log.concat(m.events);
  else { net?.link?.send({ t: 'resync' }); return; }
  const next: GameState = { ...m.view, log };
  ready = m.ready;
  awaitingHost = false;
  if (m.stage === 'deploy') {
    if (fresh) return enterOnlineDeployment(next, P2);
    // Still placing our own ships: keep where we have put them, take the rest from the host.
    if (!ready.guest) next.ships.forEach((x) => { if (x.owner === me) x.pose = shipById(x.id).pose; });
    state = next;
    scene.syncShips(state.ships);
    if (!carrying) renderDeployment();
    return;
  }
  if (fresh) return enterOnlineBattle(next, P2);
  if (stage === 'deploy') {
    state = next;
    stage = 'battle';
    mode = null;
    scene.setDeployZone(null);
    scene.setRings({});
    disp = structuredClone(state.ships);
    void pump();
    return;
  }
  state = next;
  if (state.phase === 'over') saveGuest(null);
  if (!busy) void pump();
}

/** Show a game we did not create here (guest joining, or anyone resuming) at deployment. */
function enterOnlineDeployment(s: GameState, seat: string) {
  versus = 'online';
  stage = 'deploy';
  state = s;
  me = seat;
  shown = 0;
  plan = {};
  logEl.innerHTML = '';
  roundShots = [];
  disp = structuredClone(state.ships);
  scene.clearShips();
  scene.setObstacles(state.obstacles);
  scene.syncShips(state.ships);
  scene.setDevices(state.devices);
  roundEl.textContent = 'Setup';
  phaseEl.textContent = 'deployment';
  setSeat(seat, true);
  startDeploying(seat);
}

/** Show a battle already in progress (rejoining or resuming): jump to now instead of replaying it. */
function enterOnlineBattle(s: GameState, seat: string) {
  versus = 'online';
  stage = 'battle';
  state = s;
  me = seat;
  plan = {};
  logEl.innerHTML = '';
  roundShots = [];
  for (const e of state.log) logLine(e);
  shown = state.log.length;
  disp = structuredClone(state.ships);
  scene.clearShips();
  scene.setDeployZone(null);
  scene.setObstacles(state.obstacles);
  scene.syncShips(state.ships);
  scene.setDevices(state.devices);
  roundEl.textContent = `Round ${state.round}`;
  phaseEl.textContent = state.phase;
  setSeat(seat, true);
  void pump();
}

/** Host: pick a saved game back up after a reload; the guest rejoins with the same code. */
async function resumeHosting(saved: SavedHost, ui: LobbyUi) {
  // The matchmaking service can hold our old registration for a while after a reload: keep trying for a minute.
  const h = await hostGame(saved.code, (link) => hostConnection(link, null, null), 60000);
  net = { role: 'host', code: saved.code, link: null, seat: saved.seat, stop: h.stop, budget: saved.budget };
  ready = saved.ready;
  lastSetup = { budget: saved.budget, versus: 'online', player: { ships: [] }, opponent: { ships: [] }, hints: { you: saved.hints, them: false } };
  ui.close();
  showNet('Waiting for your opponent to rejoin…');
  if (saved.stage === 'deploy') enterOnlineDeployment(saved.state, P1);
  else enterOnlineBattle(saved.state, P1);
  if (saved.stage === 'deploy' && ready.host) renderDeployWait();
}

/** Leave any online game (a new battle, or back to the squad builder). */
function leaveOnline() {
  if (!net) return;
  net.link?.send({ t: 'bye' });
  const n = net;
  net = null;
  setTimeout(() => n.stop(), 300);
  if (n.role === 'host') saveHost(null); else saveGuest(null);
  ready = { host: false, guest: false };
  awaitingHost = false;
  showNet(null);
  versus = 'ai';
}

/** Online: what the other player is doing while it is their turn (or while ours is on its way to the host). */
function renderOpponentTurn(d: NonNullable<GameState['pending']>) {
  mode = null;
  scene.setPlanned([]);
  scene.setMarkers([]);
  const ship = d.kind === 'planning' ? null : shipById(d.shipId);
  scene.highlight(ship?.id ?? null);
  const what = awaitingHost ? 'Sent. Waiting for the host…'
    : d.kind === 'planning' ? 'Your opponent is planning their maneuvers.'
    : d.kind === 'action' ? `${ship!.name} is choosing an action.`
    : d.kind === 'attack' ? `${ship!.name} is choosing a target.`
    : `${ship!.name} is deciding whether to drop a device.`;
  detail.innerHTML = `<h2>${awaitingHost ? 'Sent' : "Opponent's turn"}</h2><p class="hint"><span class="spinner"></span> ${what}</p>`;
  setBar({ status: `<span class="hint">${what}</span>` });
}

// ---------------------------------------------------------------------------
// Event presentation
// ---------------------------------------------------------------------------
// What the board currently shows. Events are applied to it one by one as they animate,
// so health markers drop the moment a shot lands, not when the whole round is done.
let disp: ShipState[] = [];
const dispShip = (id: string) => disp.find((x) => x.id === id);
/** The charges of an upgrade or the pilot's ability on a displayed ship, by source id. */
const sourceState = (d: ShipState | undefined, id: string) => (d?.ability?.id === id ? d.ability : d?.upgrades.find((x) => x.id === id));
const relabel = (id: string) => { const d = dispShip(id); if (d) scene.refreshLabel(d); };

/** One-line summaries of this round's shots, shown as a recap when the next round starts. */
let roundShots: string[] = [];
let recapRound = 0;

function logLine(e: GameEvent) {
  const text = describe(e);
  if (!text) return;
  const div = document.createElement('div');
  div.innerHTML = text;
  if (e.type === 'attack' || e.type === 'destroyed' || e.type === 'roundStart' || e.type === 'deviceDetonated' || (e.type === 'damageCard' && e.what === 'dealt')) div.className = 'hl';
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
  scene.setDevices(state.devices);
  disp = structuredClone(state.ships);
  roundEl.textContent = `Round ${state.round}`;
  phaseEl.textContent = state.phase;
}

async function animate(e: GameEvent) {
  switch (e.type) {
    case 'phase':
      phaseEl.textContent = e.phase;
      if (e.phase === 'end') for (const d of disp) { d.focus = 0; d.evade = 0; d.calculate = 0; d.reinforce = null; d.disarmed = false; d.jam = 0; relabel(d.id); }
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
      if (e.action.type === 'rotateArc') {
        if (d) d.turretArc = e.action.to;
        await scene.setTurret(e.shipId, e.action.to, 450);
      }
      if (d) {
        if (e.action.type === 'focus') d.focus++;
        if (e.action.type === 'evade') d.evade++;
        if (e.action.type === 'calculate') d.calculate++;
        if (e.action.type === 'reinforce') d.reinforce = e.action.side;
        if (e.action.type === 'lock') d.lock = e.action.targetId;
        if (e.action.type === 'reload') {
          const reload = e.action;
          const u = d.upgrades.find((x) => x.id === reload.upgrade);
          if (u) u.charges++;
          d.disarmed = true;
        }
        relabel(e.shipId);
      }
      if (e.action.type === 'coordinate') {
        const from = d?.pose ?? shipById(e.shipId).pose, to = dispShip(e.action.targetId)?.pose ?? shipById(e.action.targetId).pose;
        scene.showLine(from, to, ACTION_COLOR.coordinate, `${shipById(e.shipId).name} coordinates ${shipById(e.action.targetId).name}`);
        await scene.floatText(e.action.targetId, 'COORDINATED', 'talent-float');
        scene.clearOverlay();
      }
      if (e.action.type === 'reinforce') await scene.floatText(e.shipId, `REINFORCE ${e.action.side.toUpperCase()}`, 'talent-float');
      if (e.action.type === 'reload') await scene.floatText(e.shipId, `RELOAD ${UPGRADES[e.action.upgrade].name.toUpperCase()}`, 'talent-float');
      return;
    }
    case 'attack':
      await showAttack(e);
      return;
    case 'jam': {
      // Interference rolls from the jammer to the target, which glitches as its token is knocked off.
      await scene.jam(e.shipId, e.targetId);
      const t = dispShip(e.targetId);
      if (t) {
        if (e.effect === 'focus') t.focus = Math.max(0, t.focus - 1);
        else if (e.effect === 'evade') t.evade = Math.max(0, t.evade - 1);
        else if (e.effect === 'calculate') t.calculate = Math.max(0, t.calculate - 1);
        else if (e.effect === 'reinforce') t.reinforce = null;
        else if (e.effect === 'lock') t.lock = null;
        else t.jam = 1;
        relabel(e.targetId);
      }
      await scene.floatText(e.targetId, e.effect === 'jammed' ? 'JAMMED' : `JAMMED −${e.effect.toUpperCase()}`, 'jam-float');
      scene.clearOverlay();
      return;
    }
    case 'jamSpent': {
      const d = dispShip(e.shipId);
      // The engine never gave the token, but the action event already showed it: take it back.
      if (d) {
        if (e.lost === 'reinforce') d.reinforce = null;
        else d[e.lost] = Math.max(0, d[e.lost] - 1);
        d.jam = 0;
        relabel(e.shipId);
      }
      await scene.floatText(e.shipId, `JAMMED: NO ${e.lost.toUpperCase()}`, 'jam-float');
      return;
    }
    case 'obstacleHit': {
      const d = dispShip(e.shipId);
      if (d) {
        d.shields -= e.shieldDamage;
        d.hull -= e.hullDamage;
        d.stress += e.stress ?? 0;
        d.ion += e.ion ?? 0;
        relabel(e.shipId);
      }
      if (e.shieldDamage) void scene.shieldFlash(e.shipId);
      if (e.hullDamage) { void scene.sparks(e.shipId); void scene.shake(e.shipId); }
      const dmg = e.shieldDamage + e.hullDamage;
      const what = [dmg ? `−${dmg}` : '', e.stress ? `+${e.stress} STRESS` : '', e.ion ? 'ION +1' : ''].filter(Boolean).join(' ');
      await scene.floatText(e.shipId, `${OBSTACLE_RULES[e.kind].name.toUpperCase()}${what ? ` ${what}` : ''}`, e.ion ? 'ion-float' : 'p2c');
      return;
    }
    case 'damageCard':
      await showDamageCard(e);
      return;
    case 'deviceDropped':
      scene.highlight(e.shipId);
      await scene.dropDevice(e.shipId, e.device);
      { const u = dispShip(e.shipId)?.upgrades.find((x) => x.id === e.device.upgrade); if (u) u.charges--; }
      return;
    case 'deviceDetonated': {
      const ion = UPGRADES[e.device.upgrade].device?.effect === 'ion';
      showBanner(`<span class="who">${UPGRADES[e.device.upgrade].name}</span><b>${e.device.kind === 'mine' ? 'MINE!' : 'DETONATION'}</b>` +
        `<span class="detail">${e.ships.length ? e.ships.map((h) => shipById(h.shipId).name).join(', ') : 'nobody caught'}</span>`,
        e.ships.some((h) => shipById(h.shipId).owner === me) ? 'crit incoming' : 'crit');
      await scene.detonate(e.device, ion);
      for (const h of e.ships) {
        const d = dispShip(h.shipId);
        if (d) { d.shields -= h.shieldDamage; d.hull -= h.hullDamage; d.ion += h.ion ?? 0; relabel(h.shipId); }
        if (h.shieldDamage) void scene.shieldFlash(h.shipId, scene.shieldPoint(toV3(e.device.pose.x, e.device.pose.y, 10), h.shipId));
        if (h.hullDamage) { void scene.sparks(h.shipId, 0xffa040, 30, true); void scene.shake(h.shipId); }
        const dmg = h.shieldDamage + h.hullDamage;
        void scene.floatText(h.shipId, h.ion ? `ION +${h.ion}` : dmg ? `−${dmg}` : 'NO DAMAGE', h.ion ? 'ion-float' : 'p2c');
      }
      await scene.wait(900);
      return;
    }
    case 'upgrade': {
      const d = dispShip(e.shipId);
      const u = sourceState(d, e.upgrade);
      const src = effectSource(e.upgrade);
      const name = (src?.name ?? e.upgrade).toUpperCase();
      if (e.what === 'spent') { if (u) u.charges = 0; await scene.floatText(e.shipId, `${name} SPENT`, 'p2c'); }
      if (e.what === 'recovered') { if (u) u.charges++; await scene.floatText(e.shipId, `${name} READY`, 'talent-float'); }
      if (e.what === 'used') {
        // What the effect gave the ship comes with the event; a charge is spent if the effect costs one.
        if (u && src?.effects?.some((fx) => fx.kind === 'trigger' && fx.log === 'used' && fx.cost === 'charge')) u.charges--;
        if (d && e.focus) d.focus += e.focus;
        if (d && e.calculate) d.calculate += e.calculate;
        if (d && e.shields) d.shields += e.shields;
        if (d) relabel(e.shipId);
        const extra = (e.focus ? ' +FOCUS' : '') + (e.calculate ? ' +CALCULATE' : '') + (e.shields ? ' +SHIELD' : '');
        await scene.floatText(e.shipId, name + extra, 'talent-float');
      }
      return;
    }
    case 'destroyed': {
      const name = shipById(e.shipId).name;
      roundShots.push(`<b>${nameHtml(e.shipId)} destroyed</b>`);
      showBanner(`<span class="who">${name}</span><b>DESTROYED</b>`, shipById(e.shipId).owner === me ? 'incoming big' : 'big');
      await scene.explode(e.shipId);
      await scene.wait(500);
      return;
    }
  }
}

type AttackEvent = Extract<GameEvent, { type: 'attack' }>;

/** A damage card dealt, triggered, repaired or discarded: update the board and say what it does. */
async function showDamageCard(e: Extract<GameEvent, { type: 'damageCard' }>) {
  const d = dispShip(e.shipId);
  const c = DAMAGE_CARDS[e.card];
  const mine = shipById(e.shipId).owner === me;
  if (d) {
    if (e.what === 'dealt') d.crits.push(e.card);
    if (e.what === 'repaired' || e.what === 'discarded') {
      const i = d.crits.indexOf(e.card);
      if (i >= 0) d.crits.splice(i, 1);
    }
    d.shields -= e.shieldDamage ?? 0;
    d.hull -= e.hullDamage ?? 0;
    d.stress += e.stress ?? 0;
    d.ion += e.ion ?? 0;
    relabel(e.shipId);
  }
  if (e.shieldDamage) void scene.shieldFlash(e.shipId);
  if (e.hullDamage) { void scene.sparks(e.shipId); void scene.shake(e.shipId); }
  if (e.what === 'dealt') {
    roundShots.push(`${nameHtml(e.shipId)}: <b class="crit">${c.title}</b>`);
    showBanner(`<span class="who">${shipById(e.shipId).name} · critical damage</span><b>${c.title.toUpperCase()}</b><span class="detail">${c.text}</span>`,
      `crit card${mine ? ' incoming' : ''}`, 2600);
    await scene.wait(1500);
  } else if (e.what === 'triggered') {
    const dmg = (e.hullDamage ?? 0) + (e.shieldDamage ?? 0);
    const extra = dmg ? ` −${dmg}` : e.stress ? ' +stress' : e.ion ? ' ION' : '';
    await scene.floatText(e.shipId, `${c.tag}${e.roll ? ` (${e.roll})` : ''}${extra}`, 'crit-float');
  } else if (e.what === 'repaired') {
    await scene.floatText(e.shipId, `REPAIRED ${c.tag}`, 'repair-float');
  }
}

/** Plain-language outcome of an attack (no dice). */
function attackOutcome(e: AttackEvent) {
  const dmg = e.shieldDamage + e.hullDamage;
  const rolled = e.attackFinal.filter((f) => f === 'hit' || f === 'crit').length;
  const parts = [e.shieldDamage ? `${e.shieldDamage} shield` : '', e.hullDamage ? `${e.hullDamage} hull` : ''].filter(Boolean);
  if (!dmg) return { word: rolled ? 'EVADED' : 'MISS', detail: rolled ? 'no damage' : 'all shots missed', cls: 'miss' };
  if (e.crits > 0 && e.hullDamage > 0) return { word: 'CRITICAL HIT', detail: parts.join(' · '), cls: 'crit' };
  return { word: 'HIT', detail: parts.join(' · '), cls: 'hit' };
}

/** How a weapon's shots are drawn: its own `look`, else by kind (ion, torpedo, missile), else a laser. */
function shotLook(weapon?: string): ShotLook {
  const w = weapon ? UPGRADES[weapon] : undefined;
  if (!w?.weapon) return 'laser';
  if (w.weapon.look) return w.weapon.look;
  if (w.slot === 'torpedo') return 'torpedo';
  if (w.weapon.effect === 'ion') return 'ion';
  if (w.slot === 'missile') return 'missile';
  return 'laser';
}

/** The last attack angle used, so two shots in a row are not filmed from the same cinematic angle. */
let lastAngle: AttackAngle = 'gunner';

/**
 * How to film an attack (null: stay on the table view). The player's own shots: the gunner's view half the
 * time (less for slow ordnance, which is worth watching side-on), otherwise a cinematic angle. Enemy shots:
 * a third of the time, a cinematic angle, often from behind the player's ship as the fire comes in.
 */
function attackAngle(own: boolean, look: ShotLook): AttackAngle | null {
  if (!own && Math.random() > 0.35) return null;
  const slow = look === 'missile' || look === 'torpedo';
  if (own && Math.random() < (slow ? 0.3 : 0.5)) return (lastAngle = 'gunner');
  const pool: AttackAngle[] = own ? ['reverse', 'side', 'low', ...(slow ? ['side' as const] : [])] : ['reverse', 'reverse', 'side', 'low'];
  const choices = pool.filter((x) => x !== lastAngle);
  return (lastAngle = choices[Math.floor(Math.random() * choices.length)] ?? 'side');
}

async function showAttack(e: AttackEvent) {
  const a = shipById(e.attackerId), d = shipById(e.defenderId);
  const incoming = d.owner === me;
  const color = a.owner === P1 ? 0xff4d4d : 0x52ff7a;
  // How this weapon's shots look (docs/VFX.md): lasers, ion arcs, missiles, rocket salvoes, torpedoes.
  const look = shotLook(e.weapon);
  const ionShot = !!e.weapon && UPGRADES[e.weapon].weapon?.effect === 'ion';
  const ap = dispShip(a.id)?.pose ?? a.pose, dp = dispShip(d.id)?.pose ?? d.pose;

  // 1. Who shoots whom. The player's own shots are filmed: usually from behind the attacker, down its line
  // of fire, sometimes from a cinematic angle. Enemy shots are now and then filmed too.
  // With two players every shot is someone's own.
  const angle = attackAngle(isHuman(a.owner), look);
  scene.setRings({ [a.id]: GREEN, [d.id]: RED });
  scene.setOdds({});
  if (angle) {
    scene.attackView(a.id, d.id, 650, angle);
    await scene.wait(750);
  } else {
    scene.showArcs([a.id]);
    if (compact) framePoints([ap, dp], 150, 350);
    scene.showLine(ap, dp, incoming ? RED : 0xffd166, `${a.name} → ${d.name}`);
    await scene.wait(compact ? 650 : 450);
    scene.clearOverlay();
  }

  // 2. Bolts: one per die rolled; the ones that got through hit, the rest streak past.
  const landed = e.hits + e.crits;
  const total = Math.max(landed, Math.min(5, e.attackFinal.length));
  const order = Array.from({ length: total }, (_, i) => i < landed);
  // Shots the dice hit with but the defender evaded skim past the hull as the target jinks away.
  const rolled = e.attackFinal.filter((f) => f === 'hit' || f === 'crit').length;
  let nearLeft = Math.min(total - landed, Math.max(0, rolled - landed));
  const jinked = nearLeft > 0;
  for (let i = order.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const units = e.shieldDamage + e.hullDamage;
  const target = dispShip(d.id);
  let hitNo = 0;
  const flights: Promise<void>[] = [];
  for (let i = 0; i < order.length; i++) {
    const hit = order[i];
    const near = !hit && nearLeft-- > 0;
    const n = hit ? hitNo++ : -1;
    // Shots the shields take stop at the shield bubble.
    const end = hit && n < e.shieldDamage ? scene.shieldPoint(a.id, d.id) : scene.boltEnd(a.id, d.id, hit, i, near);
    if (!end) continue;
    const boltColor = ionShot ? 0x7fd8ff : color;
    if (near) void scene.dodge(d.id, end);
    flights.push(scene.shot(look, a.id, end, boltColor, hit, i).then(() => {
      if (near) scene.nearMiss(a.id, d.id, end, boltColor);
      if (!hit) return;
      const crit = n >= e.hits; // crits are applied after hits
      if (n < e.shieldDamage) {
        if (target) target.shields--;
        void scene.shieldFlash(d.id, end);
      } else if (n < units) {
        if (target) target.hull--;
        void scene.sparks(d.id, crit ? 0xffd27a : 0xffa040, crit ? 40 : 26, crit);
        void scene.shake(d.id, crit ? 450 : 300, crit ? 5 : 3);
      } else {
        void scene.sparks(d.id); // overkill on a ship that is already finished
      }
      relabel(d.id);
    }));
    await scene.wait(SHOT_TIMING[look].gap);
  }
  await Promise.all(flights);

  // Spent tokens leave the labels
  const ad = dispShip(a.id);
  // Upgrades the dice policy used ('attacker:<id>' / 'defender:<id>'): spend their charges on the board and say so over the ship.
  const upgradeUsed = (t: string): [ShipState | undefined, string, string] | undefined => {
    const [side, id] = t.split(':');
    if (!effectSource(id)) return undefined;
    return side === 'attacker' ? [ad, a.id, id] : [target, d.id, id];
  };
  for (const t of e.spent) {
    if (t === 'attacker:focus' && ad) ad.focus--;
    if (t === 'attacker:lock' && ad) ad.lock = null;
    if (t === 'defender:focus' && target) target.focus--;
    if (t === 'defender:evade' && target) target.evade--;
    if (t === 'attacker:calculate' && ad) ad.calculate--;
    if (t === 'defender:calculate' && target) target.calculate--;
    const used = upgradeUsed(t);
    if (used) {
      const [ship, id, upgrade] = used;
      const u = sourceState(ship, upgrade);
      // Only effects that cost a charge spend one (the same dice effects the engine applied).
      const costs = effectSource(upgrade)?.effects?.some((fx) => (fx.kind === 'rerollAttack' || fx.kind === 'rerollDefense' || fx.kind === 'cancelEvade') && fx.cost === 'charge');
      if (u && costs) u.charges--;
      void scene.floatText(id, effectSource(upgrade)!.name.toUpperCase(), 'talent-float');
    }
  }
  relabel(a.id);
  relabel(d.id);
  if (e.reinforced) void scene.floatText(d.id, 'REINFORCED', 'talent-float');
  // Ordnance spends a charge; ion weapons leave ion tokens.
  if (e.weapon) { const u = ad?.upgrades.find((x) => x.id === e.weapon); if (u) u.charges--; }
  if (e.ion && target) {
    target.ion += e.ion;
    relabel(d.id);
    void scene.floatText(d.id, `ION +${e.ion}`, 'ion-float');
  }

  // 3. Result
  const o = attackOutcome(e);
  if (o.cls === 'miss' && o.word === 'EVADED' && !jinked) void scene.dodge(d.id);
  showBanner(`<span class="who">${a.name} → ${d.name}${e.weapon ? ` · ${UPGRADES[e.weapon].name}` : ''}</span><b>${o.word}</b><span class="detail">${o.detail}</span>`,
    `${o.cls}${incoming ? ' incoming' : ''}`);
  roundShots.push(`${nameHtml(a.id)} → ${nameHtml(d.id)}: <b class="${o.cls}">${o.word === 'HIT' || o.word === 'CRITICAL HIT' ? o.detail : o.word.toLowerCase()}</b>`);
  await scene.wait(1100);
  scene.showArcs([]);
  if (angle) {
    scene.restoreView(600);
    await scene.wait(600);
  }
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
function showBanner(html: string, cls: string, ms = 1600) {
  banner.className = cls;
  banner.innerHTML = html;
  void banner.offsetWidth; // restart the pop-in animation
  banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => banner.classList.remove('show'), ms / scene.speed);
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
  clearTimeout(recapTimer);
  recapTimer = window.setTimeout(hideRecap, 9000);
}
let recapTimer = 0;
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
    case 'action': return e.action.type === 'none' || e.action.type === 'jam' ? null
      : `${nameHtml(e.shipId)} performs ${actionText(e.action)}${e.linked ? ' (linked)' : ''}${e.coordinatedBy ? ` (coordinated by ${nameHtml(e.coordinatedBy)})` : ''}`;
    case 'obstacleHit': {
      const dmg = e.shieldDamage + e.hullDamage;
      const parts = [`rolls ${e.result}`, e.stress ? `${e.stress} stress` : '', dmg ? `${dmg} damage` : '', e.ion ? '1 ion' : ''].filter(Boolean);
      const skip = OBSTACLE_RULES[e.kind].skipAction ? '; no action' : '';
      return `${nameHtml(e.shipId)} hits ${/^[AEIOU]/.test(OBSTACLE_RULES[e.kind].name) ? 'an' : 'a'} ${OBSTACLE_RULES[e.kind].name.toLowerCase()} (${parts.join(', ')}${skip})`;
    }
    case 'attack': {
      const o = attackOutcome(e);
      const talents = [...(e.diceBy ?? []), ...e.spent.map((t) => t.split(':')[1])].filter((t) => effectSource(t)).map((t) => effectSource(t)!.name);
      if (e.spent.some((t) => t.endsWith(':calculate'))) talents.push('calculate');
      if (e.reinforced) talents.push('reinforced: 1 result cancelled');
      // Tokens the dice policy kept on purpose: focus held for defense, a lock saved for later.
      const kept = (e.kept ?? []).map((t) => (t === 'attacker:focus' ? 'holds focus' : 'keeps lock'));
      return `${nameHtml(e.attackerId)} fires ${e.weapon ? `${UPGRADES[e.weapon].name} ` : ''}at ${nameHtml(e.defenderId)} (range ${e.range}${e.obstructed ? ', obstructed' : ''}${talents.length ? `; ${talents.join(', ')}` : ''}${kept.length ? `; ${kept.join(', ')}` : ''}): ` +
        `<b>${o.word === 'HIT' || o.word === 'CRITICAL HIT' ? `${o.word.toLowerCase()}, ${o.detail}` : o.word.toLowerCase()}</b>`;
    }
    case 'damageCard': {
      const c = DAMAGE_CARDS[e.card];
      const dmg = (e.hullDamage ?? 0) + (e.shieldDamage ?? 0);
      if (e.what === 'dealt') return `⚠ ${nameHtml(e.shipId)} takes critical damage: <b>${c.title}</b> — ${c.text}`;
      if (e.what === 'repaired') return `${nameHtml(e.shipId)} repairs ${c.title}`;
      if (e.what === 'triggered') {
        const parts = [e.roll ? `rolls ${e.roll}` : '', dmg ? `${dmg} damage` : '', e.stress ? `${e.stress} stress` : '', e.ion ? 'ionized' : ''].filter(Boolean);
        return `${nameHtml(e.shipId)}: ${c.title}${parts.length ? ` (${parts.join(', ')})` : ''}`;
      }
      return null;
    }
    case 'upgrade': {
      const n = effectSource(e.upgrade)?.name ?? e.upgrade;
      if (e.what === 'recovered') return `${nameHtml(e.shipId)}'s ${n} is ready again`;
      if (e.what === 'used' && (e.focus || e.calculate || e.shields)) {
        const gains = [e.focus ? 'gains focus' : '', e.calculate ? 'gains calculate' : '', e.shields ? `recovers ${e.shields} shield${e.shields > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
        return `${nameHtml(e.shipId)}: ${n} (${gains})`;
      }
      if (e.what === 'used') return `${nameHtml(e.shipId)} uses ${n}`;
      return `${nameHtml(e.shipId)}'s ${n} is spent`;
    }
    case 'deviceDropped': { const n = UPGRADES[e.device.upgrade].name; return `${nameHtml(e.shipId)} drops ${/^[AEIOU]/.test(n) ? 'an' : 'a'} ${n}`; }
    case 'deviceDetonated': {
      const name = UPGRADES[e.device.upgrade].name;
      if (!e.ships.length) return `${name} detonates: nobody in range`;
      return `${name} detonates: ` + e.ships.map((h) => `${nameHtml(h.shipId)} ${h.ion ? `+${h.ion} ion` : `${h.shieldDamage + h.hullDamage} damage`}${h.roll ? ` (rolled ${h.roll.join(', ')})` : ''}`).join('; ');
    }
    case 'jam': {
      const what = { focus: 'its Focus', evade: 'its Evade', calculate: 'its Calculate', reinforce: 'its Reinforce', lock: 'its lock', jammed: '' }[e.effect];
      return e.effect === 'jammed'
        ? `${nameHtml(e.shipId)} jams ${nameHtml(e.targetId)}: <b>jammed</b> (its next Focus or Evade is lost)`
        : `${nameHtml(e.shipId)} jams ${nameHtml(e.targetId)}: <b>loses ${what}</b>`;
    }
    case 'jamSpent': return `${nameHtml(e.shipId)} is jammed: its ${e.lost[0].toUpperCase() + e.lost.slice(1)} is lost`;
    case 'destroyed': return `💥 ${nameHtml(e.shipId)} destroyed`;
    case 'gameOver': return `<b>${e.winner === 'draw' ? 'Draw' : `${state.players.find((p) => p.id === e.winner)?.name} win`}</b>`;
    case 'info': return e.text;
    default: return null;
  }
}

const actionTypeName = (t: ActionType) =>
  ({ barrelRoll: 'Barrel roll', rotateArc: 'Rotate', boost: 'Boost', focus: 'Focus', evade: 'Evade', lock: 'Lock', repair: 'Repair', jam: 'Jam', calculate: 'Calculate', reinforce: 'Reinforce', reload: 'Reload', coordinate: 'Coordinate' })[t];

function actionText(a: ActionChoice): string {
  switch (a.type) {
    case 'none': return 'no action';
    case 'focus': return 'Focus';
    case 'evade': return 'Evade';
    case 'lock': return `Lock on ${shipById(a.targetId).name}`;
    case 'barrelRoll': return `Barrel roll ${a.dir}${a.shift ? (a.shift > 0 ? ' (forward)' : ' (back)') : ''}`;
    case 'boost': return `Boost ${a.bearing === 'straight' ? 'straight' : a.bearing === 'bankLeft' ? 'left' : 'right'}`;
    case 'repair': return `Repair ${DAMAGE_CARDS[a.card].title}`;
    case 'rotateArc': return `Rotate turret to face ${a.to}`;
    case 'jam': return `Jam ${shipById(a.targetId).name}`;
    case 'calculate': return 'Calculate';
    case 'reinforce': return `Reinforce ${a.side}`;
    case 'reload': return `Reload ${UPGRADES[a.upgrade].name}`;
    case 'coordinate': return `Coordinate ${shipById(a.targetId).name}`;
  }
}

// ---------------------------------------------------------------------------
// Decision panels
// ---------------------------------------------------------------------------
function render() {
  userOverview = false;
  // A gunner's view left over from the last decision (e.g. holding fire) goes back to the table.
  setGunsight(null);
  scene.restoreView();
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
  // Online: the other player's decision (or ours, sent and waiting for the host) shows what they are doing.
  if (versus === 'online' && d && state.phase !== 'over' && (awaitingHost || !(d.kind === 'planning' ? d.waitingOn.includes(me) : d.playerId === me))) {
    return renderOpponentTurn(d);
  }
  if (state.phase === 'over' || !d) {
    scene.highlight(null);
    const title = resultTitle();
    detail.innerHTML = `<h2>${title}</h2>
      <p class="hint">Battle ended in round ${state.round}.</p>
      <div class="row"><button class="go" id="again">New battle</button><button class="opt mini" id="results">Results</button></div>`;
    document.getElementById('again')!.onclick = () => newGame();
    document.getElementById('results')!.onclick = () => showFinale();
    setBar({ status: `<b>${title}</b> <span class="hint">· round ${state.round}</span>`, buttons: [
      { label: 'Results', onClick: () => showFinale() }, { label: 'New battle', cls: 'primary', onClick: () => newGame() }] });
    if (finaleFor !== state) { finaleFor = state; showFinale(true); }
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
  if (d.kind === 'action') return renderAction(d.shipId, d.options, d.linked, d.coordinated?.by);
  if (d.kind === 'attack') return renderAttack(d.shipId, d.targets);
  if (d.kind === 'system') return renderSystem(d.shipId, d.options);
}

// ---------------------------------------------------------------------------
// End of battle: a full-screen result with the battle's numbers, and the winner's
// fireworks over the board. "View board" tucks it away; Results brings it back.
// ---------------------------------------------------------------------------
let finaleFor: GameState | null = null;
const finale = document.createElement('div');
finale.id = 'finale';
finale.hidden = true;
document.body.appendChild(finale);

/** Kills per ship: the last ship to hit a ship (shot or bomb) gets the credit when it is destroyed. */
function killsBy(): Map<string, number> {
  const lastHit = new Map<string, string>(), dropper = new Map<string, string>(), kills = new Map<string, number>();
  for (const e of state.log) {
    if (e.type === 'attack' && e.hullDamage + e.shieldDamage + (e.ion ?? 0) > 0) lastHit.set(e.defenderId, e.attackerId);
    if (e.type === 'deviceDropped') dropper.set(e.device.id, e.shipId);
    if (e.type === 'deviceDetonated') {
      const by = dropper.get(e.device.id);
      if (by) for (const h of e.ships) if (h.shipId !== by && h.hullDamage + h.shieldDamage > 0) lastHit.set(h.shipId, by);
    }
    if (e.type === 'destroyed') {
      const by = lastHit.get(e.shipId);
      if (by && shipById(by).owner !== shipById(e.shipId).owner) kills.set(by, (kills.get(by) ?? 0) + 1);
    }
  }
  return kills;
}

/** Victory/Defeat against the AI; with two players, who won. */
function resultTitle() {
  if (state.winner === 'draw') return 'Draw';
  if (versus === 'human') return `${seatName(state.winner!)} wins`;
  return state.winner === me ? 'Victory' : 'Defeat';
}

function showFinale(first = false) {
  const two = versus === 'human';
  // Two players: told from the winner's side (it's their celebration), and named rather than "you".
  const hero = two && state.winner && state.winner !== 'draw' ? state.winner : me;
  const result = state.winner === 'draw' ? 'draw' : two || state.winner === me ? 'victory' : 'defeat';
  const title = resultTitle();
  const mine = state.ships.filter((s) => s.owner === hero), theirs = state.ships.filter((s) => s.owner === other(hero));
  const down = (xs: ShipState[]) => xs.filter((s) => s.destroyed).length;
  const wiped = (xs: ShipState[]) => down(xs) === xs.length;
  const loser = two ? `${seatName(other(hero))}'s ${factionName(other(hero))}` : factionName(other(hero));
  const why = result === 'draw' ? (wiped(mine) && wiped(theirs) ? 'Both squadrons were wiped out.' : 'Time ran out with the squadrons dead even.')
    : result === 'victory' ? (wiped(theirs) ? `The ${loser} squadron has been wiped out.`
      : `Time ran out after round ${state.round}, with ${two ? `${seatName(hero)}'s` : 'your'} squadron ahead on hull and shields.`)
    : (wiped(mine) ? 'Your squadron has been wiped out.' : `Time ran out after round ${state.round}, with the ${factionName(other(hero))} ahead on hull and shields.`);
  const kills = killsBy();
  // The top ace: the winner's (or anyone's, in a draw) ship with the most kills.
  const aces = [...kills].filter(([id]) => result === 'draw' || shipById(id).owner === state.winner).sort((a, b) => b[1] - a[1]);
  const ace = aces[0];
  const survivors = state.ships.filter((s) => !s.destroyed && (result === 'draw' || s.owner === state.winner));
  const letters = [...title.toUpperCase()].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
  finale.className = result;
  finale.innerHTML = `
    <div class="finale-rays" aria-hidden="true"></div>
    <div class="finale-card" role="dialog" aria-modal="true" aria-labelledby="finale-title">
      <div class="finale-kicker">Battle over · round ${state.round}</div>
      <h1 id="finale-title" aria-label="${title}">${letters}</h1>
      <p class="finale-why">${why}</p>
      <div class="finale-stats">
        <div><b>${down(theirs)}<i>/${theirs.length}</i></b><span>${two && result === 'draw' ? 'Player 2 ships lost' : 'enemy ships destroyed'}</span></div>
        <div><b>${down(mine)}<i>/${mine.length}</i></b><span>${two && result !== 'draw' ? `of ${seatName(hero)}'s ships lost` : two ? 'Player 1 ships lost' : 'of your ships lost'}</span></div>
        <div><b>${state.round}</b><span>rounds</span></div>
      </div>
      ${ace ? `<div class="finale-ace"><span class="medal" aria-hidden="true">★</span><div><span class="hint">Top ace</span><br>
        <b class="${shipById(ace[0]).owner}">${shipById(ace[0]).name}</b> · ${ace[1]} kill${ace[1] > 1 ? 's' : ''}</div></div>` : ''}
      ${survivors.length ? `<div class="finale-survivors"><span class="hint">Still flying</span>
        ${survivors.map((s) => `<span class="chip ${s.owner}">${s.name} <i>${s.hull}/${s.maxHull} hull</i></span>`).join('')}</div>` : ''}
      <div class="finale-buttons"><button class="opt" id="fn-board">View board</button><button class="go" id="fn-again">New battle</button></div>
    </div>`;
  finale.hidden = false;
  void finale.offsetWidth;
  finale.classList.add('show');
  finale.querySelector<HTMLButtonElement>('#fn-again')!.onclick = () => newGame();
  finale.querySelector<HTMLButtonElement>('#fn-board')!.onclick = () => { finale.classList.remove('show'); finale.hidden = true; };
  finale.querySelector<HTMLButtonElement>('#fn-again')!.focus();
  if (first) scene.celebrate(result === 'draw' ? null : state.winner);
}

function hideFinale() {
  finale.hidden = true;
  finale.classList.remove('show');
  scene.stopCelebration();
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
/**
 * The candidate was chosen (a click or tap on a dot, a drag that ended, a special-move button), not just
 * hovered: it stays put while the player looks it over, flips it, or compares, until they choose another
 * or press Set move. Nothing is set without that.
 */
let locked = false;
let lastPointer = 'mouse';
let pointerDown: { x: number; y: number; moved: boolean } | null = null;

interface SnapGroup { pos: { x: number; y: number }; idx: number[] }

/** Maneuvers that end on the same spot as a plain one (K-turn, loops, rolls...), so they hide behind its dot. */
const SPECIAL = new Set<Bearing>(['kturn', 'sloopLeft', 'sloopRight', 'trollLeft', 'trollRight', 'stop', 'reverseStraight', 'reverseBankLeft', 'reverseBankRight']);
const isSpecial = (s: ShipState, i: number) => SPECIAL.has(maneuverOf(s, i).bearing);

/** Choose dial entry `i` directly (from a special-move chip); choosing the one already shown sets it. */
/** Choose maneuver `i` for `s` (a special-move button or the classic dial): it is shown, not set. */
function pickManeuver(s: ShipState, i: number) {
  const g = snapGroups(s).find((x) => x.idx.includes(i));
  if (!g) return;
  candidate = { group: g.idx, flip: g.idx.indexOf(i) };
  locked = true;
  refreshBoard();
}

/** A row of chips under the selected ship for its special maneuvers: tap to choose (then Set move). */
function specialChips(s: ShipState) {
  const specials = legalDial(state, s).filter((i) => isSpecial(s, i));
  const cur = candidate ? candidate.group[candidate.flip] : -1;
  const hint = suggestions()?.[s.id]?.dial;
  const chips = specials.map((i) => {
    const m = maneuverOf(s, i);
    return {
      label: `${i === hint ? '💡 ' : ''}<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span> ${BEARING_NAME[m.bearing]}${i === cur ? ' <b>· chosen</b>' : ''}`,
      cls: `special${i === cur ? ' on' : ''}`,
      onClick: () => pickManeuver(s, i),
    };
  });
  scene.showChips(s.pose, chips, { key: `${s.id}|${specials.join(',')}|${cur}|${hint}`, cls: 'special-row' });
}

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

/** A dial entry as the ship must fly it now (damage cards can make turns harder). */
const maneuverOf = (s: ShipState, i: number) => maneuverFor(s, i);
const maneuverName = (s: ShipState, i: number) => {
  const m = maneuverOf(s, i);
  return `<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span> ${BEARING_NAME[m.bearing]}`;
};
const ghostPoses = (s: ShipState, i: number) => {
  const m = maneuverOf(s, i);
  return [...maneuverPath(s.pose, sizeOf(s), m).path, maneuverFinalPose(s.pose, sizeOf(s), m)];
};
const myShips = () => state.ships.filter((s) => s.owner === me && !s.destroyed);

function updateControls() {
  // On touch, dragging steers the ship, so the camera must not rotate while one is selected.
  scene.controls.enableRotate = !(selected && lastPointer !== 'mouse');
}

function selectShip(id: string | null) {
  selected = id;
  candidate = null;
  locked = false;
  if (id && plan[id] !== undefined) {
    // A ship that already has a move shows it, chosen; pick another dot to change it.
    const s = shipById(id);
    const g = snapGroups(s).find((x) => x.idx.includes(plan[id]));
    if (g) { candidate = { group: g.idx, flip: g.idx.indexOf(plan[id]) }; locked = true; }
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
    scene.clearChips();
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
    // ring the dots that hide a special maneuver, in its colour
    ring: g.idx.filter((i) => isSpecial(s, i)).map((i) => DIFF_COLOR[maneuverOf(s, i).difficulty])[0],
    suggested: suggestions()?.[s.id] !== undefined && g.idx.includes(suggestions()![s.id].dial),
  })));
  specialChips(s);
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
    const already = plan[s.id] === i;
    cand.innerHTML = `<div class="cand-row"><span>${maneuverName(s, i)} <span class="hint">(${m.difficulty})</span></span>
      ${alt !== null ? '<button class="opt mini" id="flip">Flip</button>' : ''}
      <button class="opt mini confirm" id="confirm">${already ? 'Keep' : 'Set move'}</button></div>
      <p class="hint">${locked ? `Chosen${alt !== null ? ': Flip shows the other move from this spot' : ''}. Look it over, pick another dot to compare, then <b>Set move</b> (Enter).`
        : 'Click to choose this move, or keep moving the pointer to compare.'}</p>`;
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

// ---------------------------------------------------------------------------
// Learning aid: the AI's suggested maneuver for each ship, for players who turned hints on at setup.
// ---------------------------------------------------------------------------
let hintCache: { key: string; sug: Record<string, Suggestion> } | null = null;

/** The suggestions for the player planning now (computed once per round from their own view), or null if they are off. */
function suggestions(): Record<string, Suggestion> | null {
  // Each device's own choice: online that is always "you"; two players on one device each have their own.
  const on = versus === 'online' ? lastSetup?.hints.you : me === P1 ? lastSetup?.hints.you : lastSetup?.hints.them;
  if (!lastSetup || state.phase !== 'planning' || !on) return null;
  const key = `${state.round}:${me}`;
  if (hintCache?.key !== key) hintCache = { key, sug: suggestManeuvers(viewFor(state, me), me) };
  return hintCache.sug;
}

/** The suggestion for a ship as a line on its planning card: the move, why, and a button to use it. */
function hintLine(s: ShipState): string {
  const sug = suggestions()?.[s.id];
  if (!sug) return '';
  const odds = (c: number) => (c >= 0.8 ? 'a sure' : c >= 0.5 ? 'a likely' : 'a possible');
  const why = [
    ...(sug.shots.length ? sug.shots.slice(0, 2).map((t) => `${odds(t.chance)} shot at ${shipById(t.shipId).name} (range ${t.range})`) : ['no shot expected yet']),
    sug.threats.length ? `${sug.threats.map((t) => shipById(t.shipId).name).join(' and ')} may have you in ${sug.threats.length > 1 ? 'their arcs' : 'its arc'}`
      : 'out of the enemies\' likely arcs',
    ...sug.obstacles.map((id) => `flies into ${state.obstacles.find((o) => o.id === id) ? OBSTACLE_RULES[state.obstacles.find((o) => o.id === id)!.kind].name.toLowerCase() : 'an obstacle'}`),
  ];
  const following = plan[s.id] === sug.dial;
  return `<div class="suggest"><span>💡 Suggested: <b>${maneuverName(s, sug.dial)}</b>${following ? ' ✓' : ''}</span>
    ${following ? '' : `<button class="opt mini" data-use-hint="${s.id}">Use</button>`}
    <div class="hint">${why.join('; ')}.</div></div>`;
}

/** Set a ship's maneuver to the suggestion (undoable like any other pick) and move on to the next ship. */
function useSuggestion(shipId: string) {
  const sug = suggestions()?.[shipId];
  if (!sug) return;
  lastCommit = { shipId, prev: plan[shipId] };
  plan[shipId] = sug.dial;
  candidate = null;
  const next = myShips().find((x) => plan[x.id] === undefined);
  selectShip(next ? next.id : null);
}

function commit() {
  if (!selected || !candidate) return;
  locked = false;
  lastCommit = { shipId: selected, prev: plan[selected] };
  plan[selected] = candidate.group[candidate.flip];
  const next = myShips().find((s) => plan[s.id] === undefined);
  selectShip(next ? next.id : null);
}

function executePlan() {
  const mine = myShips();
  if (mine.some((s) => plan[s.id] === undefined)) return;
  const dials = Object.fromEntries(mine.map((s) => [s.id, plan[s.id]]));
  camFree = false; // movement and combat: the game frames the action again
  plan = {};
  selected = null;
  candidate = null;
  lastCommit = null;
  hideRecap();
  scene.setPlanned([]);
  scene.setMarkers([]);
  updateControls();
  send({ type: 'setDials', playerId: me, dials });
}

// ---------------------------------------------------------------------------
// Board input. Each decision type installs a BoardMode; the canvas listeners just
// dispatch to it. Mouse previews on hover, touch previews while dragging, and a
// click/tap (no drag) commits.
// ---------------------------------------------------------------------------
/** The pointer position a mode works with (touch drags are lifted above the finger). */
type P = { clientX: number; clientY: number; pointerType: string };
interface BoardMode {
  /** Touch: whether a finger pressed here is the mode's (steering, dragging a ship); otherwise a drag pans the camera. */
  grabs?(p: P): boolean;
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
/** A one-finger camera drag in progress (touch), with the last finger position. */
let panning: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  // A primary pointer means no other finger is down: forget any lift we may have missed,
  // so a lost pointerup can never leave every later touch treated as a two-finger gesture.
  if (e.isPrimary) { touches.clear(); multi = false; }
  touches.add(e.pointerId);
  // Touching the board puts away the round recap and the log sheet.
  if (!recap.hidden) hideRecap();
  if (compact) logEl.classList.remove('open');
  lastPointer = e.pointerType;
  updateControls();
  if (touches.size > 1) { multi = true; if (pointerDown) pointerDown.moved = true; panning = null; return; }
  multi = false;
  pointerDown = { x: e.clientX, y: e.clientY, moved: false };
  // Touch: a finger the current mode doesn't claim (e.g. planning, away from the ship and its dots; or
  // while it isn't our turn) drags the camera instead, so the player can look around with one finger.
  const touch = e.pointerType !== 'mouse';
  const grabbed = !busy && !!mode && (mode.grabs ? mode.grabs(e) : true);
  panning = touch && !grabbed && stage === 'battle' ? { x: e.clientX, y: e.clientY } : null;
  if (!busy && mode && touch && grabbed) { mode.press?.(e); mode.hover?.(lift(e)); }
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 8) pointerDown.moved = true;
  if (panning && pointerDown && !multi) {
    if (pointerDown.moved) { scene.panBy(e.clientX - panning.x, e.clientY - panning.y); panning = { x: e.clientX, y: e.clientY }; }
    return;
  }
  if (busy || !mode || multi) return;
  if (e.pointerType === 'mouse' ? !pointerDown : !!pointerDown) mode.hover?.(lift(e));
});
canvas.addEventListener('pointerup', (e) => {
  touches.delete(e.pointerId);
  const down = pointerDown;
  pointerDown = null;
  const panned = panning && down?.moved;
  panning = null;
  if (busy && down && !down.moved && !multi) scene.skipping = true; // a tap on the board skips the current animation (a drag looks around)
  if (multi) { if (touches.size === 0) multi = false; return; }
  if (panned) return; // the drag looked around; it chose nothing
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
  panning = null;
  if (touches.size === 0) multi = false;
});
addEventListener('keydown', (e) => { if (!busy && mode) mode.key?.(e); });

/**
 * Planning on the board. Choosing and setting are separate: hover (mouse) previews a move; a click or tap
 * on a dot, or a drag from the ship that ends on one, chooses it (it stays shown, to look over or flip);
 * Set move (or Enter) sets it and moves on to the next ship.
 */
const planningMode: BoardMode = {
  /** A finger starting on the selected ship or one of its dots steers; anywhere else it pans the camera. */
  grabs(p) {
    if (!selected) return !!ownShipAt(p);
    const s = shipById(selected);
    if (screenDist(p, s.pose.x, s.pose.y) < 70 || ownShipAt(p)) return true;
    return snapGroups(s).some((g) => screenDist(p, g.pos.x, g.pos.y) < 48);
  },
  press(p) {
    // Pressing on another of your ships selects it, so you can drag straight out of it.
    const picked = ownShipAt(p);
    if (picked && picked !== selected) selectShip(picked);
    locked = false; // steering: follow the finger until it lifts
  },
  hover(p) { if (selected && (!locked || pointerDown)) candidateAt(p); },
  click(p) {
    const mine = ownShipAt(p);
    if (mine && mine !== selected) return selectShip(mine);
    if (!selected) return;
    candidateAt(p);
    if (candidate) { locked = true; refreshBoard(); return; }
    // A click on empty board puts a chosen move down first, then the ship.
    if (locked) { locked = false; refreshBoard(); } else selectShip(null);
  },
  release() { if (selected && candidate) { locked = true; refreshBoard(); } },
  key(e) {
    if (e.key === 'f' || e.key === 'F') flip();
    if (e.key === 'Escape') { if (locked && candidate) { locked = false; candidate = null; refreshBoard(); } else selectShip(null); }
    if (e.key === 'Enter') { if (candidate) commit(); else executePlan(); }
  },
};
/** One of the player's own ships under the pointer, if any. */
const ownShipAt = (p: P) => { const id = scene.pickShip(p.clientX, p.clientY); return id && shipById(id).owner === me ? id : null; };

const deployMode: BoardMode = {
  press(p) {
    const picked = scene.pickShip(p.clientX, p.clientY);
    if (picked && shipById(picked).owner === me) pickUp(picked);
  },
  hover(p) { moveCarried(p); },
  click(p) {
    if (carrying) return dropCarried();
    const picked = scene.pickShip(p.clientX, p.clientY);
    if (picked && shipById(picked).owner === me) pickUp(picked);
  },
  release() { dropCarried(); },
  key(e) {
    if (e.key === 'Escape' && carrying) { carryValid = false; dropCarried(); }
    if (e.key === 'Enter') beginBattle();
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
    if (stage === 'deploy') renderDeployment();
    else if (stage === 'battle' && state && !busy) renderDecision();
  }
  applyCamera(250);
}
addEventListener('resize', () => updateLayout());
/**
 * Phones rotating: some browsers report the new size a moment late and can leave the page scrolled or
 * zoomed from the other orientation. Put the page back at the origin and measure again once it settles.
 */
let settleTimers: number[] = [];
const resettle = () => {
  settleTimers.forEach(clearTimeout);
  const again = () => { scrollTo(0, 0); scene.resize(); updateLayout(); };
  again();
  settleTimers = [150, 500, 1000].map((ms) => window.setTimeout(again, ms));
};
addEventListener('orientationchange', resettle);
visualViewport?.addEventListener('resize', () => { if (visualViewport!.scale !== 1 || scrollX || scrollY) resettle(); });
screen.orientation?.addEventListener?.('change', resettle);

/** Screen area covered by UI, so the camera can frame what is left. */
function uiInsets() {
  const r = panel.getBoundingClientRect();
  const top = Math.max(ticker.getBoundingClientRect().bottom, 40) + 6;
  return innerHeight >= innerWidth
    ? { top, bottom: innerHeight - r.top + 6, left: 0, right: 0 }
    : { top: 44, bottom: 0, left: 0, right: innerWidth - r.left + 6 };
}

/** Phones: the player has moved the camera themselves, so the game leaves it alone (until Recenter, or the next round's planning). */
let camFree = false;
scene.onUserCamera = () => {
  if (!compact || camFree) return;
  camFree = true;
  viewBtn.textContent = 'Recenter';
};

function applyCamera(ms = 500) {
  if (!compact || !state || scene.inAttackView) return;
  // On an upright phone the board is wider than the screen: zoom in past its sides a little.
  const zoom = innerHeight > innerWidth ? 1.25 : 1;
  // The whole board, plus headroom past the far edge for the labels floating over the enemy's ships.
  const board = (tilt: number) => scene.frameRect(457, 457 + 35 * scene.facing, 457, 492, uiInsets(), tilt, ms, zoom);
  if (stage === 'deploy') { viewBtn.hidden = true; board(0.45); return; }
  if (stage !== 'battle') return;
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
      pts = [s.pose, ...d.options.flatMap((o) => (o.type === 'lock' || o.type === 'coordinate' ? [shipById(o.targetId).pose] : []))];
      minHalf = 130;
    }
    if (d.kind === 'attack') pts = [shipById(d.shipId).pose, ...d.targets.map((t) => shipById(t.targetId).pose)];
    if (d.kind === 'system') { pts = [shipById(d.shipId).pose, ...d.options.flatMap((o) => (o.type === 'drop' ? [o.pose] : []))]; minHalf = 160; }
  }
  viewBtn.hidden = false;
  viewBtn.textContent = userOverview || camFree ? 'Recenter' : 'Overview';
  // The player moved the camera: leave it where they put it until they press Recenter.
  if (camFree) return;
  if (pts && !userOverview) framePoints(pts, minHalf, ms);
  else board(0.2);
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
    // Tapping a ship's button always brings the camera to it, even after an Overview or looking around.
    b.onclick = () => { userOverview = false; camFree = false; if (s.id === selected) applyCamera(); else selectShip(s.id); };
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
      status = `<b>${s.name.split(' ')[0]}</b>: ${maneuverName(s, i)}${plan[s.id] === i ? ' <span class="hint">(set)</span>' : ' <span class="hint">· not set yet</span>'}`;
      if (candidate.group.length > 1) buttons.push({ label: 'Flip', onClick: flip });
      if (plan[s.id] !== i) buttons.push({ label: 'Set move', cls: 'primary', onClick: commit });
    } else {
      status = `<b>${s.name.split(' ')[0]}</b>: drag from the ship or tap a dot to choose a move · drag elsewhere to look around`;
    }
    // Learning aid on phones: the suggestion as a one-tap button (the gold-ringed dot shows where it goes).
    const sug = suggestions()?.[s.id];
    if (sug && plan[s.id] !== sug.dial && !isIonized(s)) buttons.push({ label: `💡 ${shortMove(s, sug.dial)}`, onClick: () => useSuggestion(s.id) });
  }
  if (lastCommit) buttons.unshift({ label: 'Undo', onClick: undoCommit });
  buttons.push({ label: 'Execute', cls: 'go-btn', disabled: mine.some((s) => plan[s.id] === undefined), onClick: executePlan });
  setBar({ status, ships, buttons });
}

function renderPlanning() {
  const mine = myShips();
  // An ionized ship ignores its dial (it drifts 1 straight), so plan it automatically.
  for (const s of mine) if (isIonized(s) && plan[s.id] === undefined) plan[s.id] = legalDial(state, s)[0];
  detail.innerHTML = `<h2>Planning</h2><p class="hint">Click a ship, then move the pointer: the ghost snaps to each maneuver it can fly.
    Click a dot to choose that move; it stays shown so you can look it over and compare. <b>Set move</b> (Enter) sets it.
    Special moves (K-turn, loops, rolls) are the buttons under the ship. A ringed dot hides one; <b>F</b> or Flip switches to it.
    Blue clears stress, red adds it.</p>${obstacleLegend()}`;
  for (const s of mine) {
    const t = SHIP_TYPES[s.typeId];
    const card = document.createElement('div');
    card.className = 'card' + (plan[s.id] !== undefined ? ' done' : '') + (s.id === selected ? ' active' : '');
    card.innerHTML = `<h3>${s.name} <span class="hint">· ${t.name} · init ${s.initiative}</span></h3>
      <div class="stats">atk ${t.primaries.map((p) => `${p.attack}${p.arc === 'rear' ? 'R' : ''}`).join('/')} · agi ${t.agility} · hull ${s.hull}/${s.maxHull} · shields ${s.shields}/${s.maxShields}${s.stress ? ` · <span style="color:var(--red)">stressed</span>` : ''}</div>
      ${abilityLine(s)}
      ${s.upgrades.length ? `<div class="hint">${s.upgrades.map((u) => upgradeLabel(u, s)).join(' · ')}</div>` : ''}
      ${critList(s)}
      ${isIonized(s) ? '' : hintLine(s)}
      <div class="planned">${isIonized(s) ? '<span class="ion">⚡ Ionized: drifts 1 straight, Focus only</span>'
        : plan[s.id] !== undefined ? maneuverName(s, plan[s.id]) : '<span class="hint">No maneuver set</span>'}</div>`;
    card.onclick = (e) => { if (!(e.target as HTMLElement).closest('details, button')) selectShip(s.id); };
    card.querySelector<HTMLButtonElement>('[data-use-hint]')?.addEventListener('click', () => useSuggestion(s.id));
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
/** The ship's face-up damage cards, with what each one does. */
function critList(s: ShipState): string {
  if (!s.crits.length) return '';
  return `<ul class="crit-list">${s.crits.map((c) => `<li><b>${DAMAGE_CARDS[c].title}</b> ${DAMAGE_CARDS[c].text}${DAMAGE_CARDS[c].repairable ? ' <span class="hint">(repairable)</span>' : ''}</li>`).join('')}</ul>`;
}

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
      const m = maneuverOf(s, i);
      const b = document.createElement('button');
      b.innerHTML = `<span class="${m.difficulty}">${m.speed} ${GLYPH[m.bearing]}</span>`;
      b.title = `${maneuverLabel(m)} (${m.difficulty})`;
      b.disabled = !legal.has(i);
      if (plan[s.id] === i) b.classList.add('sel');
      // The classic dial chooses too; Set move confirms.
      b.onclick = () => { if (selected !== s.id) selectShip(s.id); pickManeuver(s, i); };
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
type JamChoice = Extract<ActionChoice, { type: 'jam' }>;
type CoordChoice = Extract<ActionChoice, { type: 'coordinate' }>;
/** Actions aimed at another ship: picked by clicking a ringed ship. */
type ShipTargeted = LockChoice | JamChoice | CoordChoice;
const ACTION_COLOR = { barrelRoll: 0x7cf0c5, boost: 0x9be37c, lock: 0xffd166, jam: 0xc58bff, coordinate: 0x8fd3ff } as const;
const GREEN = 0x7cf0c5, RED = 0xff5a5a;
/** How far (mm) the pointer may be from a barrel roll / boost spot and still snap. */
const ACTION_SNAP = 45;

/** `linked`: this is the linked action offered after another one (only its options, maybe red). */
/** What each action does, for the action ring's help popup (hover with a mouse, hold with a finger). */
const ACTION_HELP: Record<string, string> = {
  focus: 'Gain a focus token. When you attack, every focus result becomes a hit; when you defend, every focus result becomes an evade. It is spent for you when it helps, and lasts until the end of the round.',
  evade: 'Gain an evade token. When you defend, it adds an evade result, cancelling one hit. Lasts until the end of the round.',
  calculate: 'Gain a calculate token. It changes <b>one</b> focus result: to a hit when you attack, or an evade when you defend. Weaker than Focus (one die instead of all of them), but cheap insurance. Lasts until the end of the round.',
  lock: 'Lock onto an enemy (any range, no arc needed). Attacking that ship, you reroll your blanks (and focus results if you have no focus to spend). Most missiles and torpedoes can only fire at a locked ship. A lock lasts until you use it.',
  jam: 'Jam an enemy at range 1-2 in your firing arc: it loses its focus, evade, calculate or reinforce token, or else its lock. If it has none, it gets a jam token that cancels the next token it gains.',
  coordinate: 'Pick a friendly ship at range 0-2 that isn\'t stressed: it takes an action right now (and still gets its own later).',
  barrelRoll: 'Slide sideways by one base width, forward, level or back, keeping your facing. A quick way into an enemy\'s path or out of its arc. Then pick a teal spot.',
  boost: 'Fly a short extra move after your maneuver: 1 straight or a 1 bank. Close in, or slip out of an arc. Then pick a green spot.',
  rotateArc: 'Turn your turret arc to face front, left, right or rear, so the turret can shoot that way.',
  reinforce: 'Brace the front or rear half of your ship for the rest of the round: an attack from that side that lands 2 or more hits loses one.',
  reload: 'Get back one charge on this missile, torpedo or bomb. You can\'t attack this round.',
  none: 'Take no action this round.',
};
const RED_NOTE = '<br><span class="red">Red: it costs 1 stress. A stressed ship can\'t take actions or fly red maneuvers until a blue maneuver clears it.</span>';

function renderAction(shipId: string, options: ActionChoice[], linked?: { from: ActionType; red: boolean }, coordinatedBy?: string) {
  const s = shipById(shipId);
  const by = coordinatedBy ? shipById(coordinatedBy).name : '';
  const linkNote = [linked ? `Linked after ${actionTypeName(linked.from)}${linked.red ? ' (red: +1 stress)' : ''}` : '', by ? `Coordinated by ${by}` : ''].filter(Boolean).join(' · ');
  const red = linked?.red ? 'red' : undefined;
  const spots = options.filter((o): o is Spot => o.type === 'barrelRoll' || o.type === 'boost');
  const locks = options.filter((o): o is LockChoice => o.type === 'lock');
  const jams = options.filter((o): o is JamChoice => o.type === 'jam');
  const coords = options.filter((o): o is CoordChoice => o.type === 'coordinate');
  const instant = (o: ActionChoice) => ['focus', 'evade', 'calculate', 'reinforce', 'reload', 'repair'].includes(o.type);
  const simple = [...options.filter(instant), { type: 'none' } as ActionChoice];
  let cand: ActionChoice | null = null;
  /**
   * The targeted action picked from the ring (lock / barrel roll / boost), or null while the ring is
   * showing. Picking one hides the ring and shows only its targets; Esc or Back brings the ring back.
   */
  let only: 'lock' | 'jam' | 'coordinate' | 'barrelRoll' | 'boost' | 'rotateArc' | null = null;
  const choose = (c: ActionChoice) => send({ type: 'action', playerId: me, choice: c });
  const back = () => { only = null; cand = null; show(); };
  /** Ships the picked targeted action (Lock, Jam: enemies; Coordinate: friends) can reach: ringed on the board. */
  const shownLocks = (): ShipTargeted[] => (only === 'lock' ? locks : only === 'jam' ? jams : only === 'coordinate' ? coords : []);
  const shownSpots = () => spots.filter((o) => only === o.type);

  /** The ring: instant actions do it now; Lock / Barrel roll / Boost narrow the board to their targets. */
  const radial = () => {
    const has = (t: string) => options.some((o) => o.type === t);
    if (only === 'rotateArc') {
      // Rotate: the ring becomes the turret facings (hover to preview the arc), plus Back.
      const dirs = options.filter((o): o is Extract<ActionChoice, { type: 'rotateArc' }> => o.type === 'rotateArc');
      // Each facing's button sits (and its arrow points) where that facing is on screen, so with the ship
      // pointing up the board Left is on the left, Right on the right and Rear at the bottom. Back takes
      // the remaining spot: the way the turret faces now.
      const OFFSET: Record<string, number> = { front: 0, left: Math.PI / 2, rear: Math.PI, right: -Math.PI / 2 };
      const onScreen = (arc: string) => scene.screenBearing(s.pose.x, s.pose.y, s.pose.h + OFFSET[arc]);
      const items: RadialItem[] = dirs.map((o) => ({
        angle: onScreen(o.to),
        icon: `<span style="display:inline-flex;transform:rotate(${onScreen(o.to).toFixed(0)}deg)">${ICONS.boost}</span>`,
        label: o.to[0].toUpperCase() + o.to.slice(1),
        title: `Turn the turret to face ${o.to}`,
        onClick: () => choose(o),
        onHover: (on) => { void scene.setTurret(s.id, on ? o.to : s.turretArc, 150, true); },
      }));
      items.push({ angle: onScreen(s.turretArc), icon: ICONS.back, label: 'Back', title: 'Back to the action menu (Esc)', cls: 'quiet', onClick: () => { void scene.setTurret(s.id, s.turretArc, 0, true); back(); } });
      scene.showRadial(s.pose, items, { key: 'rotate', caption: `Turret faces ${s.turretArc}: pick a new facing · Esc to go back` });
      return;
    }
    if (only) {
      // Targeting: the ring makes way for the targets; a lone Back button returns to it.
      const what = only === 'lock' ? 'Click a ringed enemy to lock it' : only === 'jam' ? 'Click a ringed enemy to jam it'
        : only === 'coordinate' ? 'Click a ringed friend: it takes an action now' : only === 'barrelRoll' ? 'Click a teal spot to barrel roll' : 'Click a green spot to boost';
      scene.showRadial(s.pose, [{ icon: ICONS.back, label: 'Back', title: 'Back to the action menu (Esc)', cls: 'quiet', onClick: back }],
        { key: `back|${only}|${cand ? JSON.stringify(cand) : ''}`, caption: `${cand ? actionText(cand) : what} · Esc to go back` });
      return;
    }
    const redOf = (t: ActionType) => !!SHIP_TYPES[s.typeId].actions.find((a) => a.type === t)?.red || !!linked?.red;
    const helpOf = (t: ActionType) => ACTION_HELP[t] + (redOf(t) ? RED_NOTE : '');
    const narrow = (t: 'lock' | 'jam' | 'coordinate' | 'barrelRoll' | 'boost', icon: string, label: string, hint: string): RadialItem =>
      ({ icon, label, title: hint.split(':')[0], help: helpOf(t), onClick: () => { only = t; cand = null; show(); } });
    const items: RadialItem[] = [];
    const stress = linked?.red ? ' (red: +1 stress)' : '';
    if (has('focus')) items.push({ icon: ICONS.focus, label: 'Focus', title: `Focus${stress}`, help: helpOf('focus'), cls: red, onClick: () => choose({ type: 'focus' }) });
    if (has('evade')) items.push({ icon: ICONS.evade, label: 'Evade', title: `Evade${stress}`, help: helpOf('evade'), cls: red, onClick: () => choose({ type: 'evade' }) });
    if (has('calculate')) items.push({ icon: ICONS.calculate, label: 'Calc', title: `Calculate${stress}`, help: helpOf('calculate'), cls: red, onClick: () => choose({ type: 'calculate' }) });
    for (const o of options) {
      if (o.type !== 'reinforce') continue;
      items.push({
        icon: ICONS.reinforce, label: o.side === 'front' ? 'Reinf. fr.' : 'Reinf. rear',
        title: `Reinforce ${o.side}${stress}`, help: helpOf('reinforce').replace('the front or rear half', `the <b>${o.side}</b> half`), cls: red, onClick: () => choose(o),
      });
    }
    for (const o of options) {
      if (o.type !== 'reload') continue;
      const u = UPGRADES[o.upgrade];
      items.push({ icon: ICONS.reload, label: 'Reload', title: `Reload ${u.name}${stress}`, help: helpOf('reload').replace('this missile, torpedo or bomb', `your <b>${u.name}</b>`), cls: red, onClick: () => choose(o) });
    }
    if (locks.length) items.push(narrow('lock', ICONS.lock, 'Lock', 'Lock: then click a ringed enemy'));
    if (jams.length) items.push(narrow('jam', ICONS.jam, 'Jam', 'Jam: strip an enemy\'s Focus, Evade or lock (range 1-2 in your arc); then click a ringed enemy'));
    if (coords.length) items.push(narrow('coordinate', ICONS.coordinate, 'Coord.', 'Coordinate: a friend at range 0-2 that is not stressed takes an action now; then click a ringed friend'));
    if (spots.some((o) => o.type === 'barrelRoll')) items.push(narrow('barrelRoll', ICONS.barrelRoll, 'Roll', 'Barrel roll: then click a teal dot'));
    if (spots.some((o) => o.type === 'boost')) items.push(narrow('boost', ICONS.boost, 'Boost', 'Boost: then click a green dot'));
    if (has('rotateArc')) items.push({ icon: ICONS.turret, label: 'Rotate', title: `Rotate the turret (now facing ${s.turretArc})`, help: helpOf('rotateArc'), onClick: () => { only = 'rotateArc'; cand = null; show(); } });
    for (const o of options) {
      if (o.type !== 'repair') continue;
      const c = DAMAGE_CARDS[o.card];
      items.push({ icon: ICONS.repair, label: c.tag.slice(0, 7), title: `Repair ${c.title}`, help: `Use your action to fix this damage card and discard it. While it stays: ${c.text}`, cls: 'repair', onClick: () => choose(o) });
    }
    items.push({ icon: ICONS.skip, label: 'Skip', title: linked ? 'Skip the linked action' : 'Skip the action', help: linked ? 'Don\'t take the linked action.' : ACTION_HELP.none, cls: 'quiet', onClick: () => choose({ type: 'none' }) });
    scene.showRadial(s.pose, items, {
      key: linked ? `linked|${linked.from}|${shipId}` : by ? `coord|${shipId}` : 'menu',
      caption: linked ? `${linkNote}: take it or skip` : by ? `Coordinated by ${by}: pick an action` : 'Pick an action',
    });
  };

  const show = () => {
    scene.setRings({ [s.id]: GREEN, ...Object.fromEntries(shownLocks().map((l) => [l.targetId, ACTION_COLOR[l.type]])) });
    scene.setMarkers(shownSpots().map((o) => ({ x: o.to.x, y: o.to.y, color: ACTION_COLOR[o.type], active: cand === o })));
    radial();
    const repositioning = cand && (cand.type === 'barrelRoll' || cand.type === 'boost');
    scene.showArcs(repositioning ? [] : [s.id], only === 'rotateArc' ? 'turret' : 'all');
    showOddsFrom(s, cand && (cand.type === 'barrelRoll' || cand.type === 'boost') ? cand.to : s.pose, true);
    if (cand && (cand.type === 'barrelRoll' || cand.type === 'boost')) {
      scene.showGhost(sizeOf(s), [s.pose, cand.to], ACTION_COLOR[cand.type], actionText(cand), s.id);
    } else scene.clearGhost();
    if (cand?.type === 'lock' || cand?.type === 'jam' || cand?.type === 'coordinate') {
      scene.showLine(s.pose, shipById(cand.targetId).pose, ACTION_COLOR[cand.type], actionText(cand));
    } else scene.clearOverlay();
    const who = `<b>${s.name.split(' ')[0]}</b>`;
    const boardHint = only === 'barrelRoll' ? 'tap a teal dot to roll' : only === 'boost' ? 'tap a green dot to boost'
      : only === 'lock' ? 'tap a ringed enemy to lock it' : only === 'jam' ? 'tap a ringed enemy to jam it'
      : only === 'coordinate' ? 'tap a ringed friend to coordinate it' : 'pick from the ring around your ship';
    const btns: BarButton[] = only ? [{ label: 'Back', onClick: back }]
      : simple.map((o) => ({ label: o.type === 'none' ? 'Skip' : actionText(o), onClick: () => choose(o) }));
    if (cand && cand.type !== 'none' && !instant(cand)) {
      const c = cand;
      btns.unshift({ label: 'Do it', cls: 'primary', onClick: () => choose(c) });
    }
    setBar({ status: cand ? `${who}: ${actionText(cand)}` : `${who}: ${linkNote ? `${linkNote}, ` : ''}${boardHint}`, buttons: btns });
  };
  const pick = (p: P): ActionChoice | null => {
    const picked = scene.pickShip(p.clientX, p.clientY);
    const lock = shownLocks().find((l) => l.targetId === picked);
    if (lock) return lock;
    const pt = scene.boardPoint(p.clientX, p.clientY);
    let best: Spot | null = null, bestD = Infinity;
    for (const o of shownSpots()) {
      const d = screenDist(p, o.to.x, o.to.y);
      const near = d < fingerPx(p) || (pt !== null && Math.hypot(o.to.x - pt.x, o.to.y - pt.y) < ACTION_SNAP);
      if (near && d < bestD) { bestD = d; best = o; }
    }
    if (best) return best;
    // Touch: also accept a tap near a lockable enemy's base.
    for (const l of shownLocks()) {
      const t = shipById(l.targetId).pose;
      if (screenDist(p, t.x, t.y) < fingerPx(p)) return l;
    }
    return null;
  };
  mode = {
    hover(e) { const c = pick(e); if (c !== cand) { cand = c; show(); } },
    click(e) { const c = pick(e); if (c) choose(c); },
    key(e) { if (e.key === 'Escape' && only) { if (only === 'rotateArc') void scene.setTurret(s.id, s.turretArc, 0, true); back(); } },
  };

  const ring = [
    `Pick from the ring around your ship: ${['Focus', 'Evade', 'Calculate', 'Reinforce', 'Reload'].filter((n) => options.some((o) => o.type === n.toLowerCase())).join(', ') || 'instant actions'} act at once`,
    locks.length ? '<b style="color:#ffd166">Lock</b> then click a ringed enemy' : '',
    jams.length ? '<b style="color:#c58bff">Jam</b> then click a ringed enemy to strip its Focus, Evade or lock' : '',
    coords.length ? '<b style="color:#8fd3ff">Coordinate</b> then click a ringed friend: it takes an action now' : '',
    spots.some((o) => o.type === 'barrelRoll') ? '<b style="color:#7cf0c5">Roll</b> shows the barrel-roll spots' : '',
    spots.some((o) => o.type === 'boost') ? '<b style="color:#9be37c">Boost</b> shows the boost spots' : '',
  ].filter(Boolean);
  detail.innerHTML = linked
    ? `<h2>Linked action: ${s.name}</h2><p class="hint">${linkNote}. Take it from the ring, or skip.</p>${critList(s)}`
    : by ? `<h2>Coordinated: ${s.name}</h2><p class="hint">${by} lets ${s.name} take an action now, outside its own turn. ${ring.join('; ')}.</p>${critList(s)}`
    : `<h2>Action: ${s.name}</h2><p class="hint">${ring.join('; ')}. Or pick a line below.</p>${critList(s)}`;
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
type Target = TargetInfo;
const weaponName = (t: Pick<Target, 'weapon'>) => (isPrimary(t) ? 'Primary' : UPGRADES[t.weapon!].name);
const targetText = (t: Target, attacker?: ShipState) =>
  `${shipById(t.targetId).name}: ${isPrimary(t) ? '' : `${weaponName(t)}, `}range ${t.range}, ` +
  `${attacker ? attackDiceFor(attacker, t, shipById(t.targetId)) : t.attack} dice${t.obstructed ? ', obstructed' : ''}${isPrimary(t) && t.bullseye ? ', bullseye' : ''}`;

/** What each kind of obstacle on this board does, for the planning panel (all of them block line of sight). */
function obstacleLegend(): string {
  const kinds = [...new Set(state.obstacles.map((o) => o.kind))];
  if (!kinds.length) return '';
  const swatch: Record<string, string> = { asteroid: '#d08a4a', debris: '#d8c56a', gas: '#b08cff' };
  return `<details class="legend"><summary>Obstacles: ${kinds.map((k) => `<span style="color:${swatch[k]}">${OBSTACLE_RULES[k].name}</span>`).join(' · ')}</summary>
    <p class="hint">Flying through or onto one:</p>
    ${kinds.map((k) => `<p class="hint"><b style="color:${swatch[k]}">${OBSTACLE_RULES[k].name}</b>: ${OBSTACLE_RULES[k].text}</p>`).join('')}
    <p class="hint">All of them obstruct attacks drawn through them (+1 defense die).</p></details>`;
}

/** The pilot's ability, with its charges if it has any, e.g. "Steady Nerves 0/1" (hover for the text). */
function abilityLine(s: ShipState): string {
  const a = s.ability && effectSource(s.ability.id);
  if (!s.ability || !a) return '';
  const charges = a.charges ? ` ${s.ability.charges}/${a.charges}` : '';
  return `<div class="hint ability" title="${a.text}"><b>${a.name}</b>${charges}: ${a.text}</div>`;
}

/** An upgrade with its charges, e.g. "Proton Torpedoes 1/2", or "(spent)" for one-shot talents. */
function upgradeLabel(u: { id: string; charges: number }, ship?: ShipState) {
  const def = UPGRADES[u.id];
  if (def.weapon?.arc === 'turret') return `${def.name}${ship ? ` (facing ${ship.turretArc})` : ''}`;
  if (def.weapon || def.device) return `${def.name} ${u.charges}/${def.charges}`;
  return `${def.name}${def.charges && !u.charges ? ' (spent)' : ''}`;
}

/** How good a shot is, for picking a default weapon: expected damage, plus ions and kills. */
const shotValue = (attacker: ShipState, t: Target) => {
  const o = attackOdds(attacker, shipById(t.targetId), t, state);
  return o.expected + o.ion * 0.6 + o.kill * 3;
};
/** The best weapon per enemy from a list of target entries. */
function bestPerTarget(attacker: ShipState, ts: Target[]): Map<string, Target> {
  const best = new Map<string, Target>();
  for (const t of ts) {
    const cur = best.get(t.targetId);
    if (!cur || shotValue(attacker, t) > shotValue(attacker, cur)) best.set(t.targetId, t);
  }
  return best;
}

/** "62% hit · 1.4 dmg · 18% kill" for one attack, from the engine's exact odds. */
function oddsHtml(attacker: ShipState, t: Target): string {
  const o = attackOdds(attacker, shipById(t.targetId), t, state);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const cls = o.hit >= 0.66 ? 'hi' : o.hit >= 0.4 ? 'mid' : 'lo';
  return `${isPrimary(t) ? '' : `<span class="wpn">${weaponName(t)}</span> `}<span class="${cls}"><b>${pct(o.hit)}</b> hit</span> · ${o.expected.toFixed(1)} dmg` +
    (o.ion >= 0.05 ? ` · <span class="ion">${o.ion.toFixed(1)} ion</span>` : '') +
    (o.kill >= 0.005 ? ` · <span class="kill">${pct(o.kill)} kill</span>` : '');
}

/**
 * Hit odds over every enemy `s` could shoot from `pose` (default: where it is). Used wherever its arc
 * is shown; while planning the enemies' current positions are used, so it is a preview.
 */
function showOddsFrom(s: ShipState, pose: Pose = s.pose, preview = false) {
  const me = { ...s, pose };
  scene.setOdds(Object.fromEntries([...bestPerTarget(me, legalTargets(state, me)).values()].map((t) =>
    [t.targetId, `${preview ? '<span class="pv">if here</span> ' : ''}${oddsHtml(me, t)}`])));
}

/**
 * System phase: drop a bomb or mine behind the ship, or skip. Hovering a choice previews where the token
 * lands and (for bombs) its range-1 blast.
 */
function renderSystem(shipId: string, options: DropChoice[]) {
  const s = shipById(shipId);
  const drops = options.filter((o): o is Extract<DropChoice, { type: 'drop' }> => o.type === 'drop');
  const choose = (c: DropChoice) => { scene.previewDevice(null); send({ type: 'drop', playerId: me, choice: c }); };
  const preview = (o: Extract<DropChoice, { type: 'drop' }> | null) =>
    scene.previewDevice(o ? { pose: o.pose, kind: UPGRADES[o.upgrade].device!.kind } : null);
  const short = (id: string) => ({ 'proton-bomb': 'Proton', 'ion-bomb': 'Ion bomb', 'proximity-mine': 'Mine' } as Record<string, string>)[id] ?? UPGRADES[id].name.split(' ')[0];
  scene.setRings({ [s.id]: GREEN });
  scene.showArcs([]);
  const items: RadialItem[] = drops.map((o) => ({
    icon: UPGRADES[o.upgrade].device!.kind === 'mine' ? ICONS.mine : ICONS.bomb,
    label: short(o.upgrade),
    badge: s.upgrades.find((u) => u.id === o.upgrade)?.charges,
    title: `Drop ${UPGRADES[o.upgrade].name}`, help: UPGRADES[o.upgrade].text,
    onClick: () => choose(o),
    onHover: (on) => preview(on ? o : null),
  }));
  items.push({ icon: ICONS.skip, label: 'Skip', title: 'Drop nothing', help: 'Keep your bombs and mines for later.', cls: 'quiet', onClick: () => choose({ type: 'none' }) });
  scene.showRadial(s.pose, items, { key: 'system', caption: 'System phase: drop a device behind you? (hover to preview)' });
  mode = { click() {}, key(e) { if (e.key === 'Escape') choose({ type: 'none' }); } };
  setBar({
    status: `<b>${s.name.split(' ')[0]}</b>: drop a bomb or mine?`,
    buttons: [...drops.map((o) => ({ label: `Drop ${short(o.upgrade)}`, onClick: () => choose(o) })), { label: 'Skip', onClick: () => choose({ type: 'none' }) }],
  });
  detail.innerHTML = `<h2>System: ${s.name}</h2><p class="hint">Before anyone moves, you may drop one device one straight template behind
    your ship. Bombs go off at the end of the Activation phase and hit every ship at range 0-1, yours too; mines stay until a ship
    flies through or onto one. Hover a button in the ring to preview.</p>`;
  for (const o of drops) {
    const b = document.createElement('button');
    b.className = 'opt';
    const u = s.upgrades.find((x) => x.id === o.upgrade);
    b.innerHTML = `<b>Drop ${UPGRADES[o.upgrade].name}</b> (${u?.charges} left)<br><span class="hint">${UPGRADES[o.upgrade].text}</span>`;
    b.onmouseenter = () => preview(o);
    b.onmouseleave = () => preview(null);
    b.onclick = () => choose(o);
    detail.appendChild(b);
  }
  const skip = document.createElement('button');
  skip.className = 'opt';
  skip.textContent = 'Drop nothing';
  skip.onclick = () => choose({ type: 'none' });
  detail.appendChild(skip);
}

/** Radial-menu icon and short label for a weapon ('primary' or an ordnance upgrade id). */
const weaponIcon = (w: string, turretPrimary = false) => (w === 'primary' ? (turretPrimary ? ICONS.turret : ICONS.lasers) : UPGRADES[w].slot === 'torpedo' ? ICONS.torpedo : UPGRADES[w].slot === 'turret' ? ICONS.turret : ICONS.missile);
const WEAPON_SHORT: Record<string, string> = {
  primary: 'Lasers', 'proton-torpedoes': 'Proton', 'ion-torpedoes': 'Ion torp', 'concussion-missiles': 'Missiles', 'rocket-pods': 'Rockets',
  'dorsal-turret': 'Turret', 'ion-turret': 'Ion cann.',
};
const weaponShort = (w: string) => WEAPON_SHORT[w] ?? UPGRADES[w].name.split(' ')[0].slice(0, 8);

// ---------------------------------------------------------------------------
// Gunsight: the target readout shown while aiming from the gunner's view
// ---------------------------------------------------------------------------
const gunsight = document.createElement('div');
gunsight.id = 'gunsight';
gunsight.hidden = true;
document.body.appendChild(gunsight);
function setGunsight(html: string | null, on: Record<string, () => void> = {}) {
  if (html === null) { gunsight.hidden = true; gunsight.innerHTML = ''; return; }
  // Sit above whatever UI covers the bottom (the phone panel), centred in the space left over.
  // On desktop, keep clear of the combat log in the bottom-left corner.
  const ins = uiInsets();
  const log = logEl.getBoundingClientRect();
  gunsight.style.bottom = `${(compact ? ins.bottom : 0) + 16}px`;
  gunsight.style.left = `${compact ? ins.left : log.width ? log.right + 12 : 0}px`;
  gunsight.style.right = `${compact ? ins.right : 0}px`;
  gunsight.innerHTML = html;
  gunsight.hidden = false;
  gunsight.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); on[b.dataset.act!]?.(); }));
}

/** Bearing of `to` seen from `from`, relative to its heading: positive is to the left, negative to the right. */
function relBearing(from: Pose, to: Pose) {
  const a = Math.atan2(to.y - from.y, to.x - from.x) - from.h;
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Attack: pick a weapon from the ring around your ship. The camera then drops in behind it, aimed at the
 * best shot; cycle through every enemy that weapon can hit (arrows / Tab, or the gunsight's buttons),
 * compare the odds, and fire. Esc / Back returns to the table and the ring.
 */
function renderAttack(shipId: string, targets: Target[]) {
  const s = shipById(shipId);
  const weaponIds = ['primary', ...s.upgrades.filter((u) => UPGRADES[u.id].weapon).map((u) => u.id)];
  const turretPrimary = SHIP_TYPES[s.typeId].primaries.some((p) => p.arc === 'turret');
  const targetsFor = (w: string) => targets.filter((t) => (t.weapon ?? 'primary') === w);
  /** The weapon picked from the ring, or null while the ring is showing (then nothing is targeted yet). */
  let weapon: string | null = null;
  let candId: string | null = null;
  /** The enemy the camera is currently aimed at. */
  let aimed: string | null = null;
  const fire = (t: Target | null) => {
    setGunsight(null);
    if (!t) scene.restoreView();
    void send({ type: 'attack', playerId: me, targetId: t ? t.targetId : null, ...(t && !isPrimary(t) ? { weapon: t.weapon } : {}) });
  };
  const current = () => (weapon ? targetsFor(weapon) : []);
  const shotAt = (id: string | null) => current().find((t) => t.targetId === id) ?? null;
  const best = (ts: Target[]) => ts.reduce<Target | null>((b, t) => (!b || shotValue(s, t) > shotValue(s, b) ? t : b), null);
  /** This weapon's targets, left to right as seen from behind the ship. */
  const ordered = () => [...current()].sort((a, b) =>
    relBearing(s.pose, shipById(b.targetId).pose) - relBearing(s.pose, shipById(a.targetId).pose));
  /** Pick a weapon, keeping the current enemy when it can hit that one too; otherwise aim at its best shot. */
  const pickWeapon = (w: string) => {
    weapon = w;
    if (!shotAt(candId)) candId = best(current())?.targetId ?? null;
    show();
  };
  const back = () => { weapon = null; candId = null; show(); };
  const cycle = (dir: 1 | -1) => {
    const list = ordered();
    if (list.length < 2) return;
    const i = list.findIndex((t) => t.targetId === candId);
    candId = list[(i + dir + list.length) % list.length].targetId;
    show();
  };
  /** Why a weapon cannot fire right now (shown on its greyed-out button). */
  const why = (w: string) => {
    if (w === 'primary') return turretPrimary ? `No enemy in your turret arc (facing ${s.turretArc}); Rotate it in the action step` : 'No enemy in your firing arc';
    const u = s.upgrades.find((x) => x.id === w)!, def = UPGRADES[w].weapon!;
    if (UPGRADES[w].charges !== undefined && u.charges <= 0) return `${UPGRADES[w].name}: out of charges`;
    if (def.arc === 'turret') return `${UPGRADES[w].name}: no enemy at range ${def.minRange}-${def.maxRange} in the turret arc (facing ${s.turretArc}); Rotate it in the action step`;
    if (def.requires === 'lock') return `${UPGRADES[w].name}: needs a lock on an enemy at range ${def.minRange}-${def.maxRange} in your front arc`;
    return `${UPGRADES[w].name}: no enemy at range ${def.minRange}-${def.maxRange} in your front arc`;
  };

  /** The gunsight readout for the enemy in the crosshairs. */
  const sight = (c: Target) => {
    const e = shipById(c.targetId);
    const o = attackOdds(s, e, c, state);
    const pct = (p: number) => `${Math.round(p * 100)}%`;
    const cls = o.hit >= 0.66 ? 'hi' : o.hit >= 0.4 ? 'mid' : 'lo';
    const list = ordered();
    const n = list.length, i = list.findIndex((t) => t.targetId === c.targetId);
    const isBest = n > 1 && best(list)?.targetId === c.targetId;
    const wname = weapon === 'primary' ? (turretPrimary ? 'Turret lasers' : 'Lasers') : UPGRADES[weapon!].name;
    // The same enemy through the ship's other weapons, so the best option is one click away.
    const alts = targets.filter((t) => t.targetId === c.targetId && (t.weapon ?? 'primary') !== weapon);
    const altHtml = alts.map((t) => {
      const w = t.weapon ?? 'primary';
      return `<button class="gs-alt" data-act="w:${w}">${weaponShort(w)} <b>${pct(attackOdds(s, e, t, state).hit)}</b></button>`;
    }).join('');
    const nav = (d: string, label: string, sym: string) =>
      `<button class="gs-nav" data-act="${d}" aria-label="${label}"${n < 2 ? ' disabled' : ''}>${sym}</button>`;
    return `<div class="gs-row">${nav('prev', 'Previous target', '&#8249;')}
      <div class="gs-main">
        <div class="gs-name"><span class="p2c">${e.name}</span>${isBest ? '<span class="gs-best">Best shot</span>' : ''}<span class="gs-count">${i + 1} / ${n}</span></div>
        <div class="gs-odds"><span class="gs-pct ${cls}">${pct(o.hit)}</span><span>hit chance</span></div>
        <div class="gs-stats">${o.expected.toFixed(1)} dmg${o.kill >= 0.005 ? ` · <span class="kill">${pct(o.kill)} kill</span>` : ''}${o.ion >= 0.05 ? ` · <span class="ion">${o.ion.toFixed(1)} ion</span>` : ''}</div>
        <div class="gs-meta">${wname} · range ${c.range} · ${attackDiceFor(s, c, e)} dice${c.obstructed ? ' · obstructed' : ''}${isPrimary(c) && c.bullseye ? ' · bullseye' : ''}
          · hull ${e.hull} · shields ${e.shields}</div>
      </div>${nav('next', 'Next target', '&#8250;')}</div>
      ${altHtml ? `<div class="gs-alts"><span>Also on this ship:</span>${altHtml}</div>` : ''}
      <div class="gs-actions"><button class="opt mini" data-act="back">Back <kbd>Esc</kbd></button>
        <button class="go gs-fire" data-act="fire">Fire ${isPrimary(c) ? '' : weaponShort(c.weapon!)} <kbd>Enter</kbd></button></div>`;
  };

  const show = () => {
    const ts = current();
    const c = shotAt(candId);
    scene.setRings({ [s.id]: GREEN, ...Object.fromEntries(ts.map((t) => [t.targetId, t.targetId === candId ? RED : 0x8a3030])) });
    const turretWeapon = !!weapon && (weapon === 'primary' ? turretPrimary : UPGRADES[weapon]?.weapon?.arc === 'turret');
    scene.showArcs(weapon ? [] : [s.id], weapon === null ? 'all' : turretWeapon ? 'turret' : 'primary');
    scene.setOdds(Object.fromEntries(ts.map((t) => [t.targetId, oddsHtml(s, t)])));
    scene.clearOverlay();
    if (weapon && c) {
      // Gunner's view: no ring, the gunsight carries the controls.
      scene.clearChips();
      if (aimed !== c.targetId) { aimed = c.targetId; scene.attackView(s.id, c.targetId, 450); }
      setGunsight(sight(c), {
        prev: () => cycle(-1), next: () => cycle(1), back, fire: () => fire(c),
        ...Object.fromEntries(weaponIds.map((w) => [`w:${w}`, () => pickWeapon(w)])),
      });
    } else {
      setGunsight(null);
      if (aimed) { aimed = null; scene.restoreView(); }
      const items: RadialItem[] = weaponIds.map((w) => {
        const u = s.upgrades.find((x) => x.id === w);
        const ok = targetsFor(w).length > 0;
        return {
          icon: weaponIcon(w, turretPrimary), label: weaponShort(w), badge: u && UPGRADES[w].charges !== undefined ? u.charges : undefined, disabled: !ok,
          title: ok ? `${w === 'primary' ? 'Primary weapon (lasers)' : UPGRADES[w].name}: ${targetsFor(w).length} target${targetsFor(w).length > 1 ? 's' : ''}` : why(w),
          help: w === 'primary' ? 'Your main guns. Range 1 rolls a die fewer, range 2 one more (the sweet spot), range 4 gives the defender an extra die. Then pick a ringed enemy; each shows your odds.'
            : `${UPGRADES[w].text}${ok ? ' Then pick a ringed enemy; each shows your odds.' : `<br><span class="red">${why(w)}</span>`}`,
          onClick: () => pickWeapon(w),
        };
      });
      items.push({ icon: ICONS.holdFire, label: 'Hold', title: 'Hold fire', help: 'Don\'t attack this round. Your tokens stay for defending.', cls: 'danger', onClick: () => fire(null) });
      scene.showRadial(s.pose, items, { key: 'menu', caption: 'Pick a weapon' });
    }
    const btns: BarButton[] = weapon ? [{ label: 'Back', onClick: back }] : [];
    if (c) btns.push({ label: isPrimary(c) ? 'Fire' : `Fire ${weaponName(c)}`, cls: 'primary', onClick: () => fire(c) });
    if (!weapon) btns.push({ label: 'Hold fire', cls: 'danger', onClick: () => fire(null) });
    setBar({ status: c ? targetText(c, s) : `<b>${s.name.split(' ')[0]}</b>: pick a weapon from the ring`, buttons: btns });
  };
  const pick = (p: P): string | null => {
    const ids = current().map((t) => t.targetId);
    const picked = scene.pickShip(p.clientX, p.clientY);
    if (picked && ids.includes(picked)) return picked;
    // Small models are fiddly to hit, so also accept a click near a target's base.
    const pt = scene.boardPoint(p.clientX, p.clientY);
    let best: string | null = null, bestD = Infinity;
    for (const id of ids) {
      const tp = shipById(id).pose;
      const d = screenDist(p, tp.x, tp.y);
      const near = d < fingerPx(p) || (pt !== null && Math.hypot(tp.x - pt.x, tp.y - pt.y) < 40);
      if (near && d < bestD) { bestD = d; best = id; }
    }
    return best;
  };
  mode = {
    // In the gunner's view the camera follows the selection, so clicking (not hovering) picks a target:
    // a click on another enemy swings to it, a click on the one in the sights fires.
    click(e) {
      const id = pick(e);
      if (!id) return;
      if (id === candId) fire(shotAt(id));
      else { candId = id; show(); }
    },
    key(e) {
      if (e.key === 'Escape' && weapon) back();
      if (e.key === 'Enter' && shotAt(candId)) fire(shotAt(candId));
      if (weapon && (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey))) { e.preventDefault(); cycle(1); }
      if (weapon && (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey))) { e.preventDefault(); cycle(-1); }
      // Number keys pick a weapon.
      const n = Number(e.key);
      if (n >= 1 && n <= weaponIds.length && targetsFor(weaponIds[n - 1]).length) pickWeapon(weaponIds[n - 1]);
    },
  };

  detail.innerHTML = `<h2>Attack: ${s.name}</h2><p class="hint">Pick a weapon from the ring around your ship (or press 1-${weaponIds.length}).
    The camera drops in behind your ship, aimed at the best shot: use the arrows (or ← → / Tab) to look at each enemy in range and compare
    the odds, then Fire (Enter). Esc goes back to the table. Primary weapons: range 1 (very close) loses an attack die, range 2 is the sweet spot (an extra attack die), range 3 is plain, and range 4 gives the defender an extra die;
    obstruction adds a defense die. Tokens are spent automatically, and only when they help: focus is held for defense if an enemy can still shoot you this round. Or pick a line below.</p>`;
  for (const t of targets) {
    const e = shipById(t.targetId);
    const charges = s.upgrades.find((u) => u.id === t.weapon)?.charges;
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<b>${e.name}</b> · ${weaponName(t)}${isPrimary(t) ? '' : ` (${charges} left)`}: range ${t.range}, ${t.arc} arc, ` +
      `${attackDiceFor(s, t, e)} dice${t.obstructed ? ', obstructed' : ''}${isPrimary(t) && t.bullseye ? ', bullseye' : ''}<br><span class="odds">${oddsHtml(s, t)}</span>` +
      `<br><span class="hint">hull ${e.hull} · shields ${e.shields} · agi ${SHIP_TYPES[e.typeId].agility}</span>`;
    // While aiming, hovering a line swings the sights to it.
    b.onmouseenter = () => { if (weapon) { weapon = t.weapon ?? 'primary'; candId = t.targetId; show(); } };
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
  /** The player this device is acting for, and a way to send its commands (as the UI would). */
  get me() { return me; },
  send: (cmd: Command) => send(cmd),
  /** Legal dial indices for one of the ships (for test scripts that plan moves). */
  legalDial: (id: string) => legalDial(state, shipById(id)),
  get stage() { return stage; },
  get online() { return net && { role: net.role, code: net.code, connected: !!net.link, awaitingHost, ready }; },
  /** Input state, for diagnosing taps that do nothing. */
  get input() { return { busy, stage, mode: !!mode, multi, touches: [...touches], pointerDown, selected, compact }; },
  finalPose: (shipId: string, dialIndex: number) => {
    const s = shipById(shipId);
    return maneuverFinalPose(s.pose, sizeOf(s), SHIP_TYPES[s.typeId].dial[dialIndex]);
  },
};
