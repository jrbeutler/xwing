// The online lobby: host a game (and show its code) or join one with a code. Only the screen lives here;
// main.ts does the connecting and the game.
import { normalizeCode } from './online';

/** What the lobby can ask main.ts to do. Each returns when the attempt has started or failed (it throws a readable Error). */
export interface LobbyActions {
  host(ui: LobbyUi): Promise<void>;
  join(code: string, ui: LobbyUi): Promise<void>;
  /** A hosted game saved in this browser (after a reload): resume hosting it. */
  resumeHost?: { code: string; round: number; run(ui: LobbyUi): Promise<void> };
  /** A game this browser had joined: rejoin it. */
  rejoin?: { code: string; run(ui: LobbyUi): Promise<void> };
  /** Stop hosting or joining (Cancel). */
  cancel(): void;
  /** Back to the squad builder. */
  back(): void;
}

export interface LobbyUi {
  status(html: string, error?: boolean): void;
  /** Hosting: show the code to send to the friend. */
  showCode(code: string): void;
  close(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** `joinCode`: a code from an invite link, prefilled in the Join box. */
export function openLobby(actions: LobbyActions, info: { budget: number; joinCode?: string }): LobbyUi {
  const root = document.createElement('div');
  root.id = 'lobby';
  document.body.appendChild(root);
  let busy = false;
  let code: string | null = null;

  const ui: LobbyUi = {
    status(html, error = false) {
      const el = root.querySelector<HTMLElement>('#lb-status');
      if (el) { el.innerHTML = html; el.className = `status${error ? ' err' : ''}`; }
      if (error) { busy = false; code = null; render(html, true); }
    },
    showCode(c) { code = c; render(); },
    close() { root.remove(); },
  };

  const render = (statusHtml = '', error = false) => {
    const invite = code ? `${location.origin}${location.pathname}?join=${code}` : '';
    root.innerHTML = `
      <div class="setup-inner">
        <header class="setup-head"><h1>Play online</h1><button class="opt mini" id="lb-back">← Squad</button></header>
        ${code ? `
        <section class="lobby-card">
          <h2>Your game</h2>
          <div class="code" aria-label="Game code">${code}</div>
          <p class="hint">Send this code to your friend (or the invite link). They choose <b>Online</b>, build a squad of up to ${info.budget} points, and join.</p>
          <div class="row"><button class="opt mini" id="lb-copy">Copy code</button><button class="opt mini" id="lb-link">Copy invite link</button><button class="opt mini" id="lb-cancel">Cancel</button></div>
          <div id="lb-status" class="status"><span class="spinner"></span>Waiting for your friend to join… Keep this tab open.</div>
        </section>` : `
        ${actions.resumeHost ? `<section class="lobby-card"><h2>Resume your game</h2>
          <p class="hint">You were hosting game <b>${esc(actions.resumeHost.code)}</b> (round ${actions.resumeHost.round}). Resume it, and your friend can rejoin with the same code.</p>
          <div class="row"><button class="go" id="lb-resume" ${busy ? 'disabled' : ''}>Resume ${esc(actions.resumeHost.code)}</button></div></section>` : ''}
        ${actions.rejoin ? `<section class="lobby-card"><h2>Rejoin your game</h2>
          <p class="hint">You were playing in game <b>${esc(actions.rejoin.code)}</b>.</p>
          <div class="row"><button class="go" id="lb-rejoin" ${busy ? 'disabled' : ''}>Rejoin ${esc(actions.rejoin.code)}</button></div></section>` : ''}
        <section class="lobby-card">
          <h2>Host a game</h2>
          <p class="hint">Get a code to send to your friend. Your squad and points limit (${info.budget}) are used; you fly the Coalition from the near edge.</p>
          <div class="row"><button class="go" id="lb-host" ${busy ? 'disabled' : ''}>Host a game</button></div>
        </section>
        <div class="or">or</div>
        <section class="lobby-card">
          <h2>Join a game</h2>
          <p class="hint">Enter the code your friend sent you. You fly the Syndicate from the far edge.</p>
          <div class="row"><input id="lb-code" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" value="${esc(info.joinCode ?? '')}" aria-label="Game code">
            <button class="go" id="lb-join" style="width:auto" ${busy ? 'disabled' : ''}>Join</button></div>
        </section>
        <div id="lb-status" class="status${error ? ' err' : ''}">${statusHtml}</div>`}
      </div>`;
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`);
    $('lb-back')!.onclick = () => { actions.cancel(); root.remove(); actions.back(); };
    const start = (run: () => Promise<void>, what: string) => async () => {
      if (busy) return;
      busy = true;
      render(`<span class="spinner"></span>${what}`);
      try { await run(); } catch (e) { ui.status(esc((e as Error).message), true); }
    };
    const host = $('lb-host');
    if (host) host.onclick = start(() => actions.host(ui), 'Starting…');
    const resume = $('lb-resume');
    if (resume && actions.resumeHost) resume.onclick = start(() => actions.resumeHost!.run(ui), 'Resuming… (this can take up to a minute after a reload)');
    const rejoin = $('lb-rejoin');
    if (rejoin && actions.rejoin) rejoin.onclick = start(() => actions.rejoin!.run(ui), 'Connecting…');
    const input = $<HTMLInputElement>('lb-code');
    if (input) {
      input.oninput = () => { const v = normalizeCode(input.value); if (v !== input.value) input.value = v; };
      const join = () => {
        const c = normalizeCode(input.value);
        if (c.length !== 5) { ui.status('A game code has 5 letters and digits.', true); return; }
        void start(() => actions.join(c, ui), 'Connecting…')();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') join(); };
      $('lb-join')!.onclick = join;
    }
    const copy = (text: string, label: string) => async () => {
      try { await navigator.clipboard.writeText(text); ui.status(`${label} copied. Waiting for your friend to join…`); }
      catch { ui.status(`Copy it by hand: ${esc(text)}`); }
    };
    if (code) {
      $('lb-copy')!.onclick = copy(code, 'Code');
      $('lb-link')!.onclick = copy(invite, 'Invite link');
      $('lb-cancel')!.onclick = () => { actions.cancel(); busy = false; code = null; render(); };
    }
  };
  render();
  return ui;
}
