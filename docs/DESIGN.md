# Squadron Tactics: Design Document

Working title. A squadron-commander campaign game: recruit and develop pilots, manage a
carrier/base on a strategic map, and fight tactical starfighter battles that use
X-Wing-style (2nd edition / 2.5) table rules. The setting is a **placeholder universe**,
to be replaced by an original setting later. All content is data, so the swap is
purely a content job.

## Pillars

1. **Plan, then commit.** Secret simultaneous maneuver planning, then reveal in initiative order. This tension is the core of the game.
2. **Readable tactics.** Every rule is visible on the table: arcs, range bands, template previews, dice results.
3. **Your squadron matters.** Pilots persist, improve, get injured and can die (campaign layer).
4. **Deterministic core.** Same seed and same commands give the same game. That enables replays, netcode, AI training and balance simulation.

## Architecture

```
packages/engine   Pure TypeScript rules engine. No DOM, no rendering, no I/O.
apps/web          Three.js prototype client (3D ships on a 2D plane).
(later)
apps/server       Authoritative Node multiplayer server running the same engine.
clients/unreal    Unreal Engine client talking the same command/event protocol.
```

### Engine contract

```ts
createGame(setup) -> GameState            // JSON-serialisable
apply(state, command) -> GameState        // pure; throws on illegal commands
state.pending: Decision                   // what input is needed, and from whom
state.log: GameEvent[]                    // append-only; clients animate from this
viewFor(state, playerId) -> GameState     // redacts hidden info (opponent dials, RNG)
```

- The **state** is plain data. The RNG state is a single integer inside it.
- **Commands**: `setDials`, `action`, `attack`. Every input from a human, the AI or the network goes through `apply`.
- **Decisions**: `planning` (simultaneous, waits on several players), `action`, `attack`.
- **Events** are the only thing a renderer needs: `moved` (with a sampled path), `attack` (with dice), `destroyed`, and so on.

### Path to Unreal

Unreal does not run TypeScript, so the engine is designed so that moving to Unreal means swapping the front end:

1. **Multiplayer server first.** Wrap the engine in a WebSocket server: `client → Command`, `server → {view, newEvents, pending}`. The server holds the real state and sends each client `viewFor(state, player)`. That design is *required* anyway for secret dials.
2. **Unreal client.** Unreal connects to the same protocol (WebSocket plugin + JSON). It renders poses from events exactly like the web client does, because the coordinate system and units (mm, radians, +y up on the board) are specified here.
3. **Offline/single-player in Unreal.** Either bundle the Node server as a local sidecar, or port the engine to C++. The engine is small (geometry, templates, phase machine, combat), and the test suite plus recorded game logs (seed + commands → expected events) become the acceptance tests for the port.

Keep these rules so this stays cheap:
- No rendering, timing or platform calls in `packages/engine`.
- No hidden state outside `GameState`.
- All randomness through `rng.ts`.

## Rules implemented (vertical slice)

| Area | Status | Notes |
|---|---|---|
| Round structure | ✅ | Planning → System → Activation (lowest initiative first) → Engagement (highest first) → End |
| Initiative ties | ✅ | First player resolves first |
| Maneuvers | ✅ | Straight, bank, turn, K-turn, segnor-style loop ("sloop"), tallon-style roll ("troll"), stop, reverse straight/bank |
| Difficulty and stress | ✅ | Red adds stress, blue removes one. Stressed ships cannot pick red maneuvers or perform actions |
| Bumping | ✅ | Ship backs along its path until clear. Partial maneuver skips the action and loses the final rotation |
| Fly-over | ✅ | Ships may pass over others; only the final position matters |
| Fleeing | ✅ | Base partly off the board, so the ship is destroyed |
| Asteroids | ✅ | Moving through or landing on one: roll 1 attack die (hit/crit = damage), skip action |
| Actions | ✅ | Focus, Evade, Lock (range 0–3, one lock at a time), Barrel Roll, Boost, red actions |
| Arcs | ✅ | 90° front/rear wedges through the base corners; bullseye strip detected |
| Range | ✅ | Closest base-to-base distance *within the arc*; bands of 100 mm; range 0 allowed |
| Attack | ✅ | Range 0–1: +1 attack die. Range 3: +1 defense die. Obstructed: +1 defense die |
| Dice | ✅ | Attack 3 hit / 1 crit / 2 focus / 2 blank. Defense 3 evade / 2 focus / 3 blank |
| Damage | ✅ (simplified) | Shields absorb first. **Crits are 1 damage; no damage deck yet** |
| Simultaneous fire | ✅ | Ships destroyed during an initiative step still attack in that step |
| Win condition | ✅ | Last player with ships; at the round cap (12), most hull+shields left wins |

### Simplifications and to-do (rules)

- Dice modification is **automatic** (lock reroll → focus → defender focus → evade). Next: interactive modify steps for humans.
- No damage deck, ship/pilot abilities, upgrades, charges/force, ion, tractor, reinforce, coordinate, calculate, linked actions, obstacles other than asteroids, or a points/loadout system.
- Barrel roll uses 3 fixed positions (forward/centre/back), not continuous placement.
- Tallon-style roll uses the centred position only.
- Obstruction is checked along the closest-points line only.

### Measurements to verify against physical components

All live in `packages/engine/src/maneuvers.ts`:
- `BANK_RADIUS` (80/130/180 mm centre-line) and `TURN_RADIUS` (35/62.5/90 mm).
- Template width (20 mm), bullseye width, range band (100 mm), base sizes (40/60/80 mm).

**Rules verification:** the rules here are written from general knowledge of the
2.0/2.5 core rules. Before relying on them for balance, check each table row against
the current official Rules Reference, especially stress and red maneuvers, range-0
attacks, and partial-maneuver details.

## Placeholder content

| Ship | Base | Atk | Agi | Hull | Shd | Actions |
|---|---|---|---|---|---|---|
| Kestrel Fighter | small | 3 | 2 | 4 | 2 | Focus, Lock, Barrel Roll |
| Wasp Interceptor | small | 3 | 3 | 3 | 0 | Focus, Evade, Lock, Barrel Roll, Boost |
| Bulwark Gunship | medium | 3 front / 2 rear | 1 | 7 | 3 | Focus, Lock, red Boost |

Factions: Coalition (player) vs Syndicate (AI). Pilots and dials are in `content.ts`.

## AI

v1 is a one-ply lookahead. For each legal maneuver it scores the end position: enemies in
my arc (closer is better), me in their predicted arc (bad), board edges, obstacles,
distance to the nearest enemy, and stress. It adds a small jitter so it isn't predictable.

Next steps:
- Sample enemy maneuvers instead of predicting straight-2.
- Two-ply search over activation order.
- Personalities (aggressive, cautious, flanker).
- Self-play for balance.

The AI already decides from `viewFor` (the redacted view), the same view a network client gets.

## Roadmap

1. ✅ **Movement and combat vertical slice**: engine + tests + 3D web client vs AI.
2. **Rules depth**: interactive dice mods, damage deck, more actions, more obstacle types, pilot abilities as data-driven effect hooks.
3. **Multiplayer**: `apps/server` (WebSocket, rooms, reconnection, server-authoritative state), lobby in the web client.
4. **Missions**: scenario files (deployment zones, objectives, reinforcements, turn limits), mission scripting hooks.
5. **Campaign**: pilot XP and traits, injuries and permadeath, hangar and upgrades, carrier facilities, star map with rising threat, save/load.
6. **Own universe**: replace the placeholder content, art direction, audio.
7. **Unreal client**: against the server protocol, then decide on a C++ port or a sidecar for offline play.

## Coordinate conventions (shared with every client)

- Board is 914 × 914 mm, origin bottom-left, +x right, +y "up" (towards player 2).
- Pose `{x, y, h}`: `h` in radians, forward = `(cos h, sin h)`, left = forward rotated +90°.
- Web client maps board `(x, y)` → three.js `(x − 457, height, −(y − 457))` with `rotation.y = h`.
