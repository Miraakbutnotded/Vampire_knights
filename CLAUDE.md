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

All simulation tests live in `src/gameplay/simulation.test.ts`; the UI has its own three (see Tests).
There is no linter configured; `tsc` is the gate.

`cap:sync` and `verify:ios` are **not** the same gate. `cap sync` rewrites
`ios/App/CapApp-SPM/Package.swift` and copies web assets without ever invoking the Swift toolchain,
so a plugin can appear in the manifest while the target no longer builds — "SPM picked it up" is not
"it compiles". `verify:ios` runs `xcodebuild` for a device Release with signing off, which is the
only thing that answers the second question. It needs macOS and Xcode, so it is the one gate a
non-Mac session cannot run; say so plainly rather than inferring the build from a successful sync.

## What this is

A Vampire Survivors-style arena game: custom TypeScript engine on Canvas2D, no framework, no runtime
dependencies. All game content (enemies, weapons, passives, characters, waves, maps) is data-driven
JSON in `src/content/`. **The README documents every content JSON format in detail — read it before
editing content files.** This file covers the code architecture instead.

## Architecture

### Ownership and flow

`src/main.ts` `boot()` → awaits `SpriteTable.load()` (the only async startup step) → constructs
`Game` (`src/game.ts`) → wraps it in `Loop` (`src/core/loop.ts`). There are **no module-level
singletons**: all state (World, Run, Ctx, Input, Renderer, Hud, Screens, EventBus, Rng, Spawner)
lives on the `Game` instance. The HMR `dispose()` wiring in main.ts is load-bearing — removing it
stacks loops and duplicates input listeners on every hot reload.

`Game` owns a state machine (`title | loading | playing | levelup | paused | results`). `update(dt)`
early-returns unless `state === 'playing'` — that is how pause/menus freeze the sim. ESC closes
pause only; on the level-up draft it is deliberately ignored.

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

1. `difficultyAt()` → writes `ctx.hpScale/damageScale/speedScale` (consumed at spawn time only; existing enemies never rescale)
2. `world.snapshotPositions()` — first, so the renderer can lerp prev→current by alpha
3. `enemyHash.build()` **rebuild #1** (pre-movement: crowd separation + contact damage)
4. `updatePlayer` → `spawner.update` → `updateEnemies`
5. `enemyHash.build()` **rebuild #2** (post-movement: all weapon/damage resolution — new damage systems go after this)
6. `updateEnemyProjectiles` → `updateWeapons` → `updatePlayerProjectiles` → `updateHazards`
7. `pickupHash.build()` → `updatePickups` → fx → camera
8. `world.flush()` — **last, exactly once**
9. Deferred state changes: open level-up if `run.pendingLevelUps > 0`, else victory check

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
  `KIND_COUNT` in world.ts must match the Kind values in components.ts.

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

`MetaService` owns the one `SaveData` and is the only thing that persists it; `daily.ts` and
`feats.ts` are pure functions over plain data for that reason. **Nothing under `services/` reachable
from `save.ts` or `telemetry.ts` may import `gameplay/` or `ui/`** — telemetry.test.ts walks that
import closure and fails on any edge that leaves `services/` and `core/`. A field added to `SaveData`
must also be added to `encodeSave`'s explicit literal and to `migrate()`, or it typechecks and
silently never persists.

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
  `spawnEnemy`, AI case in `updateEnemies`; new tunables get defaulted fields in `EnemyDef` +
  `normalizeEnemies` (content.ts).
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
  (tiles) instead of hand-placing PNGs, then run `npm run validate:art`: it fails on a missing PNG
  (which otherwise silently falls back to a placeholder), a strip that doesn't divide into whole
  frames, and any off-palette pixel. Every strip in the repo passes today, the character sheets
  included — a failure is a regression, never a pre-existing exception to wave through.
- **New game event**: add to the `GameEvents` interface in `src/core/events.ts`.
- **New unlock signal** (what a character's `unlock.requirement` may measure): add to the
  `UnlockSignal` const in content.ts (this whitelists it for JSON validation) **and** emit it from
  `featDelta` in `services/feats.ts`. The two lists are duplicated rather than imported because
  save.ts's import closure is walled off from `gameplay/` by telemetry.test.ts; feats.test.ts asserts
  they stay equal. Requirements resolve against the same per-run signals the daily oaths use, so a
  new one needs a signal `dailyDelta` already derives — nothing new is tracked in the sim.
- **New Ctx field**: initialize in Game's constructor **and** `makeHarness()` in
  simulation.test.ts, reset in `startRun()`.

## Tests

`simulation.test.ts` runs the real gameplay systems in the real tick order with exactly two stubs
(`stubSprites()`, `stubMap()` — the browser-bound deps). `makeHarness(characterId?, seed)` builds a
real `Ctx` with a fixed seed and returns `{ctx, spawner, run(seconds), levelUpsTaken}`; level-ups
auto-resolve by taking the first offer. To write a test: `makeHarness()`, mutate state directly
(e.g. `ctx.run.time = 860` to jump waves, `world.hp[ctx.player] = 1e9` for immortality,
`spawnEnemy(ctx, enemyDef('brute')!, x, y)`), `harness.run(seconds)`, assert on `ctx.run`,
`world.list(Kind.X)`, or bus events. The 15-minute full-run test treats >4000 concurrent entities
as a leak.

Renderer, Hud, Screens, Input, TileMap and SpriteTable need a browser, so their DOM work is verified
with `npm run dev`. What can be pulled out of them is: `src/ui/navigation.test.ts` covers the menu
cursor and the title screen's flat-index-to-meaning mapping (`src/ui/navigation.ts`), and
`src/ui/metrics.test.ts` / `src/ui/layout.test.ts` parse `style.css` itself — the art-unit allowlist,
the physical size every token resolves to at the touch floor, and whether each cross-element
clearance is still composed rather than a literal. New UI arithmetic belongs in one of those two
rather than in a comment.
