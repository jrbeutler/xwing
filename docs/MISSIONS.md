# Missions, training and campaign: plan

Status: the mission framework and the eight training missions are built (build steps 1 and 2 below); the
campaign layer and fleet battles are not. Decisions so far:
- **Fighters in fleet battles** are abstract squadron tokens to start (the fleet layer is later).
- **Permadeath**: pilots and ships lost in a mission are gone.
- **Single player** first; the design keeps co-op possible (two players sharing one roster against the AI).
- **No story yet**: a simple training track proves the mission format; story comes later.

## Layers

| Layer | What it is | Where |
|---|---|---|
| Squadron battle | The current game: fighters on a 3'×3' table | `packages/engine` |
| Fleet battle (later) | Capital ships: hull zones and shields per arc, command dials set ahead, speed changes, squadrons as tokens | new `packages/fleet`, sharing dice, RNG, the event log, `viewFor` and the effects-as-data system |
| Campaign | Picks the next mission, sets it up from campaign state, reads the result back; never runs a battle itself | new `packages/campaign` |

## Missions are data

A mission is a TypeScript data file (like upgrades and pilots in `content.ts`), checked by tests, no code of
its own. Sketch:

```ts
interface Mission {
  id: string; title: string; layer: 'squadron' | 'fleet';
  briefing: string;                 // shown before the battle
  ruleset: Ruleset;                 // which rules and content are on (training gates)
  table: { obstacles: Obstacle[] | 'random' | 'none'; zones?: Zone[]; markers?: Marker[] };
  forces: {
    player: { fixed: SquadEntry[] } | { roster: { points: number; maxShips: number; ships?: string[] } };
    enemy: { squad: SquadEntry[]; ai?: AiProfile };
  };
  objectives: Objective[];          // all `required` ones done = win; any `fail` condition met = loss
  triggers?: Trigger[];             // scripted events
  maxRounds?: number;
  outcomes: { win: CampaignEffect[]; loss: CampaignEffect[] };
}
```

**Objectives** (squadron layer to start), each with an id, a short label for the HUD and progress:
- `destroy`: every enemy, or ships with a tag.
- `survive`: keep going until round N (with at least one ship, or a tagged ship, alive).
- `reach`: a ship (or any of yours) ends a move inside a zone or at a table edge.
- `course`: fly through markers in order (the first training mission).
- `protect`: a tagged friendly ship must not be destroyed (a `fail` objective).
- `scan`: end a round at range 0-1 of each marker (and not stressed, say).

**Triggers** are data, like effect triggers: on `roundStart` (N), `roundEnd`, `shipDestroyed` (tag),
`objectiveDone` (id), `shipDamaged` (tag, below half) → run ops: `message` (a popup, e.g. a coach tip),
`reinforce` (ships arrive at an edge or zone), `revealObjective`, `endMission` (win or loss).

**Ruleset** switches rules and content on per mission. Anything off disappears from the action ring, the
squad builder, the log and the help text, so a new player never sees what they have not been taught:
```ts
interface Ruleset {
  actions: ActionType[];            // e.g. ['focus'] in mission 2
  linkedActions: boolean; redManeuvers: boolean; specialManeuvers: boolean;   // K-turns, loops, rolls
  obstacles: boolean; damageCards: boolean;   // off: crits count as plain hull damage
  slots: SlotType[]; upgrades?: string[];     // what the builder offers
  ion: boolean; devices: boolean;
  hints: { suggestMoves: boolean; coachTips: boolean };
}
```
Skirmish keeps the full ruleset (`FULL_RULES`).

### Engine changes for missions
- `GameSetup` gains `mission` (ruleset, objectives, triggers, zones, markers). `createGame` uses its table
  instead of a random one.
- Win conditions: objectives are checked after each move and in the End phase; `gameOver` carries the
  mission result and which objectives were met.
- Ruleset gates in `actionOptions`, `legalDial` (red and special maneuvers), obstacle setup, `critToHull`
  (damage cards off) and the squad builder (`upgradeOptions`, slots).
- New events: `objective` (progress, done, failed), `message`, `reinforcements` (ships added mid-game, with
  their poses).
- Scenario actions for later missions (e.g. `scan`) go on the action bar like other actions.
- The AI: plays objectives through a small `AiProfile` (aggressive, defend a ship or zone, run for an edge)
  that adds to its maneuver scoring; elimination stays the default.

### Client changes
- A briefing screen before the battle (objectives, the one new rule), a mission HUD (objectives and
  progress), a debriefing after (what happened, what it changes).
- Coach tips: a short popup the first time something happens on the table (first stress, first crit), when
  the ruleset turns tips on.
- Zones and markers drawn on the table.

## Training track (simple, no story)

One new idea per mission. Each starts with a short briefing on that idea, and turns on the hints.

| # | Teaches | Mission | Ruleset adds |
|---|---|---|---|
| 1 | Dial, maneuvers, blue/white/red, stress | **Flight course**: fly through 5 markers in order, no enemies, 8 rounds | Maneuvers only (no red), then red with a stress tip |
| 2 | Firing arcs, range, attacking | **Target drones**: destroy 3 drones that fly straight and never shoot | Attacks |
| 3 | Focus and Evade, the dice | **First duel**: 1-vs-1 against a pilot that uses Focus | Focus, Evade |
| 4 | Lock, initiative order | **Wingmen**: 2-vs-2 | Lock |
| 5 | Obstacles | **Rock field**: destroy the enemy through an asteroid field | Obstacles |
| 6 | Barrel roll, boost | **Break contact**: reach the far edge with a faster enemy on your tail | Barrel roll, boost, special maneuvers |
| 7 | Damage cards | **Attrition**: a longer 2-vs-3 fight | Damage cards |
| 8 | Squad points, first upgrades | **Escort**: protect a freighter to the far edge; build your own squad of 3 | Points, modifications and talents |

After the track, later missions add one upgrade family each (missiles and torpedoes, turrets, crew and
gunners, droids and sensors, devices, ion), so the full game is unlocked by the end of the first campaign.
A **skip training** option starts experienced players with everything.

## Campaign

**State**, a plain JSON object saved in the browser (localStorage) for single player:
- Roster: pilots (from a recruitable pool of generics plus named pilots met in missions), their ships,
  upgrades owned, experience; `alive: false` for the fallen.
- Unlocked content: ships, slots, upgrades, rules (the training track's ruleset carries into the campaign).
- Mission progress: done, failed, available; story flags set by outcomes.
- Later: capital ships and their persistent damage, resources, the strategic map.

**Permadeath**: a pilot whose ship is destroyed is dead, and the ship with its upgrades is lost. To keep a
bad mission from ending a campaign, generic replacement pilots can always be recruited (low initiative, no
talents), and experience and named pilots are what you stand to lose. A mission loss is not a campaign loss:
it closes some branches and opens worse ones.

**Mission graph**: missions are nodes with prerequisites (missions done, flags set); outcomes set flags and
unlock nodes. A mostly linear spine with optional side missions. In the fleet era, fleet battles set the
strategic situation and fighter missions are the plot points whose results change the next fleet battle
(e.g. destroy a shield relay → the enemy flagship starts with fewer shields).

**Co-op later**: two players share one roster against the AI. The online code already runs two humans in
one game (the host's browser runs it); campaign state would live with the host, or on the planned server.

## As built (steps 1 and 2)

- Engine: `rules.ts` (rulesets), `mission.ts` (objectives, triggers, result), `training.ts` (the eight missions
  and `missionGame`). Objectives built: destroy, survive, reach, course, protect (`scan` and reinforcements
  later). Triggers fire messages on a round, an objective done, a tagged ship destroyed, or the first stress,
  damage card, obstacle hit, attack, hit or lock of the player's. The AI has a `drone` profile, and the
  player's side is drawn to its objectives (move hints). The ruleset gates attacks, actions, linked actions, red
  and special maneuvers and damage cards; mission forces are fixed, so slots and devices need no gate yet.
- Client: a start menu (Campaign, Skirmish), the campaign's mission list (progress in localStorage, Skip
  training), briefings, the objectives HUD, gates and zones on the table, coach-tip cards, and a debrief with
  Next / Retry / Campaign. Missions turn the move hints on.
- Mission 8 teaches upgrades with a fixed escort (the escorts carry a Shield Booster and Hull Plating); building
  your own squad within a budget comes with the campaign layer.
- In tests each mission is played to a result with the AI flying both sides: the course and the drones are
  won nearly every time; the fights are won roughly a quarter to two thirds of the time by the AI, so a player
  using the hints should do better.

## Build order

1. **Mission framework in the squadron engine**: the format, objectives, triggers, rulesets, briefing, HUD,
   debriefing, coach tips; training missions 1-4.
2. **Training missions 5-8** and the AI profiles they need (drones, runner, escort).
3. **Campaign layer**: state, save and load, roster with experience and permadeath, the mission graph, the
   campaign screens; a first short arc of 5-6 missions after training.
4. **Fleet engine** with squadron tokens, its client view, and fleet training missions.
5. **Linking layers**: fleet ↔ fighter outcomes, the strategic map.

## Open questions (for later steps)

- Experience: what it buys (initiative, talent slots, talents) and how fast.
- Can a destroyed pilot eject (a chance to survive, injured) or is every loss final?
- Fleet layer: which capital-ship rules first (hull zones, command dials, navigation) and what scale the table is.
