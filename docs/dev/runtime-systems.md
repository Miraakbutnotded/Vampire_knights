# Runtime systems

How the running game actually works, end to end. [`module-reference.md`](module-reference.md)
says what each module *is*; this says what happens *when*.

- [Boot](#boot)
- [The frame](#the-frame)
- [The tick](#the-tick)
- [State machine](#state-machine)
- [Entity lifecycle](#entity-lifecycle)
- [The damage pipeline](#the-damage-pipeline)
- [Blood, abilities, sieges](#blood-abilities-sieges)
- [Event catalogue](#event-catalogue)
- [Rendering](#rendering)
- [UI layout](#ui-layout)
- [Persistence](#persistence)
- [End of run](#end-of-run)

---

## Boot

```
main.ts boot()
  │
  ├─ query #game, #ui, #touch, #menu           throws if index.html is missing one
  ├─ await SpriteTable.load()                  every sprite now resolves to something drawable
  ├─ await selectStorage()                     ← the only StorageAdapter decision in the codebase
  │     ├─ dynamic import('@capacitor/core')   racing a 2500 ms deadline
  │     ├─ not native → LocalStorageAdapter
  │     └─ native → liftStorage(local → prefs) also deadlined; failure = stay on localStorage
  ├─ await Promise.all([meta.load(), telemetry.load()])   same store, neither needs the other
  ├─ meta.rollDaily(Date.now())                rollover point #1 of 3; must precede the Game
  ├─ new Game(canvas, roots, sprites, meta, telemetry)    constructor opens the title screen
  ├─ new Loop({...}); loop.start()
  ├─ wireLifecycle(game, document)             web visibilitychange
  ├─ wireCapacitorLifecycle({ autoPause })     native; rejection is warned, never fatal
  ├─ new AudioEngine(game.bus); new HapticsDriver(game.bus)
  └─ import.meta.hot.dispose(...)              tears all of the above down
```

Two rules govern this sequence:

1. **Every native bridge races a deadline and loses by default.** A plugin that never answers
   produces silence, not a rejection — and unbounded waiting means a black screen on boot. A
   wallet restored a launch later is worth incomparably more than a game that never starts.
2. **The wallet and Sanctum ranks must exist before the title screen renders**, because the title
   card prints lock states and today's oaths, and before the first `Run` is constructed, because
   `Run`'s constructor folds `computeMetaMods()` in as its first stat source.

The three daily-rollover points are boot, `openTitle()`, and resume from background — **none of
them during a run**. Freezing the day for the duration of a run is what stops a run that starts at
23:59 and ends at 00:02 from watching its own progress bar reset.

---

## The frame

```
Loop
  beforeFrame()                 ← exactly once per frame
  update(FIXED_DT) × 0..5       ← may run zero times, or five
  render(alpha, frameDt)        ← exactly once per frame
  afterFrame()                  ← exactly once per frame
```

`FIXED_DT` is 1/60. Rendering interpolates between the previous and current simulation positions
by `alpha`.

Because `update` may run **zero** times in a frame, anything edge-triggered must be handled
frame-side:

| handled in `beforeFrame` | why |
| --- | --- |
| `F3` debug toggle | Pure UI. |
| `Escape` | Closes pause; on the level-up draft it is deliberately ignored, so you cannot escape a draft without picking. On the Sanctum it returns to the title. |
| `KeyQ` → `ctx.bloodIntent = 'heal'` | Latched, not applied. |
| `KeyE` → `ctx.bloodIntent = 'burst'` | Latched, not applied. |
| `Space` → `ctx.abilityQueued = true` | Latched, not applied. |

A press written straight into a system would be dropped on a frame that ran the sim zero times.
The latch is consumed by `updateBlood` / `updateAbility` on the next sim tick, and **every menu
clears both latches on the way in** so no cast survives a pause.

`Input.wasPressed(code)` is edge-triggered **and consuming** — the first caller per frame wins and
later callers get `false`. That is why the blood/ability codes are distinct from `Escape` and why
system call order in `beforeFrame` matters.

---

## The tick

`Game.tick(dt)`, run only in `playing`. **`simulation.test.ts`'s harness duplicates this order
verbatim — a change to one is a change to both.**

| # | step | why here |
| --- | --- | --- |
| 1 | `run.time += dt`; `difficultyAt()` → `ctx.hpScale/damageScale/speedScale` | Consumed at spawn time only. Enemies already on the field never rescale. |
| 2 | `world.snapshotPositions()` | First, so the renderer can lerp prev→current by alpha. |
| 3 | `enemyHash.build()` — **rebuild #1** | Pre-movement index: crowd separation and contact damage read this. |
| 4 | `updatePlayer` → `spawner.update` → `updateEnemies` | Everything that moves an enemy. |
| 5 | `enemyHash.build()` — **rebuild #2** | Post-movement index. Weapons resolve against where enemies *are*, not where they were. **New damage systems go after this.** |
| 6 | `updateAbility` → `updateEnemyProjectiles` → `updateWeapons` → `updatePlayerProjectiles` → `updateHazards` → `updateStructures` | Damage resolution. |
| 7 | `pickupHash.build()` → `updatePickups` → `updateBlood` → `updateCorpses` → `fx.update` → `camera.follow` | Collection, economy, cosmetics. |
| 8 | `world.flush()` | **Last, exactly once.** |
| 9 | Deferred state changes | See below. |

Two placements in that list are arguments, not accidents:

- **`updateAbility` before `updateEnemyProjectiles`**, so dash i-frames granted this tick already
  cover this tick's enemy fire.
- **`updateBlood` after `updatePickups`**, so every kill and collection for the tick has landed
  before intake, decay and the latched Feast/Frenzy spend are resolved. `updateCorpses` runs after
  both, so bodies start ageing on the tick they fell rather than a tick later.

### Deferred state changes (step 9), in precedence order

```
if (state !== 'playing') return;          ← a death mid-tick already moved us to 'dying'
if (run.pendingLevelUps > 0) openLevelUp();
if (run.time >= wave.victorySeconds) declareVictory();
```

Death **outranks both**: a level-up draft would resume play at 0 hp on resolve, and a victory on
the killing tick would contradict the `run:ended` summary `settleRun` already emitted with
`victory: false`. Banked level-ups are simply dropped — the run is over.

---

## State machine

```
                 startRun()          pendingLevelUps > 0
   title ────────────────► loading ──► playing ◄──────────► levelup
     ▲                                  │  ▲  │                 (chains until the queue empties)
     │                          ESC ────┘  │  └──── hp ≤ 0 ──► dying
     │                                     │                      │
     │                       resume ── paused                     │ animation ends
     │                                     │                      ▼
     └──── openTitle() ◄── results ◄───────┴──── victorySeconds ──┘
     │
     └──► sanctum ── ESC ──► title
```

- **`this.state` is assigned in exactly one place, `setState()`**, which also latches the frame
  gate. `render/repaint.test.ts` scans `game.ts`'s source and fails the build if a second
  assignment or a raw state entry appears.
- `update(dt)` runs `tick()` only in `playing` and routes `dying` to `updateDying`. **Every other
  state freezes the simulation** — that is how pause and menus work, with no separate pause flag
  anywhere in gameplay.
- A chained level-up re-enters `levelup` without leaving it, which is exactly why the frame gate
  is a latch (`enter()` on every state entry) rather than a `state !== lastPainted` comparison.
- Auto-pause (backgrounding) never *un*pauses: the app returns to the pause screen and the player
  resumes deliberately.

---

## Entity lifecycle

```
world.create(kind)          → id, or -1 at capacity (every spawn site must handle -1)
world.place(id, x, y)       → sets x/y AND prevX/prevY
… systems run, reading and writing typed arrays by id …
world.destroy(id)           → marks dead only; the id stays readable for the rest of the tick
world.flush()               → compacts kind lists, bumps gen, recycles the id
```

**Deferred destruction is the load-bearing part.** Every system tolerates reading a dead entity;
none tolerate the id lists being compacted underneath them. So `destroy` is safe mid-iteration and
`flush` runs exactly once, last.

Because ids are recycled with a generation counter, anything held **across ticks** must be a
handle:

```ts
const h = world.handleOf(id);   // pack id + gen × MAX_ENTITIES
const now = world.resolve(h);   // -1 if that entity has died or been recycled
```

The sanctioned exception is `owner`, which stores raw ids — owners outlive their attachments.

Two further contracts bite when adding a component:

- **A new component array needs a new reset line in `World.create()`**, or a recycled id inherits
  the previous occupant's value.
- `world.list(kind)` is a **live readonly view**. Never mutate it, never retain it across ticks.

### `Kind.Corpse`

A killed enemy leaves a body that plays a death animation and is then gone. It is its own Kind
rather than a flag on an enemy precisely so the broadphase, contact damage, weapon targeting and
the wave cap all keep ignoring it *for free*, by iterating a list it is not on. Bodies are
cosmetic — no collider, no health, no team — and carry a negative `drawBias` so they lie under
anything still standing on the same row. `spawnCorpse` returns `-1` when the sprite has no death
art of its own. Culling and the revive nuke both bypass it, so only a real kill leaves a body.

---

## The damage pipeline

### Player → enemy

```
updateWeapons
  └─ effectiveStats(run, weapon)        base × passives × meta × Frenzy (read-side)
       └─ fireX() → spawnProjectile / spawnHazard / direct resolve
            └─ enemyHash.query(...)     candidates only
                 └─ exact distance test + world.isAlive
                      └─ world.registerHit(source, target)    pierce / aura dedup
                           └─ damageEnemy(...)
                                ├─ crit roll (ctx.rng, run.stats.critChance/critMult)
                                ├─ hp -= dealt; hitFlash; fx.damageNumber
                                ├─ knockback × (1 - def.knockbackResist) → kbx/kby
                                └─ hp ≤ 0 → killEnemy(...)
```

`killEnemy` in order: `run.kills++` → `grantBlood(def.blood × bloodGain)` → emit `enemy:killed` →
tier fx → Blood Vial if elite/boss → gem → coin roll → meat/magnet roll → chest if `dropsChest` →
**split** → **corpse** → `destroy`. Split is second-to-last so children spawn against a world where
the parent's drops already exist; the corpse is read off the entity while it is still readable.

Splitter children arrive through the ordinary spawn path, so they carry the difficulty scaling in
force **now** rather than the parent's — they are new enemies, not pieces of an old one. They
bypass the wave director, which is the only place the concurrent cap is enforced, so `splitEnemy`
re-checks `maxAlive` itself.

**Engagement gating.** `withinEngagement` keeps player weapons from killing things off screen and
dropping their gems out there. Half-extents are `VIEW/2 + 24` — a sprite's worth of slack, so an
enemy leaning into frame is already fair game — measured from the **camera**, not the player,
because on a bounded map the camera stops at the wall while the player keeps walking. Emplacements
are exempt: a watchtower's whole job is to hold a wall you have walked away from, so it answers to
its own `range`.

### Enemy → player

```
damagePlayer(ctx, amount, source)
  ├─ iframe > 0 → return false
  ├─ reduced = max(1, amount - run.stats.armor)     flat reduction, floor of 1
  ├─ hp -= reduced; iframe = 0.45; hitFlash; fx; camera.shake
  ├─ emit player:damaged
  └─ hp ≤ 0
       ├─ revivesLeft > 0 → revivesLeft--; hp = maxHp; iframe = 2.5;
       │                     clearNearbyEnemies(90)      so the revive isn't spent instantly
       └─ else → emit player:died { killedBy: attribute(source) }
```

Armour is flat with a floor of 1, so stacking it stays valuable against weak enemies without ever
making the player literally untouchable. `attribute()` resolves both shapes through `defIndex` —
an enemy carries its own, an enemy projectile is stamped with its shooter's at spawn, so a bolt
still names the wisp that fired it after the wisp is dead. Anything else answers `'unknown'`
rather than guessing at enemy zero.

---

## Blood, abilities, sieges

Three systems sit beside weapons and share one rule: **nothing they add may reach `run.stats` per
tick.** `Run.recomputeStats()` has exactly three sources — meta mods, passives, an active buff
ability's `abilityMods` — and runs only on a state change.

### Blood

Kills fill a bar. At `threshold` the **whole bar** is spent, on either Feast (heal) or Frenzy
(timed buff + one-tick nova). Per tick, `updateBlood`:

1. Reset `bloodIntakeWindow` if `floor(run.time)` crossed a whole **sim** second.
2. Count down `frenzyT`.
3. **Consume the latched intent** — before decay, so a bar the HUD shows as ready can never be
   dipped under the threshold by this tick's decay before the press is honoured. Below the
   threshold the press is swallowed: no partial spends.
4. Decay: at or above `threshold - 1`, blood holds through `decayGrace` seconds after the last
   gain, then bleeds down — but never below `threshold - 1`.

Frenzy folds in **read-side** off `run.frenzyT` inside `effectiveStats` and `abilityStats`, never
written into `run.stats`. Every timer advances on sim `dt`; the anti-farm intake window is keyed
to `run.time` crossing a whole second, **never** to wall clock — otherwise a run stops being
reproducible from its seed.

### Abilities

One active per character, off `characterDef().ability`. Scaling is a deliberately narrow
guardrail: **damage ×might, sizes ×area, lifetime ×duration, and nothing else.** `amount`,
`cooldown` and `projectileSpeed` do not apply, and the ability's own cooldown lives raw on
`AbilityDef`, immune to cooldown scaling. Casts ride `spawnProjectile`/`spawnHazard`, so every
downstream updater works on them unchanged.

Five kinds: `nova` (radial burst), `volley` (a burst pumped out over `duration`), `buff` (timed
`abilityMods` + optional heal), `dash` (displacement + i-frames + a hazard trail), `zone` (a
lingering hazard).

### Sieges

A map that ships a `structures` array is a siege map, and the picker derives its tag from that.
`Spawner.updateSieges` walks a forward-only cursor over `wave.sieges`; each due entry spawns
attackers on the 300-unit ring and hands each melee one a **handle** to the nearest living
structure. With no living structure the handle stays `-1` and the attacker hunts the player, so
sieges degrade gracefully on structure-less maps.

Overlapping sieges extend one shared window and resolve once. **Defended** = at least one
structure still stands when the window closes; the reward (chest + that structure's `gold`) lands
at the first survivor, so walking back to the wall you held is the loop. Every structure down =
no reward and nothing else. The difficulty penalty is already banked in `run.wallsLost`
(+8% enemy damage and speed per wall, at spawn time), and **player death stays the only fail
state**.

Towers shoot from `TOWER_STATS`, built from `WEAPON_STAT_DEFAULTS` and **never**
`effectiveStats()` — a passive or Frenzy multiplier reaching a tower would turn terrain into part
of the build.

---

## Event catalogue

`GameEvents` in `src/core/events.ts` is the whole contract between the simulation and every
listener. Gameplay emits; HUD, audio, haptics, the daily tally, feats, coach and telemetry
subscribe — and none of them are imported by gameplay.

| event | payload | emitted when |
| --- | --- | --- |
| `player:damaged` | `{ amount, hp, maxHp }` | A hit lands after armour. |
| `player:healed` | `{ amount, hp, maxHp }` | Any heal, with what actually landed. |
| `player:died` | `{ survivedSeconds, kills, killedBy: DeathCause }` | No revives left. One emit site, so the killer can never desynchronise from the death. |
| `player:levelup` | `{ level }` | A level threshold is crossed. |
| `run:victory` | `{ survivedSeconds, kills }` | `run.time ≥ victorySeconds`. |
| `draft:picked` | `{ kind, id, level, isNew, atLevel, offered[] }` | A level-up draft resolves. `offered` carries the declined ids too — take-rate needs a denominator. |
| `weapon:evolved` | `{ baseId, intoId, name }` | A maxed weapon fuses with its maxed passive at a chest. |
| `xp:gained` | `{ amount, xp, needed, level }` | XP is granted. |
| `enemy:killed` | `{ x, y, kills }` | Any enemy death. |
| `gold:gained` | `{ amount, total }` | Coins, chests, the gold consolation offer. |
| `boss:spawned` | `{ name }` | A boss entry fires. |
| `stats:changed` | `undefined` | The loadout changed and stats were recomputed. |
| `blood:gained` | `{ amount, blood, max }` | Blood actually banked, after the intake cap. |
| `blood:ready` | `undefined` | The bar crosses `threshold`. |
| `blood:feast` | `{ spent, healed }` | Feast. `healed` is what landed, not what was asked for. |
| `blood:frenzy` | `{ spent, duration }` | Frenzy, alongside the one-tick nova. |
| `ability:used` | `{ name, kind, cooldown }` | A cast succeeds. |
| `ability:ready` | `undefined` | The cooldown reaches zero. |
| `structure:damaged` | `{ hp, maxHp, index }` | A structure takes a hit. |
| `structure:destroyed` | `{ name, remaining, index }` | A structure falls. |
| `siege:started` | `{ duration }` | A siege entry fires. |
| `siege:defended` | `{ gold }` | The window closes with at least one structure standing. |
| `run:ended` | `{ victory, survivedSeconds, kills, gold, level, mapId, structuresSpawned, structuresLost }` | `settleRun`, exactly once per run. `spawned > 0 && lost === 0` is a clean hold. |
| `meta:goldBanked` | `{ banked, total }` | After `bankRun`. `banked` is the run's own gold; the oath payout is a separate line. |
| `meta:purchased` | `{ nodeId, rank }` | A Sanctum purchase. |
| `character:unlocked` | `{ id }` | A character purchase. |

**Adding an event** means adding to this interface and nothing else — that is the extension point.

---

## Rendering

```
render(alpha, frameDt)
  ├─ frame.claim()                     skip entirely if this state already painted
  ├─ renderer.begin(camera)            camera rounded to whole pixels
  ├─ tilemap ground
  ├─ fx particles
  ├─ queueKind(...) for each Kind      positions lerp(prev, cur, alpha), rounded in queue()
  │    └─ flushSprites()               ONCE, after all queues; depth defaults to y
  ├─ fx damage numbers                 3×5 hand-built pixel font
  └─ present()                         480×270 buffer → canvas, nearest-neighbour
```

Pixel-crispness invariants: positions round to whole pixels in `queue()`, the camera rounds in
`begin()`, `imageSmoothingEnabled = false` is re-set defensively after **any** canvas resize.
Interpolation happens in `game.ts` before `renderer.queue()` — the renderer never sees raw sim
positions.

Depth sorting defaults to `y`, for feet-on-ground ordering; `drawBias` shifts an entity above or
below its row (corpses use a negative bias).

**Zero allocation per frame is a core constraint.** DrawList and Fx pools are fixed-capacity SoA
typed arrays that **silently drop overflow** — 768 particles, 160 damage numbers. Don't replace
them with growable arrays. In-world text uses the pixel font because canvas `fillText` is blurry
at 480×270; all other text is DOM.

The frame gate exists because the world only advances in `playing` and `dying`, so a repaint in
any other state reproduces pixels already on the canvas.

---

## UI layout

Two units, both published by `Game.syncUiMetrics()` and only when the viewport changes:

| unit | source | meaning |
| --- | --- | --- |
| `--u` | `--scale` | One game pixel. |
| `--ui` | `--ui-scale`, from `uiScale()` | One chrome unit: the same number clamped to `[2, 4.5]`, floor raised to 3 on touch. |

Inside the band they are identical, so a desktop window renders the same either way. They part
company only on a phone (chrome pinned to 3 while the art sits near 1.5) and above 2160 px wide
(art keeps growing, chrome stops).

**`--u` is an allowlist of exactly one rule, `.xp-track`** — the four-game-pixel band that frames
the world. Everything else, hairlines and icon canvases included, is chrome and uses `--ui`
through the semantic tokens in `:root`. `ui/metrics.test.ts` fails the build on any other rule
spending `--u`, so a new world-anchored element joins the allowlist deliberately.

Three DOM layers, in paint order:

| layer | contents | safe-area composition |
| --- | --- | --- |
| `#touch` | Joystick, pause button | `max(design, safe)` — spans the viewport |
| `#ui` | HUD, debug | `max(design, safe − offset)` — **clipped and translated to the letterboxed play box** |
| `#menu` | The five screens | `max(design, safe)` — spans the viewport |

Only `#ui`'s contents are anchored to the world, which is why only it subtracts the letterbox
offset. Using the `#ui` idiom in the other two under-insets a notched phone by the width of the
letterbox bar; `ui/layout.test.ts` gates it.

Cross-element clearances (`--cluster-w`, `--pause-reserve`, `--bottom-band`, `--hud-center-h`) are
**composed, never measured** — each is built from the tokens of the things it has to clear, so
resizing a control moves everything that reserves space against it in the same edit.
`layout.test.ts` fails the build if one turns back into a literal.

Every menu is two regions (`shell()` in `screens.ts`): `.screen-aside` holds the reading matter
and no focusable; `.screen-main` holds everything actionable. They stack into one centred column
normally and become lanes under `@media (max-height: 560px)` — a phone in landscape. That query
asks about vertical room, which is a different question from `.coarse`, not a second answer to it.

Touch styling hangs off a `.coarse` class the constructor writes from `navigator.maxTouchPoints` —
never `@media (pointer: coarse)`, which is a second source of truth that disagrees with the JS on
hybrid laptops.

---

## Persistence

```
StorageAdapter (async, 3 impls)
   ├─ PreferencesStorageAdapter   on device
   ├─ LocalStorageAdapter         on web
   └─ MemoryStorageAdapter        in vitest
        │
        ▼
   SaveStore  ──dual slot──►  vk-save  +  vk-save.bak
        │
        ▼
   MetaService (owns the one SaveData; the only thing that persists it)
        ├─ daily.ts   pure functions over DailySave
        ├─ feats.ts   pure functions over FeatSave
        └─ coach.ts   pure functions + one director over CoachSave
```

The interface is Promise-based even though `localStorage` is synchronous — that is what let
Capacitor Preferences slot in underneath without touching a call site.

**Dual-slot writes**: every persist writes the primary slot then the backup. A write interrupted
between the two leaves the previous good save in the backup, which `load()` falls back to (healing
the primary) before giving up and returning defaults. Adapter failures are logged, never thrown —
a failed save must not take the game down, and the next persist retries.

`decodeSave` returns `null` on any corruption — bad JSON, checksum mismatch, a payload `migrate()`
rejects — and never throws. `migrate` fills missing fields from defaults, and **rejects unknown
future versions** rather than guessing, so a downgraded build falls back to the backup instead of
mangling a newer save.

`migration.ts` is the one-time lift of an existing `localStorage` save onto Preferences. Four
rules: the marker lives in the **destination** (a marker in the source would be erased by the
eviction the lift exists to survive), the destination always wins key by key, the source is never
deleted, values are copied verbatim.

`MetaService` replaces state, never mutates it, so a half-applied purchase can't be persisted;
writes are chained through one pending promise so they land in call order even on a slow adapter,
and are fire-and-forget so UI never blocks a frame on storage.

---

## End of run

```
death ──► beginDeath() ──► 'dying' ──► updateDying() ──► showDefeat()
                              │                              │
victory ─────────────────────────► declareVictory() ─────────┤
                                                             ▼
                                                        endRun(victory)
                                                             │
                                                        settleRun(victory)   ← guarded
                                                             │
                                                        showResults(...)
```

`settleRun` is the single funnel and can legitimately be *reached* twice per run (death on the
victory-crossing tick; a second death after the die-plus-level-up same-tick resume; the death
animation ending after `beginDeath` already settled). It is therefore guarded twice:

- `this.runEnded`, the browser-side brace — a `run:ended` listener must never see two conflicting
  summaries for one run.
- `runToken`, the headless-tested belt — `bankRun`, `commitDailyRun` and `recordFeats` each
  ignore a token they have already seen, so even if Game's own guard were refactored away the
  wallet could not double-bank.

Order inside the guard is **bank → commit daily → record feats → emit `run:ended` → emit
`meta:goldBanked`**. Banking runs first for a storage reason rather than a gameplay one: the
wallet and the telemetry log share one origin quota, and `run:ended` is what closes the telemetry
record and chains its write. Settling all three record-writes before the emit means a single
persist covers the wallet, the oath record and the feat record together.

Only a **finished** run folds into the feat record. Quitting mid-run records nothing, exactly as
it banks nothing — `startRun` calls `telemetry.abandonRun` while the old `Run` is still current,
so its final numbers are real rather than zeroes.
