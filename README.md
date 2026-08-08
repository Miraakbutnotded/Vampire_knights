# Survivors

A Vampire Survivors-style arena survival game. Custom TypeScript engine on Canvas2D — no game framework.

Everything is data-driven: enemies, weapons, passives, characters, wave pacing and maps all live in
`src/content/*.json`. You should be able to design a whole campaign without opening a `.ts` file.

```bash
npm install
npm run dev      # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. Editing a content JSON reloads instantly. |
| `npm run build` | Typecheck, then bundle to `dist/`. |
| `npm run preview` | Serve the production bundle. |
| `npm test` | Headless tests — the simulation, plus the architectural gates (see [Tests](#tests)). |
| `npm run typecheck` | Types only. There is no linter; `tsc` is the gate. |
| `npm run validate:art` | Check every sprite strip against the palette and frame rules (see [The art pipeline](#the-art-pipeline)). |
| `npm run cap:sync` | Build, then copy `dist/` and regenerate the SPM manifest for iOS. |
| `npm run verify:ios` | `cap:sync`, then actually compile and link the iOS target. Needs macOS and Xcode. |

`npx vitest run -t "every weapon"` runs a single test by name. `cap:sync` and `verify:ios` answer
different questions: `cap sync` rewrites the Swift package manifest and copies web assets without
ever invoking the Swift toolchain, so a plugin can appear in the manifest while the target no longer
builds. Only `verify:ios` runs `xcodebuild`.

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows / left stick / joystick | Move. Weapons fire automatically. |
| `Q` / `E`, or the two HUD buttons | Feast / Frenzy — spend the blood bar (see [`blood.json`](#bloodjson)). |
| `Space` / gamepad button / the round HUD button | Your character's active ability. |
| `Esc` / the pause button | Pause. |
| `1`–`9`, click, or arrows + `Enter` | Choose on any menu. |
| `F3` | Debug overlay: fps, entity counts, difficulty multipliers. |

Your **last movement direction** is your aim. Directional weapons (whip, knives) fire along it, and it
persists while you stand still — letting go of the keys doesn't swing your aim.

On a touch device the left of the screen is a floating joystick — the first touch anchors the base
under your thumb — and everything else is an ordinary button. The boundary between the two is
computed from the button cluster's own width, so putting a thumb down to walk can never land on
Feast instead.

## Placeholder art, and replacing it

**The game is fully playable before any art exists.** Every sprite in `sprites.json` declares a
`placeholder` — a shape and a colour — and the loader paints an animated strip from it when the PNG is
missing.

To replace one, drop a PNG at the path the sprite already names. No code or JSON change:

```
public/assets/player/idle.png     ← "player" sprite, idle animation
public/assets/enemies/bat.png     ← "bat" sprite
public/assets/tiles/grass.png     ← meadow ground tile
```

`F3` reports how many sprites are still placeholders, and the console lists them by name on startup.

**Sprite sheets are horizontal strips of equal frames.** By default frames are assumed *square*, sized
by the image height — a 128×32 PNG is read as 4 frames of 32×32 with no configuration. Only declare
`frameW`/`frameH` for non-square frames.

## The art pipeline

`docs/art/palette.md` is the single source of truth for colour. Twenty entries, derived from the
shipped character sprites so new art matches what is already on screen. Nothing reads a colour list
from anywhere else — the converters parse that table, and the validator checks against the same
parse. If a piece of art needs a colour the palette does not have, the fix is to add a row there and
say why, never to let one sprite carry its own hues.

Image models cannot draw at 32×32, so the pipeline works the other way round: ask for one big frame
on a chroma-green field, then bring it down.

```bash
node scripts/python.mjs scripts/spritify.py raw.png public/assets/enemies/ghoul.png --size 32 --preview look.png
node scripts/python.mjs scripts/tilify.py   raw.png public/assets/tiles/flagstone.png --size 16
```

`scripts/python.mjs` is just an interpreter launcher: it finds a working Python 3 and hands off. Run
the scripts with `python3` directly if that name works on your machine — it does on macOS and Linux.
It does not on Windows, where `python3` resolves to a Store alias stub that exits non-zero, so the
shim is what keeps `npm run validate:art` runnable on every platform.

`spritify.py` keys out the green, crops to the subject, box-samples to the target size, snaps every
surviving pixel to the palette and redraws the 1px silhouette outline. Quantising *last* is what
holds the style together across batches — the prompt only nudges the model, the remap is binding.
`tilify.py` is the tile counterpart: no keying, no crop, no outline, but a wrap fold across the seam
so a texture repeats without printing a grid over the map. `--preview` on either writes a
nearest-neighbour blow-up worth actually looking at before you commit the result.

**Animations are derived, not generated.** Only the single idle frame comes from a model; every strip
is built from that frame by `scripts/animate.py`, which copies source pixels to whole-pixel offsets.
Generating each frame of a cycle independently does not work — the model redraws the character every
time, so the frames jitter and stop reading as one creature — and deriving them also means a strip
cannot drift off-palette.

```bash
# walk / float / flap / blob are looping cycles; collapse is a one-shot death.
node scripts/python.mjs scripts/animate.py enemies/x.png enemies/x_walk.png  --mode walk --frames 8 --stride 2
node scripts/python.mjs scripts/animate.py enemies/x.png enemies/x_idle.png  --mode blob --frames 4 --squash 1
node scripts/python.mjs scripts/animate.py enemies/x.png enemies/x_death.png --mode collapse --frames 5 --floor 3 --lean 2
```

`collapse` runs 0→1 across the strip instead of sampling a sine, folding the body into the ground
(anchored at its bottom row, so the feet stay where they fell) and slumping it `lean` pixels sideways.
`floor` is how much content height is left in the final frame. Amplitudes are clamped per layer
against that layer's margin to the frame edge, so a request that would slice pixels off the art is
reduced and reported rather than silently cropping — worth reading, since a clamped 2px stride at 8
frames just duplicates poses and a 4-frame strip would have been the same animation for half the size.

One category does not come down that road: the geometric weapon effects — tether beads, chain sparks,
shockwave rings, blood pools, crescent blades. Their drawn edge *is* their collider
(`spriteScaleForRadius` fits the two together by width), so quantising a painted circle back into a
circle loses the one property they have to keep. Those are drawn in code instead, from the same
palette table:

```bash
node scripts/python.mjs scripts/drawfx.py --preview look.png   # redraw them
node scripts/python.mjs scripts/drawfx.py --check              # committed PNGs still match the source
```

Nothing there is exempt from the rules below — the output is validated exactly like hand-drawn art.

Then gate it:

```bash
npm run validate:art
```

For every animation in `sprites.json` that names a `src`, the validator checks that the PNG exists,
that the strip width divides evenly into whole frames, and that every opaque pixel is a palette
member. Each of those failures is otherwise **silent** — a missing PNG falls back to a placeholder
and the game still runs, a ragged strip just cuts the last frame short, and off-palette art only
shows up as a slow drift in how the set looks. It exits non-zero, prints one line per strip and
names the worst stray colours, so `--quiet` gives you just the problems.

Art that predates the pipeline will fail the palette check honestly; that is a real finding about the
art, not noise to be tuned out.

## Content reference

### `sprites.json`

```jsonc
"bat": {
  "origin": [0.5, 0.6],              // anchor within the frame, 0..1
  "anims": {
    "idle": { "src": "enemies/bat.png", "fps": 10 },
    "walk": { "src": "enemies/bat_fly.png", "fps": 12 },
    "hurt": { "src": "...", "loop": false },   // optional
    "death": { "src": "...", "loop": false }   // optional
  },
  "placeholder": { "shape": "bat", "color": "#6b4a8f", "accent": "#241733", "size": 14, "bob": 2 }
}
```

- **`origin`** — where the sprite's world position sits inside the frame. Characters want about
  `[0.5, 0.85]` so their feet land on their position and depth sorting looks right. Projectiles and
  pickups want `[0.5, 0.5]`.
- **`anims`** — only `idle` is required. Any missing state falls back to `idle`, so a one-animation
  enemy is fine. `death` is special: giving an enemy one is what makes it leave a body behind when
  killed instead of vanishing, because the engine only spawns a corpse when the death art is
  genuinely distinct from the idle art. Omitting `anims` entirely is legal and means "placeholder for now": the loader
  generates the strip from `placeholder`, and `validate:art` has nothing to check because no `src` was
  promised. That is how art that has not been drawn yet gets a reserved name.
- **`frameW` / `frameH`** — per-animation, optional. Omit for square frames.
- **`placeholder.shape`** — one of:
  `capsule` (humanoid), `blob`, `bat`, `ghost`, `skull`, `gem`, `coin`, `orb`, `slash`, `knife`,
  `ring`, `square`, `diamond`, `star`.

### `enemies.json`

```jsonc
"skeleton": {
  "name": "Bonepicker",
  "sprite": "skeleton",
  "behavior": "chase",
  "hp": 34, "damage": 11, "speed": 35, "radius": 6,
  "xp": 3,
  "knockbackResist": 0.3,       // 0 = flung freely, 1 = immovable
  "coinChance": 0.05, "coin": 2
}
```

Speeds and distances are **world units per second**; the camera shows 480×270 units. For reference the
player moves at 64.

| `behavior` | How it moves | Extra fields |
| --- | --- | --- |
| `chase` | Straight at you, forever. The baseline swarm. | — |
| `hopper` | Lunges, pauses, lunges. | `hopTime`, `restTime` |
| `charger` | Approaches, telegraphs, then dashes in a locked line. | `windupTime`, `dashTime`, `dashSpeed`, `restTime` |
| `orbiter` | Circles at a set distance instead of closing. | `orbitRadius`, `orbitSpeed` |
| `ranged` | Holds distance and shoots. | `preferredRange`, `shootInterval`, `projectileSprite`, `projectileSpeed`, `projectileDamage`, `projectileRadius`, `projectileLifetime` |
| `drifter` | Fixed heading across the arena, ignores you. | — |
| `exploder` | Closes, stops, flashes, then detonates in an area. | `fuseRange`, `fuseTime`, `blastRadius` |
| `splitter` | Chases; breaks into smaller enemies when killed. | `splitInto`, `splitCount` |

Flags: `elite` and `boss` exempt an enemy from off-screen culling and give it a bigger death effect;
`boss` also shows an arrival banner. `dropsChest: true` drops a chest worth 1–3 upgrades.

**An `exploder` deals no contact damage.** Its `damage` is the blast, spent once when the fuse runs
out — so walking into one is free, and killing it during `fuseTime` cancels the detonation outright.
Detonating is deliberately not a death: it grants no xp, no drops and no kill credit. Stopping the
fuse is the reward, which is what makes an exploder a question about *target priority* rather than
one more health bar. It stands still and flashes for the whole fuse so the threat is answerable.

**A `splitter` may not split into another splitter** — the population would be unbounded, and one
typo should not be able to exhaust the entity pool. That, an unknown `splitInto`, and splitting into
itself each warn and disable the split; the enemy still spawns and fights normally. Children arrive
through the ordinary spawn path, so they carry the difficulty scaling in force when the parent fell,
and they respect the same `maxAlive` cap the wave director does. Only a *killed* splitter splits:
being culled off screen, or cleared by a revive, produces nothing.

`blood` — blood granted on kill (defaults: 1; swarm-tier enemies 0.5; elites and bosses 8). Elites
and bosses additionally drop a Blood Vial worth `vialValue` from `blood.json`.

### `weapons.json`

```jsonc
"knife": {
  "name": "Throwing Knives",
  "sprite": "proj_knife",
  "behavior": "straight",
  "description": "Shown on the level-up card.",
  "weight": 100,                     // relative chance of being offered
  "base": { "damage": 8, "cooldown": 0.85, "count": 1, "pierce": 1, "speed": 195, "lifetime": 1.5, "spread": 0.12 },
  "levels": [
    { "count": 1, "note": "+1 knife" },   // taking level 2 applies this
    { "damage": 4, "note": "+4 damage" }  // level 3, and so on
  ]
}
```

`levels` entries are **additive deltas** on `base`. Level 1 is `base` alone, so max level is
`levels.length + 1` automatically — add an entry and the ceiling rises. `note` is the text the
level-up card shows, so write it for the player.

| `behavior` | Effect | Stats it reads |
| --- | --- | --- |
| `arc` | Melee sweep along your aim. Extra `count` adds a sweep behind, then fans out. | `reach`, `duration`, `knockback` |
| `straight` | Fan of projectiles along your aim. | `speed`, `lifetime`, `pierce`, `spread` |
| `homing` | Projectiles that curve into the nearest enemy. | `speed`, `lifetime`, `pierce`, `turnRate` |
| `aura` | Always-on damaging ring centred on you. | `radius`, `interval`, `knockback` |
| `orbit` | Satellites circling you for `duration`, then a cooldown. | `radius`, `orbitSpeed`, `duration`, `interval` |
| `drop` | Lobs lingering ground hazards; the first favours a nearby enemy. | `spawnRadius`, `radius`, `duration`, `interval` |
| `nova` | Radial burst in every direction. | `speed`, `lifetime`, `pierce` |
| `lightning` | Instant strikes on random enemies on screen, ignoring cover. | `radius`, `duration` |
| `tether` | Cords strung to the `count` nearest enemies, cutting along their whole length. | `reach`, `radius`, `duration`, `count` |
| `chain` | A strike that leaps `count` times, each jump starting where the last landed. | `radius`, `duration`, `spawnRadius` (leap range) |
| `trail` | Lingering ground dropped behind you; `count` widens the wake. | `spawnRadius` (how far behind), `radius`, `duration`, `interval` |
| `slam` | Shockwave rings expanding from `radius` out to `spawnRadius`, hitting bodies as they sweep past. | `radius`, `spawnRadius`, `duration`, `knockback`, `count` |
| `spiral` | Radial shot that keeps turning as it flies, sweeping a spiral. | `speed`, `lifetime`, `pierce`, `turnRate` |

`interval` is the re-hit cadence for anything persistent. `pierce: -1` means unlimited. A weapon whose
`interval` is 0 hits each enemy exactly once per instance — which is what makes `slam` a sweep rather
than a grinder: the ring passes over a body once and is done with it.

`tether` and `chain` pick their own targets, and both only ever choose enemies the camera frames — the
same rule that decides whether damage lands at all.

#### Evolutions

A weapon carried to its ceiling, plus the passive it was built around at *its* ceiling, fuses into a
different weapon the next time you open a chest:

```jsonc
"whip": {
  ...,
  "evolution": { "passive": "widelens", "into": "reap" }
}
```

The far side is an ordinary entry in the same file with `"weight": 0` and `"levels": []` — an empty
`levels` array makes `maxLevel` 1, so it is structurally terminal and can never be offered as an
upgrade. Its `behavior` should match the base's: an evolution is the same weapon, further along.

Chests come from `dropsChest` enemies and from surviving a siege. Exactly one evolution resolves per
chest — if two are ready, the one whose base you have carried longest wins and the other fires on the
next chest — and it costs the chest one of its 1–3 upgrade rolls. The passive is **not** consumed, and
the loadout slot does not move. A full six-weapon loadout evolves exactly like an empty one: the swap
happens in place, so the slot cap is never consulted.

Bad references disable one recipe and nothing else, with a warning naming it: an unknown passive or
target, a weapon evolving into itself, a target that declares its own `evolution` (no chains), or two
bases sharing one target (the later one loses). The weapons themselves keep working.

### `passives.json`

```jsonc
"whetstone": { "name": "Whetstone", "description": "...", "maxLevel": 5, "weight": 100,
               "perLevel": { "might": 0.1 } }
```

`perLevel` values are multiplied by the level and summed across all passives. Valid keys:

| Key | Meaning |
| --- | --- |
| `might` | Weapon damage multiplier (`0.1` = +10%). |
| `area` | Weapon size / radius multiplier. |
| `cooldown` | Attack cooldown; use **negative** to attack faster. |
| `amount` | Flat extra projectiles on every weapon. |
| `projectileSpeed`, `duration` | Multipliers on those weapon stats. |
| `maxHpMul`, `moveSpeedMul`, `magnetMul` | Multiplicative (they scale an existing quantity). |
| `armor` | Flat reduction per hit; damage never drops below 1. |
| `recovery` | Health per second. |
| `growth`, `greed`, `luck` | Experience, gold, and crit/drop rates. |
| `critChance`, `critMult` | Crit rate and crit damage. |
| `bloodGain` | Blood gained from kills (`0.1` = +10%). |
| `pierce` | Extra bodies every projectile passes through. Whole numbers; a weapon whose own `pierce` is `-1` already passes through everything and gains nothing. |

Unknown keys are warned about on startup rather than silently ignored.

Values may be **negative**, which is how a passive charges a price for what it grants (Hollow Vow
sells max health for damage, Grave Iron sells movement for armour). Max health is floored at 1 and
current health follows the cap down when it moves, so the trade can never read as a health bar past
its own end.

### `blood.json`

The blood economy: kills fill a bar; at `threshold` you can spend **all** of it on a heal (Feast,
`Q` or the left HUD button) or a damage burst (Frenzy, `E` or the right HUD button). Effects scale
per blood spent, so cashing out at a full bar is meaningfully stronger.

```jsonc
{
  "barMax": 100, "threshold": 50,
  "intakePerSec": 12,        // anti-farm cap on kill income; Blood Vials bypass it
  "decayPerSec": 1.5,        // above the threshold, blood decays…
  "decayGrace": 4,           // …after this many seconds without a kill
  "healPerBlood": 0.005,     // Feast: fraction of max HP restored per blood spent
  "vialValue": 25,           // blood granted by an elite/boss Blood Vial
  "frenzy": {
    "baseDuration": 3, "durationPerBlood": 0.06,
    "mightMult": 1.4, "cooldownMult": 0.75, "moveSpeedMult": 1.15,
    "novaDamage": 30, "novaRadius": 80     // burst fired the instant Frenzy starts
  }
}
```

### `waves.json`

The pacing of an entire run.

```jsonc
"default": {
  "victorySeconds": 900,
  "maxAlive": 400,                    // hard cap on concurrent enemies
  "scaling": {
    "hpPerMinute": 0.2,               // enemy health, per elapsed minute
    "damagePerMinute": 0.05,
    "speedPerMinute": 0.012,
    "hpExponent": 1.05                // >1 makes late health outpace weapons
  },
  "waves": [
    { "at": 0,   "spawnInterval": 1.3, "perSpawn": 2, "enemies": [{ "type": "bat", "weight": 10 }] },
    { "at": 45,  "spawnInterval": 1.1, "perSpawn": 3, "enemies": [
        { "type": "bat", "weight": 8 }, { "type": "swarmling", "weight": 5 } ] }
  ],
  "elites":  { "startAt": 150, "interval": 60, "type": "brute", "count": 1, "countGrowthPerMinute": 0.15 },
  "bosses":  [ { "at": 240, "type": "warden", "count": 1 } ],
  "sieges":  [ { "at": 60, "type": "zombie", "count": 4, "duration": 20 } ]
}
```

Each `waves` entry takes over at `at` seconds and fully replaces the previous one. Enemies arrive in
bursts from one direction just off screen, rather than evenly surrounding you.

**`sieges`** opens a window at `at` seconds for `duration` seconds, during which `count` attackers
spawn off screen and head for the map's structures instead of for you. Overlapping windows merge into
one, and the reward resolves once.

Hold the window with **at least one** structure alive and that survivor drops a chest and a coin
worth its `gold`, at its own feet — so walking back to the wall you held is the loop. Lose every
structure and you simply get nothing: the penalty is already paid in what you lost, and player death
stays the only fail state.

Name a touch-range attacker (`chase`, `hopper`, `charger`). Siege attackers park at the wall and
swing, which a `ranged` or `drifter` enemy has no way to do — name one of those and it still spawns,
but as an ordinary player-chaser, with a warning at load naming the offending entry. Sieges on a map
with no structures degrade the same way rather than breaking: the attackers just hunt you.

`waves.json` ships two tables today — `default` (no sieges) and `bastion` (six).

### `characters.json`

Starting stats and starting weapon. Same stat names as the passive table, but as **absolute base
values** rather than deltas (`might: 1` is normal damage, `cooldown: 1` is normal speed). `revives`
grants a full-health second chance that also clears nearby enemies.

An `unlock` block prices the character; omit it and the character is free. The first character in the
file is always free regardless — a paywalled slot 0 would soft-lock a fresh save.

```jsonc
"unlock": {
  "gold": 2500,
  "requirement": {
    "id": "level",                          // what to measure — see the table below
    "target": 20,                           // how much of it
    "mode": "best",                         // "best" = in one run, "sum" = over every run ever
    "label": "Reach level 20 in one run"    // printed on the locked card
  }
}
```

Both gates apply: the feat has to be earned **and** the price paid, in that order. `requirement` is
optional — leave it out and gold alone unlocks the character.

| `id` | scores |
| --- | --- |
| `kills` | enemies slain |
| `level` | level reached |
| `picks` | weapon/passive upgrades taken |
| `gold` | gold banked |
| `survive` | seconds survived |
| `frenzy` | times Frenzy was entered |
| `feast` | health recovered by Feast |
| `siege` | sieges repelled |
| `evolve` | weapons awakened |
| `walls` | 1 for a siege held with no structure lost, else 0 |
| `victory` | 1 for a run won, else 0 |

Only a **finished** run scores — quitting mid-run records nothing, exactly as it banks no gold. An
unknown `id` or a non-positive `target` warns and drops the requirement, leaving the price standing;
it never makes a character harder to reach than the JSON asked for. The ids are whitelisted by
`UnlockSignal` in `content.ts` and emitted by `featDelta` in `services/feats.ts` — adding one means
touching both, and `feats.test.ts` fails if they drift apart.

#### Active abilities

An optional `ability` block gives the character something to press. It is cast with `Space` (or the
round HUD button) and is entirely separate from the automatic weapons.

```jsonc
"ability": {
  "name": "Crimson Cleave",
  "description": "A ring of spectral blades erupts outward.",
  "icon": "ability_cleave",        // HUD icon, through the sprites.json placeholder pipeline
  "sprite": "fx_slash",            // sprite for whatever the ability spawns
  "kind": "nova",
  "cooldown": 18,                  // seconds; see the guardrail below
  "duration": 5,                   // buff window / dash iframes / volley burst length
  "params": { "damage": 30, "count": 10, "speed": 150, "radius": 24 },
  "mods": { "armor": 2 }           // buff kind only
}
```

| `kind` | What it does |
| --- | --- |
| `nova` | Radial burst of projectiles around you. |
| `volley` | A paced burst of homing projectiles across `duration`. |
| `zone` | One large lingering hazard at your feet. |
| `buff` | Applies `mods` for `duration`, plus an instant `params.heal`. |
| `dash` | Instant reposition with invulnerability frames and a damaging trail. |

`params` keys: `damage`, `count`, `speed`, `pierce`, `knockback`, `radius`, `interval`, `lifetime`,
`turnRate`, `distance`, `trailCount`, `heal`. Each kind reads the subset that applies to it.

**Ability scaling is deliberately narrow**, and this is a design guardrail rather than an oversight:
damage scales with might, sizes with area, lifetime with duration, and *nothing else*. The `cooldown`
is outside the stat system entirely — neither the cooldown passive nor Frenzy's `cooldownMult` ever
shortens it, so no build can turn an active into a second automatic weapon.

An unknown `kind` or a malformed block costs that character its ability, with a warning. Everything
else about them keeps working.

### `structures.json`

Defendable objectives for siege maps. A map that ships a `structures` array is a siege map; one that
doesn't is an ordinary survival map, and the picker derives its `DEFEND THE WALLS` / `SURVIVE` tag
from exactly that, so it can never advertise a siege that doesn't happen.

```jsonc
"tower": {
  "name": "Watchtower",
  "sprite": "structure_tower",
  "hp": 140,
  "radius": 10,
  "solid": true,          // blocks movement (gates); false walks through (shrines)
  "gold": 30,             // the siege payout, if this is the survivor that pays it out
  "range": 170,           // > 0 arms it — omit for a passive wall
  "shootInterval": 1.4,
  "projectileDamage": 14,
  "projectileSpeed": 190,
  "projectileLifetime": 1.2,
  "projectileSprite": "proj_bolt"
}
```

**`range` is the whole armed/unarmed switch.** Omit it and the structure never shoots; gates and
shrines leave out every field below it and behave exactly as they did before towers existed.

A tower's bolts are **fixed content**: they are built from the defaults and this entry, never from
your stats. No passive, weapon level or Frenzy multiplier reaches them — the moment a tower scales
with the build, it stops being terrain and starts carrying the run.

An empty `structures.json` is legal, unlike an empty `enemies.json`. Structures are an optional
per-map feature and a game without them has to keep working.

### `meta.json`

The Sanctum: permanent, gold-bought stat ranks that apply to every future run.

```jsonc
"bloodthirst": {
  "name": "Bloodthirst",
  "description": "+5% might per rank. The hunger sharpens the blade.",
  "costs": [100, 250, 600, 1400, 3000],   // cost of rank r+1 is costs[r]
  "perRank": { "might": 0.05 }
}
```

**`costs.length` is the max rank** — append a number and the ceiling rises, exactly like a weapon's
`levels`. `perRank` takes the same stat keys as `passives.json`, plus `revives`. Values stack
additively with passives through the same accumulator, so a Sanctum rank and a passive level are the
same kind of number.

A node with no valid costs is skipped and an unknown `perRank` key is dropped, both with a warning —
a typo costs one upgrade, not the Sanctum.

### `audio.json`

Every sound in the game, keyed by the event that fires it. There are **no audio files**: each entry
is a one-oscillator blip synthesized on the fly, which is why the game is audible before any real
SFX exist.

```jsonc
"player:levelup": { "wave": "triangle", "freq": 520, "freqEnd": 1040,
                    "duration": 0.3, "volume": 0.5, "throttleMs": 200 }
```

`wave` is `sine` / `square` / `sawtooth` / `triangle`. `freqEnd` sweeps away from `freq` (equal means
a flat tone), `duration` is clamped to 0.02–2s, `volume` to 0–1, and `throttleMs` is that sound's
minimum gap — `enemy:killed` fires hundreds of times a minute and needs one.

The key must name a real game event; anything else is skipped with a warning listing it. Sounds that
are over budget or inside their throttle are **dropped, never queued**, the same policy the particle
pools use — audio that lags behind the action is worse than audio that thins out.

## Designing maps

Maps live in `src/content/maps/*.json`. **Any file you add there is picked up automatically** and
appears in the arena picker on the title screen — the filename is the map id.

Three fields exist only for that picker, and all three are optional:

| field | effect |
|---|---|
| `name` | Card title. Falls back to the map id. |
| `blurb` | One line under the title: what this place asks of you. |
| `order` | Sort key, ascending. **The first map is also the default run** — a player who presses start without reading gets it. Omit it and the map sorts after every ordered one, alphabetically. |

The `DEFEND THE WALLS` / `SURVIVE` tag on each card is *not* authored: it is derived from whether the
map ships a `structures` array, so it can never advertise a siege the map does not run.

```jsonc
"structures": [
  { "type": "gate",  "x": -240, "y": 0 },     // type indexes structures.json
  { "type": "tower", "x": -190, "y": -76 }
]
```

Hand-placed, like `props`. Pair it with a wave table that declares `sieges` — the structures are what
gets attacked, the wave table is what schedules the attack, and each is inert without the other.

Two ground modes:

**`scatter`** — infinite, procedurally tiled from a weighted tileset. Deterministic, so it never
shimmers or repeats visibly. This is what an endless arena wants.

```jsonc
{
  "name": "Moonlit Meadow",
  "blurb": "Open ground under a full moon.",       // picker line
  "order": 1,                                      // picker position; first = default run
  "tileSize": 16,
  "ground": { "mode": "scatter", "patchScale": 7 }, // patchScale: side of one material area, in tiles
  "bounds": null,                                  // null = unbounded
  "spawnPoint": [0, 0],
  "waves": "default",
  "tileset": [
    { "src": "tiles/grass.png",   "weight": 26, "placeholder": { "color": "#27351f", "detail": 0.5 } },
    { "src": "tiles/grass_b.png", "weight": 14, "placeholder": { "color": "#2c3b23", "detail": 0.7 } }
  ],
  "decor": [
    { "sprite": "tree",   "density": 0.055 },      // scattered, depth-sorted
    { "sprite": "rock",   "density": 0.03, "solid": 8 },    // solid = collision radius; needs bounds
    { "sprite": "flower", "density": 0.09, "flat": true }   // flat = always drawn under entities
  ],
  "props": [
    { "sprite": "grave", "x": -180, "y": -140, "solid": 7 } // hand-placed; solid = collision radius
  ]
}
```

**`patchScale`** decides whether the tileset reads as *material* or as *static*. Omit it (or use 0)
and every tile is drawn independently, which is right for a tileset that is all one material — the
four greens of `meadow`, the four stones of `crypt`. Set it and the tileset is laid down in
contiguous areas instead, roughly `patchScale` tiles across, which is what a mixed tileset needs:
without it, grass and bare earth shuffle per cell into a checkerboard. **Patches change where a tile
lands, never how much of it there is** — the `weight` shares are preserved to within a fifth of a
percentage point, so the two settings are interchangeable without re-tuning weights.

**`solid` on decor needs `bounds`.** Scattered decor is generated from a hash as the camera moves,
but collision is resolved against a flat array that has to exist up front, so the field is only
honoured on a bounded map, where the cell range is finite and can be swept once at load. On an
unbounded map it warns and is ignored — hand-place that obstacle in `props` instead. Every solid is
scanned per entity per tick, so keep the total in the low hundreds; `ruins` runs 97.

**`grid`** — a hand-authored tile map. `tiles` is row-major, **1-based** into `tileset`; `0` is void.
A tileset entry with `"solid": true` blocks movement for both you and enemies. Bounds default to the
grid extent. See `maps/arena.json` for a working 20×14 example.

```jsonc
{
  "tileSize": 32,
  "ground": { "mode": "grid" },
  "gridWidth": 20, "gridHeight": 14,
  "tileset": [
    { "src": "tiles/floor.png", "placeholder": { "color": "#2e2a35" } },
    { "src": "tiles/wall.png",  "solid": true, "placeholder": { "color": "#15131c" } }
  ],
  "tiles": [ 2,2,2, /* … gridWidth × gridHeight entries … */ ]
}
```

A mismatched tile count is reported as a console warning with the number expected, and the missing
entries render as void rather than crashing.

## Architecture

```
src/
  core/      loop (fixed timestep), input, seeded rng, math, event bus, placeholder art
  ecs/       entity store — structure-of-arrays over typed arrays
  render/    renderer, camera, sprite loading, tilemap, particles & damage numbers
  gameplay/  player, enemies, spawn director, weapons, abilities, blood, structures,
             pickups, damage, upgrades, content loader
  ui/        HUD and menus (DOM), style.css
  services/  save/wallet, Sanctum, daily objectives, feats, coaching, telemetry, storage
  platform/  device concerns: audio, haptics, touch, app lifecycle
  content/   ← all the JSON above
public/assets/  ← all the PNGs
```

The bottom two directories are kept strictly downstream of the game. **The engine — `core`, `ecs`,
`gameplay`, `render` — may not import `services/` or `platform/`**, and `platform/` may reach only
for `core` types and content JSON. Both rules are enforced by a test that reads the source tree, so
they fail the build rather than eroding. What flows between them is events: the sim emits, and the
HUD, audio, haptics, daily tally, feats, coach and telemetry all subscribe.

A few decisions worth knowing before you extend it:

- **Fixed 60Hz simulation, interpolated rendering.** Gameplay is framerate-independent and
  deterministic given a seed; the renderer lerps between ticks so high-refresh displays stay smooth.
- **Fixed 480×270 internal buffer**, nearest-neighbour upscaled to the window. Pixel art stays crisp,
  and every player sees exactly the same amount of the arena — how much you can see is a difficulty
  knob in this genre, so it shouldn't depend on monitor size.
- **Structure-of-arrays entities**, not objects. Hot data lives in parallel typed arrays so the inner
  loops run over contiguous memory; this is what lets several thousand entities coexist.
- **Spatial hash broadphase**, rebuilt twice per tick — once before enemies move for crowd separation
  and contact damage, once after so weapons resolve against where enemies actually are.
- **UI is DOM over canvas.** Text stays crisp instead of being upscaled with the sprites, and the whole
  interface restyles from `ui/style.css`. Two scales are published: `--scale` (one game pixel, for
  the rare rule that has to agree with the art) and `--ui-scale` (the chrome unit everything else is
  sized in — the art scale clamped so controls stay thumb-sized on a phone and the furniture stops
  growing on a 4K monitor). Inside the band they are the same number.
- **Entity destruction is deferred** to the end of the tick. Systems may read a dead entity safely, but
  none tolerate the id lists compacting underneath them.
- **The save is written through an async adapter**, chosen once at boot: Capacitor Preferences on a
  device, `localStorage` on the web, memory in tests. A WebView's `localStorage` is cache rather than
  storage and does get evicted, so on a device the wallet is lifted onto real native storage once,
  keeping the source copy as a fallback.

### Tests

`npm test` is 20 files and 439 tests, and roughly splits in two.

The simulation half drives the real gameplay systems in the real tick order, with only the two
genuinely browser-bound dependencies stubbed (sprite table, tile map). It plays a full fifteen-minute
run headlessly and asserts the things that are painful to notice by hand: entity counts stay bounded,
progression doesn't stall, every weapon behaviour actually scores kills, slot caps hold, and recycled
entity ids invalidate stale handles. A few tests pin exact numbers from a fixed seed — banked gold,
for one. Those are balance tripwires: if one moves, the economy moved, and the number wants reading
before it wants updating.

The other half are **gates**. They parse the source tree or `style.css` as text and fail the build on
an architectural violation rather than a behavioural one: the two isolation rules above, the save
never leaving the device, one CSS rule and no others being allowed to spend the art unit, every
cross-element clearance staying composed rather than measured, and each UI layer composing device
safe-area insets in its own coordinate frame.

Rendering itself and the menu DOM need a browser and are checked with `npm run dev`.

## Not built yet

Deliberate gaps, in rough order of how much they'd add:

- **Enemy variety in the late game** — the last few wave stages reuse earlier enemies at higher
  multipliers rather than introducing new threats.
- **Real audio.** Every sound is a synthesized oscillator blip (see [`audio.json`](#audiojson)). The
  mapping from events to sounds is content, so recorded SFX would slot in behind it.
- **Music.** None.
- **Android.** The Capacitor shell and the native storage adapter are both platform-agnostic, but
  only the iOS target is set up and built.
