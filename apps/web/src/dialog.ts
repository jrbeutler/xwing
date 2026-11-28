// An in-page yes/no question. The browser's confirm() is blocked inside sandboxed frames (claude.ai artifacts
// among them), where it returns false without showing anything, so every confirmation goes through this.

/** Ask a yes/no question over the page; resolves true for `yes`, false for Cancel, Esc or a click outside. */
export function ask(question: string, yes = 'OK', detail = ''): Promise<boolean> {
  document.getElementById('ask')?.remove();
  const root = document.createElement('div');
  root.id = 'ask';
  root.className = 'menu-screen ask-screen';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  const card = document.createElement('div');
  card.className = 'briefing-card ask-card';
  const h = document.createElement('h2');
  h.textContent = question;
  card.appendChild(h);
  if (detail) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = detail; card.appendChild(p); }
  const buttons = document.createElement('div');
  buttons.className = 'finale-buttons';
  const no = document.createElement('button');
  no.className = 'opt';
  no.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.className = 'go';
  ok.textContent = yes;
  buttons.append(no, ok);
  card.appendChild(buttons);
  root.appendChild(card);
  document.body.appendChild(root);
  ok.focus();
  return new Promise((resolve) => {
    const done = (v: boolean) => { removeEventListener('keydown', key, true); root.remove(); resolve(v); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    addEventListener('keydown', key, true);
    ok.onclick = () => done(true);
    no.onclick = () => done(false);
    root.onclick = (e) => { if (e.target === root) done(false); };
  });
}
