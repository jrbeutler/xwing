// Pass-and-play hand-over: a full-screen cover between two players sharing one device, so the
// player who is not at the controls never sees the other's secret maneuvers being planned.

const cover = document.createElement('div');
cover.id = 'handoff';
cover.hidden = true;
cover.setAttribute('role', 'dialog');
cover.setAttribute('aria-modal', 'true');
cover.setAttribute('aria-labelledby', 'handoff-title');
document.body.appendChild(cover);

export interface Handoff {
  /** Player id ('p1' / 'p2'), used for the player's colour. */
  cls: string;
  title: string;
  text: string;
  button: string;
  onReady: () => void;
}

/** Cover the board until the named player says they are ready. */
export function handoff(h: Handoff) {
  cover.className = h.cls;
  cover.innerHTML = `<div class="handoff-card">
      <div class="handoff-kicker">Pass the device to</div>
      <h1 id="handoff-title">${h.title}</h1>
      <p>${h.text}</p>
      <button class="go" id="handoff-go">${h.button}</button>
    </div>`;
  cover.hidden = false;
  const go = cover.querySelector<HTMLButtonElement>('#handoff-go')!;
  go.onclick = () => { hideHandoff(); h.onReady(); };
  go.focus();
}

export function hideHandoff() {
  cover.hidden = true;
  cover.innerHTML = '';
}
