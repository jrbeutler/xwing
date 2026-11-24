// Squad builder: the screen before a battle. Pick a points budget, add pilots, fit power-ups into
// their slots, and see the AI's squad. Hands the two squads to `onDeploy`; knows nothing about the board.
import {
  DEFAULT_BUDGET, PILOTS, SHIP_TYPES, UPGRADES, buildAiSquad, freeSlots, pilotSlots, shipCost, squadCost, upgradeCost,
  upgradeOptions, validateSquad, type Squad, type SquadShip, type SlotType,
} from '@xw/engine';

import { onModelsReady, shipPreview } from './preview';

export interface BattleSetup { budget: number; player: Squad; ai: Squad }

const BUDGETS = [50, 75, 100, 150];
const SLOT_LABEL: Record<SlotType, string> = {
  talent: 'Talent', modification: 'Modification', missile: 'Missile', torpedo: 'Torpedo', turret: 'Turret', device: 'Bomb',
};
/** Slot kinds with power-ups available today; the others are shown as coming soon. */
const OPEN_SLOTS = new Set(Object.values(UPGRADES).map((u) => u.slot));

interface Saved { name: string; budget: number; squad: Squad }
const LAST_KEY = 'xw-squad-last', SAVED_KEY = 'xw-squads';
const load = <T>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const store = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/** Drop anything a saved squad refers to that no longer exists (pilots or upgrades renamed/removed). */
const clean = (q: Squad): Squad => ({
  ships: (q?.ships ?? []).filter((s) => PILOTS[s.pilotId]).map((s) => ({ pilotId: s.pilotId, upgrades: s.upgrades.filter((u) => UPGRADES[u]) })),
});

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const uniquesIn = (q: Squad) => new Set(q.ships.map((s) => s.pilotId).filter((p) => PILOTS[p].unique));

/** Hull/shields after stat upgrades, for the ship cards. */
function statLine(s: SquadShip) {
  const p = PILOTS[s.pilotId], t = SHIP_TYPES[p.shipType];
  const plus = (k: 'hull' | 'shields') => s.upgrades.reduce((a, u) => a + (UPGRADES[u].stats?.[k] ?? 0), 0);
  const atk = t.primaries.map((w) => `${w.attack}${w.arc === 'rear' ? ' rear' : ''}`).join(' + ');
  return `atk ${atk} · agi ${t.agility} · hull ${t.hull + plus('hull')} · shields ${t.shields + plus('shields')}`;
}

/** `keep`: reopen with this setup (e.g. back from deployment) instead of the last saved squad and a new opponent. */
export function openSetup(onDeploy: (s: BattleSetup) => void, keep?: BattleSetup) {
  const last = load<{ budget?: number; squad?: Squad }>(LAST_KEY, {});
  let budget = keep?.budget ?? (BUDGETS.includes(last.budget ?? 0) ? last.budget! : DEFAULT_BUDGET);
  let player: Squad = keep ? structuredClone(keep.player) : clean(last.squad ?? { ships: [] });
  let aiSeed = (Math.random() * 1e9) | 0;
  let ai = keep ? structuredClone(keep.ai) : buildAiSquad(aiSeed, budget, uniquesIn(player));
  let picking = false; // pilot picker open
  let saveName = '';
  /** The ship card showing the 3D preview. */
  let selected: { side: 'you' | 'ai'; i: number } | null = player.ships.length ? { side: 'you', i: 0 } : ai.ships.length ? { side: 'ai', i: 0 } : null;
  const isSel = (side: 'you' | 'ai', i: number) => selected?.side === side && selected.i === i;

  const root = document.createElement('div');
  root.id = 'setup';
  document.body.appendChild(root);

  /** The AI only rebuilds when it must: new budget, re-roll, or a named pilot the player now flies. */
  const refreshAi = (force = false) => {
    const clash = ai.ships.some((s) => PILOTS[s.pilotId].unique && uniquesIn(player).has(s.pilotId));
    if (force || clash) ai = buildAiSquad(aiSeed, budget, uniquesIn(player));
  };

  let render = () => {
    store(LAST_KEY, { budget, squad: player });
    const cost = squadCost(player);
    const problems = validateSquad(player, budget);
    const room = budget - cost;
    const saved = load<Saved[]>(SAVED_KEY, []);
    root.innerHTML = `
      <div class="setup-inner">
        <header class="setup-head">
          <h1>New battle</h1>
          <label>Points <select id="su-budget">${BUDGETS.map((b) => `<option ${b === budget ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
        </header>
        <div class="setup-cols">
          <section class="setup-col you">
            <div class="col-head"><h2>Your squad</h2>
              <div class="points ${cost > budget ? 'over' : ''}"><b>${cost}</b> / ${budget}<span class="meter"><i style="width:${Math.min(100, (cost / budget) * 100)}%"></i></span></div>
            </div>
            <div class="ships">${player.ships.map((s, i) => shipCard(s, i, room)).join('') || '<p class="hint">No ships yet. Add one below, or let the game pick a random squad.</p>'}</div>
            ${picking ? pilotPicker(room) : ''}
            <div class="row">
              <button class="opt mini" id="su-add">${picking ? 'Close' : '+ Add ship'}</button>
              <button class="opt mini" id="su-random">Random squad</button>
              ${player.ships.length ? '<button class="opt mini" id="su-clear">Clear</button>' : ''}
            </div>
            ${problems.length && player.ships.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
            <details class="saved"><summary class="hint">Saved squads (${saved.length})</summary>
              <div class="row"><input id="su-name" placeholder="Name this squad" value="${esc(saveName)}" maxlength="40"><button class="opt mini" id="su-save" ${player.ships.length ? '' : 'disabled'}>Save</button></div>
              ${saved.map((sv, i) => `<div class="saved-row"><span>${esc(sv.name)} <span class="hint">· ${squadCost(clean(sv.squad))} pts · ${clean(sv.squad).ships.length} ships</span></span>
                <button class="opt mini" data-load="${i}">Load</button><button class="opt mini" data-del="${i}" aria-label="Delete ${esc(sv.name)}">✕</button></div>`).join('')}
            </details>
          </section>
          <section class="setup-col them">
            <div class="col-head"><h2>Opponent (AI)</h2><div class="points"><b>${squadCost(ai)}</b> / ${budget}</div></div>
            <div class="ships">${ai.ships.map((s, i) => aiCard(s, i)).join('')}</div>
            <div class="row"><button class="opt mini" id="su-reroll">Re-roll opponent</button></div>
          </section>
        </div>
        <footer class="setup-foot">
          <span class="hint">${problems.length ? esc(problems[0]) : 'Next: place your ships in your setup area.'}</span>
          <button class="go" id="su-deploy" ${problems.length ? 'disabled' : ''}>Deploy →</button>
        </footer>
      </div>`;
    wire();
    attachPreview();
  };

  /** Move the live preview canvas into the selected card and show that ship. */
  const attachPreview = () => {
    const list = selected?.side === 'ai' ? ai.ships : player.ships;
    const ship = selected ? list[selected.i] : undefined;
    const slot = root.querySelector('.preview-slot');
    if (!ship || !slot) return;
    const pv = shipPreview();
    slot.appendChild(pv.canvas);
    pv.show(PILOTS[ship.pilotId].shipType, selected!.side === 'ai' ? 'red' : 'blue');
    pv.start();
  };

  const shipCard = (s: SquadShip, i: number, room: number) => {
    const p = PILOTS[s.pilotId], t = SHIP_TYPES[p.shipType];
    const filled = s.upgrades.map((u, ui) => `<span class="slot full" title="${esc(UPGRADES[u].text)}">
        <i>${SLOT_LABEL[UPGRADES[u].slot]}</i> ${esc(UPGRADES[u].name)} <em>${upgradeCost(u, s.pilotId)}</em>
        <button data-unfit="${i}:${ui}" aria-label="Remove ${esc(UPGRADES[u].name)}">✕</button></span>`);
    const opts = upgradeOptions(s);
    const empty = freeSlots(s).map((slot) => {
      if (!OPEN_SLOTS.has(slot)) return `<span class="slot soon" title="Power-ups for this slot are coming in a later update"><i>${SLOT_LABEL[slot]}</i> soon</span>`;
      const fit = opts.filter((u) => UPGRADES[u].slot === slot);
      return `<select class="slot pick" data-fit="${i}" aria-label="Add a ${SLOT_LABEL[slot]}">
          <option value="">+ ${SLOT_LABEL[slot]}</option>
          ${fit.map((u) => `<option value="${u}" ${upgradeCost(u, s.pilotId) > room ? 'class="dear"' : ''}>${esc(UPGRADES[u].name)} (${upgradeCost(u, s.pilotId)}) — ${esc(UPGRADES[u].text)}</option>`).join('')}
        </select>`;
    });
    return `<div class="sq-ship ${isSel('you', i) ? 'selected' : ''}" data-sel="you:${i}">
        ${isSel('you', i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}
        <div class="sq-top"><span class="who"><b>${esc(p.name)}</b> <span class="init">${p.initiative}</span>
          <span class="hint">${esc(t.name)}${p.unique ? '' : ' · generic'}</span></span>
          <span class="cost">${shipCost(s)}</span><button class="rm" data-rm="${i}" aria-label="Remove ${esc(p.name)}">✕</button></div>
        <div class="stats">${statLine(s)}</div>
        <div class="slots">${[...filled, ...empty].join('')}</div>
      </div>`;
  };

  const aiCard = (s: SquadShip, i: number) => {
    const p = PILOTS[s.pilotId];
    return `<div class="sq-ship compact ${isSel('ai', i) ? 'selected' : ''}" data-sel="ai:${i}">
      ${isSel('ai', i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}<div class="sq-top"><span class="who"><b>${esc(p.name)}</b> <span class="init">${p.initiative}</span>
      <span class="hint">${esc(SHIP_TYPES[p.shipType].name)}</span></span><span class="cost">${shipCost(s)}</span></div>
      ${s.upgrades.length ? `<div class="hint">${s.upgrades.map((u) => esc(UPGRADES[u].name)).join(' · ')}</div>` : ''}</div>`;
  };

  const pilotPicker = (room: number) => {
    const taken = uniquesIn(player);
    const groups = Object.values(SHIP_TYPES).map((t) => {
      const pilots = Object.values(PILOTS).filter((p) => p.shipType === t.id).sort((a, b) => b.initiative - a.initiative);
      return `<div class="pick-group"><img class="thumb" alt="" src="${shipPreview().thumbnail(t.id)}"><h3>${esc(t.name)} <span class="hint">${t.size} · atk ${t.primaries.map((w) => w.attack).join('+')} · agi ${t.agility} · hull ${t.hull} · shields ${t.shields} · slots: ${pilotSlots(pilots[0].id).filter((x) => x !== 'talent').map((x) => SLOT_LABEL[x]).join(', ')}</span></h3>
        ${pilots.map((p) => {
          const off = p.unique && taken.has(p.id);
          return `<button class="opt pick-pilot ${p.cost > room ? 'dear' : ''}" data-add="${p.id}" ${off ? 'disabled' : ''}>
            <b>${esc(p.name)}</b> <span class="init">${p.initiative}</span> <span class="hint">${p.unique ? 'named' : 'generic'}${pilotSlots(p.id).includes('talent') ? ' · talent slot' : ''}</span>
            <span class="cost">${p.cost}</span></button>`;
        }).join('')}</div>`;
    });
    return `<div class="picker">${groups.join('')}</div>`;
  };

  const wire = () => {
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`);
    $<HTMLSelectElement>('su-budget')!.onchange = (e) => { budget = Number((e.target as HTMLSelectElement).value); refreshAi(true); render(); };
    $('su-add')!.onclick = () => { picking = !picking; render(); };
    $('su-random')!.onclick = () => { player = buildAiSquad((Math.random() * 1e9) | 0, budget); picking = false; refreshAi(); render(); };
    const clear = $('su-clear');
    if (clear) clear.onclick = () => { player = { ships: [] }; render(); };
    $('su-reroll')!.onclick = () => { aiSeed = (Math.random() * 1e9) | 0; refreshAi(true); render(); };
    $('su-deploy')!.onclick = () => { root.remove(); onDeploy({ budget, player: structuredClone(player), ai: structuredClone(ai) }); };
    const name = $<HTMLInputElement>('su-name')!;
    name.oninput = () => { saveName = name.value; };
    $('su-save')!.onclick = () => {
      const saved = load<Saved[]>(SAVED_KEY, []);
      saved.unshift({ name: saveName.trim() || `Squad ${saved.length + 1}`, budget, squad: player });
      store(SAVED_KEY, saved.slice(0, 20));
      saveName = '';
      render();
      root.querySelector<HTMLDetailsElement>('.saved')!.open = true;
    };
    root.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) => { b.onclick = () => {
      const sv = load<Saved[]>(SAVED_KEY, [])[Number(b.dataset.load)];
      if (!sv) return;
      player = clean(sv.squad);
      if (BUDGETS.includes(sv.budget)) budget = sv.budget;
      refreshAi(true);
      render();
    }; });
    root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => { b.onclick = () => {
      const saved = load<Saved[]>(SAVED_KEY, []);
      saved.splice(Number(b.dataset.del), 1);
      store(SAVED_KEY, saved);
      render();
      root.querySelector<HTMLDetailsElement>('.saved')!.open = true;
    }; });
    root.querySelectorAll<HTMLElement>('[data-sel]').forEach((card) => { card.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return;
      const [side, i] = card.dataset.sel!.split(':');
      selected = { side: side as 'you' | 'ai', i: Number(i) };
      render();
    }; });
    root.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => { b.onclick = () => {
      player.ships.push({ pilotId: b.dataset.add!, upgrades: [] });
      selected = { side: 'you', i: player.ships.length - 1 };
      picking = false;
      refreshAi();
      render();
    }; });
    root.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => { b.onclick = () => {
      const i = Number(b.dataset.rm);
      player.ships.splice(i, 1);
      if (selected?.side === 'you') selected = player.ships.length ? { side: 'you', i: Math.min(selected.i, player.ships.length - 1) } : null;
      render();
    }; });
    root.querySelectorAll<HTMLButtonElement>('[data-unfit]').forEach((b) => { b.onclick = () => {
      const [i, ui] = b.dataset.unfit!.split(':').map(Number);
      player.ships[i].upgrades.splice(ui, 1);
      render();
    }; });
    root.querySelectorAll<HTMLSelectElement>('[data-fit]').forEach((sel) => { sel.onchange = () => {
      if (sel.value) player.ships[Number(sel.dataset.fit)].upgrades.push(sel.value);
      render();
    }; });
  };

  // The opponent can change under the selection (re-roll, budget): keep it pointing at a real ship.
  const baseRender = render;
  const guarded = () => {
    if (selected?.side === 'ai' && selected.i >= ai.ships.length) selected = ai.ships.length ? { side: 'ai', i: 0 } : null;
    if (selected?.side === 'you' && selected.i >= player.ships.length) selected = null;
    if (!selected && player.ships.length) selected = { side: 'you', i: 0 };
    baseRender();
  };
  render = guarded;
  // Picker thumbnails and the live view start with stand-in models; redraw once the real ones load.
  onModelsReady(() => { shipPreview().refresh(); if (root.isConnected) render(); });
  render();
}
