# Testing

```bash
npm test                            # vitest run — the whole suite, headless
npm run test:watch                  # watch mode
npx vitest run -t "every weapon"    # a single test by name pattern
npx vitest run src/services         # a directory
```

**20 files, 460 tests, all green** at the time of writing (`vitest 4.1.10`, ~21 s). A red test is
a regression, never a known failure to wave through.

There is no linter. `tsc --noEmit` is the type gate; the suite is everything else.

---

## What kind of suite this is

Most of these files are **gates**, not feature tests. They parse the source tree or the stylesheet
as *text* and fail the build on an architectural violation. That is deliberate: the rules in
[`../../CLAUDE.md`](../../CLAUDE.md) are only rules if something enforces them, and a comment
enforces nothing.

| file | tests | fails the build on |
| --- | ---: | --- |
| `gameplay/simulation.test.ts` | 155 | Real gameplay systems in the real tick order — behaviour, balance bounds, leaks, stalls. |
| `services/coach.test.ts` | 41 | The coach director's scheduling, gating and persistence. |
| `services/daily.test.ts` | 38 | Day rollover (including clock abuse and timezone travel), objective folding, payouts. |
| `services/meta.test.ts` | 35 | Wallet, Sanctum purchases, lock states, the exactly-once run-token guards. |
| `services/telemetry.test.ts` | 29 | **Telemetry leaving the device**, and the record's own bounds. |
| `platform/platform.test.ts` | 19 | Joystick maths, voice allocation, rate gating, lifecycle rules. |
| `services/migration.test.ts` | 18 | The one-time localStorage → Preferences lift, in every partial-failure shape. |
| `ui/layout.test.ts` | 17 | A cross-element clearance turning back into a literal; a layer composing safe-area insets in the wrong frame. |
| `ui/navigation.test.ts` | 14 | The menu cursor, and the title screen's flat-index-to-meaning mapping. |
| `render/pixel-font.test.ts` | 13 | Glyph table, atlas geometry, text measurement. |
| `ui/metrics.test.ts` | 12 | **Any rule but `.xp-track` spending the art unit `--u`.** |
| `services/feats.test.ts` | 12 | The feat record, and that `FEAT_SIGNAL_IDS` still equals content.ts's `UnlockSignal`. |
| `render/repaint.test.ts` | 11 | **A `this.state` assignment outside `setState`**, or a state entered around it. |
| `services/isolation.test.ts` | 8 | Engine importing `services/`/`platform/`; `platform/` reaching outside its allowlist. |
| `render/flash-sheet.test.ts` | 7 | Hit-flash cache bounds and eviction. |
| `render/tilemap.test.ts` | 6 | Map discovery, ordering, solid registration. |
| `render/camera.test.ts` | 6 | Follow, bounds clamping, shake decay. |
| `render/renderer.test.ts` | 4 | Viewport scale maths. |
| `core/input.test.ts` | 4 | Edge-triggered consuming presses. |
| `services/storage.test.ts` | 1 | **The accidentally-thenable Capacitor plugin proxy regressing.** |

Renderer, Hud, Screens, TileMap and SpriteTable need a browser, so their DOM work is verified with
`npm run dev`. Everything that *can* be pulled out of them has been, into the gates above.

---

## `simulation.test.ts`

The bulk of the suite. It runs the **real** gameplay systems in the **real** tick order with
exactly two stubs — `stubSprites()` and `stubMap()`, the browser-bound dependencies.

> **The harness duplicates `Game.tick()` verbatim. A change to one is a change to both.**
>
> This duplication is deliberate: importing `game.ts` would drag the DOM, the renderer and the
> services into a headless test. The cost is that the copy must be maintained by hand, and the
> comment at the top of `Game.tick` says so.

### The harness

```ts
const harness = makeHarness(characterId?, seed?, metaMods?);
// characterId defaults to CHARACTER_LIST[0].id, seed to 12345, metaMods to {}

harness.ctx            // a real Ctx: world, run, rng, bus, wave, spatial hashes…
harness.spawner        // a real Spawner
harness.run(seconds)   // advance the simulation, in FIXED_DT steps
harness.levelUpsTaken  // level-ups auto-resolve by taking the first offer
```

### Writing a test

Mutate state directly — there is no API to go through, and that is the point:

```ts
const h = makeHarness();

h.ctx.run.time = 860;                       // jump to a late wave stage
h.ctx.world.hp[h.ctx.player] = 1e9;         // immortality, to isolate what you are measuring
spawnEnemy(h.ctx, enemyDef('brute')!, 40, 0);
h.run(10);

expect(h.ctx.world.list(Kind.Enemy).length).toBeGreaterThan(0);
```

Assert on `ctx.run`, on `world.list(Kind.X)`, or on bus events (subscribe before `run()`).

### Existing groups

`content` · `exploder` · `splitter` · `enemy animation state` · `corpses` · `the flinch` ·
`progression` · `simulation` · `difficulty scaling` · `blood economy` · `active abilities` ·
`castle defense` · `watchtowers` · `meta progression` · `pickup magnetism` · `engagement range` ·
`a run reports what happened to it` · `weapon evolutions — content` · `weapon evolutions —
loadout` · `weapon evolutions — the chest trigger` · `the weapons that are not projectiles in a
line` · `the passives that are not plain multipliers`.

Put a new test in the group it belongs to rather than starting a twenty-third.

---

## The three kinds of assertion, and how to treat a failure

### 1. Safety bounds — fix the code

No leak, no stall, cap respected. The fifteen-minute full-run test treats **>4000 concurrent
entities** as a leak. These never move; a failure is a bug.

### 2. Balance tripwires — look, don't reflexively update

A few tests pin exact numbers from a fixed seed — banked gold from a full seeded run, for one.
A diff there means **the economy moved and wants a look**, not a number to bump. Ask what change
moved it and whether that was intended before touching the expectation.

### 3. Content gates — fix the content

The one that lives in `simulation.test.ts` rather than in a services file:

> **No wave stage may drop below 75% of the pressure the stage before it set** — mean enemy HP ×
> spawn rate × the HP scaling at that point.

Every *other* assertion about a run is a safety bound, and a run that gets **easier** violates
none of them. That is how `default`'s 780 s stage sat at a 44% collapse unnoticed until this gate
was written. Dips are legal; collapses are not. (See
[`../design/progression.md`](../design/progression.md#wave-pressure) for the shipped curve — the
sharpest legal dip today is 375 s at 87%.)

---

## The two isolation gates

`services/isolation.test.ts` scans source text for **every** module-specifier form — static,
side-effect, dynamic, `require`, re-export — so neither can be evaded by import style.

1. **Engine code (`core/`, `ecs/`, `gameplay/`, `render/`) may not import `services/` or
   `platform/`.** That is what keeps the simulation headless-testable.
2. **`platform/` is a leaf**: it may import only `./` siblings, `../core/`, and `../content/`.
   This one is an **allowlist**, so reaching for `game.ts` or `ui/` is a violation by default
   rather than by omission — which is what stops a platform module closing a cycle back into
   `Game`.

`services/telemetry.test.ts` runs a third scan of the same shape: it walks `save.ts`'s import
closure to prove it never leaves `services/` and `core/`. That is why `feats.ts` spells out its
signal list instead of importing `UnlockSignal` from `content.ts`, and why `feats.test.ts` asserts
the two lists stay equal.

---

## Adding a test that is worth having

Before writing an assertion, ask which of the three kinds it is.

- **A new invariant that a comment currently describes** → write a gate that reads the source or
  the CSS as text. New UI arithmetic belongs in `metrics.test.ts` or `layout.test.ts` rather than
  in a comment.
- **A new system or behavior** → a group in `simulation.test.ts`, driven through `makeHarness`.
- **A new pure function in `services/`** → its own file beside the module, tested directly.

Two mechanical requirements that bite:

- **A new `Ctx` field must be initialized in `makeHarness()` as well as in Game's constructor**,
  and reset in `startRun()`. Miss the harness and the suite fails on the next run; miss
  `startRun` and the second run of a session inherits the first one's value.
- **A change to `Game.tick()`'s order must be mirrored in the harness.** Nothing detects the
  divergence automatically — the tests simply start proving something the game no longer does.

---

## Art validation

```bash
npm run validate:art
```

Not vitest — a Python script (`scripts/validate-art.py`, run through `scripts/python.mjs`). It
fails on:

1. a **missing PNG** (which would otherwise silently fall back to a placeholder),
2. a strip that doesn't divide into whole frames,
3. any **off-palette** pixel,
4. a `walk` whose **lower third is identical in every frame** — a character skating across the
   floor is the one art fault the other three cannot see.

That last check is a floor, not a proof of a good cycle: it says the legs moved, never that they
moved coherently. Every strip in the repo passes today, the character sheets included — a failure
is a regression, never a pre-existing exception to wave through.
