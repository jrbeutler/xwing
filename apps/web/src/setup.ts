// Squad builder: the screen before a battle. Pick a points budget, add pilots, fit power-ups into
// their slots, and see the AI's squad (or let a second player build theirs). Hands the two squads to `onDeploy`; knows nothing about the board.
import {
  DEFAULT_BUDGET, PILOTS, SHIP_TYPES, UPGRADES, buildAiSquad, effectiveInitiative, fitsSlots, freeSlots, hullOf, isOffClass,
  shipCost, signatureTalents, squadCost, talentSlotCount, upgradeCost, upgradeOptions, validateSquad,
  type ActionType, type PilotDef, type ShipClass, type Squad, type SquadShip, type SlotType,
} from '@xw/engine';

import { onModelsReady, shipPreview } from './preview';

/** Who flies the second squad: the AI, or a second person on the same device (pass and play). */
export type Versus = 'ai' | 'human';
/**
 * `hints`: whether each human player sees the AI's suggested maneuver while planning (a learning aid). `you`
 * is player 1; `them` is player 2 in a two-player game (ignored against the AI).
 */
export interface BattleSetup { budget: number; versus: Versus; player: Squad; opponent: Squad; hints: Record<Side, boolean> }

const BUDGETS = [50, 75, 100, 150];
const SLOT_LABEL: Record<SlotType, string> = {
  talent: 'Talent', modification: 'Modification', missile: 'Missile', torpedo: 'Torpedo', turret: 'Turret', device: 'Bomb',
};
const CLASS_LABEL: Record<ShipClass, string> = { fighter: 'Fighter', bomber: 'Bomber', freighter: 'Freighter' };
const CLASSES: ShipClass[] = ['fighter', 'bomber', 'freighter'];
/** Slot kinds with power-ups available today; the others are shown as coming soon. */
const OPEN_SLOTS = new Set(Object.values(UPGRADES).map((u) => u.slot));

interface Saved { name: string; budget: number; squad: Squad }
const LAST_KEY = 'xw-squad-last', LAST2_KEY = 'xw-squad-last-2', SAVED_KEY = 'xw-squads', VERSUS_KEY = 'xw-versus', HINTS_KEY = 'xw-hints';
const load = <T>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const store = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/**
 * Drop anything a saved squad refers to that no longer exists (pilots, hulls or upgrades renamed/removed),
 * and upgrades that no longer fit (e.g. a talent that is now the pilot's signature). Old saves have no hull:
 * the pilot's usual one is used.
 */
const clean = (q: Squad): Squad => ({
  ships: (q?.ships ?? []).filter((s) => PILOTS[s.pilotId]).map((s) => {
    const ship: SquadShip = { pilotId: s.pilotId, shipType: SHIP_TYPES[s.shipType ?? ''] ? s.shipType : PILOTS[s.pilotId].ship, upgrades: [] };
    return { ...ship, upgrades: keepFitting(ship, (s.upgrades ?? []).filter((u) => UPGRADES[u])) };
  }),
});

/** The upgrades from `wanted` that still fit, in order (talents after a hull change, or anything from an old save). */
function keepFitting(s: SquadShip, wanted: string[]): string[] {
  const kept: string[] = [];
  for (const u of wanted) if (fitsSlots({ ...s, upgrades: [...kept, u] })) kept.push(u);
  return kept;
}

/** Initiative badge: the pilot's own, or struck through and lowered when flying outside their class. */
const initBadge = (s: SquadShip) => {
  const p = PILOTS[s.pilotId], eff = effectiveInitiative(s);
  return eff === p.initiative ? `<span class="init">${eff}</span>`
    : `<span class="init off" title="Flying outside their specialty: -1 initiative"><s>${p.initiative}</s> ${eff}</span>`;
};
const talentSummary = (p: PilotDef) => {
  const n = talentSlotCount(p.initiative);
  const sig = (p.talents ?? []).map((t) => UPGRADES[t].name).join(', ');
  return [sig, n ? `${n} talent slot${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const uniquesIn = (q: Squad) => new Set(q.ships.map((s) => s.pilotId).filter((p) => PILOTS[p].unique));

/** Hull/shields after stat upgrades, for the ship cards. */
function statLine(s: SquadShip) {
  const t = SHIP_TYPES[hullOf(s)];
  const plus = (k: 'hull' | 'shields') => s.upgrades.reduce((a, u) => a + (UPGRADES[u].stats?.[k] ?? 0), 0);
  const atk = t.primaries.map((w) => `${w.attack}${w.arc === 'rear' ? ' rear' : ''}`).join(' + ');
  return `atk ${atk} · agi ${t.agility} · hull ${t.hull + plus('hull')} · shields ${t.shields + plus('shields')}`;
}

const ACTION_NAMES: Record<ActionType, string> = {
  focus: 'Focus', evade: 'Evade', lock: 'Lock', barrelRoll: 'Barrel Roll', boost: 'Boost', repair: 'Repair',
  rotateArc: 'Rotate', jam: 'Jam', calculate: 'Calculate', reinforce: 'Reinforce', reload: 'Reload', coordinate: 'Coordinate',
};
/** The hull's action bar: red actions in red, linked actions as "Focus → Rotate". */
function actionLine(s: SquadShip) {
  const name = (a: { type: ActionType; red?: boolean }) => (a.red ? `<span class="red-act">${ACTION_NAMES[a.type]}</span>` : ACTION_NAMES[a.type]);
  return SHIP_TYPES[hullOf(s)].actions.map((a) => (a.linked ? `${name(a)} → ${name(a.linked)}` : name(a))).join(' · ');
}

type Side = 'you' | 'them';

/** `keep`: reopen with this setup (e.g. back from deployment) instead of the last saved squad and a new opponent. */
export function openSetup(onDeploy: (s: BattleSetup) => void, keep?: BattleSetup) {
  const last = load<{ budget?: number; squad?: Squad }>(LAST_KEY, {});
  let budget = keep?.budget ?? (BUDGETS.includes(last.budget ?? 0) ? last.budget! : DEFAULT_BUDGET);
  let versus: Versus = keep?.versus ?? (load<string>(VERSUS_KEY, 'ai') === 'human' ? 'human' : 'ai');
  const hints: Record<Side, boolean> = keep?.hints ? { ...keep.hints } : { you: false, them: false, ...load<Partial<Record<Side, boolean>>>(HINTS_KEY, {}) };
  let player: Squad = keep ? structuredClone(keep.player) : clean(last.squad ?? { ships: [] });
  let aiSeed = (Math.random() * 1e9) | 0;
  /** Player 2's own squad, kept apart from the AI's so switching modes loses neither. */
  let second: Squad = keep?.versus === 'human' ? structuredClone(keep.opponent) : clean(load<{ squad?: Squad }>(LAST2_KEY, {}).squad ?? { ships: [] });
  let ai = keep?.versus === 'ai' ? structuredClone(keep.opponent) : buildAiSquad(aiSeed, budget, uniquesIn(player));
  const two = () => versus === 'human';
  const squad = (side: Side) => (side === 'you' ? player : two() ? second : ai);
  const setSquad = (side: Side, q: Squad) => { if (side === 'you') player = q; else second = q; };
  let picking: Side | null = null; // pilot picker open, for this squad
  const saveName: Record<Side, string> = { you: '', them: '' };
  /** The ship card showing the 3D preview. */
  let selected: { side: Side; i: number } | null = player.ships.length ? { side: 'you', i: 0 } : ai.ships.length ? { side: 'them', i: 0 } : null;
  const isSel = (side: Side, i: number) => selected?.side === side && selected.i === i;

  const root = document.createElement('div');
  root.id = 'setup';
  document.body.appendChild(root);

  /** The AI only rebuilds when it must: new budget, re-roll, or a named pilot the player now flies. */
  const refreshAi = (force = false) => {
    const clash = ai.ships.some((s) => PILOTS[s.pilotId].unique && uniquesIn(player).has(s.pilotId));
    if (force || clash) ai = buildAiSquad(aiSeed, budget, uniquesIn(player));
  };

  /** A squad the players edit: ship cards, pilot picker, random/clear, problems and saved squads. */
  const editableCol = (side: Side, title: string, saved: Saved[]) => {
    const q = squad(side);
    const cost = squadCost(q);
    const problems = validateSquad(q, budget);
    const room = budget - cost;
    const k = side;
    return `<section class="setup-col ${side} edit">
        <div class="col-head"><h2>${title}</h2>
          <label class="hint-toggle" title="While planning, highlight the maneuver the AI would fly for each of your ships, and say why"><input type="checkbox" data-hints="${side}" ${hints[side] ? 'checked' : ''}> 💡 Suggest moves</label>
          <div class="points ${cost > budget ? 'over' : ''}"><b>${cost}</b> / ${budget}<span class="meter"><i style="width:${Math.min(100, (cost / budget) * 100)}%"></i></span></div>
        </div>
        <div class="ships">${q.ships.map((s, i) => shipCard(side, s, i, room)).join('') || '<p class="hint">No ships yet. Add one below, or let the game pick a random squad.</p>'}</div>
        ${picking === side ? pilotPicker(side, room) : ''}
        <div class="row">
          <button class="opt mini" data-add-toggle="${k}">${picking === side ? 'Close' : '+ Add ship'}</button>
          <button class="opt mini" data-random="${k}">Random squad</button>
          ${q.ships.length ? `<button class="opt mini" data-clear="${k}">Clear</button>` : ''}
        </div>
        ${problems.length && q.ships.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        <details class="saved" data-saved="${k}"><summary class="hint">Saved squads (${saved.length})</summary>
          <div class="row"><input data-name="${k}" placeholder="Name this squad" value="${esc(saveName[side])}" maxlength="40"><button class="opt mini" data-save="${k}" ${q.ships.length ? '' : 'disabled'}>Save</button></div>
          ${saved.map((sv, i) => `<div class="saved-row"><span>${esc(sv.name)} <span class="hint">· ${squadCost(clean(sv.squad))} pts · ${clean(sv.squad).ships.length} ships</span></span>
            <button class="opt mini" data-load="${k}:${i}">Load</button><button class="opt mini" data-del="${k}:${i}" aria-label="Delete ${esc(sv.name)}">✕</button></div>`).join('')}
        </details>
      </section>`;
  };

  let render = () => {
    store(LAST_KEY, { budget, squad: player });
    store(LAST2_KEY, { squad: second });
    store(VERSUS_KEY, versus);
    store(HINTS_KEY, hints);
    const problems = [
      ...validateSquad(player, budget).map((p) => (two() ? `Player 1: ${p}` : p)),
      ...(two() ? validateSquad(second, budget).map((p) => `Player 2: ${p}`) : []),
    ];
    const saved = load<Saved[]>(SAVED_KEY, []);
    root.innerHTML = `
      <div class="setup-inner">
        <header class="setup-head">
          <h1>New battle</h1>
          <div class="head-opts">
            <div class="seg" role="radiogroup" aria-label="Opponent">
              <button role="radio" aria-checked="${!two()}" class="${two() ? '' : 'on'}" data-versus="ai">vs AI</button>
              <button role="radio" aria-checked="${two()}" class="${two() ? 'on' : ''}" data-versus="human">2 players</button>
            </div>
            <label>Points <select id="su-budget">${BUDGETS.map((b) => `<option ${b === budget ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
          </div>
        </header>
        ${two() ? '<p class="hint versus-note">Two players, one device: take turns at the controls. Before each player plans their moves, a screen asks the other to look away.</p>' : ''}
        <div class="setup-cols ${two() ? 'two' : ''}">
          ${editableCol('you', two() ? '<span class="p1c">Player 1</span> · Coalition' : 'Your squad', saved)}
          ${two() ? editableCol('them', '<span class="p2c">Player 2</span> · Syndicate', saved) : `
          <section class="setup-col them">
            <div class="col-head"><h2>Opponent (AI)</h2><div class="points"><b>${squadCost(ai)}</b> / ${budget}</div></div>
            <div class="ships">${ai.ships.map((s, i) => aiCard(s, i)).join('')}</div>
            <div class="row"><button class="opt mini" id="su-reroll">Re-roll opponent</button></div>
          </section>`}
        </div>
        <footer class="setup-foot">
          <span class="hint">${problems.length ? esc(problems[0]) : two() ? 'Next: each player places their ships.' : 'Next: place your ships in your setup area.'}</span>
          <button class="go" id="su-deploy" ${problems.length ? 'disabled' : ''}>Deploy →</button>
        </footer>
      </div>`;
    wire();
    attachPreview();
  };

  /** Move the live preview canvas into the selected card and show that ship. */
  const attachPreview = () => {
    const ship = selected ? squad(selected.side).ships[selected.i] : undefined;
    const slot = root.querySelector('.preview-slot');
    if (!ship || !slot) return;
    const pv = shipPreview();
    slot.appendChild(pv.canvas);
    pv.show(hullOf(ship), selected!.side === 'them' ? 'red' : 'blue');
    pv.start();
  };

  /** Hull choice: the pilot's specialty first, then other classes (flown at -1 initiative). */
  const hullPicker = (side: Side, s: SquadShip, i: number) => {
    const p = PILOTS[s.pilotId];
    const opt = (id: string) => `<option value="${id}" ${id === hullOf(s) ? 'selected' : ''}>${esc(SHIP_TYPES[id].name)} (${SHIP_TYPES[id].cost})</option>`;
    const hulls = Object.values(SHIP_TYPES);
    const own = hulls.filter((t) => t.class === p.specialty).map((t) => opt(t.id)).join('');
    const other = hulls.filter((t) => t.class !== p.specialty).map((t) => opt(t.id)).join('');
    return `<select class="hull-pick" data-hull="${side}:${i}" aria-label="Ship for ${esc(p.name)}">
      <optgroup label="${CLASS_LABEL[p.specialty]} (specialty)">${own}</optgroup>
      <optgroup label="Other classes: -1 initiative">${other}</optgroup></select>`;
  };

  const shipCard = (side: Side, s: SquadShip, i: number, room: number) => {
    const p = PILOTS[s.pilotId];
    const sig = signatureTalents(s).map((u) => `<span class="slot full sig" title="Signature talent: comes with ${esc(p.name)}. ${esc(UPGRADES[u].text)}">
        <i>Talent</i> ${esc(UPGRADES[u].name)} <em>★</em></span>`);
    const lost = (p.talents ?? []).filter((u) => !signatureTalents(s).includes(u))
      .map((u) => `<span class="slot soon" title="No talent slot for it at this initiative"><i>Talent</i> <s>${esc(UPGRADES[u].name)}</s></span>`);
    const filled = s.upgrades.map((u, ui) => [UPGRADES[u].slot, `<span class="slot full" title="${esc(UPGRADES[u].text)}">
        <i>${SLOT_LABEL[UPGRADES[u].slot]}</i> ${esc(UPGRADES[u].name)} <em>${upgradeCost(u, s)}</em>
        <button data-unfit="${side}:${i}:${ui}" aria-label="Remove ${esc(UPGRADES[u].name)}">✕</button></span>`] as const);
    const opts = upgradeOptions(s);
    const empty = freeSlots(s).map((slot) => [slot, emptySlot(slot)] as const);
    const of = (xs: readonly (readonly [SlotType, string])[], talent: boolean) => xs.filter(([k]) => (k === 'talent') === talent).map(([, h]) => h);
    const pilotRow = [...sig, ...lost, ...of(filled, true), ...of(empty, true)];
    const shipRow = [...of(filled, false), ...of(empty, false)];
    function emptySlot(slot: SlotType) {
      if (!OPEN_SLOTS.has(slot)) return `<span class="slot soon" title="Power-ups for this slot are coming in a later update"><i>${SLOT_LABEL[slot]}</i> soon</span>`;
      const fit = opts.filter((u) => UPGRADES[u].slot === slot);
      return `<select class="slot pick" data-fit="${side}:${i}" aria-label="Add a ${SLOT_LABEL[slot]}">
          <option value="">+ ${slot === 'talent' ? `${CLASS_LABEL[p.specialty]} talent` : SLOT_LABEL[slot]}</option>
          ${fit.map((u) => `<option value="${u}" ${upgradeCost(u, s) > room ? 'class="dear"' : ''}>${esc(UPGRADES[u].name)} (${upgradeCost(u, s)}) — ${esc(UPGRADES[u].text)}</option>`).join('')}
        </select>`;
    }
    return `<div class="sq-ship ${isSel(side, i) ? 'selected' : ''}" data-sel="${side}:${i}">
        ${isSel(side, i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}
        <div class="sq-top"><span class="who"><b>${esc(p.name)}</b> ${initBadge(s)}
          <span class="hint">${CLASS_LABEL[p.specialty]} pilot${p.unique ? '' : ' · generic'}</span></span>
          <span class="cost">${shipCost(s)}</span><button class="rm" data-rm="${side}:${i}" aria-label="Remove ${esc(p.name)}">✕</button></div>
        <div class="hull-row">${hullPicker(side, s, i)}${isOffClass(s) ? '<span class="hint off-class">outside specialty: -1 initiative</span>' : ''}</div>
        <div class="stats">${statLine(s)}</div>
        <div class="stats acts">${actionLine(s)}</div>
        ${p.ability ? `<div class="ability"><b>${esc(p.ability.name)}</b> ${esc(p.ability.text)}</div>` : ''}
        <div class="slots"><span class="slot-group">Pilot</span>${pilotRow.join('') || '<span class="hint">no talent slots below initiative 3</span>'}</div>
        <div class="slots"><span class="slot-group">Ship</span>${shipRow.join('')}</div>
      </div>`;
  };

  const aiCard = (s: SquadShip, i: number) => {
    const p = PILOTS[s.pilotId];
    const ups = [
      ...(p.ability ? [`<span class="ab" title="${esc(p.ability.text)}">${esc(p.ability.name)}</span>`] : []),
      ...signatureTalents(s).map((u) => `${esc(UPGRADES[u].name)} ★`), ...s.upgrades.map((u) => esc(UPGRADES[u].name)),
    ];
    return `<div class="sq-ship compact ${isSel('them', i) ? 'selected' : ''}" data-sel="them:${i}">
      ${isSel('them', i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}<div class="sq-top"><span class="who"><b>${esc(p.name)}</b> ${initBadge(s)}
      <span class="hint">${esc(SHIP_TYPES[hullOf(s)].name)}</span></span><span class="cost">${shipCost(s)}</span></div>
      ${ups.length ? `<div class="hint">${ups.join(' · ')}</div>` : ''}</div>`;
  };

  /** Pilots by specialty. Each joins in their usual hull; the hull can be changed on the ship card. */
  const pilotPicker = (side: Side, room: number) => {
    const taken = uniquesIn(squad(side));
    const groups = CLASSES.map((c) => {
      const hulls = Object.values(SHIP_TYPES).filter((t) => t.class === c);
      const pilots = Object.values(PILOTS).filter((p) => p.specialty === c).sort((a, b) => b.initiative - a.initiative || a.name.localeCompare(b.name));
      if (!pilots.length) return '';
      return `<div class="pick-group"><div class="thumbs">${hulls.map((t) => `<img class="thumb" alt="" title="${esc(t.name)}" src="${shipPreview().thumbnail(t.id)}">`).join('')}</div>
        <h3>${CLASS_LABEL[c]} pilots <span class="hint">fly ${hulls.map((t) => `${esc(t.name)} (${t.cost})`).join(', ')}</span></h3>
        ${pilots.map((p) => {
          const off = p.unique && taken.has(p.id);
          const cost = shipCost({ pilotId: p.id, upgrades: [] });
          const extra = [p.ability?.name ?? '', talentSummary(p)].filter(Boolean).join(' · ');
          return `<button class="opt pick-pilot ${cost > room ? 'dear' : ''}" data-add="${side}:${p.id}" ${off ? 'disabled' : ''}${p.ability ? ` title="${esc(p.ability.name)}: ${esc(p.ability.text)}"` : ''}>
            <b>${esc(p.name)}</b> <span class="init">${p.initiative}</span> <span class="hint">${p.unique ? 'named' : 'generic'} · ${esc(SHIP_TYPES[p.ship].name)}${extra ? ` · ${esc(extra)}` : ''}</span>
            <span class="cost">${cost}</span></button>`;
        }).join('')}</div>`;
    });
    return `<div class="picker"><p class="hint">Pilots fly any ship of their class; another class costs them 1 initiative (and maybe a talent slot). Talents belong to the pilot: 1 slot at initiative 3-4, 2 at 5+. ★ marks a signature talent, which comes with the pilot and fills a slot. Named pilots also have an ability of their own (hover to read it).</p>${groups.join('')}</div>`;
  };

  /** Split a `side:rest` data attribute. */
  const sideOf = (v: string): [Side, string] => { const at = v.indexOf(':'); return [v.slice(0, at) as Side, v.slice(at + 1)]; };
  const each = <T extends HTMLElement>(sel: string, f: (el: T) => void) => root.querySelectorAll<T>(sel).forEach(f);

  const wire = () => {
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`);
    $<HTMLSelectElement>('su-budget')!.onchange = (e) => { budget = Number((e.target as HTMLSelectElement).value); refreshAi(true); render(); };
    each<HTMLButtonElement>('[data-versus]', (b) => { b.onclick = () => {
      versus = b.dataset.versus as Versus;
      picking = null;
      if (selected?.side === 'them') selected = null;
      render();
    }; });
    each<HTMLButtonElement>('[data-add-toggle]', (b) => { b.onclick = () => {
      const side = b.dataset.addToggle as Side;
      picking = picking === side ? null : side;
      render();
    }; });
    each<HTMLButtonElement>('[data-random]', (b) => { b.onclick = () => {
      const side = b.dataset.random as Side;
      setSquad(side, buildAiSquad((Math.random() * 1e9) | 0, budget));
      picking = null;
      refreshAi();
      render();
    }; });
    each<HTMLInputElement>('[data-hints]', (box) => { box.onchange = () => { hints[box.dataset.hints as Side] = box.checked; render(); }; });
    each<HTMLButtonElement>('[data-clear]', (b) => { b.onclick = () => { setSquad(b.dataset.clear as Side, { ships: [] }); render(); }; });
    const reroll = $('su-reroll');
    if (reroll) reroll.onclick = () => { aiSeed = (Math.random() * 1e9) | 0; refreshAi(true); render(); };
    $('su-deploy')!.onclick = () => {
      root.remove();
      onDeploy({ budget, versus, player: structuredClone(player), opponent: structuredClone(two() ? second : ai), hints: { you: hints.you, them: two() && hints.them } });
    };
    each<HTMLInputElement>('[data-name]', (input) => { input.oninput = () => { saveName[input.dataset.name as Side] = input.value; }; });
    const reopenSaved = (side: Side) => { const d = root.querySelector<HTMLDetailsElement>(`[data-saved="${side}"]`); if (d) d.open = true; };
    each<HTMLButtonElement>('[data-save]', (b) => { b.onclick = () => {
      const side = b.dataset.save as Side;
      const saved = load<Saved[]>(SAVED_KEY, []);
      saved.unshift({ name: saveName[side].trim() || `Squad ${saved.length + 1}`, budget, squad: squad(side) });
      store(SAVED_KEY, saved.slice(0, 20));
      saveName[side] = '';
      render();
      reopenSaved(side);
    }; });
    each<HTMLButtonElement>('[data-load]', (b) => { b.onclick = () => {
      const [side, i] = sideOf(b.dataset.load!);
      const sv = load<Saved[]>(SAVED_KEY, [])[Number(i)];
      if (!sv) return;
      setSquad(side, clean(sv.squad));
      if (BUDGETS.includes(sv.budget)) budget = sv.budget;
      refreshAi(true);
      render();
    }; });
    each<HTMLButtonElement>('[data-del]', (b) => { b.onclick = () => {
      const [side, i] = sideOf(b.dataset.del!);
      const saved = load<Saved[]>(SAVED_KEY, []);
      saved.splice(Number(i), 1);
      store(SAVED_KEY, saved);
      render();
      reopenSaved(side);
    }; });
    each<HTMLElement>('[data-sel]', (card) => { card.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return;
      const [side, i] = sideOf(card.dataset.sel!);
      selected = { side, i: Number(i) };
      render();
    }; });
    each<HTMLButtonElement>('[data-add]', (b) => { b.onclick = () => {
      const [side, id] = sideOf(b.dataset.add!);
      const q = squad(side);
      q.ships.push({ pilotId: id, shipType: PILOTS[id].ship, upgrades: [] });
      selected = { side, i: q.ships.length - 1 };
      picking = null;
      refreshAi();
      render();
    }; });
    each<HTMLButtonElement>('[data-rm]', (b) => { b.onclick = () => {
      const [side, i] = sideOf(b.dataset.rm!);
      const q = squad(side);
      q.ships.splice(Number(i), 1);
      if (selected?.side === side) selected = q.ships.length ? { side, i: Math.min(selected.i, q.ships.length - 1) } : null;
      render();
    }; });
    each<HTMLButtonElement>('[data-unfit]', (b) => { b.onclick = () => {
      const [side, rest] = sideOf(b.dataset.unfit!);
      const [i, ui] = rest.split(':').map(Number);
      squad(side).ships[i].upgrades.splice(ui, 1);
      render();
    }; });
    each<HTMLSelectElement>('[data-hull]', (sel) => { sel.onchange = () => {
      const [side, i] = sideOf(sel.dataset.hull!);
      const s = squad(side).ships[Number(i)];
      s.shipType = sel.value;
      // A new ship starts bare: the pilot keeps their talents (if they still have the slots), ship upgrades are cleared.
      s.upgrades = keepFitting({ ...s, upgrades: [] }, s.upgrades.filter((u) => UPGRADES[u].slot === 'talent'));
      render();
    }; });
    each<HTMLSelectElement>('[data-fit]', (sel) => { sel.onchange = () => {
      const [side, i] = sideOf(sel.dataset.fit!);
      if (sel.value) squad(side).ships[Number(i)].upgrades.push(sel.value);
      render();
    }; });
  };

  // The opponent can change under the selection (re-roll, budget, mode): keep it pointing at a real ship.
  const baseRender = render;
  const guarded = () => {
    if (selected && selected.i >= squad(selected.side).ships.length) selected = null;
    if (!selected && player.ships.length) selected = { side: 'you', i: 0 };
    if (!selected && squad('them').ships.length) selected = { side: 'them', i: 0 };
    baseRender();
  };
  render = guarded;
  // Picker thumbnails and the live view start with stand-in models; redraw once the real ones load.
  onModelsReady(() => { shipPreview().refresh(); if (root.isConnected) render(); });
  render();
}
