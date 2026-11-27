# Visual effects plan

Effects should do two jobs: look good, and tell the player what happened without reading the log.
Every effect respects the 1×/2× speed setting, tap-to-skip, and reduced motion (no shaking or rolling),
and stays cheap enough for phones (short-lived particles, everything disposed when done).

Colours: each side's shots use its team colour (Coalition red, Syndicate green); ion is always electric blue,
jamming always violet, proton warheads orange-white.

## Phase 1: shots (done in this branch)

| Weapon | Before | Now |
|---|---|---|
| **Lasers** (primaries, Dorsal Turret) | One glowing bolt from the nose | Bolts alternate between two gun points, a bright core with a coloured glow and a short fading tail; a hit flares where it lands, a miss streaks past |
| **Missiles** (Concussion Missiles) | Shared "ordnance" glow with a trail | A missile body with a flickering exhaust drops off the launcher, then curves in on the target, leaving smoke puffs that hang and fade; a hit is a fireball |
| **Rockets** (Rocket Pods) | Same as missiles | A quick ripple-fired salvo of small rockets that wobble as they fly, with short smoke puffs and small pops on impact |
| **Torpedoes** (Proton, Ion Torpedoes) | Same as missiles | A slow, heavy, pulsing warhead with a sparkling wake; a hit is a big flash with a shockwave ring |
| **Ion** (Ion Cannon Turret, Ion Torpedoes) | Blue-tinted laser or missile | The turret fires a jagged arc of electricity that flickers; ion torpedoes are blue warheads; a hit crackles with arcs over the target. **Ionized ships** keep a faint flickering blue aura with stray sparks until the ion wears off |
| **Jamming** | A flat purple line | Rings of interference travel from the jammer to the target over a crackle of static; the target glitches (the model flickers and jitters, violet static) as its token is knocked off |

## Phase 2: hits and lasting damage

- **Critical hits** deal damage cards: show them on the ship, not only in a banner. Console Fire: a small fire
  glow; Damaged Engine: a sputtering exhaust; Fuel Leak: a vapour trail; any hull below half: a thin smoke trail.
- **Evades**: a near-miss streak past the hull with the jink.
- **Shield hits**: the bubble ripples out from where the shot struck, not uniformly.
- **Destroyed**: bigger, longer blast for medium bases; debris that drifts and fades on the table.

## Phase 3: bombs and mines

- **Dropping**: the device detaches from the ship and settles on the table with a small thruster puff.
- **Proton bomb**: a shockwave ring along the table, a fireball and debris.
- **Ion bomb**: an expanding ion storm; caught ships crackle.
- **Proximity mine**: arms with a blinking light; when triggered, it pops up and lunges at the ship.

## Phase 4: actions

- **Lock**: a targeting reticle closes onto the enemy and stays on it while the lock is held (a thin dashed
  line when the locking ship is selected).
- **Coordinate**: a signal pulse travels to the friendly ship, which lights up briefly.
- **Tokens**: Focus, Evade and Calculate give the ship a brief glow in the token's colour; **Reinforce** shows
  a translucent shield over the braced half for the round.
- **Reload**: a loading flash at the launcher. **Repair**: welding sparks. **Rotate**: the turret swings (exists).

## Phase 5: movement and the table

- **Barrel roll**: the model actually rolls as it slides. **Boost**: an engine burn on the way.
- **Bumps**: a jolt and a small spark where the bases touch. **Fleeing**: the ship burns off the edge.
- **Obstacle hits**: an asteroid impact throws rock chips; debris clatters off the hull; a gas cloud
  crackles around the ship as it takes ion.
