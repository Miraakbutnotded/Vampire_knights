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
```

All tests live in `src/gameplay/simulation.test.ts`. There is no linter configured; `tsc` is the gate.

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

UI is DOM over canvas. Everything is sized in `calc(var(--u) * N)` (`--u` derives from `--scale`,
published by `Game.syncUiMetrics()` only when the viewport changes) so UI scales with the art.

### Content pipeline (`src/gameplay/content.ts`)

The only importer of the raw JSON. Normalizes once at module load into typed defs
(`ENEMY_LIST`, `WEAPON_LIST`, `weaponDef()`, `waveTable()`, …). Validation is **warn-don't-throw**:
unknown weapon behavior → weapon skipped with a warning; unknown enemy id in a wave → filtered;
lookups return null + `warnOnce` instead of throwing. A typo in content costs one entity type, not
the game — preserve this contract. Same fail-soft rule in rendering: missing PNG → generated
placeholder, unknown sprite name → id 0 + warn.

Weapon levels are additive deltas on `base`; `maxLevel = levels.length + 1` implicitly.
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
- **New map**: drop a JSON in `src/content/maps/` — auto-discovered via `import.meta.glob`, filename
  is the map id. No registration.
- **New art**: colour comes from `docs/art/palette.md` and nowhere else — never start a second
  palette. Bring generated images down with `scripts/spritify.py` (sprites) or `scripts/tilify.py`
  (tiles) instead of hand-placing PNGs, then run `npm run validate:art`: it fails on a missing PNG
  (which otherwise silently falls back to a placeholder), a strip that doesn't divide into whole
  frames, and any off-palette pixel. The five character strips in `public/assets/player/` predate the
  pipeline and fail the palette check today — a known finding, not a reason to loosen the gate.
- **New game event**: add to the `GameEvents` interface in `src/core/events.ts`.
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

Renderer, Hud, Screens, Input, TileMap, SpriteTable have no test coverage — they need a browser;
verify those changes with `npm run dev`.
