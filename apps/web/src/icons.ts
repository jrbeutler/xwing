// Small line icons (24×24, stroke = currentColor) for the radial menus.
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  /** Primary weapon: twin laser bolts. */
  lasers: svg('<path d="M5 19 15 9M9 21l10-10"/><path d="M15 9l2-5 1 4 4 1-5 2M19 11"/>'),
  /** Missile: a small rocket. */
  missile: svg('<path d="M14 4c3 0 6 3 6 6l-8 8-6-6 8-8z"/><path d="M8 14l-3 1-2 4 4-2 1-3M10 16l-1 3 3-1"/><circle cx="15" cy="9" r="1.5"/>'),
  /** Torpedo: a round warhead with a wake. */
  torpedo: svg('<circle cx="15" cy="9" r="4.5"/><path d="M12 12 4 20M9 10 3 16M14 15l-6 6"/>'),
  /** Turret: a dome with a barrel. */
  turret: svg('<path d="M4 18h16M6 18a6 6 0 0 1 12 0"/><path d="M12 12 19 5"/>'),
  holdFire: svg('<circle cx="12" cy="12" r="8"/><path d="M7 17 17 7"/>'),
  focus: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  evade: svg('<path d="M4 7h9a4 4 0 0 1 0 8H8"/><path d="M11 12l-3 3 3 3"/><path d="M4 4v6"/>'),
  lock: svg('<circle cx="12" cy="12" r="6"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  barrelRoll: svg('<path d="M3 12h13"/><path d="M13 8l4 4-4 4"/><path d="M20 6v12"/><path d="M6 8a3 3 0 0 1 0 8"/>'),
  boost: svg('<path d="M6 13l6-6 6 6M6 19l6-6 6 6"/>'),
  repair: svg('<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-1-1-3 2.5-2.5z"/>'),
  skip: svg('<path d="M5 6l8 6-8 6V6zM17 6v12"/>'),
  /** Bomb: a round casing with a fuse. */
  bomb: svg('<circle cx="11" cy="14" r="6.5"/><path d="M15 9.5 18 6.5"/><path d="M18 3v2M21 6.5h-2M20.5 4l-1.4 1.4"/>'),
  /** Mine: a spiked disc. */
  mine: svg('<circle cx="12" cy="12" r="5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2 19 19M19 5l-2.8 2.8M7.8 16.2 5 19"/>'),
  /** Jam: signal waves cut by a slash. */
  jam: svg('<path d="M5 17a9 9 0 0 1 0-10M8 14.5a5 5 0 0 1 0-5M19 7a9 9 0 0 1 0 10M16 9.5a5 5 0 0 1 0 5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M4 21 20 3"/>'),
  /** Calculate: a small processor chip. */
  calculate: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>'),
  /** Reinforce: a shield, one half filled by the side it covers. */
  reinforce: svg('<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3z"/><path d="M12 3v18"/>'),
  /** Reload: a circular arrow around a round. */
  reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2.5"/>'),
  /** Coordinate: a signal from one ship to another. */
  // Recover: a medical cross.
  recover: svg('<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>'),
  coordinate: svg('<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M8 15 16 9"/><path d="M5 10a6 6 0 0 1 5-5M19 14a6 6 0 0 1-5 5"/>'),
  /** Back to the menu. */
  back: svg('<path d="M10 6 4 12l6 6"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>'),
} as const;
