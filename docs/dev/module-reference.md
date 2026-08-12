# Module reference

Every module in `src/`, what it owns, and the contract its exports hold. This is the "does this
already exist, and where does my new thing go" map. For *why* the boundaries sit where they do,
read [`../../CLAUDE.md`](../../CLAUDE.md); for *how the pieces run together*, read
[`runtime-systems.md`](runtime-systems.md).

Layer rules, enforced by `services/isolation.test.ts`:

- `core/`, `ecs/`, `gameplay/`, `render/` are **engine**. They may not import `services/` or
  `platform/`. That is what keeps the simulation headless-testable.
- `platform/` is a **leaf**: it may import only its own siblings, `../core/`, and `../content/`.
  This one is an allowlist, so reaching for `game.ts` or `ui/` is a violation by default.
- `game.ts`, `main.ts` and `ui/` sit above everything and may import anything.

---

## `src/main.ts` — boot

Not a class. One `boot()` function plus the storage decision.

| export | contract |
| --- | --- |
| *(module side effects)* | `boot()` runs on import; failure paints an escaped error into `document.body` rather than leaving a blank page. |

Internals worth knowing:

- **`selectStorage()`** is the only place in the codebase allowed to choose a `StorageAdapter`.
  Services take one; they never construct one. It detects native via
  `Capacitor.isNativePlatform()` behind a dynamic import, races every bridge call against a
  **2500 ms deadline**, and *loses by default* — a plugin that never answers yields
  `localStorage`, not a hang.
- Boot order: `SpriteTable.load()` → `selectStorage()` → `Promise.all([meta.load(),
  telemetry.load()])` → `meta.rollDaily(Date.now())` → `new Game(...)` → `new Loop(...)` →
  `loop.start()` → attach lifecycle, audio, haptics.
- `import.meta.hot.dispose()` tears down the loop, game, lifecycle detachers, audio and haptics.
  **Load-bearing** — without it every hot reload stacks another loop, duplicates input listeners
  and leaks an AudioContext.
- `window.vkTelemetry` exists in DEV only, declared through a global augmentation so the service
  itself never learns a global exists.

## `src/game.ts` — the orchestrator

`class Game implements LoopHooks`. Owns every piece of state; there are no module-level
singletons anywhere in the project.

| member | contract |
| --- | --- |
| `state: State` | `title \| loading \| playing \| levelup \| paused \| dying \| results \| sanctum`. **Assigned in exactly one place, `setState()`.** `render/repaint.test.ts` scans this file's source and fails the build on a second assignment site. |
| `startRun(characterId, mapId)` | Async (map load). Abandons any run in flight, resets world/fx/spawner, reseeds RNG, constructs a fresh `Run` with meta mods, spawns player and structures, freezes `runDay`, increments `runToken`, opens `playing`. |
| `beforeFrame()` | Edge-triggered input only: F3 debug, ESC, `KeyQ`/`KeyE` blood latches, `Space` ability latch. Runs **once per frame**, unlike `update`. |
| `update(dt)` | Routes `dying` → `updateDying`, `playing` → `tick`. Every other state freezes the simulation — that is how pause and menus work. |
| `afterFrame()` | `input.endFrame()`. |
| `render(alpha, frameDt)` | Interpolates `lerp(prevX, x, alpha)` **before** queueing; the renderer never sees raw sim positions. Gated by `FrameGate.claim()`. |
| `autoPause()` / `onResumed()` | Platform hooks. Auto-pause never *un*pauses. |
| `dispose()` | HMR teardown. |
| `interface UiRoots` | `{ ui, touch, menu }` — the three DOM layers, wired from `index.html`. |

Private methods that carry real rules:

- **`setState(next)`** — assigns state *and* latches `frame.enter()`, so a chained level-up draft
  re-entering `levelup` still repaints.
- **`tick(dt)`** — the fixed-step simulation. Order is documented in
  [`runtime-systems.md`](runtime-systems.md#the-tick) and is duplicated verbatim by
  `simulation.test.ts`'s harness. **A change to one is a change to both.**
- **`settleRun(victory)`** — the single funnel for both end-of-run paths. Guarded by `runEnded`
  *and* by `runToken` inside `MetaService`. Banks gold → commits the daily → records feats →
  emits `run:ended`, in that order, because the wallet and telemetry share one origin quota.
- **`syncUiMetrics()`** — the only publisher of `--scale`/`--u` and `--ui-scale`/`--ui`, and only
  when the viewport changes.

---

## `src/core/` — engine primitives, no game knowledge

### `loop.ts`

| export | contract |
| --- | --- |
| `TICK_RATE = 60`, `FIXED_DT = 1/60` | Fixed simulation step. |
| `interface LoopHooks` | `beforeFrame` / `update(dt)` / `render(alpha, frameDt)` / `afterFrame`. |
| `class Loop` | `start()`, `stop()`, `fps`. Runs `update` **0..5 times per frame** and interpolates the remainder into `alpha`. |

The 0..5 range is the reason edge-triggered input lives in `beforeFrame` and the reason
`Ctx.bloodIntent` / `Ctx.abilityQueued` are latches.

### `events.ts`

| export | contract |
| --- | --- |
| `class EventBus<Events>` | `on(event, handler) → unsubscribe`, `emit(event, payload)`, `clear()`. Dispatch iterates a copy, so a handler may unsubscribe mid-dispatch. |
| `interface GameEvents` | **The entire contract between the sim and every listener.** Full catalogue in [`runtime-systems.md`](runtime-systems.md#event-catalogue). |
| `type DeathCauseKind`, `interface DeathCause` | `contact \| projectile \| unknown` + enemy id + post-armour damage. |
| `type DraftPickKind` | `weapon \| passive \| heal \| gold`. `upgrades.ts`'s `OfferKind` is an alias of this — one vocabulary, not two. |

### `input.ts`

| export | contract |
| --- | --- |
| `interface AxisSource` | What a joystick supplies. |
| `class Input` | `wasPressed(code)` is edge-triggered **and consuming** — first caller per frame wins, so system call order matters. Gamepad buttons inject synthetic `Enter`/`Escape`. |

Menus poll through `Screens.handleInput(input)` from the loop. Never add keydown listeners to
screen elements — keys double-fire.

### `rng.ts`

| export | contract |
| --- | --- |
| `class Rng` | Seeded. `reseed`, `next`, `range`, `int`, `chance`, `weightedIndex`. A run is reproducible from its seed and headless tests depend on it. |
| `fxRng` | Shared cosmetic stream (particles, damage-number jitter). |

**Never mix the two, and never use `Math.random()` in a gameplay path.**

### `math.ts`

`TAU`, `clamp`, `lerp`, `damp`, `dist`, `dist2`, `circlesOverlap`, `angleDelta`, `approach`,
`smoothstep`, `normalize`, `angleToOct`, `formatTime`. Pure, allocation-free.

### `placeholders.ts`

Procedural art generation so a missing PNG is never a crash. `generateStrip(spec)`,
`generateTileTexture(spec)`, `darken`, `lighten`, plus the `PlaceholderShape` vocabulary.

---

## `src/ecs/` — the entity store

### `components.ts`

| export | contract |
| --- | --- |
| `Kind` | `None, Player, Enemy, Projectile, Pickup, Hazard, Structure, Corpse` — 8 values. **`KIND_COUNT` in `world.ts` must match.** |
| `Comp` | Bitmask: `Transform, Velocity, Sprite, Health, Collider, Chase, Lifetime, Damaging, Orbit, Magnetic, Pushable, Persistent, Shooter`. |
| `Team` | `Player \| Enemy`. |
| `AnimState` | `Idle, Walk, Hurt, Death`. |
| `Behavior` | `Chase, Charger, Orbiter, Ranged, Drifter, Hopper, Exploder, Splitter`. |
| `ChargePhase`, `FusePhase` | AI phase vocabularies, stored in `aiPhase`. They live here — not in `enemies.ts` — because the spawn path seeds them and the update path advances them, and those are deliberately different modules. |
| `behaviorFromName(name)` | Warn-don't-throw: an unknown name logs and falls back to `Chase`. |

All enums are `const object + type union`, never TS `enum`.

### `world.ts`

`class World`, `MAX_ENTITIES = 16384`. Structure-of-arrays: every component is a parallel typed
array indexed by entity id.

| method | contract |
| --- | --- |
| `create(kind)` | Resets **every** field. Returns `-1` at capacity — every spawn site must treat that as "skip". **A new component array needs a new reset line here**, or recycled ids leak stale values. |
| `place(id, x, y)` | Sets current *and* prev position. Writing `x`/`y` directly makes a fresh sprite streak from (0,0). |
| `destroy(id)` | Marks dead only. The id stays readable until `flush()`. Safe mid-iteration. |
| `flush()` | Compacts kind lists, bumps generations, recycles ids. **Call once, at the end of the tick — never from inside a system.** |
| `snapshotPositions()` | Copies current → prev. Top of every tick, so the renderer can lerp. |
| `list(kind)` | A **live readonly view**. Never mutate; never retain across ticks. |
| `handleOf(id)` / `resolve(handle)` | Ids are recycled with a generation counter, so anything held across ticks must be a handle. `resolve` returns `-1` if the entity is gone. |
| `registerHit(source, target)` / `clearHits(source)` | Pierce and aura dedup. **Any new damage source must use it.** |
| `reset()` | Wipes everything for a fresh run. |

Field notes: knockback lives in `kbx`/`kby`, *not* `vx`/`vy` (AI overwrites velocity every tick).
`owner` stores raw ids — the sanctioned exception, because owners outlive attachments.
`targetHandle` is `Float64Array` because handles pack id + gen×16384. `aiPhase` is polymorphic by
Kind (charger phase / projectile turn rate / pickup magnet latch) — don't repurpose it on an
existing Kind.

---

## `src/gameplay/` — the simulation

A **DAG**. Systems are stateless free functions `fn(ctx, dt)`; the only classes are `Run` and
`Spawner`. Gameplay never imports `game.ts` and never calls UI — it emits on `ctx.bus`.

### `context.ts`

`interface Ctx` — the single shared bag, built once in Game's constructor and mutated in place
between runs: `world, run, sprites, fx, camera, map, rng, bus, wave, player, aimX, aimY,
enemyHash, pickupHash, scratch, scratchInner, hpScale, damageScale, speedScale, bloodIntent,
abilityQueued`.

**A new Ctx field must be initialized in Game's constructor *and* in `makeHarness()` in
`simulation.test.ts`, and reset in `startRun()`.**

### `content.ts` — the only importer of raw JSON

Normalizes once at module load into typed defs. Validation is **warn-don't-throw**: unknown
weapon behavior → weapon skipped with a warning; unknown enemy id in a wave → filtered; lookups
return `null` + `warnOnce`. A typo in content costs one entity type, not the game. **Preserve
this contract.**

| group | exports |
| --- | --- |
| enemies | `EnemyDef`, `ENEMY_LIST`, `enemyDef(id)`, `enemyDefByIndex(i)` |
| structures | `StructureDef`, `STRUCTURE_LIST`, `structureDef`, `structureDefByIndex` |
| weapons | `WeaponBehavior` (the whitelist), `WeaponStats`, `WEAPON_STAT_DEFAULTS`, `WeaponLevel`, `WeaponEvolution`, `WeaponDef`, `WEAPON_LIST`, `weaponDef`, `weaponStatsAtLevel(def, level)`, `parseEvolutionBlock`, `linkEvolutions`, `EVOLVED_WEAPON_IDS` |
| passives | `StatMods`, `PassiveDef`, `PASSIVE_LIST`, `passiveDef` |
| abilities | `AbilityKind` (the whitelist), `AbilityParams`, `AbilityDef`, `normalizeAbility` |
| characters | `BaseStats`, `UnlockSignal` (the whitelist), `UNLOCK_SIGNAL_IDS`, `UnlockMode`, `UnlockRequirement`, `CharacterUnlock`, `CharacterDef`, `CHARACTER_LIST`, `characterDef`, `normalizeUnlockRequirement` |
| waves | `WaveEnemyEntry`, `WaveStage`, `EliteSchedule`, `BossSpawn`, `SiegeEvent`, `WaveTable`, `waveTable(id)`, `isSiegeMelee(behavior)` |
| blood | `FrenzyConfig`, `BloodConfig`, `normalizeBlood`, `BLOOD_CONFIG` |
| meta | `MetaMods`, `MetaNodeDef`, `META_LIST`, `metaNodeDef`, `normalizeMeta` |

Weapon levels are **additive deltas** on `base`; `maxLevel = levels.length + 1` implicitly.
Evolutions are linked in a **second pass** (`linkEvolutions`, after `normalizePassives`) because a
weapon cannot cross-reference a passive during its own normalization.

### `run.ts`

| export | contract |
| --- | --- |
| `MAX_WEAPON_SLOTS = 6`, `MAX_PASSIVE_SLOTS = 6` | Capped separately, genre standard. |
| `xpForLevel(level)` | `floor(5 + 4(n-1) + (n-1)^1.6)`. |
| `OwnedWeapon`, `OwnedPassive`, `AbilityState` | Per-run loadout state. Cooldowns live here and are ticked on sim `dt`. |
| `class Run` | Progression, loadout, derived stats, the blood economy fields, and the siege counters. |

**`recomputeStats()` has exactly three sources** — meta mods, passives, an active buff ability's
`abilityMods` — and runs **only on a state change** (loadout, buff start, buff expiry). Never per
tick, never mutate `run.stats` directly. It clamps: `maxHp ≥ 1`, `cooldown ≥ 0.35`, `area`,
`projectileSpeed`, `duration ≥ 0.2`, `growth ≥ 0.1`, `critChance ∈ [0, 0.95]`, `pierce ≥ 0` and
whole. It publishes `maxHpDelta` so a +health pick can be granted as current health.

`gainBlood(amount, uncapped=false)` honours the per-second intake cap; `uncapped` is for Blood
Vials, which sidestep the window in both directions but still clamp to the bar and still refresh
the decay grace. `evolveWeapon` replaces **in place** so the HUD slot keeps its position — and
destroying whatever the old weapon owned in the world is the *caller's* job.

### `spawn.ts` — the DAG's pressure valve

`spawnEnemy(ctx, def, x, y)` and `spawnCorpse(ctx, from)`. This module imports content and the
ECS and **nothing else in `gameplay/`**, which is what turns `enemies → damage → enemies` into
`enemies → damage → spawn`. `enemies.ts` re-exports `spawnEnemy`, so call sites don't care.

`spawnCorpse` returns `-1` when the sprite has no death art of its own — a frozen standing sprite
on the floor reads as a bug.

### `spawner.ts`

| export | contract |
| --- | --- |
| `class Spawner` | Wave stages, elites, bosses, sieges. `reset()`, `update(ctx, dt)`. Holds the concurrent cap (`maxAlive`) — when at cap it parks the timer at 0 so spawning resumes the moment room frees up. |
| `difficultyAt(ctx, seconds)` | `{ hp, damage, speed }`. Consumed **at spawn time only** — existing enemies never rescale. |

Spawn rings: bosses 210, elites 290, sieges 300, trash 330 (default in `offscreenSpawnPoint`).
Each burst picks **one** position with ±34 scatter, so a group arrives from one direction.
`wallsLost` feeds `difficultyAt` at **+8% damage and speed per wall** — armed emplacements are
deliberately excluded, so mounting more towers cannot raise a map's difficulty ceiling.

### `player.ts`

`spawnPlayer(ctx, x, y)`, `updatePlayer(ctx, dt, input)`, `playerAlpha(ctx)`. Maintains
`ctx.aimX/aimY` — the last **non-zero** movement direction, so letting go of the keys doesn't
swing your aim.

### `enemies.ts`

`updateEnemies(ctx, dt)` (the AI switch over `Behavior`), `updateCorpses(ctx, dt)` — the *only*
system that touches `Kind.Corpse` — `offscreenSpawnPoint(ctx, ringRadius = 330)`,
`updateEnemyProjectiles(ctx, dt)`, plus the `spawnEnemy` re-export.

### `damage.ts`

| export | contract |
| --- | --- |
| `withinEngagement(ctx, id)` | On-screen test, measured **from the camera**, not the player: on a bounded map the camera stops at the wall while the player keeps walking. Half-extents are `VIEW/2 + 24`. Emplacements are exempt — a tower answers to its own range. |
| `PLAYER_IFRAME = 0.45` | Seconds of immunity after a hit. |
| `damageEnemy(ctx, id, amount, knockback, srcX, srcY, canCrit = true)` | Crit roll, flash, damage number, knockback scaled by `1 - knockbackResist`, death dispatch. Returns damage dealt. |
| `killEnemy(ctx, id, allowSplit = true)` | Blood, `enemy:killed`, fx by tier, vial for elite/boss, gem, coin roll, meat/magnet roll, chest, split, **corpse, then destroy**. `allowSplit=false` is for the revive nuke. |
| `damagePlayer(ctx, amount, source = -1)` | Armour is **flat with a floor of 1**. Handles the revive branch (full heal, 2.5 s iframes, `clearNearbyEnemies(90)`) and the death emit. `source` is what lets a death name its killer. |
| `clearNearbyEnemies(ctx, x, y, radius)` | Kills everything in radius except bosses. |

Base drop chances, before luck: meat `0.004`, magnet `0.003`.

### `weapons.ts`

| export | contract |
| --- | --- |
| `effectiveStats(run, weapon)` | **The single place passives meet weapon numbers.** Also where Frenzy folds in read-side, keyed off `run.frenzyT` — `run.stats` is never touched. |
| `updateWeapons(ctx, dt)` | Ticks cooldowns and fires. Aura weapons are cooldown-exempt: they maintain one persistent entity. |
| `spawnProjectile(...)`, `spawnHazard(...)` | Shared spawn helpers. Abilities ride these, which is why every downstream updater works on ability casts unchanged. |
| `nearestEnemy(ctx, x, y, range = 300)` | Targeting. |
| `updatePlayerProjectiles(ctx, dt)`, `updateHazards(ctx, dt)` | Movement, lifetime, damage resolution. Despawn distance 700. |

Private `fireX()` functions, one per behavior: `fireArc`, `fireHoming`, `fireStraight`,
`fireOrbit`, `fireDrop`, `fireNova`, `fireLightning`, `fireTether`, `fireChain`, `fireTrail`,
`fireSlam`, `fireSpiral`, plus `maintainAura`. **A new behavior = an entry in the
`WeaponBehavior` const in content.ts (which whitelists it for JSON validation) + a `fireX()` + a
case in the `fire()` switch.** New tunables go in `WeaponStats` + `WEAPON_STAT_KEYS` +
`WEAPON_STAT_DEFAULTS`.

### `abilities.ts`

`abilityStats(run, def)` and `updateAbility(ctx, dt)`. Scaling is a deliberately narrow
guardrail — **damage ×might, sizes ×area, lifetime ×duration, and nothing else**. `amount`,
`cooldown` and `projectileSpeed` do not apply, and the ability's own cooldown lives raw on
`AbilityDef`, immune to cooldown scaling. Kinds: `nova`, `volley`, `buff`, `dash`, `zone`.

### `blood.ts`

`updateBlood(ctx, dt)`. Resets the anti-farm intake window on each whole **sim** second, counts
down Frenzy, consumes the latched intent, then decays. Order inside the function matters: the
intent is consumed *before* the decay step, so a bar the HUD shows as ready can never be dipped
under the threshold by the same tick's decay. Private `castBloodNova` is a single-tick burst, so
it needs no `registerHit` bookkeeping.

### `pickups.ts`

`PickupKind`, `spawnGem`, `spawnCoin`, `spawnMeat`, `spawnMagnet`, `spawnChest`,
`spawnBloodVial`, `updatePickups(ctx, dt)`, `healPlayer(ctx, amount)` (returns what *actually*
landed, not what was asked for), `grantBlood(ctx, amount, uncapped = false)`.

### `upgrades.ts`

`OfferKind` (alias), `Offer`, `rollOffers(ctx, count = 3)`, `applyOffer(ctx, offer, offered)`,
`weaponSummary(ctx, weaponId)`.

Draws **without replacement** from a weighted pool. Owning something already multiplies its
weight by `EXISTING_WEIGHT_BONUS = 1.6`, so builds deepen instead of spreading across six level-one
weapons. Evolved ids are skipped at level 0, as is a base whose evolution is already owned — that
would sell a slot and eight picks for a weapon that can never fuse again. A fully maxed loadout
falls back to `heal` (40% max HP) and `gold` (20–60, before greed).

`applyOffer` takes the **whole draft** because the declined offers exist nowhere else once the
screen closes, and take-rate without a denominator is just the weight table read back.

### `evolutions.ts`

`EvolutionResult`, `tryEvolve(ctx)` — called from the chest case in `pickups.ts`. Must stay
**rng-free**, and must `world.destroy` the base weapon's `activeIds` before the swap or the aura
ring outlives it as an immortal entity.

### `structures.ts`

`spawnStructure(ctx, def, x, y)`, `damageStructure(ctx, id, amount)`, `updateStructures(ctx, dt)`.
`Kind.Structure`, static, `Team.Player`, with HP. A positive `range` arms it (`Comp.Shooter`); `0`
makes it a passive wall. Towers shoot from `TOWER_STATS`, built from `WEAPON_STAT_DEFAULTS` and
**never** `effectiveStats()` — a passive or Frenzy multiplier reaching a tower would turn terrain
into part of the build.

### `collision.ts`

`MAX_QUERY_RESULTS = 512`, `class SpatialHash`, `separateCrowd(...)`. A 128×128 bucket grid,
cell size 40, coordinates **wrapped** modulo the grid so an unbounded map has no blind spot.
Population is a counting sort into one flat array — zero allocation after construction.

**Query results are candidates only.** Every consumer must do an exact distance test plus
`world.isAlive`. Use `ctx.scratch` for outer loops and `ctx.scratchInner` for a query nested
inside another query's iteration — never share one buffer between nested queries.

---

## `src/render/` — Canvas2D

The world renders into a fixed **480×270** offscreen buffer, nearest-neighbour upscaled (integer
factor when ≥1). Zero-allocation-per-frame is a core constraint: pools are fixed-capacity SoA
typed arrays that **silently drop overflow**.

| module | surface |
| --- | --- |
| `renderer.ts` | `VIEW_W = 480`, `VIEW_H = 270`, `viewportScale(w, h)`, `class Renderer`. Draw order: ground → particles → depth-sorted sprite queue (`flushSprites()` once, after all queues) → damage numbers → `present()`. Positions round to whole pixels in `queue()`, camera rounds in `begin()`, `imageSmoothingEnabled = false` is re-set defensively after any resize. |
| `camera.ts` | `CameraBounds`, `class Camera` — `follow`, `snapTo`, `shake`, `bounds`. |
| `fx.ts` | `ParticleShape`, `class Fx` — `burst`, `shockwave`, `damageNumber`, `floatingText`, `update`, `clear`. Pools: **768 particles, 160 numbers.** In-world text uses the hand-built 3×5 pixel font, because canvas `fillText` is blurry at 480×270. |
| `pixel-font.ts` | The 3×5 glyph table and its atlas baking: `GLYPH_W/H/GAP`, `GLYPH_CHARS`, `GLYPH_ROWS`, `ATLAS_W/H`, `glyphColumn`, `glyphAdvance`, `pixelTextWidth`, `atlasUsable`, `MAX_ATLASES = 16`, `bakeAtlasCanvas`, `class PixelFont`. |
| `flash-sheet.ts` | White hit-flash sheets, cached: `MAX_FLASH_SHEETS = 192`, `MAX_FLASH_PIXELS = 2 MiB`, `class FlashSheetCache`, `bakeFlashSheet`. |
| `sprites.ts` | `Anim`, `Sprite`, `class SpriteTable` (`load()`, lookup, `anim`), `frameIndex(anim, animTime)`. Fail-soft: missing PNG → generated placeholder, unknown sprite name → id 0 + warn. `sprites.anim` resolves `Death` to the *same object* as `Idle` when there is no death art — which is how `spawnCorpse` and `game.ts` detect it. |
| `tilemap.ts` | `MapJson`, `Solid`, `MapChoice`, `orderMaps`, `mapChoices()`, `availableMaps()`, `class TileMap` (`load`, `bounds`, `spawnX/Y`, `structures`, `wavesTable`, `clearRuntimeSolids`). Maps are auto-discovered via `import.meta.glob` — filename is the map id, no registration. |
| `repaint.ts` | `ANIMATING_STATES = ['playing','dying']`, `isAnimating(state)`, `class FrameGate` (`enter()`, `claim()`). A **latch**, not a `state !== lastPainted` comparison — a chained level-up draft re-enters `levelup` without leaving it, and that second frame carries real HUD changes. |

---

## `src/ui/` — DOM over canvas

Three layers, in paint order: `#touch` (joystick + pause), `#ui` (HUD + debug), `#menu` (the five
screens). **Only `#ui` is clipped and translated to the letterboxed play box**, so only its
children compose device insets as `max(design, safe − offset)`; children of `#touch` and `#menu`
span the viewport and compose them directly as `max(design, safe)`. `ui/layout.test.ts` gates it.

| module | surface |
| --- | --- |
| `metrics.ts` | `UI_SCALE_MIN_FINE = 2`, `UI_SCALE_MIN_COARSE = 3`, `UI_SCALE_MAX = 4.5`, `uiScale(cssW, cssH, coarse)`. |
| `navigation.ts` | `NUMBER_KEYS`, `wrapIndex`, `choiceLabel`, `TitleSelection`, `titleSelection(...)` — the title screen's flat-index-to-meaning mapping. |
| `hud.ts` | `class Hud` — bars, structure pips, banner, coach strip, debug panel. |
| `screens.ts` | `ScreenName`, `ResultsData`, `TitleDailyRow`, `TitleMeta`, the four callback interfaces, `SanctumMeta`, `class Screens`. Every menu is built from two regions by `shell()`: `.screen-aside` (reading matter, no focusables) and `.screen-main` (everything actionable). They stack into one centred column, and become lanes under `@media (max-height: 560px)` — a phone in landscape. |
| `style.css` | Two size units. **`--u` (one game pixel) is an allowlist of exactly one rule, `.xp-track`**; everything else is chrome and uses `--ui` through the semantic tokens in `:root`. `ui/metrics.test.ts` fails the build on any other rule spending `--u`. Cross-element clearances (`--cluster-w`, `--pause-reserve`, `--bottom-band`, `--hud-center-h`) are **composed, never measured**. Touch styling hangs off a `.coarse` class written from `navigator.maxTouchPoints` — never `@media (pointer: coarse)`, which disagrees with the JS on hybrid laptops. |

---

## `src/services/` — persistence and derived records

`MetaService` owns the one `SaveData` and is the only thing that persists it. `daily.ts`,
`feats.ts` and `coach.ts` are pure functions (plus one director class) over plain data **for that
reason** — a second service persisting its own copy would make the two overwrite each other.

| module | surface |
| --- | --- |
| `storage.ts` | `interface StorageAdapter` (Promise-based even though localStorage is synchronous — that is what let Capacitor Preferences slot in underneath without touching a call site), `LocalStorageAdapter`, `PreferencesStorageAdapter`, `MemoryStorageAdapter`. |
| `save.ts` | `SAVE_VERSION = 4`, `SAVE_KEY`, `SAVE_BACKUP_KEY`, `SaveData`, `defaultSave`, `checksum` (FNV-1a — a corruption tripwire, not security), `encodeSave`, `decodeSave`, `migrate`, `class SaveStore`. **Dual-slot**: every persist writes primary then backup; `load()` falls back to the backup and heals the primary. |
| `migration.ts` | `MIGRATION_KEY`, `MIGRATION_STAMP`, `MIGRATED_KEYS`, `MigrationOutcome`, `MigrationReport`, `liftStorage(from, to)`. The marker lives in the **destination**, the destination always wins key by key, the source is never deleted, values are copied verbatim. |
| `meta.ts` | `LockState`, `class MetaService`. `load`, `gold`, `bankRun`, `dailyState`, `rollDaily`, `commitDailyRun`, `feats`, `recordFeats`, `coachState`, `markCoachSeen`, `rankOf`, `buyNode`, `computeMetaMods`, `isUnlocked`, `lockStateOf`, `unlockCharacter`, `flush`. State is **replaced, never mutated**; writes are chained through one pending promise, fire-and-forget. |
| `daily.ts` | `DailyTier`, `DailyMode`, `DailyObjectiveDef`, `DailySave`, `DAY_MS`, `DAILY_OBJECTIVE_GOLD = 150`, `DAILY_BONUS_GOLD = 150`, `DAILY_POOL`, `defaultDaily`, `dailyObjective`, `dailySet(day)`, `localDayIndex`, `rolloverDaily`, `DailyRunTally`, `attachDailyTally(bus)`, `DailyRunSummary`, `emptyTally`, `dailyDelta`, `DailyPayout`, `foldDaily`, `migrateDaily`. |
| `feats.ts` | `FEAT_SIGNAL_IDS`, `FeatRequirement`, `FeatSave`, `defaultFeats`, `featDelta`, `foldFeats`, `featProgress`, `featMet`, `migrateFeats`. |
| `coach.ts` | `COACH_CUES`, `CoachPromptDef`, `CoachSave`, `COACH_GAP_SECONDS = 4`, `COACH_QUEUE_MAX = 8`, `COACH_POOL`, `defaultCoach`, `coachPrompt`, `CoachAction`, `CoachConditions`, `CoachStep`, `class CoachDirector`, `CoachCueBinding`, `attachCoachCues`, `migrateCoach`. |
| `telemetry.ts` | `TELEMETRY_VERSION`, `TELEMETRY_KEY`, `MAX_RECORDS = 50`, `MAX_PICKS_PER_RUN = 60`, `MAX_BYTES = 256 KiB`, `PickRecord`, `DeathRecord`, `RunOutcome`, `RunRecord`, `TelemetryDoc`, `RunSummary`, `encodeTelemetry`, `decodeTelemetry`, `migrateTelemetry`, `class TelemetryService`. **Local only** — `telemetry.test.ts` fails the build if it ever leaves the device. |

**Adding a field to `SaveData` is not enough.** `encodeSave` builds an explicit literal rather
than spreading, so a field added to the interface and not to that literal typechecks, round-trips
through `migrate()` as "missing → default", and silently never persists. Add it to both.

`feats.ts` spells out its signal list rather than importing `UnlockSignal` from `content.ts`,
because it sits in `save.ts`'s import closure and `telemetry.test.ts` walks that closure to prove
it never reaches into `gameplay/`. `feats.test.ts` asserts the two lists stay equal — **change
one, change both.**

---

## `src/platform/` — native and device

Attached in `main.ts`, driven **entirely off the event bus**. Gameplay neither knows nor imports
any of it.

| module | surface |
| --- | --- |
| `audio.ts` | `class AudioEngine` — a WebAudio synth with **no asset files**. An AudioContext may only start from a user gesture, so it unlocks on first pointer/touch/**keydown** — keyboard and gamepad players would otherwise be silent for the whole session. |
| `audio-map.ts` | `WaveKind`, `SoundDef`, `normalizeAudioMap`, `AUDIO_MAP`. A new sound is a `SoundDef` naming an existing event — no code, no asset. Over-budget or throttled sounds are **dropped, never queued**, the same policy as the fx pools. |
| `voices.ts` | `MAX_VOICES = 8`, `class RateGate`, `class VoiceAllocator`. |
| `haptics.ts` | `class HapticsDriver`. Memoized dynamic import, same idiom as storage. |
| `lifecycle.ts` | `AutoPausable`, `Resumable`, `VisibilityHost`, `shouldAutoPause(state)`, `wireLifecycle(game, document)`, `wireCapacitorLifecycle(host)`. |
| `touch.ts` | `class TouchControls` — the joystick and pause button on `#touch`. |
| `joystick.ts` | `joystickVector(...)`, `nubOffset(...)`. Pure maths, so it is testable without a DOM. |

**When resolving a Capacitor plugin, `await` the module namespace and destructure the plugin
only afterwards.** `registerPlugin` returns a Proxy whose get-trap manufactures a method for any
name — `then` included — so it is accidentally a thenable; resolving a promise with it makes the
promise machinery call `proxy.then(...)` and await forever. That hang shipped once as a black
screen. `storage.test.ts` pins it.
