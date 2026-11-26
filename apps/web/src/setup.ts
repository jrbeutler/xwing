// Squad builder: the screen before a battle. Pick a points budget, add pilots, fit power-ups into
// their slots, and see the AI's squad. Hands the two squads to `onDeploy`; knows nothing about the board.
import {
  DEFAULT_BUDGET, PILOTS, SHIP_TYPES, UPGRADES, buildAiSquad, effectiveInitiative, fitsSlots, freeSlots, hullOf, isOffClass,
  shipCost, signatureTalents, squadCost, talentSlotCount, upgradeCost, upgradeOptions, validateSquad,
  type PilotDef, type ShipClass, type Squad, type SquadShip, type SlotType,
} from '@xw/engine';

import { onModelsReady, shipPreview } from './preview';

export interface BattleSetup { budget: number; player: Squad; ai: Squad }

const BUDGETS = [50, 75, 100, 150];
const SLOT_LABEL: Record<SlotType, string> = {
  talent: 'Talent', modification: 'Modification', missile: 'Missile', torpedo: 'Torpedo', turret: 'Turret', device: 'Bomb',
};
const CLASS_LABEL: Record<ShipClass, string> = { fighter: 'Fighter', bomber: 'Bomber', freighter: 'Freighter' };
const CLASSES: ShipClass[] = ['fighter', 'bomber', 'freighter'];
/** Slot kinds with power-ups available today; the others are shown as coming soon. */
const OPEN_SLOTS = new Set(Object.values(UPGRADES).map((u) => u.slot));

interface Saved { name: string; budget: number; squad: Squad }
const LAST_KEY = 'xw-squad-last', SAVED_KEY = 'xw-squads';
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

/** The upgrades from `wanted` that still fit, in order (after a hull change, or from an old save). */
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
    pv.show(hullOf(ship), selected!.side === 'ai' ? 'red' : 'blue');
    pv.start();
  };

  /** Hull choice: the pilot's specialty first, then other classes (flown at -1 initiative). */
  const hullPicker = (s: SquadShip, i: number) => {
    const p = PILOTS[s.pilotId];
    const opt = (id: string) => `<option value="${id}" ${id === hullOf(s) ? 'selected' : ''}>${esc(SHIP_TYPES[id].name)} (${SHIP_TYPES[id].cost})</option>`;
    const hulls = Object.values(SHIP_TYPES);
    const own = hulls.filter((t) => t.class === p.specialty).map((t) => opt(t.id)).join('');
    const other = hulls.filter((t) => t.class !== p.specialty).map((t) => opt(t.id)).join('');
    return `<select class="hull-pick" data-hull="${i}" aria-label="Ship for ${esc(p.name)}">
      <optgroup label="${CLASS_LABEL[p.specialty]} (specialty)">${own}</optgroup>
      <optgroup label="Other classes: -1 initiative">${other}</optgroup></select>`;
  };

  const shipCard = (s: SquadShip, i: number, room: number) => {
    const p = PILOTS[s.pilotId];
    const sig = signatureTalents(s).map((u) => `<span class="slot full sig" title="Signature talent: comes with ${esc(p.name)}. ${esc(UPGRADES[u].text)}">
        <i>Talent</i> ${esc(UPGRADES[u].name)} <em>★</em></span>`);
    const lost = (p.talents ?? []).filter((u) => !signatureTalents(s).includes(u))
      .map((u) => `<span class="slot soon" title="No talent slot for it at this initiative"><i>Talent</i> <s>${esc(UPGRADES[u].name)}</s></span>`);
    const filled = s.upgrades.map((u, ui) => `<span class="slot full" title="${esc(UPGRADES[u].text)}">
        <i>${SLOT_LABEL[UPGRADES[u].slot]}</i> ${esc(UPGRADES[u].name)} <em>${upgradeCost(u, s)}</em>
        <button data-unfit="${i}:${ui}" aria-label="Remove ${esc(UPGRADES[u].name)}">✕</button></span>`);
    const opts = upgradeOptions(s);
    const empty = freeSlots(s).map((slot) => {
      if (!OPEN_SLOTS.has(slot)) return `<span class="slot soon" title="Power-ups for this slot are coming in a later update"><i>${SLOT_LABEL[slot]}</i> soon</span>`;
      const fit = opts.filter((u) => UPGRADES[u].slot === slot);
      return `<select class="slot pick" data-fit="${i}" aria-label="Add a ${SLOT_LABEL[slot]}">
          <option value="">+ ${slot === 'talent' ? `${CLASS_LABEL[p.specialty]} talent` : SLOT_LABEL[slot]}</option>
          ${fit.map((u) => `<option value="${u}" ${upgradeCost(u, s) > room ? 'class="dear"' : ''}>${esc(UPGRADES[u].name)} (${upgradeCost(u, s)}) — ${esc(UPGRADES[u].text)}</option>`).join('')}
        </select>`;
    });
    return `<div class="sq-ship ${isSel('you', i) ? 'selected' : ''}" data-sel="you:${i}">
        ${isSel('you', i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}
        <div class="sq-top"><span class="who"><b>${esc(p.name)}</b> ${initBadge(s)}
          <span class="hint">${CLASS_LABEL[p.specialty]} pilot${p.unique ? '' : ' · generic'}</span></span>
          <span class="cost">${shipCost(s)}</span><button class="rm" data-rm="${i}" aria-label="Remove ${esc(p.name)}">✕</button></div>
        <div class="hull-row">${hullPicker(s, i)}${isOffClass(s) ? '<span class="hint off-class">outside specialty: -1 initiative</span>' : ''}</div>
        <div class="stats">${statLine(s)}</div>
        <div class="slots">${[...sig, ...lost, ...filled, ...empty].join('')}</div>
      </div>`;
  };

  const aiCard = (s: SquadShip, i: number) => {
    const p = PILOTS[s.pilotId];
    const ups = [...signatureTalents(s).map((u) => `${esc(UPGRADES[u].name)} ★`), ...s.upgrades.map((u) => esc(UPGRADES[u].name))];
    return `<div class="sq-ship compact ${isSel('ai', i) ? 'selected' : ''}" data-sel="ai:${i}">
      ${isSel('ai', i) ? '<div class="preview-slot" aria-hidden="true"></div>' : ''}<div class="sq-top"><span class="who"><b>${esc(p.name)}</b> ${initBadge(s)}
      <span class="hint">${esc(SHIP_TYPES[hullOf(s)].name)}</span></span><span class="cost">${shipCost(s)}</span></div>
      ${ups.length ? `<div class="hint">${ups.join(' · ')}</div>` : ''}</div>`;
  };

  /** Pilots by specialty. Each joins in their usual hull; the hull can be changed on the ship card. */
  const pilotPicker = (room: number) => {
    const taken = uniquesIn(player);
    const groups = CLASSES.map((c) => {
      const hulls = Object.values(SHIP_TYPES).filter((t) => t.class === c);
      const pilots = Object.values(PILOTS).filter((p) => p.specialty === c).sort((a, b) => b.initiative - a.initiative || a.name.localeCompare(b.name));
      if (!pilots.length) return '';
      return `<div class="pick-group"><div class="thumbs">${hulls.map((t) => `<img class="thumb" alt="" title="${esc(t.name)}" src="${shipPreview().thumbnail(t.id)}">`).join('')}</div>
        <h3>${CLASS_LABEL[c]} pilots <span class="hint">fly ${hulls.map((t) => `${esc(t.name)} (${t.cost})`).join(', ')}</span></h3>
        ${pilots.map((p) => {
          const off = p.unique && taken.has(p.id);
          const cost = shipCost({ pilotId: p.id, upgrades: [] });
          const extra = talentSummary(p);
          return `<button class="opt pick-pilot ${cost > room ? 'dear' : ''}" data-add="${p.id}" ${off ? 'disabled' : ''}>
            <b>${esc(p.name)}</b> <span class="init">${p.initiative}</span> <span class="hint">${p.unique ? 'named' : 'generic'} · ${esc(SHIP_TYPES[p.ship].name)}${extra ? ` · ${esc(extra)}` : ''}</span>
            <span class="cost">${cost}</span></button>`;
        }).join('')}</div>`;
    });
    return `<div class="picker"><p class="hint">Pilots fly any ship of their class; another class costs them 1 initiative (and maybe a talent slot). Talents belong to the pilot: 1 slot at initiative 3-4, 2 at 5+. ★ marks a signature talent, which comes with the pilot and fills a slot.</p>${groups.join('')}</div>`;
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
      player.ships.push({ pilotId: b.dataset.add!, shipType: PILOTS[b.dataset.add!].ship, upgrades: [] });
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
    root.querySelectorAll<HTMLSelectElement>('[data-hull]').forEach((sel) => { sel.onchange = () => {
      const s = player.ships[Number(sel.dataset.hull)];
      s.shipType = sel.value;
      s.upgrades = keepFitting({ ...s, upgrades: [] }, s.upgrades); // a smaller hull drops what no longer fits
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
