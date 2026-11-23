# Squadron Tactics (prototype)

A squadron-commander tactics game prototype: 3D starfighters on a 2D table, using
X-Wing-style (2.0/2.5) maneuver-dial rules. You play a 3-ship squadron against an AI.

See [docs/DESIGN.md](docs/DESIGN.md) for the design, architecture, rules coverage and roadmap.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests
npm run typecheck
```

## How to play

1. **Planning:** pick a maneuver for each ship on its dial. Hover a maneuver to preview where the ship ends up. Blue maneuvers clear stress, red ones add it.
2. **Activation:** ships move from lowest to highest initiative. After moving, choose an action (Focus, Evade, Lock, Barrel Roll, Boost). Hover an option to preview it.
3. **Engagement:** ships fire from highest to lowest initiative. Pick a target in arc and in range 1–3.
4. Destroy the enemy squadron, or have more hull and shields left after round 12.

Drag to orbit the camera; scroll to zoom.

## Layout

```
packages/engine   Deterministic rules engine (pure TS, no rendering) + tests
apps/web          Three.js client
docs/DESIGN.md    Design document
```

## Screenshots

| Planning (maneuver preview) | Attack targeting |
|---|---|
| ![Planning](docs/screenshots/02-desktop-maneuver-preview.png) | ![Attack](docs/screenshots/05-desktop-attack-choice.png) |

More in [docs/screenshots](docs/screenshots), including phone emulation (the layout is not mobile-ready yet).
