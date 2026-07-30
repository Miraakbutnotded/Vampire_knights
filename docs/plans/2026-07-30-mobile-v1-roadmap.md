# Vampire Knights — Mobile v1 Phase Roadmap

> Source of truth for scope and mechanics: `docs/plans/2026-07-30-mobile-v1-design.md`.
> This document sequences that design into shippable phases. **Each phase gets its own
> detailed, bite-sized implementation plan (like `2026-07-30-phase1-blood-economy.md`)
> written just-in-time, after the reassessment that closes the previous phase — do not
> pre-write later phase plans; what we learn in each phase changes the next.**

**Engine invariants that every phase must respect** (from `CLAUDE.md`): determinism (all
gameplay randomness via `ctx.rng`, timers on `run.time`/sim `dt`), `run.stats` never
mutated outside `recomputeStats()`, every `Game.tick()` change mirrored verbatim in
`makeHarness()` in the same commit, warn-don't-throw content normalization, engine code
(`core/`, `ecs/`, `gameplay/`, `render/`) never importing platform/services code.

**Branch strategy:** one branch per phase — `feat/phase-N-<name>` — squash-merged to
`main` when the phase's exit criteria are met. The three gameplay phases (1–3) land
**sequentially, never in parallel branches**: all three edit `Game.tick()` /
`makeHarness()` ordering and `simulation.test.ts`, and parallel branches would produce
harness merge conflicts that defeat the determinism tripwire (design doc §7). The test
suite must be green after every commit inside a phase branch.

---

## Phase 1 — Blood Economy

**Branch:** `feat/phase-1-blood-economy` · **Effort:** 3–4 developer-days (design §1)

**Goal:** The run-scoped Feast/Frenzy blood resource: kills bank blood, spending ≥50
heals (Feast) or buffs damage/speed with a nova (Frenzy), with an anti-farm intake cap
and use-it-or-lose-it decay.

**Key deliverables**
- `src/content/blood.json` + `BLOOD_CONFIG` normalization in `content.ts` (warn-don't-throw)
- Per-enemy `blood` field; `bloodGain` stat + Bloodthirst passive
- `Run` blood state (`blood`, `bloodIntakeWindow`, `frenzyT`, `graceT`) + capped `gainBlood`
- `killEnemy` blood grant; `PickupKind.BloodVial` from elites/bosses; `MEAT_CHANCE` halved
- New `src/gameplay/blood.ts::updateBlood` after `updatePickups` in tick + harness
- `ctx.bloodIntent` latch; Frenzy read-side multipliers in `effectiveStats`/`updatePlayer`
- 4 new `GameEvents`; HUD blood orb + Feast/Frenzy buttons; `KeyQ`/`KeyE` in `beforeFrame`

**Dependencies:** none — first phase on the current `main`.

**Exit criteria (mechanically verifiable)**
- [ ] `npm run typecheck` clean
- [ ] `npm test` green, including **~14 new blood-economy tests** (per-def grants, intake
      cap + window reset, feast heal, below-threshold no-op, decay floor, nova ring,
      read-side multipliers with a `run.stats` before/during/after immutability
      assertion, vial drop)
- [ ] The pre-existing 15-minute full-run test still green (determinism + <4000 entities)
- [ ] Manual dev-server check: orb fills, buttons pulse at ≥50, Q/E and taps cast, below
      50 nothing happens
- [ ] Squash-merged to `main`

**Detailed plan:** `docs/plans/2026-07-30-phase1-blood-economy.md` (written, ready to execute).

---

## Phase 2 — Character Active Abilities + Five Characters

**Branch:** `feat/phase-2-active-abilities` · **Effort:** 4–6 developer-days (design §2)

**Goal:** One unique active ability per character on a cooldown (Space / HUD button),
plus the five gothic character kits (Valen, Morrigan, Aldric, Vespera, Dragos).

**Key deliverables**
- `AbilityDef` + `ABILITY_KINDS` whitelist in `content.ts` (warn-don't-throw, per-kind
  param defaults); `ability` block in `characters.json`; 5th character added
- `Run.ability: AbilityState | null`; new `src/gameplay/abilities.ts::updateAbility`
  inserted between `updateEnemyProjectiles` and `updateWeapons` (tick + harness, same commit)
- Five kinds: `nova`/`volley`/`zone` (reuse exported `spawnProjectile`/`spawnHazard`),
  `buff` (third `recomputeStats()` source, on-state-change only), `dash` (substepped
  through map resolve calls)
- `ctx.abilityQueued` latch; `Input.injectPress(code)`; HUD ability button with
  conic-gradient cooldown ring
- `'ability:used'` event; ability icons through the placeholder sprite pipeline

**Dependencies:** Phase 1 merged (sequential tick/harness edits; Phase 1's blood buttons
and this phase's ability button share the bottom-band input conventions).

**Exit criteria**
- [ ] `npm run typecheck` clean; `npm test` green including the design's **7 new test
      groups**: per-character activation loop, cooldown gate (two presses → one
      activation), two-harness same-seed determinism at 60s, buff round-trip
      (`armor` +10 then restored exactly), dash bounds + iframes, fail-soft bogus
      `kind` (loads, `ability === null`, warning only), 15-min auto-press leak test
      (<4000 entities)
- [ ] All 5 characters selectable and playable in the dev server with placeholder icons
- [ ] Squash-merged to `main`

---

## Phase 3 — Castle Defense Objectives

**Branch:** `feat/phase-3-castle-defense` · **Effort:** 4–6 developer-days (design §3)

**Goal:** Defendable structures on siege maps: siege waves target gates/shrines,
surviving a siege pays out, losing structures raises difficulty — player death stays the
only fail state.

**Key deliverables**
- `Kind.Structure` (KIND_COUNT 6→7), `world.targetHandle` Float64Array + reset line
- `src/content/structures.json` + `normalizeStructures()`; `src/gameplay/structures.ts`
  (`spawnStructure`/`damageStructure`/`updateStructures` after `updateHazards`)
- `TileMap.addRuntimeSolid`/`clearRuntimeSolids`; map-schema `structures` array;
  new `maps/bastion.json`
- Enemy target-handle substitution in `updateEnemies` (attack cadence via `hitCooldown`,
  retarget/peel rules, cull exemption while target alive)
- `Spawner.updateSieges()` + `sieges` in `waves.json`; `difficultyAt` ×
  `(1 + 0.08 × structuresLost)`; siege reward chest/coins
- 4 new events; HUD structure pips + siege banners; off-screen edge markers in `render()`

**Dependencies:** Phases 1–2 merged (final tick order settles here; blood economy can
subscribe to `siege:defended` later without schema change).

**Exit criteria**
- [ ] `npm run typecheck` clean; `npm test` green including the design's **6 new tests**
      (standoff attack cadence, retarget on destruction, stale-handle safety, siege
      reward, structure-less graceful degradation, 15-min leak test covering a siege window)
- [ ] `bastion` map playable in dev server: siege banner, gate breach opens the wall,
      pips update
- [ ] Squash-merged to `main`

---

## Phase 4 — Meta-Progression + Services/Save Layer

**Branch:** `feat/phase-4-meta-progression` · **Effort:** ~5–6 developer-days (the
meta/save/UI half of design §4's 8–12d)

**Goal:** Persistent progression: gold banks between runs into the 10-node Sanctum
upgrade tree, character unlocks, versioned dual-slot local saves — all behind a
`src/services/` boundary the engine never imports.

**Key deliverables**
- `src/content/meta.json` + `normalizeMeta()` validated against `STAT_MOD_KEYS`
- `Run` constructor gains `metaMods` param seeding the `recomputeStats()` accumulator
  (default `{}` keeps every existing test byte-identical)
- `src/services/save.ts` (KVStore, dual-slot + checksum + migration), `services/meta.ts`
  (wallet, `buy`, `computeMetaMods`, `bankRun`)
- `unlock` field on characters; `run:ended` + 3 meta events; `sanctum`/`shop` states;
  `showSanctum()`/`showShop()` screens; boot-time `SaveService.load()`

**Dependencies:** Phases 1–3 merged (income curve for the gold-band balance test must
include blood/ability/siege effects on kill rates and siege gold).

**Exit criteria**
- [ ] `npm run typecheck` clean; `npm test` green plus new `src/services/meta.test.ts`
      (buy/deduct/reject, `computeMetaMods` summation, migration v0→v1, corrupt →
      `.bak` → defaults) and `simulation.test.ts` additions (`new Run('wanderer',
      {might: 0.15})` reflected with clamps, seeded greed-multiplier determinism,
      15-min run banks gold inside a stated band)
- [ ] Engine-isolation grep gate: no `services/` import anywhere under `src/core`,
      `src/ecs`, `src/gameplay`, `src/render`
- [ ] Save survives reload in dev server; corrupting the primary slot recovers from `.bak`
- [ ] Squash-merged to `main`

---

## Phase 5 — Mobile Platform Layer (Capacitor / Touch / Audio)

**Branch:** `feat/phase-5-mobile-platform` · **Effort:** 8–10 developer-days (design §5)

**Goal:** The game running as a landscape iOS Capacitor app: floating touch joystick +
button injection, safe areas, lifecycle auto-pause, WebAudio SFX/music, haptics.

**Key deliverables**
- `capacitor.config.ts`, iOS project, plist (landscape-only), icon/splash
- `src/core/touch.ts` TouchControls (joystick with `Touch.identifier` ownership,
  `injectPress` buffer) plugged into `Input.beginFrame()`; pause button; safe-area CSS
- `src/platform/lifecycle.ts` (`Game.autoPause()` on hide/pause), `platform/audio.ts`
  (bus-driven WebAudio + `src/content/audio.json`), `platform/haptics.ts`
- All platform modules bus-driven — `simulation.test.ts` stays headless-clean

**Dependencies:** Phases 1–2 (blood buttons + ability button are the touch consumers);
realistically all gameplay merged. Art pipeline output lands independently.

**Exit criteria**
- [ ] `npm run build && npx cap sync ios` succeeds from a clean checkout
- [ ] **On-device 60fps** during a minute-10 horde on the oldest target device
      (iPhone SE class), verified with the F3 overlay
- [ ] 3-finger test: joystick + ability + blood buttons all respond with no stolen
      touches; `npm test` green including a new harness test injecting synthetic
      presses through `Input` (ordering identical to keyboard)
- [ ] Backgrounding auto-pauses; resume does not burst catch-up ticks; audio unlocks on
      first touch and ducks on hide
- [ ] Squash-merged to `main`

---

## Phase 6 — Monetization Wiring (IAP / Rewarded Ads)

**Branch:** `feat/phase-6-monetization` · **Effort:** ~5–6 developer-days (the
AdMob/IAP/QA half of design §4's 8–12d)

**Goal:** Free-to-play loop live: rewarded revive / gold-double / daily chest, IAP
catalog (remove-ads premium, character pack, gold packs) with restore, App Store
compliance (ATT, privacy manifest).

**Key deliverables**
- `services/ads.ts` (AdMob, ATT handling, offer gates + daily caps in `adState`),
  `services/iap.ts` (StoreKit behind an interface)
- `player:died` intercept → `showReviveOffer()` → `revivePlayer(ctx)` (extracted in
  `player.ts`); gold-double on results; daily chest on title
- Loop accumulated-time drop on resume from fullscreen ad; shop screen wiring;
  `PrivacyInfo.xcprivacy` + App Privacy answers

**Dependencies:** Phase 4 (save/services layer, wallet) and Phase 5 (Capacitor shell,
ATT prompt, lifecycle).

**Exit criteria**
- [ ] `npm test` green plus unit tests for ad caps (1 revive/run, 3/day, chest 1/24h)
      and entitlement gating running against `MemoryStore`
- [ ] Sandbox on device: each IAP purchases and **restores**; rewarded revive resumes
      the run without a catch-up burst
- [ ] Airplane-mode run: fully playable, no ad buttons rendered, no errors thrown
- [ ] Engine-isolation grep gate still clean (engine never imports services)
- [ ] Squash-merged to `main`

---

## Parallel Track — Art Direction & AI Pixel-Art Pipeline

**Branches:** `feat/art-<batch>` per asset batch · **Effort:** 8–12 developer-days
(design §6) · **Runs in parallel from Phase 2 onward.**

The placeholder-sprite system means every mechanic is playable before art lands and PNG
drop-ins need zero code changes, so this track never blocks the phase sequence. Order:
palette + style-key sheet (approval gate) → `scripts/validate-art.mjs` → characters →
tiles → enemies → pickups/FX → structures → decor → UI pack + `style.css` reskin →
icon/screenshots.

**Dependencies:** style-key approval only; structure sprites (batch 7) wait for Phase 3's
`structures.json` ids; ability icons (batch within UI pack) wait for Phase 2's icon ids.

**Exit criteria**
- [ ] `npm run validate:art` green for every landed strip (square-frame convention,
      tile sizes match maps)
- [ ] Per-batch in-game screenshot review at 480×270 integer scale accepted
- [ ] All ~75 strips + 12 tiles + UI/store pack landed; zero `placeholder art: N` line
      in the F3 debug overlay on all maps/characters

---

## Effort summary

| Phase | Estimate | Cumulative |
|---|---|---|
| 1 Blood Economy | 3–4 d | 3–4 d |
| 2 Active Abilities | 4–6 d | 7–10 d |
| 3 Castle Defense | 4–6 d | 11–16 d |
| 4 Meta-Progression + Save | ~5–6 d | 16–22 d |
| 5 Mobile Platform | 8–10 d | 24–32 d |
| 6 Monetization | ~5–6 d | 29–38 d |
| Art (parallel from Phase 2) | 8–12 d | — |
| **Total** | **35–50 developer-days** (design §7) | |

## Process rules

1. **Just-in-time planning.** Only the *next* phase ever has a detailed task-level plan.
   After each phase's squash merge, run a reassessment (what did we learn? are the
   remaining phases still scoped right?) and only then write the next phase's plan.
2. **Suite green at every commit** inside a phase branch; `tsc` is the gate (no linter).
3. **Tick/harness edits are atomic** — `Game.tick()` and `makeHarness()` change in the
   same commit, always.
4. **Cross-cutting risks** (design §8) are re-checked at each phase boundary: bottom
   thumb-zone conflicts (phases 1/2/5), engine-invariant regressions (1/2/3), stacked
   balance (1/2/3/4), iOS compliance (5/6), art consistency (parallel track).
