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
| `npm test` | Headless simulation tests (see [Tests](#tests)). |
| `npm run typecheck` | Types only. |
| `npm run validate:art` | Check every sprite strip against the palette and frame rules (see [The art pipeline](#the-art-pipeline)). |

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows / left stick | Move. Weapons fire automatically. |
| `Esc` | Pause. |
| `1`–`9`, click, or arrows + `Enter` | Choose on any menu. |
| `F3` | Debug overlay: fps, entity counts, difficulty multipliers. |

Your **last movement direction** is your aim. Directional weapons (whip, knives) fire along it, and it
persists while you stand still — letting go of the keys doesn't swing your aim.

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
python3 scripts/spritify.py raw.png public/assets/enemies/ghoul.png --size 32 --preview look.png
python3 scripts/tilify.py  raw.png public/assets/tiles/flagstone.png --size 16
```

`spritify.py` keys out the green, crops to the subject, box-samples to the target size, snaps every
surviving pixel to the palette and redraws the 1px silhouette outline. Quantising *last* is what
holds the style together across batches — the prompt only nudges the model, the remap is binding.
`tilify.py` is the tile counterpart: no keying, no crop, no outline, but a wrap fold across the seam
so a texture repeats without printing a grid over the map. `--preview` on either writes a
nearest-neighbour blow-up worth actually looking at before you commit the result.

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
  enemy is fine.
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

Flags: `elite` and `boss` exempt an enemy from off-screen culling and give it a bigger death effect;
`boss` also shows an arrival banner. `dropsChest: true` drops a chest worth 1–3 upgrades.

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

`interval` is the re-hit cadence for anything persistent. `pierce: -1` means unlimited. A weapon whose
`interval` is 0 hits each enemy exactly once per instance.

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

Unknown keys are warned about on startup rather than silently ignored.

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
  "bosses":  [ { "at": 240, "type": "warden", "count": 1 } ]
}
```

Each `waves` entry takes over at `at` seconds and fully replaces the previous one. Enemies arrive in
bursts from one direction just off screen, rather than evenly surrounding you.

### `characters.json`

Starting stats and starting weapon. Same stat names as the passive table, but as **absolute base
values** rather than deltas (`might: 1` is normal damage, `cooldown: 1` is normal speed). `revives`
grants a full-health second chance that also clears nearby enemies.

## Designing maps

Maps live in `src/content/maps/*.json`. **Any file you add there is picked up automatically** and
appears in the arena picker on the title screen — the filename is the map id.

Two ground modes:

**`scatter`** — infinite, procedurally tiled from a weighted tileset. Deterministic, so it never
shimmers or repeats visibly. This is what an endless arena wants.

```jsonc
{
  "name": "Moonlit Meadow",
  "tileSize": 16,
  "ground": { "mode": "scatter" },
  "bounds": null,                                  // null = unbounded
  "spawnPoint": [0, 0],
  "waves": "default",
  "tileset": [
    { "src": "tiles/grass.png",   "weight": 26, "placeholder": { "color": "#27351f", "detail": 0.5 } },
    { "src": "tiles/grass_b.png", "weight": 14, "placeholder": { "color": "#2c3b23", "detail": 0.7 } }
  ],
  "decor": [
    { "sprite": "tree",   "density": 0.055 },      // scattered, decorative, depth-sorted
    { "sprite": "flower", "density": 0.09, "flat": true }   // flat = always drawn under entities
  ],
  "props": [
    { "sprite": "grave", "x": -180, "y": -140, "solid": 7 } // hand-placed; solid = collision radius
  ]
}
```

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
  gameplay/  player, enemies, spawn director, weapons, pickups, damage, upgrades, content loader
  ui/        HUD and menus (DOM), style.css
  content/   ← all the JSON above
public/assets/  ← all the PNGs
```

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
  interface restyles from `ui/style.css`. `--scale` is published each frame so UI sized in
  `calc(var(--scale) * Npx)` grows with the art.
- **Entity destruction is deferred** to the end of the tick. Systems may read a dead entity safely, but
  none tolerate the id lists compacting underneath them.

### Tests

`npm test` drives the real gameplay systems in the real tick order, with only the two genuinely
browser-bound dependencies stubbed (sprite table, tile map). It plays a full fifteen-minute run
headlessly and asserts the things that are painful to notice by hand: entity counts stay bounded,
progression doesn't stall, every weapon behaviour actually scores kills, slot caps hold, and recycled
entity ids invalidate stale handles.

Rendering and menus are not covered — they need a browser.

## Not built yet

Deliberate gaps, in rough order of how much they'd add:

- **Weapon evolutions** — the union of a maxed weapon and a passive into a stronger one. The data model
  already supports it; it needs an `evolution` block in `weapons.json` and a check on chest pickup.
- **Meta-progression** — gold is tracked and displayed but doesn't persist or buy anything yet.
- **Audio.** No sound at all.
- **Enemy variety in the late game** — the last few wave stages reuse earlier enemies at higher
  multipliers rather than introducing new threats.
