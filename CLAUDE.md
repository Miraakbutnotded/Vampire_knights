# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server at http://localhost:5173 (content JSON hot-reloads)
npm run build      # tsc --noEmit, then vite build to dist/
npm run typecheck  # types only
npm test           # vitest run — headless simulation tests
npm run test:watch # vitest watch mode
npx vitest run -t "every weapon"   # single test by name pattern
npm run validate:art               # sprite strips vs. the canonical palette and frame rules
npm run cap:sync                   # build, then copy dist/ + regenerate the SPM manifest for iOS
npm run verify:ios                 # cap:sync, then actually compile and link the iOS target
```

There is no linter configured; `tsc` is the gate. `npm test` is 20 files / 439 tests, all green —
a red one is a regression, never a known failure to wave through. Most of them are *gates* rather
than feature tests: they parse the source tree or the stylesheet and fail the build on an
architectural violation (see Tests).

`cap:sync` and `verify:ios` are **not** the same gate. `cap sync` rewrites
`ios/App/CapApp-SPM/Package.swift` and copies web assets without ever invoking the Swift toolchain,
so a plugin can appear in the manifest while the target no longer builds — "SPM picked it up" is not
"it compiles". `verify:ios` runs `xcodebuild` for a device Release with signing off, which is the
only thing that answers the second question. It needs macOS and Xcode, so it is the one gate a
non-Mac session cannot run; say so plainly rather than inferring the build from a successful sync.

## What this is

A Vampire Survivors-style arena game: custom TypeScript engine on Canvas2D, no framework. The only
runtime dependencies are the Capacitor packages that ship it as an iOS app, and every one of them is
reached through a dynamic import behind a fallback, so the web build and the headless tests run
identically when none of them resolve. All game content (enemies, weapons, passives, characters,
abilities, waves, maps, structures, blood, meta) is data-driven JSON in `src/content/`. **The README
documents every content JSON format in detail — read it before editing content files.** This file
covers the code architecture instead.

## Architecture

### Ownership and flow

`src/main.ts` `boot()` → `SpriteTable.load()` and `selectStorage()` → `meta.load()` +
`telemetry.load()` (together) → `meta.rollDaily()` → constructs `Game` (`src/game.ts`) → wraps it in
`Loop` (`src/core/loop.ts`) → attaches the platform drivers (audio, haptics, lifecycle). There are
**no module-level singletons**: all state (World, Run, Ctx, Input, Renderer, Hud, Screens, EventBus,
Rng, Spawner) lives on the `Game` instance. The HMR `dispose()` wiring in main.ts is load-bearing —
removing it stacks loops, duplicates input listeners and leaks an AudioContext on every hot reload.

**main.ts is the only module allowed to choose a `StorageAdapter`** — services take one, they never
construct one. Every native bridge it touches races a 2.5s deadline and *loses by default*: a plugin
that never answers is silence, not a rejection, and unbounded waiting means a black screen on boot.

`Game` owns a state machine: `title | loading | playing | levelup | paused | dying | results |
sanctum`. `update(dt)` runs `tick()` only in `playing` and routes `dying` to `updateDying` — every
other state freezes the sim, which is how pause and menus work. ESC closes pause only; on the
level-up draft it is deliberately ignored. **`this.state` is assigned in exactly one place,
`setState()`**, which also latches the frame gate; `repaint.test.ts` scans game.ts's source and
fails if a second assignment or a raw state entry appears.

**`gameplay/` is a DAG and should stay one.** The one place that pressures it is enemy spawning:
`enemies.ts` imports `damage.ts` for contact damage, while `damage.ts` has to spawn enemies when a
splitter breaks apart. `spawnEnemy` therefore lives in its own leaf, **`spawn.ts`** (imports content
and the ECS, nothing else in `gameplay/`), so the chain reads `enemies → damage → spawn` instead of
closing a cycle. `enemies.ts` re-exports it, so call sites don't care.

Gameplay systems (`src/gameplay/*.ts`) are stateless free functions `fn(ctx: Ctx, dt)` (exceptions:
`Run` and `Spawner` classes). `Ctx` (`src/gameplay/context.ts`) is the single shared bag, built once
in Game's constructor and mutated in place between runs. Gameplay never imports `game.ts` and never
calls UI directly — it emits typed events on `ctx.bus` (`EventBus<GameEvents>`, vocabulary in
`src/core/events.ts`); UI subscribes.

### The tick (order is load-bearing)

Fixed 60Hz simulation (`FIXED_DT`), interpolated rendering. Per frame: `beforeFrame` →
`update(FIXED_DT)` ×0..5 → `render(alpha)` → `afterFrame`. **`update` may run zero or several times
per frame**, so edge-triggered input (menu keys, pause, F3) is handled only in `beforeFrame`.

`Game.tick()` order (the test harness in `simulation.test.ts` duplicates it verbatim — change both):

1. `run.time += dt`, then `difficultyAt()` → writes `ctx.hpScale/damageScale/speedScale` (consumed at spawn time only; existing enemies never rescale)
2. `world.snapshotPositions()` — first, so the renderer can lerp prev→current by alpha
3. `enemyHash.build()` **rebuild #1** (pre-movement: crowd separation + contact damage)
4. `updatePlayer` → `spawner.update` → `updateEnemies`
5. `enemyHash.build()` **rebuild #2** (post-movement: all weapon/damage resolution — new damage systems go after this)
6. `updateAbility` → `updateEnemyProjectiles` → `updateWeapons` → `updatePlayerProjectiles` → `updateHazards` → `updateStructures`
7. `pickupHash.build()` → `updatePickups` → `updateBlood` → `updateCorpses` → fx → camera
8. `world.flush()` — **last, exactly once**
9. Deferred state changes, in this precedence: a death mid-tick already moved us to `dying` and
   outranks both others (`return`), then level-up if `run.pendingLevelUps > 0`, then victory

Two placements in that list are arguments, not accidents. `updateAbility` runs *before*
`updateEnemyProjectiles` so dash i-frames granted this tick already cover this tick's enemy fire.
`updateBlood` runs *after* `updatePickups` so every kill and collection for the tick has landed
before intake, decay and the latched Feast/Frenzy spend are resolved.

Input the sim must not miss is **latched** on `Ctx` by the frame side and consumed by the sim
(`ctx.bloodIntent`, `ctx.abilityQueued`). A frame can run `update` zero times, so a press written
straight into a system would be dropped; menus clear the latches so no cast survives a pause.

### ECS contracts (`src/ecs/world.ts`, `components.ts`)

Structure-of-arrays: every component is a parallel typed array of length `MAX_ENTITIES` (16384),
indexed by entity id. Rules that hold everything together:

- **Deferred destruction**: `world.destroy(id)` only marks dead; the id stays readable until
  `flush()` compacts kind lists and recycles it. Safe to destroy mid-iteration; never call `flush()`
  from inside a system.
- **Handles, not ids, across ticks**: ids are recycled with a generation counter. Store
  `world.handleOf(id)`, re-resolve with `world.resolve(handle)` (returns -1 if gone). Sanctioned
  exception: the `owner` array stores raw ids (owners outlive attachments).
- **Spawns use `world.place(id, x, y)`** — it sets both current and prev position; writing `x/y`
  directly makes the sprite streak from (0,0).
- **New component array ⇒ new reset line in `World.create()`**, or recycled ids leak stale values.
  `create()` returns -1 at capacity; every spawn site must treat -1 as "skip".
- `world.list(kind)` returns a live readonly view — never mutate or retain across ticks.
- Knockback lives in `kbx/kby`, not `vx/vy` (AI overwrites velocity every tick).
- Pierce/aura dedup goes through `world.registerHit(source, target)` / `clearHits()`. Any new damage
  source must use it.
- `aiPhase` is polymorphic by Kind (charger phase / projectile turnRate+homing flag / pickup magnet
  latch) — don't repurpose it on an existing Kind.
- Enums are `const object + type union` (Kind, Comp, Team, Behavior, AnimState), not TS `enum`.
  `KIND_COUNT` in world.ts must match the Kind values in components.ts — 8 today, `Kind.Corpse`
  being the newest.

### Blood, abilities, sieges

Three systems sit beside weapons and share one rule: **nothing they add may reach `run.stats` per
tick**. `Run.recomputeStats()` has exactly three sources — meta mods, passives, and an active buff
ability's `abilityMods` — and runs only on a state change (loadout, buff start, buff expiry).

- **Blood** (`blood.ts`, `blood.json`) — kills fill a bar; at `threshold` the whole bar is spent on
  Feast (heal) or Frenzy (timed buff + one-tick nova). Frenzy folds in **read-side** off
  `run.frenzyT`, never written into `run.stats`. Every timer advances on sim `dt`; the anti-farm
  intake window is keyed to `run.time` crossing a whole second, never to wall clock.
- **Abilities** (`abilities.ts`) — one active per character, off `characterDef().ability`. Scaling is
  a deliberately narrow guardrail: damage ×might, sizes ×area, lifetime ×duration, and nothing else.
  The ability's own cooldown lives raw on `AbilityDef`, immune to cooldown scaling. Casts ride
  `spawnProjectile`/`spawnHazard` so every downstream updater works unchanged.
- **Structures** (`structures.ts`, `structures.json`) — `Kind.Structure`, static, `Team.Player`, with
  HP; a map that ships a `structures` array is a siege map and the picker derives its tag from that.
  Towers shoot from `TOWER_STATS`, built from `WEAPON_STAT_DEFAULTS` and **never** `effectiveStats()`
  — a passive or Frenzy multiplier reaching a tower turns terrain into part of the build.

### Corpses (`Kind.Corpse`)

A killed enemy leaves a body that plays a death animation and is then gone —
`spawnCorpse` (spawn.ts) copies position, sprite and facing off the dying entity while it is still
readable, and `updateCorpses` (enemies.ts) is the **only** system that touches the Kind. That is the
whole reason it is its own Kind rather than a flag on an enemy: the broadphase, contact damage,
weapon targeting and the wave cap all keep ignoring it for free, by iterating a list it is not on.

Bodies are cosmetic — no collider, no health, no team — and carry a negative `drawBias` so they lie
under anything still standing on the same row. `spawnCorpse` returns -1 when the sprite has no death
art of its own (`sprites.anim` resolves Death to the *same object* as Idle in that case, which is how
both this and `game.ts` detect it), because a frozen standing sprite on the floor reads as a bug.
Culling and the revive nuke both bypass it, so only a real kill leaves a body.

### Frame gate (`src/render/repaint.ts`)

The world only advances in `playing` and `dying`, so a repaint in any other state reproduces pixels
already on the canvas. `FrameGate.claim()` skips those frames. It is a **latch** (`enter()` on every
state entry), not a `state !== lastPainted` comparison, because a chained level-up draft re-enters
`levelup` without leaving it and the second draft's frame carries real HUD changes.

### Input (`src/core/input.ts`)

`Input.wasPressed(code)` is edge-triggered **and consuming** — first caller per frame wins, later
callers get false, so system call order matters. Gamepad buttons are injected as synthetic
'Enter'/'Escape' presses; menu code only checks keyboard codes. Menus poll via
`Screens.handleInput(input)` from the loop — never add keydown listeners to screen elements or keys
double-fire.

### Two RNG streams — never mix

Gameplay randomness: `ctx.rng` (seeded per run; a run is reproducible from its seed, and headless
tests depend on it). Cosmetic randomness (particles, damage-number jitter): the shared `fxRng`
export. `Math.random()` in a gameplay path breaks determinism and test reproducibility.

### Spatial hash (`src/gameplay/collision.ts`)

128×128 bucket grid that **wraps coordinates** — query results are candidates only; every consumer
must do an exact distance test plus `world.isAlive`. Queries cap at `MAX_QUERY_RESULTS` (512) into
shared scratch buffers: `ctx.scratch` for outer loops, `ctx.scratchInner` for a query nested inside
another query's iteration — never share one buffer between nested queries.

### Rendering (`src/render/`)

World renders into a fixed 480×270 offscreen buffer, nearest-neighbour upscaled (integer factor when
≥1). Pixel-crispness invariants: positions rounded to whole pixels in `queue()`, camera rounded in
`begin()`, `imageSmoothingEnabled=false` re-set defensively after any canvas resize. Interpolation
happens in `game.ts` (`lerp(prevX, x, alpha)`) before `renderer.queue()` — the renderer never sees
raw sim positions. Draw order per frame: ground → particles → depth-sorted sprite queue
(`flushSprites()` once, after all queues; depth defaults to y for feet-on-ground sorting) → damage
numbers → `present()`.

Zero-allocation-per-frame is a core constraint: DrawList and Fx pools are fixed-capacity SoA typed
arrays that silently drop overflow (768 particles, 160 numbers). Don't replace with growable arrays.
In-world text uses the hand-built 3×5 pixel font in `fx.ts` (canvas `fillText` is blurry at 480×270);
all other text is DOM.

UI is DOM over canvas, and it is sized in **two** units, both published by `Game.syncUiMetrics()`
only when the viewport changes. `--u` (from `--scale`) is one game pixel; `--ui` (from `--ui-scale`,
computed by `uiScale()` in `src/ui/metrics.ts`) is one chrome unit — the same number clamped to
`[2, 4.5]`, with the floor raised to 3 on touch. Inside the band they are identical, so a desktop
window renders the same either way; they part company only on a phone (chrome pinned to 3 while the
art sits near 1.5) and above 2160px wide (art keeps growing, chrome stops).

**`--u` is an allowlist of exactly one rule, `.xp-track`** — the four-game-pixel band that frames the
world. Everything else, hairlines and icon canvases included, is chrome and uses `--ui` through the
semantic tokens in `:root` (`--text-*`, `--hair`, `--edge-inset`, `--pad-*`). `src/ui/metrics.test.ts`
fails the build on any other rule spending `--u`, so a new world-anchored element joins the allowlist
deliberately. Touch styling hangs off a `.coarse` class the constructor writes from
`navigator.maxTouchPoints` — never `@media (pointer: coarse)`, which is a second source of truth that
disagrees with the JS on hybrid laptops.

**Three DOM layers**, in paint order (`index.html`, wired through `UiRoots` in game.ts): `#touch`
(joystick + pause), `#ui` (HUD + debug), `#menu` (the five screens). Only `#ui` is clipped and
translated to the letterboxed play box, because only its contents are anchored to the world — so
only its children compose device insets as `max(design, safe − offset)`. Children of `#touch` and
`#menu` span the viewport and compose them **directly** (`max(design, safe)`); using the `#ui` idiom
there under-insets a notched phone by the width of the letterbox bar, and `src/ui/layout.test.ts`
gates it.

Cross-element clearances in the stylesheet are **composed, never measured** — `--cluster-w`,
`--pause-reserve`, `--bottom-band`, `--hud-center-h`. Each is built from the tokens of the things it
has to clear, so resizing a control moves everything that reserves space against it in the same
edit; layout.test.ts fails the build if one of them turns back into a literal. Every menu is built
from two regions (`shell()` in screens.ts): `.screen-aside` holds the reading matter and no
focusable, `.screen-main` holds everything actionable. They stack into one centred column normally
and become lanes under `@media (max-height: 560px)` — a phone in landscape. That media query asks
about vertical room, which is a different question from `.coarse`, not a second answer to it.

### Persistence (`src/services/`)

`MetaService` owns the one `SaveData` and is the only thing that persists it; `daily.ts`, `feats.ts`
and `coach.ts` are pure functions (plus one director class) over plain data for that reason. A field
added to `SaveData` must also be added to `encodeSave`'s explicit literal and to `migrate()`, or it
typechecks and silently never persists.

Everything persists through the async `StorageAdapter` interface (`storage.ts`) — three
implementations, chosen once in main.ts: `Preferences` on device, `localStorage` on web, memory in
vitest. The interface is Promise-based even though localStorage is synchronous, which is what let
Capacitor Preferences slot in underneath without touching a call site. `migration.ts` is the one-time
lift of an existing localStorage save onto that store: the marker lives in the **destination** (a
marker in the source would be erased by the eviction the lift exists to survive), the destination
always wins key by key, the source is never deleted, and values are copied verbatim.

When resolving a Capacitor plugin, `await` the **module namespace** and destructure the plugin only
afterwards. `registerPlugin` returns a Proxy whose get-trap manufactures a method for any name —
`then` included — so it is accidentally a thenable; resolving a promise with it makes the promise
machinery call `proxy.then(...)` and await forever. That hang shipped once as a black screen.
`storage.test.ts` pins it.

### The two isolation gates (`services/isolation.test.ts`)

Both are enforced by scanning source text for every module-specifier form (static, side-effect,
dynamic, `require`, re-export), so they cannot be evaded by import style:

1. **Engine code (`core/`, `ecs/`, `gameplay/`, `render/`) may not import `services/` or
   `platform/`.** That is what keeps the sim headless-testable.
2. **`platform/` is a leaf**: it may import only `./` siblings, `../core/`, and `../content/`. This
   one is an *allowlist*, so reaching for `game.ts` or `ui/` is a violation by default rather than by
   omission — which is what stops a platform module closing a cycle back into `Game`.

### Platform layer (`src/platform/`)

Native and device concerns, attached in main.ts and driven **entirely off the event bus** — gameplay
neither knows nor imports any of it. `audio.ts` is a WebAudio synth with no asset files (an
AudioContext may only start from a user gesture, so it unlocks on first pointer/touch/**keydown** —
keyboard and gamepad players would otherwise be silent for the whole session). `haptics.ts` and
`lifecycle.ts` use the same memoized dynamic-import idiom as storage. Auto-pause never *un*pauses:
the app returns to the pause screen and the player resumes.

Characters are gated twice: a feat (`unlock.requirement`, read off the permanent `feats` record) and
then a gold price. `MetaService.lockStateOf` is the single answer to "why is this locked" — the title
card renders it and `unlockCharacter` enforces it, so the screen and the purchase cannot disagree.
Only a finished run folds into the record (`recordFeats`, guarded by the same run token as
`bankRun`); quitting mid-run records nothing, exactly as it banks nothing.

### Content pipeline (`src/gameplay/content.ts`)

The only importer of the raw JSON. Normalizes once at module load into typed defs
(`ENEMY_LIST`, `WEAPON_LIST`, `weaponDef()`, `waveTable()`, …). Validation is **warn-don't-throw**:
unknown weapon behavior → weapon skipped with a warning; unknown enemy id in a wave → filtered;
lookups return null + `warnOnce` instead of throwing. A typo in content costs one entity type, not
the game — preserve this contract. Same fail-soft rule in rendering: missing PNG → generated
placeholder, unknown sprite name → id 0 + warn.

Weapon levels are additive deltas on `base`; `maxLevel = levels.length + 1` implicitly. Evolutions are
linked in a **second pass** (`linkEvolutions`, run after `normalizePassives` — a weapon cannot
cross-reference a passive during its own normalization) and are exported as `EVOLVED_WEAPON_IDS`;
`rollOffers` skips those ids at level 0, which is what keeps an evolution out of the draft.
`effectiveStats()` in weapons.ts is the single place passives meet weapon numbers.
`Run.recomputeStats()` runs only on loadout change, never per tick — don't mutate `run.stats`
directly.

### Extending

- **New enemy behavior**: add to `Behavior` + `behaviorFromName` (components.ts), init case in
  `spawnEnemy` (**`spawn.ts`**, not enemies.ts), AI case in `updateEnemies`; new tunables get
  defaulted fields in `EnemyDef` + `normalizeEnemies` (content.ts). AI phase vocabularies
  (`ChargePhase`, `FusePhase`) live in components.ts because the spawn path seeds them and the
  update path advances them, and those are deliberately different modules.
- **New weapon behavior**: add to the `WeaponBehavior` const in content.ts (this whitelists it for
  JSON validation), write a `fireX()` + case in the `fire()` switch in weapons.ts; new tunables go
  in `WeaponStats` + `WEAPON_STAT_KEYS` + `WEAPON_STAT_DEFAULTS`.
- **New weapon evolution**: an `evolution` block on the base plus a terminal entry (`weight: 0`,
  `levels: []`) in weapons.json — no code. `tryEvolve` (`evolutions.ts`, called from the chest case in
  `pickups.ts`) must stay **rng-free**, and it must `world.destroy` the base weapon's `activeIds`
  before the swap or the aura ring outlives it as an immortal entity.
- **New map**: drop a JSON in `src/content/maps/` — auto-discovered via `import.meta.glob`, filename
  is the map id. No registration.
- **New art**: colour comes from `docs/art/palette.md` and nowhere else — never start a second
  palette. Bring generated images down with `scripts/spritify.py` (sprites) or `scripts/tilify.py`
  (tiles) instead of hand-placing PNGs — the exception is the geometric weapon FX (rings, beads,
  pools, crescents), whose drawn edge is their collider and which `scripts/drawfx.py` draws from the
  palette in code; edit that script rather than the PNGs, and `--check` proves the two still agree.
  Then run `npm run validate:art`: it fails on a missing PNG
  (which otherwise silently falls back to a placeholder), a strip that doesn't divide into whole
  frames, and any off-palette pixel. Every strip in the repo passes today, the character sheets
  included — a failure is a regression, never a pre-existing exception to wave through.
- **New game event**: add to the `GameEvents` interface in `src/core/events.ts`. That interface is
  the whole contract between the sim and every listener — HUD, audio, haptics, daily tally, feats,
  coach and telemetry all subscribe, none of them are imported by gameplay.
- **New sound**: add a `SoundDef` to `AUDIO_MAP` in `platform/audio-map.ts` naming an existing event.
  No code, no asset — it is synthesized. Over-budget or throttled sounds are **dropped, never
  queued**, the same policy as the fx pools.
- **New ability**: a block on a character in `characters.json`; a new *kind* means adding to
  `AbilityKind` (content.ts, which whitelists it for JSON validation) plus a case in `abilities.ts`.
- **New structure**: an entry in `structures.json` plus a `structures` array on the map. A positive
  `range` arms it (`Comp.Shooter`); `0` makes it a passive wall.
- **New unlock signal** (what a character's `unlock.requirement` may measure): add to the
  `UnlockSignal` const in content.ts (this whitelists it for JSON validation) **and** emit it from
  `featDelta` in `services/feats.ts`. The two lists are duplicated rather than imported because
  save.ts's import closure is walled off from `gameplay/` by telemetry.test.ts; feats.test.ts asserts
  they stay equal. Requirements resolve against the same per-run signals the daily oaths use, so a
  new one needs a signal `dailyDelta` already derives — nothing new is tracked in the sim.
- **New Ctx field**: initialize in Game's constructor **and** `makeHarness()` in
  simulation.test.ts, reset in `startRun()`.

## Tests

`simulation.test.ts` (the bulk of the suite) runs the real gameplay systems in the real tick order
with exactly two stubs (`stubSprites()`, `stubMap()` — the browser-bound deps). **Its harness
duplicates `Game.tick()` verbatim: a change to one is a change to both.**
`makeHarness(characterId?, seed?, metaMods?)` builds a real `Ctx` and returns
`{ctx, spawner, run(seconds), levelUpsTaken}`; level-ups auto-resolve by taking the first offer. To
write a test: `makeHarness()`, mutate state directly (e.g. `ctx.run.time = 860` to jump waves,
`world.hp[ctx.player] = 1e9` for immortality, `spawnEnemy(ctx, enemyDef('brute')!, x, y)`),
`harness.run(seconds)`, assert on `ctx.run`, `world.list(Kind.X)`, or bus events. The 15-minute
full-run test treats >4000 concurrent entities as a leak, and a few tests pin exact numbers from a
fixed seed (banked gold, for one) — those are **balance tripwires**, so a diff there means the
economy moved and wants a look, not a number to update reflexively.

One content gate lives there too: **no wave stage may drop below 75% of the pressure the stage
before it set** (mean enemy hp × spawn rate × the hp scaling at that point). Every other assertion
about a run is a safety bound — no leak, no stall, cap respected — and a run that gets *easier*
violates none of them, which is how `default`'s 780s stage sat at a 44% collapse unnoticed. Dips are
legal; collapses are not.

Renderer, Hud, Screens, TileMap and SpriteTable need a browser, so their DOM work is verified with
`npm run dev`. Everything that can be pulled out of them has been, into gates that read source or
CSS as text:

| file | what it fails the build on |
| --- | --- |
| `services/isolation.test.ts` | engine importing `services/`/`platform/`; `platform/` reaching outside its allowlist |
| `services/telemetry.test.ts` | telemetry leaving the device, and the record's own bounds |
| `services/storage.test.ts` | the accidentally-thenable plugin proxy regressing |
| `render/repaint.test.ts` | a `this.state` assignment outside `setState`, or a state entered around it |
| `ui/metrics.test.ts` | any rule but `.xp-track` spending the art unit `--u` |
| `ui/layout.test.ts` | a cross-element clearance turning back into a literal; a layer composing safe-area insets in the wrong frame |
| `ui/navigation.test.ts` | the menu cursor and the title screen's flat-index-to-meaning mapping |

New UI arithmetic belongs in `metrics.test.ts` or `layout.test.ts` rather than in a comment.
