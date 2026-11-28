# Missions, training and campaign: plan

Status: the mission framework, the eight training missions and a first campaign arc (mission boards, flags; no
roster yet) are built; the roster, experience, ejection and rescue, the longer campaign and fleet battles are
not (planned below in **Roster, experience and rescue**). Decisions so far:
- **Fighters in fleet battles** are abstract squadron tokens to start (the fleet layer is later).
- **Losses**: a destroyed ship is gone. Its pilot ejects; the squadron's medic ship has to pick them up before
  their life support runs out, or they are lost (or captured, which opens a rescue mission).
- **Campaign length**: at least 10 operations, in three acts.
- **Single player** first; the design keeps co-op possible (two players sharing one roster against the AI).
- **Training an officer**: the player names an officer at enrolment and flies as them in every mission (their
  ship carries the name). Training is flight school under Commander Ress; graduation makes them a lieutenant.
- **Mission boards**: after training, each operation offers 2-4 missions and the player flies one. The others go
  away, and a campaign mission is flown once: win or lose, no retry. Results set flags that shape later boards.
- **Roster next**: campaign missions still use fixed forces, like training; the persistent squadron is the next
  step. The player picks who flies each mission, and spends experience in a hangar between missions.
- **The officer has no plot armour**: they eject and need rescuing like anyone else. Captured, they are rescued
  by the rest of the squadron; only a failed rescue ends the campaign.

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

**Losses**: a destroyed ship and its upgrades are gone; its pilot ejects and has to be recovered by the medic
ship (see **Roster, experience and rescue**). To keep a bad mission from ending a campaign, replacement pilots
join when the roster runs short, and experience is what you stand to lose. A mission loss is not a campaign
loss: it closes some branches and opens worse ones.

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

## As built (step 3, first part): the campaign arc

- Engine: `campaign.ts` holds four operations (`OPERATIONS`) of 2-4 `CampaignMission`s each: a mission plus a
  board summary, difficulty (1-3), stakes, `needs` / `needsAny` flags to appear, an `outcome` per result (flags
  set, debrief text), and `extras`: ships added to either side, or enemies left out, when an earlier result set a
  flag. Pure functions: `missionBoard`, `recordMission` (sets flags, moves to the next operation),
  `missionAsFlown` (applies extras), `campaignOver`. `missionGame(def, seed, { officer })` names the ship tagged
  `officer` (one in every mission, training included).
- The arc: **First Command** (supply run, raider hunt, listening post) → **Pressure** (depot strike if the buoys
  found it, take back stolen parts if the supply run failed, hold the relay, sweep the lanes) → **Counterstrike**
  (run the blockade, rescue a downed pilot, a duel with the Syndicate ace if the raiders got bold) → **Showdown**
  (final assault or defend the outpost, with allies and enemies set by everything before).
- Tests walk every path through the campaign (each board has 2-4 missions, every mission is reachable), check no
  ship starts on an obstacle, and play every mission (with and without its extras) to a result with the AI on
  both sides.
- Client: enrolment (name the officer), flight school with in-character intros, graduation, the operation's board
  (cards with difficulty, stakes, and notes on what earlier results changed), briefings marked final, a debrief
  with the outcome text and the way back to the board, and the end of the campaign with its history. Progress
  stays in localStorage (`xw-campaign`); old training progress carries over.

## Roster, experience and rescue (plan)

The campaign's squadron persists: pilots fly mission after mission, get better, and can be lost. The
campaign grows to at least 10 operations so there is room to advance and something to lose.

### Roster
- Each roster pilot is an individual: name, class (fighter to start), initiative, talents, banked XP, kills,
  missions flown, status (`ready`, `injured`, `captured`, `lost`). The officer is one of them, starting at
  initiative 2 (an academy graduate); new wingmen start at 1.
- Before each mission the player **picks who flies** in the mission's seats. Injured pilots can't fly that
  mission.
- **Replacements** join when the roster is short of the seats a mission needs, at initiative 1 in Act I, 2 in
  Act II and 3 in Act III, with generated names.
- A ship lost in battle is replaced by a standard hull with no upgrades.
- Engine: squad entries can carry a roster pilot's own initiative and talents instead of a pilot card's, so
  `effectiveInitiative`, `talentSlotCount` and `signatureTalents` read them from the entry.

### Experience
Earned per mission, by pilots who come home:

| Source | XP |
|---|---|
| Survived the mission (still on the board at the end) | 2 |
| Mission won (every survivor) | +1 |
| Each enemy destroyed (final blow) | +1 |
| Officer, for leading | +1 |

- **Retreat**: a ship that flies off its own table edge leaves the battle safely and earns survival and win XP
  prorated by the fraction of the mission it flew (rounds flown / rounds the battle lasted), plus full credit
  for its kills. It doesn't count as destroyed.
- A pilot who was shot down and rescued earns no survival or win XP, only kills.

**Spending** in the hangar between missions; XP is banked until spent:

| Purchase | Cost |
|---|---|
| +1 initiative (up to 6) | 2 × the new initiative (1→2: 4, 2→3: 6, 3→4: 8, 4→5: 10, 5→6: 12) |
| A new talent (needs a free slot) | 4 |

- **Slots come from initiative**, as in skirmish: one talent slot at 3-4, two at 5+. Talents come from the
  pilot's class pool.
- Pacing at about 4 XP a mission: a pilot who survives every mission is at initiative 2 after mission 2,
  3 with a talent by mission 4, 4 by mission 7, and 5 with two talents by mission 10. Initiative 6 takes an
  ace's kill count.

### Ejection, the medic ship and rescue
- **Every campaign mission** gives the player's side a **medic ship** (not skirmish or quick battle, and the
  Syndicate has none). It does not take a seat in the squad and **doesn't count as one of the player's ships**:
  if every attack ship is destroyed or has retreated, the battle is lost even with the medic still flying, and
  `destroy`-style objectives and the round-limit score ignore it.
- **The medic**: a new hull in the freighter class. No weapons; very high shields and hull, Reinforce, slow
  with a limited dial. To start, a recoloured Wayfarer or Bulwark model. **Flown by a droid** that never
  changes: not on the roster, earns no XP, can't be lost (if the medic is destroyed, the droid is salvaged and
  a new medic comes next mission). Its hull and shields don't count in the round-limit score.
- **Ejection**: when a ship is destroyed, its pilot ejects: an **escape pod** is placed where the ship was, a
  flashing beacon with a life-support countdown of **3 rounds** (the round it is destroyed counts as round 0).
  Pods are board objects: they don't block movement or line of sight and can't be shot.
- **Recover**: the medic ends a move with a pod at range 0-1 and takes the **Recover** action (its action for
  the round). The pilot is aboard and safe. A medic that retreats off its edge takes its passengers home.
- If the medic is destroyed, its passengers eject as pods where it was (with no medic left, those pods run
  out or are captured).
- **Pods that run out** of life support: the pilot is lost.
- **Recovery phase**: if the player wins with pods still out, the game plays on without enemies: the medic
  flies to the pods (the player flies it, with a fast-forward option) and each one it reaches before its
  countdown ends is saved.
- **If the player loses**, or the round limit ends the mission, every pod still out is **captured**.
- **Captured pilots** add a **rescue mission** to a later board (a jailbreak, a prisoner transport to
  intercept). Win it and they come back (injured); lose it, or skip it when it's offered, and they're lost.
- **Injured**: a rescued pilot sits out the next mission.
- **The officer** follows the same rules. If the officer is captured, the next board is only their rescue,
  flown by the rest of the squadron; a failed rescue ends the campaign. If the officer's pod runs out, the
  campaign ends.
- **AI**: the Syndicate hunts the medic and screens pods from it; the player's side (move hints, auto-flown
  wingmen) steers the medic to pods.
- **Later**: enemy pilots eject too; the medic picks them up as prisoners (intel, prisoner exchanges).

### The longer campaign
| Act | Operations | Story |
|---|---|---|
| I: Outer Reach | 1-4 | The current arc; its Showdown ends Act I, not the campaign |
| II: Taking the fight to them | 5-7 | Raids into Syndicate space, escorts, an informant subplot set by Act I's flags |
| III: Endgame | 8-10+ | The Syndicate ace and their base; the finale set by everything before |

- **Mission templates** (strike, escort, intercept, defend, rescue, recon, duel) build missions from
  parameters (table, enemy force, objective variant) so Acts II and III don't need every mission hand-made;
  briefings stay hand-written and a few set pieces stay custom. Rescue missions for captured pilots use the
  rescue template.
- **Rising threat**: enemy forces scale with the operation number and the squadron's total initiative (more
  ships, aces, upgrades), so a veteran squadron still gets a fight.
- Tests play the whole campaign with the AI on both sides to tune the life-support countdown, the medic's
  stats and the XP rates: a typical run should lose a few pilots and finish with some veterans.

### Build steps
1. **Roster and experience**: roster state, pilot picking, XP and the hangar, retreat off the table with
   prorated XP, the debrief (XP, who came home), on the current four operations.
2. **Ejection and rescue**: escape pods, the medic ship, Recover, the recovery phase, captured pilots and
   rescue missions, the officer's capture.
3. **Rising threat and mission templates.**
4. **Acts II and III**: operations 5-10.

## Build order

1. **Mission framework in the squadron engine**: the format, objectives, triggers, rulesets, briefing, HUD,
   debriefing, coach tips; training missions 1-4.
2. **Training missions 5-8** and the AI profiles they need (drones, runner, escort).
3. **Campaign layer**: state, save and load, the mission graph, the campaign screens, a first arc (built);
   then the roster, experience, rescue and the longer campaign (steps above).
4. **Fleet engine** with squadron tokens, its client view, and fleet training missions.
5. **Linking layers**: fleet ↔ fighter outcomes, the strategic map.

## Open questions (for later steps)

- Fleet layer: which capital-ship rules first (hull zones, command dials, navigation) and what scale the table is.
