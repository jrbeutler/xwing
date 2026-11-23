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

1. **Planning: fly your ships on the board.** Click a ship. Dots appear at every spot it can reach (blue = easy, white = normal, red = adds stress). Move the pointer toward a spot and the ghost snaps to that maneuver: nudge left for a 1 bank, further out for a 2 bank, and so on. Click to set it, and the next ship is selected automatically. **F** (or the Flip button) switches between moves that end in the same spot, such as 4 straight and the 4 K-turn. **Esc** deselects; **Enter** sets the move, or executes once all are set. On touch: drag to steer, tap to set. The classic dial is still under "Show dial".
2. **Activation:** ships move from lowest to highest initiative. After moving, pick an action on the board: click a **teal dot** to barrel roll or a **green dot** to boost (the ghost previews it), click a **yellow-ringed enemy** to lock it, or use the **Focus / Evade / Skip** buttons under the ship. Esc skips.
3. **Engagement:** ships fire from highest to lowest initiative. Enemies you can shoot get a **red ring**. Hover one to see range and dice, click to fire, or press **Hold fire** under your ship (Esc).
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
