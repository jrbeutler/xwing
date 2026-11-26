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
viewFor(state, playerId) -> GameState     // redacts hidden info (opponent dials in every phase, RNG, deck order)
```

- The **state** is plain data. The RNG state is a single integer inside it.
- **Commands**: `setDials`, `action`, `attack`. Every input from a human, the AI or the network goes through `apply`.
- **Decisions**: `planning` (simultaneous, waits on several players), `system` (drop a device), `action`, `attack`. An `action` decision can be a follow-up in the same activation: `linked` (the linked action after the first) or `coordinated` (a friend acting because this ship coordinated it); the activation moves on once the chain ends.
- **Events** are the only thing a renderer needs: `moved` (with a sampled path), `attack` (with dice), `destroyed`, and so on.

### Path to Unreal

Unreal does not run TypeScript, so the engine is designed so that moving to Unreal means swapping the front end:

1. **Multiplayer server first.** Wrap the engine in a WebSocket server: `client → Command`, `server → {view, newEvents, pending}`. The server holds the real state and sends each client `viewFor(state, player)`. That design is *required* anyway for secret dials.
2. **Unreal client.** Unreal connects to the same protocol (WebSocket plugin + JSON). It renders poses from events exactly like the web client does, because the coordinate system and units (mm, radians, +y up on the board) are specified here.
3. **Offline/single-player in Unreal.** Either bundle the Node server as a local sidecar, or port the engine to C++. The engine is small (geometry, templates, phase machine, combat), and the test suite plus recorded game logs (seed + commands → expected events) become the acceptance tests for the port.

### Effects (what upgrades and pilot abilities do)

Upgrades and named pilots' abilities describe what they do as data: `UpgradeDef.effects` and
`PilotDef.ability` in `content.ts`, interpreted by `effects.ts`. The rules code asks "which effects apply
now?" and never checks for an upgrade or pilot by id, so a new talent, upgrade or pilot ability is a content
change. In play, an ability is a source like an upgrade (`ShipState.ability`, id = the pilot's id, with its
own charges), listed before the ship's upgrades; `effectSource(id)` names any source for clients. Effect kinds:

| Kind | What it does | Used by |
|---|---|---|
| `dice` | ±N attack or defense dice while this ship attacks or defends | Outmaneuver, Stealth Coating; Mara Venn, Tobin Reyes, Kira Solace, Bram Holloway |
| `rerollAttack` | Reroll up to N attack dice (blanks first, then focus results) | Marksman, Steady Gunner, Ordnance Specialist |
| `rerollDefense` | Reroll up to N defense dice | Elusive |
| `cancelEvade` | Cancel 1 of the defender's evade results | Crack Shot |
| `trigger` | On an event (`redManeuverExecuted`, `endPhase`, `damaged`, `actionPerformed`, `attackHit`), if conditions hold (shields/charges below max, which action, an `AttackCondition`), run ops (`gainFocus`, `gainCalculate`, `stressDefender`, `recoverShield`, `recoverCharge`, `loseCharges`) | Hotshot, Elusive, Damage Control, Stealth Coating; Syl Ketch, Ilse Kord, Wren Tal, Drav Okono, Tessa Varn, Corin Hale |
| `stat` | Flat bonus to a looked-up number (`jamRange`, `deviceCharges`) | Signal Jammer, Payload Expert |

Attack effects can be limited with an `AttackCondition` (primary, turret, bullseye, front arc, attacker
outside the defender's arcs, defender stressed, a range of bands). `cost: 'charge'` spends one of the
source's charges per use; `needsCharge` only requires one; `recurring` sources get 1 charge back in each
End phase ("once per round"). Attack events list the sources whose dice effects changed the dice (`diceBy`). Dice effects are read by both `resolveAttack` and `attackOdds` through the same helpers,
and `test/effects.test.ts` checks the two against each other for effects the shipped content doesn't use yet
(multi-die rerolls, attack-dice changes, stacking). Triggers log an `upgrade` event that says what they gave
(`focus`, `calculate`, `shields`), so clients don't need to know any upgrade or pilot by name.

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
| Bumping | ✅ | Ship backs along its path until clear. Partial maneuver skips the action and loses the final rotation. **House rule:** a bump also costs 1 stress |
| Fly-over | ✅ | Ships may pass over others; only the final position matters |
| Fleeing | ✅ | Base partly off the board, so the ship is destroyed |
| Obstacles | ✅ | Three kinds (`OBSTACLE_RULES` in `content.ts`). Moving through or landing on one: **asteroid** roll 1 attack die, hit = 1 damage, crit = 1 critical damage, skip action; **debris field** 1 stress, then roll: crit = 1 critical damage; **gas cloud** roll: anything but a blank = 1 ion token, keep the action. All obstruct attacks (+1 defense die). Scenarios pass their own layout in `GameSetup.obstacles`; otherwise `generateObstacles` lays out a random mix (default 3 asteroids, 2 debris fields, 1 gas cloud), kept apart with room to fly between. Players never place obstacles |
| Actions | ✅ | Focus, Evade, Lock (any range band, 0–4, one lock at a time), Barrel Roll, Boost, Calculate, Reinforce, Reload, Rotate, Jam, Repair, red actions |
| Linked actions | ✅ | `ActionDef.linked`: after the first action the ship may perform the linked one (red: +1 stress). Allowed even if the first action left the ship stressed; not after an ion maneuver; one link per activation |
| Calculate | ✅ | Token; changes 1 focus result (hit attacking, evade defending). Spent instead of focus on a lone focus result, or when one change is enough; kept otherwise. Cleared in the End phase |
| Reinforce | ✅ | Token for the front or rear half (full 180° arc through the base centre). An attack from a covered attacker with 2+ uncancelled results loses 1 (a hit first). Lasts the round, not spent |
| Coordinate | ✅ | A friendly ship at range 0-2, not stressed, immediately performs an action (Focus-only if ionized) and its linked action; it cannot coordinate in turn, and still acts in its own activation. Coordinate itself has no linked action |
| Reload | ✅ | Recover 1 charge on a missile, torpedo or device below its starting charges; the ship is disarmed (no attacks) until the End phase |
| Arcs | ✅ | 90° front/rear wedges through the base corners; bullseye strip detected |
| Range | ✅ | Closest base-to-base distance *within the arc*; four bands with edges at 60/160/260/360 mm (house rule; the board game uses three 100 mm bands); range 0 allowed |
| Attack | ✅ | **House rule, four bands** (`RANGE_RULES` in `combat.ts`): range 1 (0–6 cm) −1 attack die, range 2 (6–16 cm) +1 attack die, range 3 (16–26 cm) none, range 4 (26–36 cm) +1 defense die; primary weapons only. The board game has three 10 cm bands with +1 attack die at range 0–1 and +1 defense die at range 3. Obstructed: +1 defense die |
| Dice | ✅ | Attack 3 hit / 1 crit / 2 focus / 2 blank. Defense 3 evade / 2 focus / 3 blank |
| Damage | ✅ | Shields absorb first. Crits that reach the hull deal a face-up damage card (2nd edition deck, `damage.ts`) |
| Simultaneous fire | ✅ | Ships destroyed during an initiative step still attack in that step |
| Win condition | ✅ | Last player with ships; at the round cap (12), most hull+shields left wins |

### Simplifications and to-do (rules)

- Dice modification is **automatic** (talent reroll → lock reroll → focus → defender focus → evade), on purpose: per-shot prompts slow the game down too much. The attacker's side follows a `SpendPlan` (`combat.ts`): hold focus for defense while an enemy that hasn't fired can still shoot back (unless it turns 2+ dice or could kill), keep a lock for loaded lock-only ordnance rather than reroll one die, and spend nothing on a guaranteed kill. `attackOdds` mirrors it exactly. The defender's order already keeps the more valuable token (an evade token is worth more than focus on later attacks).
- Not yet: force, tractor, strain/deplete tokens, SLAM, cloak, crew/astromech/sensor upgrade slots, and a scenario format (missions) that would lay out obstacles by design.
- The AI checks the whole path of a maneuver for obstacles (the rules count flying through the same as landing on one), weighted asteroid > debris > gas, and looks one move ahead: it avoids ending nose-up to an obstacle when a short straight and both gentle banks would all hit one next round (`OBSTACLE_AVOID` in `ai.ts`). AI-vs-AI games average about half an obstacle contact per game (down from about 10). It does not predict bumps, so it may skip a move that a collision would have stopped short of an obstacle.
- Jam strips Focus, then Evade, Calculate, Reinforce, then a lock; a jam token cancels the next token of any of those kinds.
- The AI weighs Calculate, Reinforce and Reload with the same exact-odds valuation as Focus/Evade/Lock, and takes a red linked action only when it is worth more than a stress (`TOKEN_WEIGHTS.stress`).
- Barrel roll uses 3 fixed positions (forward/centre/back), not continuous placement.
- Tallon-style roll uses the centred position only.
- Obstruction is checked along the closest-points line only.

### Measurements to verify against physical components

All live in `packages/engine/src/maneuvers.ts`:
- `BANK_RADIUS` (80/130/180 mm centre-line) and `TURN_RADIUS` (35/62.5/90 mm).
- Template width (20 mm), bullseye width, range band edges (`RANGE_RULES.edges`; devices and the setup area still use 100 mm), base sizes (40/60/80 mm).

**Rules verification:** the rules here are written from general knowledge of the
2.0/2.5 core rules. Before relying on them for balance, check each table row against
the current official Rules Reference, especially stress and red maneuvers, range-0
attacks, and partial-maneuver details.

## Placeholder content

| Ship | Base | Atk | Agi | Hull | Shd | Actions |
|---|---|---|---|---|---|---|
| Kestrel Fighter | small | 3 | 2 | 4 | 2 | Focus, Lock, Barrel Roll |
| Wasp Interceptor | small | 3 | 3 | 3 | 0 | Focus, Evade, Lock, Barrel Roll → red Evade, Boost |
| Javelin Interceptor | small | 2 | 3 | 2 | 2 | Focus, Evade, Lock, Barrel Roll, Boost → red Focus |
| Anvil Bomber | small | 2 | 1 | 6 | 2 | Focus, Lock, red Barrel Roll, Reload |
| Bulwark Gunship | medium | 3 front / 2 rear | 1 | 7 | 3 | Focus, Lock, Reinforce, Coordinate, red Boost |
| Wayfarer Light Freighter | medium | 2 turret | 2 | 3 | 2 | Focus → Rotate, Lock → Rotate, Calculate, Jam, red Boost |

Factions: Coalition (player) vs Syndicate (AI). Pilots and dials are in `content.ts`.

Named pilots' abilities (each costs 2 points in the pilot's price, 3 for the extra-die ones):

| Pilot | Ship | Ability |
|---|---|---|
| Mara Venn | Wasp | Long-Range Dodger: +1 defense die at range 3-4 |
| Syl Ketch | Wasp | Slipstream: after a Barrel Roll or Boost, gain 1 calculate |
| Tobin Reyes | Kestrel | Press the Attack: +1 attack die on primary attacks against a stressed ship |
| Ilse Kord | Kestrel | Steady Nerves: once per round, after losing shields or hull, gain 1 focus |
| Kira Solace | Javelin | Ambush: +1 attack die on primary front-arc attacks from outside the defender's arcs |
| Wren Tal | Javelin | Rattle: once per round, after a damaging attack on a ship in the bullseye, it gains 1 stress |
| Bram Holloway | Anvil | Torpedo Run: +1 attack die with missiles or torpedoes at range 3 |
| Drav Okono | Bulwark | Command Presence: after a Coordinate, gain 1 focus |
| Tessa Varn | Wayfarer | Signal Analysis: after a Jam, gain 1 calculate |
| Corin Hale | Wayfarer | Fire Control: after a Rotate, gain 1 calculate |

Over 300 AI-vs-AI games, named pilots' sides won 44-55% of the games they were in (noise at this sample
size). The AI values the tokens these abilities give after an action (`actionBonus` in `ai.ts`), e.g. Syl
Ketch's calculate after a Barrel Roll or Boost.

## AI

v1 is a one-ply lookahead. For each legal maneuver it scores the end position: enemies in
my arc (closer is better), me in their predicted arc (bad), board edges, obstacles flown
through or onto (and ending boxed in by one), distance to the nearest enemy, and stress. It adds a small jitter so it isn't predictable.

Enemy positions are predicted (`predictEnemies`, `PREDICTION` in `ai.ts`): the AI puts itself in each enemy's
seat, scores that enemy's legal maneuvers with the same scoring (assuming our ships fly straight ahead), and
keeps the best 3, weighted by exp((score − best) / 8); every candidate of ours is scored against each likely
enemy position by its weight. It uses only what a player can see: stressed enemies can't pick red maneuvers,
ionized ones drift 1 straight, damage cards change how a maneuver flies. In AI-vs-AI games the most likely
guess lands a median 38 mm from where the enemy actually ends (within 50 mm 66% of the time), against 84 mm
(25%) for the old guess of 100 mm straight ahead; that is the AI predicting itself, so humans will be harder to
read. Over 300 mirrored games it beat the straight-ahead AI 173–120 (7 draws). A planning decision takes about
12 ms (6 ms before).

The same planning gives players a learning aid (`suggestManeuvers`): for each of a player's ships, the
maneuver the AI would fly (without its random jitter) plus what it expects there: enemies likely in arc
(chance and range) and enemies likely to have the ship in an arc. The client calls it with
`viewFor(state, player)`, so it only uses what that player can see; it is a per-player option at setup.

Next steps:
- Two-ply search over activation order.
- Personalities (aggressive, cautious, flanker).
- Self-play for balance.

Actions: repairs and jams come first; then Coordinate if the best action a friend in range could take is worth more than the ship's own (`coordinateChoice`); otherwise Focus, Evade, Calculate, Reinforce, Reload or a Lock (on each enemy) is chosen by value with the exact odds (`bestToken` in `ai.ts`): how much it improves this round's best shot (a lock can make ordnance legal), how much damage it prevents from enemies that can still shoot, and, for a lock, part of its value next round (`TOKEN_WEIGHTS`). Barrel Roll and Boost are weighed the same way (`repositionValue`): the better shot from the new position and the damage it avoids, with enemies that have not moved yet this round counted at half (their position is not final), plus the linked action it opens (e.g. the Wasp's red Evade, minus its stress), minus stress for a red reposition, a mine on the way, ending near the board edge, or ending boxed in by an obstacle. Over 900 mirrored games against the same AI without repositioning it won 444–429 (27 draws), which is within noise; it does use the actions (about 2.5 rolls or boosts per game per side, 0.3 linked actions after them) and makes Slipstream fire. An action decision takes about 2.5 ms (0.8 ms without repositioning). Against the old fixed order (focus first) it took 1,500 locks instead of none and fired ordnance 2.4× as often, with no change in win rate (145–147, 8 draws, over 300 mirrored games): positioning decides games far more than token choice.

The AI already decides from `viewFor` (the redacted view), the same view a network client gets.

## Roadmap

1. ✅ **Movement and combat vertical slice**: engine + tests + 3D web client vs AI.
2. **Rules depth**: interactive dice mods, damage deck, more actions, more obstacle types, pilot abilities as data-driven effect hooks.
3. **Multiplayer**: ✅ local pass-and-play (two players on one device, hand-over screens hide each player's planning). ✅ Online between friends with no server (`apps/web/src/online.ts`, `lobby.ts`): the host's browser runs the game and the guest connects to it over WebRTC (PeerJS; the public PeerJS service only brokers the connection). The guest sends commands, the host checks them with `apply` and sends back `viewFor(state, guest)` plus the new log events (`sync`); both deploy at once and press Ready; the host saves the game in localStorage after every change and can resume it after a reload, and the guest rejoins with a seat token (or reconnects by itself). Not cheat-proof: the host has the whole state. Next: `apps/server` (WebSocket rooms, server-authoritative state) so neither player holds the game; the lobby and protocol carry over, with the server taking the host's role.
4. **Missions**: scenario files (deployment zones, objectives, reinforcements, turn limits), mission scripting hooks.
5. **Campaign**: pilot XP and traits, injuries and permadeath, hangar and upgrades, carrier facilities, star map with rising threat, save/load.
6. **Own universe**: replace the placeholder content, art direction, audio.
7. **Unreal client**: against the server protocol, then decide on a C++ port or a sidecar for offline play.

## Coordinate conventions (shared with every client)

- Board is 914 × 914 mm, origin bottom-left, +x right, +y "up" (towards player 2).
- Pose `{x, y, h}`: `h` in radians, forward = `(cos h, sin h)`, left = forward rotated +90°.
- Web client maps board `(x, y)` → three.js `(x − 457, height, −(y − 457))` with `rotation.y = h`.
