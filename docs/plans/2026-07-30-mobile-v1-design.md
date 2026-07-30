# Vampire Knights — Mobile v1 Design Document (Draft)

> Draft assembled from six parallel domain designs. Source codebase: the custom-TypeScript-engine
> Vampire-Survivors-style arena game at `/Users/boraesen/Desktop/Vampire_knights`.

## Context — locked product decisions

Vampire Knights v1 ships as a **Capacitor-wrapped iOS app** built on the existing custom TypeScript
engine (fixed-timestep sim, SoA ECS, DOM-over-canvas UI, 480x270 pixel buffer, headless
`simulation.test.ts` harness). The product identity is a **gothic vampire-knight fantasy**: the
player is a vampire knight defending against a human hunter army. v1 adds exactly **three new
gameplay mechanics** — the Blood Economy (Feast vs Frenzy), per-character Active Abilities, and
Castle Defense objectives (siege waves against defendable structures) — plus **several playable
characters** (five gothic kits, each with a unique active ability). All visual assets are produced
through an **AI pixel-art pipeline** with a strict 10-color gothic palette and validation tooling.
The business model is **free-to-play with rewarded ads (revive, gold double, daily chest) and IAP**
(remove-ads/premium, character pack, gold packs), supported by a persistent **meta-progression
layer** (Sanctum gold-sink upgrade tree, character unlocks, versioned local saves). Non-negotiable
engine invariants carry through every domain: determinism (all randomness via `ctx.rng`, timers on
`run.time`), `run.stats` never mutated outside `recomputeStats()`, `Game.tick()` mirrored verbatim
in `makeHarness()`, warn-don't-throw content normalization, and the engine never importing
platform/services code.

---

## 1. Blood Economy (`blood-economy`)

### Design

### Blood Economy — Design

#### State & ownership
Blood is run-scoped progression, so it lives on `Run` (`src/gameplay/run.ts`): `blood` (0..`bloodMax`), `bloodIntakeWindow` (anti-farm accumulator, keyed to `run.time`, not wall clock — determinism), `frenzyT` (seconds of active burst), `graceT` (decay grace). Player intent is per-tick input, so `bloodIntent: 'heal' | 'burst' | null` goes on `Ctx` (`context.ts`), initialized in Game's constructor AND `makeHarness()`, reset in `startRun()` (per the Ctx-field rule in CLAUDE.md).

#### Drop rules
- **Every death through `killEnemy` grants blood directly** — no pickup entity for normal kills (zero entity pressure at 400 maxAlive). Add `run.gainBlood(def.blood * run.stats.bloodGain)` next to `run.kills++` in `damage.ts::killEnemy`.
- **Per-enemy `blood` field** in `enemies.json`, defaulted in `content.ts::normalizeEnemies` (default 1; swarm-tier 0.5; elite 8). Warn-don't-throw as usual.
- **Elites/bosses additionally drop a Blood Vial pickup** (new `PickupKind.BloodVial`, `spawnBloodVial` in `pickups.ts`, `collect` case grants 25, magnet-attracted like gems; `sprites.json` entry with placeholder shape/color — playable before art).
- **Anti-farm**: intake capped at **12 blood/sec** — `gainBlood` accumulates into `bloodIntakeWindow`, excess is discarded; window resets each sim-second in `updateBlood`. Kills from `clearNearbyEnemies` (revive) route through `killEnemy` too; the cap makes that a non-issue.

#### Bar, threshold, decay
`bloodMax = 100`, spend threshold = **50**. Spending consumes ALL current blood, and effects scale per blood spent — spending at 100 is meaningfully stronger, creating a "cash out now or ride it" decision. Below 50: no decay. At/above 50: after a **4s** grace with no gain, decays **1.5/sec** down to 49 — use-it-or-lose-it, no infinite banking.

#### The choice — Feast vs Frenzy
New system `src/gameplay/blood.ts::updateBlood(ctx, dt)`, inserted in `Game.tick()` after `updatePickups` (step 7, after all damage resolution) and mirrored verbatim in `makeHarness`. It: ticks decay/grace/frenzy timers, then consumes `ctx.bloodIntent` (ignored + cleared if `blood < 50`):
- **Feast (heal)**: heal `0.5% maxHp per blood` via existing `pickups.ts::healPlayer` (emits `player:healed`). 50 blood = 25% maxHp, 100 = 50%.
- **Frenzy (burst)**: duration `3s + 0.06s/blood` (50→6s, 100→9s). While `frenzyT > 0`, `weapons.ts::effectiveStats()` — the single sanctioned passives-meet-weapons point — multiplies damage ×1.4 and cooldown ×0.75; `updatePlayer` reads +15% moveSpeed the same way. **Never mutates `run.stats`** (invariant preserved). On cast: instant nova — `enemyHash` query into `ctx.scratch`, exact distance test + `isAlive`, `damageEnemy` for `30 × might` in radius 80 (single-tick one-shot, no `registerHit` needed; zero allocs).

#### Input (mobile-first)
HUD is DOM over canvas, so the choice is **two persistent tap buttons flanking a blood orb, bottom-center thumb zone**. `pointerdown` → callback injected by `game.ts` → sets `ctx.bloodIntent` (latched; consumed next sim tick — survives the 0..5-updates-per-frame reality). Desktop: `KeyQ`/`KeyE` handled in `beforeFrame` only (edge-triggered rule), distinct from Escape so `wasPressed` consumption order is safe. Key hints hidden via `@media (pointer: coarse)`. Works unchanged in the Capacitor WebView.

#### HUD
Orb: `calc(var(--u) * 22)` circle, inner fill div height %-driven, cache-guarded at whole percents (same pattern as `Hud.cache.hp`); buttons `calc(var(--u) * 16)`, disabled styling below 50. `blood:ready` toggles a CSS pulse class. Read `run.blood` in `Hud.update()` each frame (it already receives `run`).

#### Events (`src/core/events.ts::GameEvents`)
`'blood:gained': {amount, blood, max}` · `'blood:ready': undefined` · `'blood:feast': {spent, healed}` · `'blood:frenzy': {spent, duration}`.

#### Content schema
- `enemies.json`: optional `"blood": number` per enemy.
- New `src/content/blood.json`: `{ "barMax": 100, "threshold": 50, "intakePerSec": 12, "decayPerSec": 1.5, "decayGrace": 4, "healPerBlood": 0.005, "frenzy": { "baseDuration": 3, "durationPerBlood": 0.06, "mightMult": 1.4, "cooldownMult": 0.75, "moveSpeedMult": 1.15, "novaDamage": 30, "novaRadius": 80 } }` — normalized with defaults in `content.ts` (warn-don't-throw), hot-reloads like all content.
- `characters.json` stats gain `bloodGain` (defaulted 1 in normalize; a vampire-lord character ships 1.25 — character differentiation hook).
- `passives.json`: new valid key `bloodGain` → "Bloodthirst" passive, `perLevel: 0.1`, folded in `recomputeStats()`.

#### Starting tuning numbers
1. Basic kill = 1 blood, swarm 0.5, elite 8, boss vial 25. 2. Intake cap 12/sec. 3. Bar 100, threshold 50. 4. Decay 1.5/sec after 4s grace, above threshold only. 5. Feast 0.5% maxHp per blood. 6. Frenzy ×1.4 dmg / ×0.75 cd, 3s + 0.06s/blood, nova 30×might @ r80.

#### Headless tests (`simulation.test.ts`)
(a) kill N enemies via `damageEnemy` → `run.blood` matches defs; (b) 100 kills in 1s → intake ≤ cap; (c) `run.blood=100; ctx.bloodIntent='heal'` → hp +50% maxHp, blood 0, `blood:feast` seen on bus; (d) `bloodIntent='burst'` → `effectiveStats` damage ×1.4 during frenzy, reverts after expiry; nova kills a planted 1-hp ring of enemies; (e) blood=30 + intent → no-op, intent cleared; (f) decay: blood=60, `run(6)` no kills → ~49; (g) 15-min full-run test still green (determinism + entity-leak guard).
### Integration points

- src/gameplay/damage.ts::killEnemy — add run.gainBlood(def.blood * stats.bloodGain) beside run.kills++; elite/boss branch also calls spawnBloodVial
- src/gameplay/run.ts::Run — new fields blood/bloodMax/bloodIntakeWindow/frenzyT/graceT + gainBlood() with intake cap; bloodGain folded into recomputeStats() StatMods
- src/gameplay/blood.ts (NEW) — updateBlood(ctx, dt): decay, frenzy countdown, consume ctx.bloodIntent, feast via healPlayer, frenzy nova via enemyHash + ctx.scratch + damageEnemy
- src/game.ts — tick(): insert updateBlood after updatePickups (step 7); beforeFrame: KeyQ/KeyE → ctx.bloodIntent; startRun(): reset ctx.bloodIntent; wire Hud button callbacks
- src/gameplay/context.ts::Ctx — add bloodIntent: 'heal' | 'burst' | null
- src/core/events.ts::GameEvents — blood:gained, blood:ready, blood:feast, blood:frenzy
- src/gameplay/content.ts — normalizeEnemies: default blood field; passive key whitelist += bloodGain; character stats default bloodGain=1; load+normalize new blood.json (warn-don't-throw)
- src/gameplay/weapons.ts::effectiveStats — apply frenzy might/cooldown multipliers when run.frenzyT > 0 (read-only, run.stats untouched)
- src/gameplay/player.ts::updatePlayer — frenzy moveSpeed multiplier
- src/gameplay/pickups.ts — PickupKind.BloodVial, spawnBloodVial(), collect() case
- src/content/enemies.json, characters.json, passives.json, sprites.json + NEW src/content/blood.json
- src/ui/hud.ts::Hud — blood orb + two tap buttons (pointerdown → injected callback), cache-guarded fill in update(), pulse class on blood:ready
- src/ui/style.css — .blood-orb/.blood-btn sized in calc(var(--u)*N), @media (pointer:coarse) hides key hints
- src/gameplay/simulation.test.ts — makeHarness(): init ctx.bloodIntent + duplicate updateBlood in tick order; ~7 new tests
### Risks

- Feast overlaps with existing Meat pickup (heals 20% maxHp via luck roll in killEnemy) — two sustain sources may trivialize damage. Mitigation: treat blood as the reliable sustain, halve MEAT_CHANCE in the same PR, and let the (b)/(c) tests plus manual runs confirm effective HP/min stays near pre-change levels.
- Frenzy buff path could tempt mutating run.stats (forbidden invariant). Mitigation: buff is exclusively read-side multipliers in effectiveStats/updatePlayer gated on run.frenzyT; add a test asserting run.stats is identical before/during/after frenzy.
- Mobile tap buttons sit in the same bottom zone a future virtual movement joystick will want; taps may conflict with movement touches. Mitigation: bottom-CENTER cluster with stopPropagation on pointerdown, and lock the joystick to bottom-left/right zones when touch movement lands (flagged as an open item for the Capacitor input pass).
- Intake cap + decay use run.time-based windows; any wall-clock leak breaks seed reproducibility and the 15-min test. Mitigation: all timers advance only inside updateBlood(dt); test (g) is the tripwire.
- Balance of frenzy (x1.4 dmg, x0.75 cd) may snowball with high-might builds late game. Mitigation: numbers live in blood.json (hot-reload tuning); consider a soft cap (frenzy duration cap 10s) if playtests show permanent uptime.
### Effort estimate

3-4 developer-days: ~1d core sim (Run fields, blood.ts, killEnemy, content normalize), ~0.5d HUD/CSS/input wiring, ~0.5d content JSON + vial pickup, ~1d tests + determinism verification, ~0.5-1d tuning passes in dev server.

---

## 2. Character Active Abilities (`active-abilities`)

### Design

### Character Active Ability System — Vampire Knights

#### Cooldown model & state location
Ability state lives on `Run` (`src/gameplay/run.ts`), mirroring the existing `OwnedWeapon.timer` precedent (weapon cooldowns already live on Run structures and are ticked by gameplay systems). New `Run.ability: AbilityState | null`:

```ts
interface AbilityState {
  def: AbilityDef;
  cooldownLeft: number;  // 0 = ready
  activeLeft: number;    // buff window / dash iframes remaining
  burstLeft: number;     // volley: shots still queued
  burstTimer: number;
}
```
A new `Run` per run auto-resets it. Logic is a stateless free function `updateAbility(ctx, dt)` in new `src/gameplay/abilities.ts` (matches the `fn(ctx, dt)` system pattern; gameplay never touches UI, emits `'ability:used'` on `ctx.bus`).

**Tick insertion (both `Game.tick()` and `makeHarness()` verbatim):** step 6 becomes `updateEnemyProjectiles → updateAbility → updateWeapons → updatePlayerProjectiles → updateHazards` — after enemyHash rebuild #2 (required for new damage systems), before `updateWeapons` so buff activation affects same-tick `effectiveStats()`.

#### Input
`update()` runs 0..5×/frame, so edge input can't be read in-sim. New Ctx field `abilityQueued: boolean` (init in Game ctor + `makeHarness`, reset in `startRun()` per the Ctx rule). In Game's `beforeFrame` edge-input block: `if (state==='playing' && input.wasPressed('Space')) ctx.abilityQueued = true`. `updateAbility` consumes the latch; it survives 0-update frames, so no lost presses. Touch button and gamepad both use the existing synthetic-press path: add `Input.injectPress(code)` (gamepad already injects synthetic 'Enter'/'Escape' in `readGamepad()`); HUD button `pointerdown` (preventDefault, not click — kills iOS delay/double-fire) → `injectPress('Space')`; gamepad face button maps to 'Space' the same way. One code path, order-safe with consuming `wasPressed`.

#### Reuse vs new code
Abilities fire through the existing spawn primitives — export `spawnProjectile`, `spawnHazard`, `nearestEnemy` from `weapons.ts`. Both take `WeaponStats`, so a helper `abilityStats(run, def)` builds `WEAPON_STAT_DEFAULTS + def.params`, scaling damage×`might`, radius/area×`area`, lifetime×`duration` (explicitly NOT `cooldown`/`amount`). Spawned entities are ordinary `Kind.Projectile`/`Kind.Hazard`, `Team.Player` — damage, pierce dedup (`registerHit`), lifetimes, rendering all ride `updatePlayerProjectiles`/`updateHazards` unchanged. Zero new damage code for 3 of 5 kinds. All spawns check `create() === -1` skip; all randomness via `ctx.rng`.

Five ability kinds (whitelist const `ABILITY_KINDS`, like `WeaponBehavior`):
- `nova` — projectile ring (pure reuse, mirrors `fireNova`)
- `volley` — N homing shots over time (reuse + `burstLeft/burstTimer`)
- `zone` — big hazard (pure `spawnHazard` reuse)
- `buff` — temp stat mods; `recomputeStats()` gains a third source (character base + passives + active ability mods), called on activate/expire — on-state-change, not per-tick, so the "never per tick" invariant holds
- `dash` — new code (~30 lines): displace player along `ctx.aimX/aimY` in 4 substeps through `map.resolveTiles/resolveSolids/clampToBounds` (reusing `updatePlayer`'s clamps), set `world.iframe[player]`, drop trail hazards

#### characters.json schema (normalized in `normalizeCharacters()`)
```jsonc
"ability": {
  "name": "Mist Dash", "description": "...", "icon": "ability_dash",
  "kind": "dash", "cooldown": 12, "duration": 0.6,
  "params": { "distance": 80, "trailCount": 3, "damage": 6, "radius": 18, "interval": 0.5, "lifetime": 2.5 }
}
```
Warn-don't-throw: unknown `kind` → ability omitted + `warnOnce`, character stays playable. Missing params → per-kind defaults. `icon` goes through sprites.json placeholders (PNG drop-in later, zero code).

#### HUD button
DOM over canvas (`hud.ts`): `.ability-btn` bottom-right, `calc(var(--u) * 30)` circle, icon via the same sprite pipeline `syncLoadout` uses. Cooldown radial: child div `background: conic-gradient(rgba(0,0,0,.65) var(--cd), transparent 0)`; `Hud.update(run, …)` already receives `run` — poll `run.ability`, write `--cd` cache-guarded to whole percents (existing `cache` pattern). `ready` class pulses; `active` class shows duration ring. "SPACE" hint hidden under `@media (pointer: coarse)`.

#### Five kits
1. **Ser Valen, the Bloodsworn** (whip). Passive: might 1.1, all-rounder. **Crimson Cleave** (`nova`): 10 blades, 40×might dmg, speed 150, pierce 3, knockback 200, lifetime 0.6s. CD 18s.
2. **Lady Morrigan of the Mist** (wand). Passive: growth 1.3, luck 1.1, maxHp 80. **Night Swarm** (`volley`): 12 homing bats over 2.4s, 14×might each, speed 160, turnRate 7. CD 20s.
3. **Ser Aldric the Sworn** (garlic). Passive: armor 2, recovery 0.3, revives 1, moveSpeed 56. **Sanguine Bulwark** (`buff`): +10 armor for 5s + instant 20 HP. CD 25s (20% uptime).
4. **Vespera, the Pale Outrider** (knife). Passive: moveSpeed 74, crit 0.06/×2.2. **Mist Dash** (`dash`): 80-unit dash, 0.6s iframes, 3 mist hazards (r18, 6×might per 0.5s, 2.5s). CD 12s.
5. **Castellan Dragos** (NEW, drop-behavior weapon). Passive: area 1.2, duration 1.2, maxHp 120, moveSpeed 58 — zone controller, synergizes with castle defense. **Unhallowed Ground** (`zone`): hazard r55×area, 12×might per 0.4s, knockback 120, 6s×duration. CD 22s.

#### Balance guardrails
Cooldowns 12–30s; ability ≤ ~25% of total DPS; damage scales only via might/area/duration; `cooldown` stat never reduces ability CD (v1); buff uptime ≤ 40% (CD ≥ 2.5× duration); dash ≤ 100 units (stays inside 480×270 view) and always map-clamped; volley count ≤ 16 (pool pressure); iframes ≤ 0.8s.

#### Headless tests (`simulation.test.ts`)
- Per character (loop `CHARACTER_LIST`): set `ctx.abilityQueued = true`, `run(1)` → `cooldownLeft ≈ def.cooldown`, Team.Player projectiles/hazards exist, no throw.
- Cooldown gate: two queued presses inside CD → exactly one activation.
- Determinism: same seed + scripted presses at fixed times → identical `run.kills` at 60s across two harnesses.
- Buff: Aldric activate → `run.stats.armor` +10; after 5s → restored to base (recomputeStats round-trip).
- Dash: displacement ≤ distance, position within map bounds, `world.iframe[player] > 0`.
- Fail-soft: character def with `kind: "bogus"` → loads, `ability === null`, warning only.
- Leak: 15-min run auto-pressing every off-cooldown → concurrent entities < 4000.
### Integration points

- src/gameplay/content.ts — normalizeCharacters(): add AbilityDef interface + ABILITY_KINDS whitelist const (pattern: WeaponBehavior), normalize ability block with per-kind param defaults, warn-don't-throw on unknown kind; extend CharacterDef with ability: AbilityDef | null
- src/content/characters.json — add ability block to all characters; rework 4 existing entries into the gothic kits; add 5th character (dragos); sprites.json gains ability_* icon entries with placeholders
- src/gameplay/run.ts — Run: new ability: AbilityState | null field (init in constructor from characterDef, mirrors OwnedWeapon.timer pattern); recomputeStats() merges a third modifier source (active ability buff) so run.stats is never mutated directly
- src/gameplay/abilities.ts (NEW) — updateAbility(ctx, dt) free function, per-kind activate functions, abilityStats(run, def) helper mapping params onto WeaponStats
- src/gameplay/weapons.ts — export spawnProjectile, spawnHazard, nearestEnemy (currently module-local) for reuse by abilities.ts
- src/gameplay/context.ts — Ctx: new abilityQueued: boolean latch field
- src/game.ts — constructor: init ctx.abilityQueued; startRun(): reset it; beforeFrame edge-input block: latch input.wasPressed('Space'); tick(): insert updateAbility between updateEnemyProjectiles and updateWeapons (after enemyHash rebuild #2)
- src/core/input.ts — Input: new public injectPress(code) (generalizes the existing gamepad synthetic-press mechanism in readGamepad); map a gamepad face button to synthetic 'Space'
- src/ui/hud.ts — Hud constructor: .ability-btn element with sprite icon (reuse syncLoadout icon path), pointerdown → input.injectPress('Space'); Hud.update(): poll run.ability, set --cd conic-gradient var cache-guarded, toggle ready/active classes
- src/ui/style.css — .ability-btn styles, conic-gradient cooldown sweep, ready pulse, @media (pointer: coarse) to hide the SPACE hint
- src/core/events.ts — GameEvents: add 'ability:used': { id: string } (future SFX/analytics; HUD itself polls via update)
- src/gameplay/simulation.test.ts — makeHarness(): mirror ctx.abilityQueued init + the tick-order change verbatim (harness duplicates Game.tick); add the 7 new test groups
### Risks

- Edge-input loss when update runs 0 times per frame (fixed-timestep catchup) — mitigated by the latch-until-consumed ctx.abilityQueued flag set in beforeFrame, consumed only inside the sim; a press can never fall between frames.
- Temp buffs via recomputeStats() could drift the 'runs only on loadout change' invariant — activation/expiry are state-change events (not per-tick), documented in CLAUDE.md; a round-trip test asserts stats restore exactly to base after expiry.
- Dash through map solids or off-map — mitigated by substepping the dash through the exact same map.resolveTiles/resolveSolids/clampToBounds calls updatePlayer uses; headless test asserts bounds (stubMap has no collision, so dev-mode manual check on a collision map is also needed).
- iOS touch double-fire / 300ms delay on the DOM button under Capacitor WebView — mitigated by pointerdown + preventDefault (never click), and routing through the same synthetic-press path as gamepad so there is one input code path; verify on device before ship.
- Determinism break if any ability path reaches fxRng or Math.random — guardrail: abilities.ts imports only ctx.rng; the two-harness same-seed test catches regressions.
- Balance: abilities stacking on top of weapon DPS could trivialize early waves — numeric guardrails (CD 12–30s, might-only scaling, ≤40% buff uptime) plus a headless kills-delta sanity test; final tuning stays a dev-mode playtest task.
- Open question: should meta-progression (gold upgrades) later reduce ability cooldowns? Deferred — AbilityState reads def.cooldown through one place (updateAbility), so a future multiplier slots in without schema change.
### Effort estimate

4-6 developer-days: core system + content normalization 1.5d, dash/volley/buff kinds 1d, HUD button + touch input 1d, 5 kits data + placeholder icons + balance pass 1d, headless tests + device verification 1d.

---

## 3. Castle Defense Objectives (`castle-defense`)

### Design

### Castle Defense Objectives — v1 Design

#### Structures = new `Kind.Structure` (7th kind)
Add `Structure: 6` to `Kind` in `src/ecs/components.ts` and bump `KIND_COUNT` 6→7 in `src/ecs/world.ts`. A structure is a static entity: `Comp.Transform | Comp.Sprite | Comp.Health | Comp.Collider`, `Team.Player`, no Velocity/Pushable — `snapshotPositions` makes prev==current so interpolation is free. Reusing Hazard or props doesn't work: Hazard is a damaging area, props live in TileMap with no HP/events. Weapons only query `enemyHash`, so structures never take friendly fire for free.

Defs in new `src/content/structures.json` (`gate`, `shrine`): `{ name, sprite, hp, radius, solid, gold }`, normalized in `content.ts` via `normalizeStructures()` + `structureDef()` with the same warn-don't-throw contract. Placeholder sprites (`shape: "square"`, gothic palette) in `sprites.json` — playable before art.

Solidity: `TileMap` gains `addRuntimeSolid(x,y,r): number` / `clearRuntimeSolids()` (pushes into the existing `solids: Solid[]` that `resolveSolids` already checks for both player and enemies). Maps are cached in `Game.mapCache`, so `startRun()` calls `clearRuntimeSolids()` every run; `destroyStructure` removes its solid (gate breach opens the wall).

#### Map schema (optional per map)
Map JSON gains optional `"structures": [{ "type": "gate", "x": -120, "y": 0 }]`. `TileMap.load` just parses it onto `map.structures` (default `[]`). `Game.startRun()` spawns them after `spawnPlayer` via `spawnStructure(ctx, def, x, y)`. Meadow/crypt/arena have no array → zero behavior change. Ship one new map `src/content/maps/bastion.json` (auto-discovered by `import.meta.glob`) with 2 structures.

#### New system: `src/gameplay/structures.ts`
- `spawnStructure()` — place, register runtime solid, store solid index in `world.value`.
- `damageStructure(ctx, id, amount)` — mirrors `damageEnemy`: hp, hitFlash, `fx.damageNumber`, emit `structure:damaged`; at 0 hp → shockwave, remove solid, `run.structuresLost++`, emit `structure:destroyed`, `world.destroy(id)` (deferred, flushed at tick end).
- `updateStructures(ctx, dt)` — decay hitFlash, smoke fx below 30% hp. Runs in `Game.tick()` after `updateHazards`, before `pickupHash.build` (deals no damage, so hash rebuild #2 position is irrelevant). Mirror the line in the test harness tick verbatim.

#### Enemy targeting — a target handle, not a new Behavior
New array `world.targetHandle = new Float64Array(MAX_ENTITIES)` (Float64 because `handleOf` packs `id + gen*16384`, which exceeds Int32 range) + reset line `targetHandle[id] = -1` in `World.create()`. No new Behavior values — siege enemies keep chase/hopper/charger movement code.

In `updateEnemies` top of loop: `const tid = world.resolve(world.targetHandle[id])`. If `tid >= 0`, substitute the structure's x/y for `px/py` when computing `toward` — every melee behavior now marches at the structure unchanged. Rules:
- **Attack**: on touch (`radius + structRadius`), zero velocity and call `damageStructure` gated by `hitCooldown` (0.8s). `hitCooldown` is only used by `Behavior.Ranged`, so restrict siege to melee behaviors — no conflict.
- **Retarget**: handle resolves -1 (structure died/recycled) → clear to -1, resume player chase. Player within 56u → clear target (peeling enemies off the gate is the counterplay).
- **Culling**: skip the `CULL_DISTANCE` destroy when the target resolves alive, otherwise attackers evaporate when the player kites away. The 4000-entity leak test bounds this.

#### Siege waves (`waves.json`)
`WaveTable` gains `sieges: SiegeEvent[]` (default `[]` in `normalizeWaves`): `{ "at": 300, "type": "footman", "count": 10, "duration": 45 }`. `Spawner` gets `nextSiege`, `siegeEndsAt` (reset in `reset()`) and `updateSieges()` mirroring `updateBosses()`: at `at`, spawn `count` via `offscreenSpawnPoint`, assign each the nearest living structure's handle (iterate `world.list(Kind.Structure)` — ≤4 entries, no hash needed), emit `siege:started`. **No living structures → spawn targeting the player, no crash** — sieges degrade gracefully on structure-less maps.

#### Fail / reward
- **Siege survived** (`siegeEndsAt` passes with ≥1 structure alive): `spawnChest` + `spawnCoin(def.gold)` at the surviving structure, emit `siege:defended` (blood-economy system can subscribe for a blood payout).
- **Structure lost**: `difficultyAt()` in `spawner.ts` multiplies damage/speed by `1 + 0.08 * ctx.run.structuresLost` ("the hunters grow bolder") — `structuresLost = 0` field on `Run`. Losing everything is not a run fail; player death stays the only fail state.

#### Events + HUD
`GameEvents` (`src/core/events.ts`): `structure:damaged {hp,maxHp,index}`, `structure:destroyed {name,remaining}`, `siege:started {duration}`, `siege:defended {gold}`. `Hud`: reuse `showBanner` ("SIEGE!" / "THE GATE HAS FALLEN"); add a pip row (one HP bar per structure, DOM, updated event-driven like `hp-fill`). Off-screen indicator: during an active siege, `Game.render()` queues each off-screen structure's sprite at scale 0.5 clamped 8px inside the 480×270 buffer edge — inline math, zero allocation, drawn before `flushSprites()`.

#### Tests (`simulation.test.ts`)
`stubMap()` gains `structures: []` + no-op solid methods; harness tick gains the `updateStructures` line. Tests: (1) siege enemy reaches structure, stops, hp drops on cadence; (2) structure destroyed → attacker resumes chasing player; (3) stale-handle: destroy + flush + recycle id → `resolve` returns -1, no misdirected attacks; (4) siege survived → chest in `world.list(Kind.Pickup)` + `siege:defended` fired; (5) sieges on a structure-less map target the player; (6) 15-min full-run leak test still bounded. All randomness stays on `ctx.rng`.
### Integration points

- src/ecs/components.ts — add Kind.Structure = 6 to the Kind const
- src/ecs/world.ts — KIND_COUNT 6→7; new targetHandle Float64Array; reset line (targetHandle[id] = -1) in World.create()
- src/gameplay/structures.ts — NEW: spawnStructure / damageStructure / updateStructures
- src/content/structures.json — NEW structure defs; src/gameplay/content.ts gains normalizeStructures() + structureDef() (warn-don't-throw)
- src/gameplay/content.ts normalizeWaves() + WaveTable interface — new sieges: SiegeEvent[] field, default []
- src/gameplay/enemies.ts updateEnemies() — resolve targetHandle at loop top, substitute target position for px/py, touch-attack via hitCooldown, retarget/peel rules, skip cull while target alive
- src/gameplay/spawner.ts — Spawner.nextSiege/siegeEndsAt + updateSieges() (mirrors updateBosses), reward on siege end; difficultyAt() multiplies by 1 + 0.08 * ctx.run.structuresLost
- src/gameplay/run.ts — structuresLost = 0 field on Run
- src/game.ts — startRun(): clearRuntimeSolids + spawn map.structures after spawnPlayer; tick(): updateStructures after updateHazards; render(): queueKind(Kind.Structure) + off-screen edge markers before flushSprites()
- src/render/tilemap.ts — map.structures parsed from map JSON; addRuntimeSolid()/clearRuntimeSolids() on the existing solids array
- src/core/events.ts GameEvents — structure:damaged, structure:destroyed, siege:started, siege:defended
- src/ui/hud.ts — structure HP pip row + reuse showBanner for siege start/loss
- src/content/sprites.json + src/content/waves.json + src/content/maps/bastion.json — placeholder sprites, a sieges block, one map with structures
- src/gameplay/simulation.test.ts — stubMap() structures + solid no-ops; harness tick gains updateStructures line (must mirror Game.tick verbatim); 6 new tests
### Risks

- Cull exemption for siege enemies can inflate entity counts if the player kites far away while a siege runs — Mitigation: exemption applies only while the handle resolves alive; siege duration is bounded (45s) and the existing >4000-entity full-run test is extended to cover a siege window.
- Tick-order drift between Game.tick and the test harness (they must stay verbatim-identical) — Mitigation: the updateStructures insertion is a single line added to both in the same commit; test (1) fails immediately if the harness lags.
- Runtime solids on cached TileMaps leak across restarts or fight prop solids — Mitigation: clearRuntimeSolids() called unconditionally in startRun(); runtime solids appended after props and tracked by index so destroyStructure removes exactly its own.
- Enemies pathing into a solid structure they target could jitter against their own goal collider (resolveSolids pushes them out each tick while AI pushes in) — Mitigation: stop-at-touch check runs before integration (velocity zeroed at radius + structRadius), so they halt just outside the solid; test (1) asserts a stable standoff distance.
- hitCooldown is reused for siege attack cadence and already drives Ranged shooting — Mitigation: siege targeting restricted to melee behaviors (chase/hopper/charger) in updateSieges; a Ranged type in a siege entry is warned and spawned as a normal player-chaser (warn-don't-throw).
- Difficulty penalty for lost structures (1 + 0.08×lost) may be too punishing or too invisible — Mitigation: single constant in difficultyAt, tunable; structure:destroyed banner makes the cause legible; balance pass during the headless full-run sim before shipping.
### Effort estimate

4-6 developer-days: ~1d ECS/content plumbing (Kind, targetHandle, structures.json, map/wave schema), ~1.5d enemies.ts targeting + spawner sieges + structures.ts, ~1d HUD pips/banners/edge markers, ~1d headless tests + full-run balance pass, ~0.5d bastion map + placeholder sprites.

---

## 4. Meta-Progression & Monetization (`meta-monetization`)

### Design

### Meta-Progression + Monetization Design

#### 1. Sanctum upgrade tree (gold sink)

New `src/content/meta.json`, normalized in `content.ts` via `normalizeMeta()` (same warn-don't-throw pattern as `normalizePassives`, validating against `STAT_MOD_KEYS`). Each node: `{ name, description, maxRank, costs: number[], perRank: Partial<StatMods> & { revives?: number } }`. 10 nodes:

| Node | perRank | Ranks | Costs (gold) |
|---|---|---|---|
| Bloodthirst | might +0.05 | 5 | 100/250/600/1400/3000 |
| Vitality | maxHpMul +0.10 | 3 | 150/400/1000 |
| Iron Skin | armor +1 | 3 | 200/500/1200 |
| Swiftness | moveSpeedMul +0.03 | 3 | 150/400/1000 |
| Haste | cooldown −0.025 | 4 | 250/600/1500/3500 |
| Greed | greed +0.10 | 5 | 100/250/600/1400/3000 |
| Scholar | growth +0.08 | 5 | 120/300/700/1600/3200 |
| Magnetism | magnetMul +0.15 | 3 | 80/200/500 |
| Fortune | luck +0.10 | 3 | 200/500/1200 |
| Second Wind | revives +1 | 1 | 5000 |

Total sink ≈ 42k gold; all numbers live in JSON for tuning.

**Run integration:** `Run` constructor becomes `constructor(characterId: string, metaMods: MetaMods = {})`. In `recomputeStats()` (run.ts:148), seed the `sum: StatMods` accumulator from `metaMods` instead of zeros before the passive loop — existing clamps (`MIN_COOLDOWN_MUL`, area/duration floors, crit clamp) apply unchanged. `revives` handled separately: `this.revivesLeft = base.revives + (metaMods.revives ?? 0)`. Default `{}` keeps `makeHarness` and all existing tests byte-identical.

#### 2. Services layer (engine isolation)

New `src/services/` — the engine (`core/`, `ecs/`, `gameplay/`, `render/`) never imports it; only `main.ts`, `game.ts`, `ui/screens.ts` do:
- `save.ts` — `KVStore` interface (get/set/remove) with `CapacitorPreferencesStore` (@capacitor/preferences; localStorage on web automatically) and `MemoryStore` for vitest. Dual-slot write (`save` + `save.bak`), checksum, write-then-swap.
- `meta.ts` — `MetaState`: gold wallet, node ranks, `buy(nodeId)`, `computeMetaMods()`, `bankRun(gold)`.
- `iap.ts` — `IapService` interface wrapping a Capacitor StoreKit plugin (swap-friendly if we later adopt RevenueCat).
- `ads.ts` — AdMob via @capacitor-community/admob; `canOfferRevive()/canOfferGoldDouble()/canOfferDailyChest()` gate on network, fill, and caps.

**Save schema (version 1):** `{ version, gold, meta: {nodeId: rank}, unlockedCharacters: string[], purchases: {removeAds, characterPack}, adState: {dayKey, revivesToday, goldDoublesToday, lastChestIso}, stats, checksum }`. `migrate(raw)` switches on version; parse failure/checksum mismatch/future version → try `save.bak`, else defaults + StoreKit restore for entitlements. Saves fire-and-forget from UI layer on run end, purchase, and Capacitor `appStateChange` — never from the sim tick.

#### 3. Character unlocks

`characters.json` entries gain optional `"unlock": { "gold": 3000 }` or `{ "iap": "character_pack_1", "gold": 12000 }` (IAP characters remain gold-unlockable at high price — App Store friendly, free players not gated). `normalizeCharacters` defaults to unlocked. `wanderer` free; `acolyte`/`outrider` gold; `warden_knight` + one new character in the pack. `renderTitle()` (screens.ts:99) greys locked cards, shows cost; selecting opens confirm-spend or routes to shop.

#### 4. IAP catalog + honest receipt note

`remove_ads` $3.99 non-consumable — since all placements are rewarded/opt-in, it grants the rewards without watching ("Premium"). `character_pack_1` $2.99. Gold consumables: 5k/$1.99, 15k/$4.99, 40k/$9.99. Restore-purchases button (App Store requirement). Receipts verified on-device via StoreKit 2 through the plugin; **no server means jailbroken devices can spoof entitlements — accepted risk for an offline single-player economy.**

#### 5. Rewarded ads (caps in adState)

- **Revive** — when `revivesLeft === 0`, `game.ts` intercepts `player:died` before `showResults`: if `ads.canOfferRevive()`, show `showReviveOffer()`; on completion call `revivePlayer(ctx)` (extracted from the existing revive path in `player.ts`) and resume `state='running'`. Cap: 1/run, 3/day. Engine never knows ads exist.
- **Gold double** — button on `showResults`, 1/run.
- **Daily chest** — title screen, 1/24h (local dayKey).
No network/fill → buttons simply not rendered; game fully playable offline; shop shows cached prices or an "unavailable" state.

#### 6. Events, screens, boot

`GameEvents` (events.ts:31) additions: `'run:ended': {victory, survivedSeconds, kills, gold, level}` (emitted from `declareVictory` and the death path — one hook for banking gold), `'meta:goldChanged': {total}`, `'meta:purchased': {nodeId, rank}`, `'character:unlocked': {id}`. Ad/IAP results stay as promises inside services, not on the engine's bus.

`game.ts` `State` union gains `'sanctum' | 'shop' | 'reviveOffer'` (non-ticking, like `'title'`). `startRun` passes `metaState.computeMetaMods()` into `new Run(...)`. `boot()` in main.ts gains `await SaveService.load()` as a second async startup step.

`screens.ts`: title footer shows wallet gold + SANCTUM/SHOP buttons; new `showSanctum()` (node grid, rank pips, buy buttons reusing `el`/`setChoices`/`setFocus` for gamepad nav), `showShop()`, `showReviveOffer()`. All DOM over canvas — 480×270 buffer untouched.

#### 7. Headless tests

`src/services/meta.test.ts` (MemoryStore, no Capacitor import): buy deducts exact cost, rejects insufficient gold / past maxRank; `computeMetaMods` summation; migration v0→v1, corrupt JSON → bak → defaults. In `simulation.test.ts`: `new Run('wanderer', {might: 0.15})` reflects in stats with clamps intact; seeded harness run with meta greed verifies `gainGold` multiplier deterministically; a balance test asserting a full 15-min harness run banks gold within a target band.
### Integration points

- src/gameplay/run.ts — Run constructor gains metaMods param; recomputeStats() (line 148) seeds the StatMods accumulator from metaMods; revivesLeft adds meta revives
- src/gameplay/content.ts — new normalizeMeta()/META_LIST/metaNodeDef() reusing STAT_MOD_KEYS validation; normalizeCharacters() parses optional unlock field on CharacterDef
- src/core/events.ts — GameEvents gains run:ended, meta:goldChanged, meta:purchased, character:unlocked
- src/game.ts — State union +'sanctum'|'shop'|'reviveOffer'; wireEvents() intercepts player:died for revive offer and banks gold on run:ended; declareVictory() emits run:ended; startRun() passes computeMetaMods() into new Run
- src/ui/screens.ts — renderTitle() locked cards + wallet/SANCTUM footer; new showSanctum()/showShop()/showReviveOffer(); showResults() gains gold-double button
- src/main.ts — boot() awaits SaveService.load() alongside SpriteTable.load(); constructs services and injects into Game
- src/gameplay/player.ts — extract existing revive logic into exported revivePlayer(ctx) so the ad flow reuses it
- src/content/meta.json (new), src/content/characters.json (unlock fields)
- src/services/save.ts, meta.ts, iap.ts, ads.ts (all new; engine never imports them)
- src/gameplay/simulation.test.ts + new src/services/meta.test.ts — upgrade math, Run metaMods, migration, gold-band balance test
### Risks

- Client-side StoreKit receipt handling is spoofable on jailbroken devices (no server by design) — mitigate with StoreKit 2 on-device verification via the plugin and accept residual risk; impact limited to a single-player economy
- Capacitor IAP plugin ecosystem is churny — mitigate by hiding the plugin behind the IapService interface so a swap (or later RevenueCat) touches one file
- Economy balance unproven (income vs ~42k sink) — mitigate with the seeded headless balance test asserting per-run gold bands; all costs/values in meta.json for tuning without code changes
- Resuming the fixed-timestep loop after a fullscreen AdMob overlay could burst catch-up updates — mitigate by dropping accumulated time in beforeFrame on resume (verify Loop's existing focus handling) before shipping the revive flow
- AdMob on iOS requires ATT prompt + privacy manifest — mitigate by handling ATT in services/ads.ts init and serving non-personalized ads on decline
- Save corruption loses gold — mitigate with dual-slot save+bak, checksum, write-then-swap, and entitlement recovery via StoreKit restore
### Effort estimate

8-12 developer-days: meta tree + Run integration + tests 2d; save/migration layer 1.5d; sanctum/shop/title UI 2d; AdMob + caps + ATT 2d; IAP + restore 2d; device QA/polish 1-2d.

---

## 5. Mobile Platform Layer (iOS / Capacitor) (`mobile-platform`)

### Design

### Mobile Platform Layer — Vampire Knights (iOS / Capacitor)

#### Capacitor project
`capacitor.config.ts` at repo root: `appId: 'com.stimilon.vampireknights'`, `webDir: 'dist'`, `backgroundColor: '#05060a'` (matches body bg in style.css), `ios: { contentInset: 'never' }`. Vite already has `base: './'` and `assetsInlineLimit: 0` — Capacitor-ready, no change. Flow: `npm run build && npx cap sync ios`. Info.plist: landscape-only (game is 480×270), `ITSAppUsesNonExemptEncryption=false`. Plugins: `@capacitor/app`, `@capacitor/haptics`, `@capacitor-community/keep-awake` (enable during `playing` state only). Engine untouched; all platform code is additive.

#### Touch controls
**New `src/core/touch.ts` — `TouchControls`**, DOM-based (respects the DOM-over-canvas pattern), attached to `#ui`, only if `navigator.maxTouchPoints > 0`. Two responsibilities:

1. **Floating joystick (left thumb).** `touchstart` on left half anchors the base; `touchmove` yields a direction vector (deadzone 10 CSS px, radius `calc(var(--u) * 24)`). Tracks its `Touch.identifier` so right-thumb taps never steal it. Exposes `axisX/axisY` (unit direction — full-speed movement like keyboard, so `normalize()` semantics hold).
2. **`injectPress(code)` buffer** for buttons.

**Plug into `Input` (`src/core/input.ts`):** constructor gains optional `touch?: TouchControls`. In `beginFrame()`, after `readGamepad()` (lines 91–95): `if (touch) { x += touch.axisX; y += touch.axisY }` before `normalize(x, y)`. Buffered presses are drained into `pressedThisFrame` there too — the exact pattern gamepad already uses at lines 128–129. `wasPressed` consumption order, edge-trigger timing, and `updatePlayer(ctx, dt, input)` signature are all unchanged; `simulation.test.ts` is untouched.

**Right thumb:** ability button + blood-bar tap are DOM buttons in `#ui` (bottom-right, `calc(var(--u)*22)` square), firing `touch.injectPress('Space')` / `('KeyE')` — gameplay systems read the same codes on desktop and mobile. Cooldown ring via CSS conic-gradient driven by Hud from bus events. A pause button (top-right) injects `'Escape'`, consumed by `Game.beforeFrame()` line 243 exactly like keyboard. Menus need nothing — Screens are DOM and already clickable. Joystick DOM hides when `screens.isOpen`.

**`src/game.ts` constructor (line 71):** `new Input(window, new TouchControls(uiRoot))`; touch roots appended alongside line 83.

#### Safe areas
`index.html` viewport meta gains `viewport-fit=cover`. `style.css :root` adds `--safe-l/r/t/b: env(safe-area-inset-*, 0px)`. HUD/buttons anchor with `max()`: e.g. `left: max(calc(var(--offset-x) + var(--u)*5), var(--safe-l))` — composes with the letterbox vars `syncUiMetrics()` (game.ts:399) already publishes; that function needs no change. `touch-action: none` on `#app` kills double-tap zoom.

#### WKWebView performance
Canvas2D is Core-Animation-backed; the fixed 480×270 buffer + one nearest-neighbour upscale is cheap. rAF caps at 60 in WKWebView (matches TICK_RATE); Low Power Mode throttles to 30 → Loop runs 2 ticks/frame, correct by design. Background stops rAF entirely — `loop.ts` frameDt clamp (0.25s) + `MAX_TICKS_PER_FRAME` + accumulator drop already prevent resume spiral. Memory: SoA arrays are a few MB; PNGs stay as files. No engine changes required.

#### Lifecycle
**New `src/platform/lifecycle.ts`**, wired in `main.ts boot()` after `loop.start()`: `visibilitychange → hidden` and Capacitor `App.addListener('pause')` both call a new **public `Game.autoPause()`** — a guard (`state === 'playing'`) around the existing private `openPause()` (game.ts:196). Capacitor import is dynamic + try/catch so web builds run unchanged. `TouchControls` clears state on `touchcancel`/hidden, mirroring Input's `blur` handler.

#### Audio
No audio exists today. **New `src/platform/audio.ts`** — WebAudio, one `AudioContext` resumed on first `touchend`/`pointerdown` (iOS unlock). Subscribes to the EventBus, never called from systems — headless tests stay silent. Expose `bus` as `readonly` on `Game`; `main.ts` does `new AudioEngine(game.bus)`. Master gain; `suspend()` on hidden, `resume()` on visible (ducking). SFX pool: ≤8 concurrent voices, per-sound 50ms throttle (400 enemies won't machine-gun). Mapping in **`src/content/audio.json`** (event → file, volume, throttle), validated warn-don't-throw like `content.ts`. Minimal list — SFX: hit_enemy, hit_player, pickup_xp, pickup_coin, levelup, ability_cast, ability_ready, blood_full, blood_heal, blood_burst, boss_spawn, ui_click, death, victory. Music: title_theme, battle_loop.

#### Haptics
**New `src/platform/haptics.ts`**, bus-driven, no-op off-iOS: player-hit → impactMedium, levelup → notificationSuccess, ability → impactHeavy, blood-full → impactLight. Global 100ms throttle; enemy hits deliberately excluded.

#### Icon / splash / App Store
`@capacitor/assets` from one 1024px gothic-knight icon + 2732px splash on #05060a (seamless into body bg). Checklist: PrivacyInfo.xcprivacy (required; merge AdMob SDK's manifest + tracking domains when ads land); ATT prompt + `NSUserTrackingUsageDescription` before personalized ads; App Privacy label (device IDs/ads data from AdMob); age rating 12+ (stylized fantasy violence — answer "cartoon blood, infrequent"); fully offline playable, rewarded-ad button hidden when no fill; IAP via StoreKit (RevenueCat) for remove-ads/packs/gold; landscape lock; keep-awake during runs.
### Integration points

- src/core/input.ts — Input constructor gains optional TouchControls param; beginFrame() (lines 91–95) adds touch.axisX/Y after readGamepad() before normalize(); buffered touch presses drained into pressedThisFrame, mirroring the gamepad synthetic-press pattern at lines 128–129
- src/core/touch.ts (NEW) — TouchControls: floating joystick with Touch.identifier tracking, injectPress(code) buffer, DOM elements in #ui sized with --u
- src/game.ts:71 — construct TouchControls(uiRoot) and pass into new Input(); append touch DOM alongside uiRoot.append at line 83
- src/game.ts:196 — new public autoPause() wrapping private openPause(), guarded by state === 'playing'; expose bus as readonly for platform subscribers
- src/game.ts:399 syncUiMetrics() — unchanged; existing --scale/--offset-x/--offset-y/--u vars are what touch UI and safe-area CSS compose with
- src/main.ts boot() — after loop.start(): wire src/platform/lifecycle.ts (visibilitychange + Capacitor App plugin via guarded dynamic import), construct AudioEngine(game.bus) and Haptics(game.bus)
- index.html:5 — viewport meta gains viewport-fit=cover
- src/ui/style.css :root — add --safe-l/r/t/b env() vars; HUD anchors use max(offset, safe-inset); touch-action: none on #app; joystick/button styles
- src/platform/lifecycle.ts, src/platform/audio.ts, src/platform/haptics.ts (NEW) — bus-driven, zero calls from gameplay systems so simulation.test.ts stays headless-clean
- src/content/audio.json (NEW) — event→SFX mapping, normalized warn-don't-throw in src/gameplay/content.ts style
- capacitor.config.ts (NEW, repo root) — webDir 'dist', contentInset 'never', backgroundColor '#05060a'; vite.config.ts already has base './' and assetsInlineLimit 0, no change
- src/core/loop.ts — no change needed; frameDt 0.25s clamp + MAX_TICKS_PER_FRAME already handle WKWebView background/resume and Low Power Mode 30Hz rAF
### Risks

- WebAudio vs iOS silent switch / AVAudioSession category — WKWebView defaults may mute game audio with the ringer switch; mitigate: verify on device day 1, set playback category via Capacitor config or a 3-line native tweak in AppDelegate
- Multi-touch conflicts (joystick vs ability/blood buttons) — mitigate: strict Touch.identifier ownership per control, 3-finger device testing before content work builds on abilities
- Injected synthetic presses vs wasPressed consumption order — a touch 'Escape' during levelup must be ignored exactly like keyboard (game.ts:234 comment); mitigate: drain injected presses only in Input.beginFrame() so ordering is identical, add a harness test injecting presses
- Age rating: 'blood economy' theming could push past 12+ if questionnaire answered carelessly — mitigate: keep pixel-stylized cartoon blood, answer 'infrequent/mild', review Apple's fantasy-violence precedent (Vampire Survivors itself is 12+)
- Privacy manifest churn — AdMob SDK's required-reason APIs and tracking domains change between SDK versions; mitigate: pin SDK version, re-validate PrivacyInfo.xcprivacy in the ship checklist each release
- Screen-edge gesture conflicts in landscape (iOS home indicator / notification pulls) near joystick zone — mitigate: preferredScreenEdgesDeferringSystemGestures in the native shell, keep joystick spawn zone inset from edges via safe-area vars
### Effort estimate

8–10 developer-days: Capacitor scaffold + iOS config 1d; touch layer (joystick, buttons, Input plumbing) 2d; safe-area CSS 0.5d; lifecycle 0.5d; WebAudio engine + audio.json + SFX wiring 2d; haptics 0.5d; icon/splash 0.5d; App Store prep (privacy manifest, ATT, plist, rating) 1d; on-device testing across iPhone SE→Pro Max 1–2d. Excludes AdMob/IAP integration (monetization domain) and SFX asset production.

---

## 6. Art Direction & AI Pixel-Art Pipeline (`art-direction`)

### Design

### Visual Identity + AI Art Pipeline — "Vampire Knights"

#### 1. Gothic style guide
**Palette — 10 hex anchors** (chosen to harmonize with placeholder colors already in sprites.json/maps so art can land incrementally):
`#0a0a10` void black (crypt voidColor, universal 1px outline) · `#241733` deep violet shadow · `#6b4a8f` royal violet · `#8b1e2d` dried blood · `#d94a5e` fresh blood (HP/blood bar) · `#e8e3d0` bone white (skeleton) · `#8a8a92` grave grey · `#d4a15a` tarnished gold (coins/UI accents) · `#7f9cc4` moonlit steel (armor, warden) · `#26332a` crypt moss. Enemies (human hunter army) additionally get torch-orange `#ff8c42` (already hazard_fire) as their faction accent — player faction reads violet/crimson, hunters read leather/steel/orange. Quantize every final sprite to this palette + at most 4 ramp steps per anchor.

**Silhouette rules at 16-32px:** one dominant shape per sprite (cloak wedge, tower shield, scythe arc); all critical detail ≥2px clusters; mandatory 1px `#0a0a10` outline on characters/enemies/pickups (NOT on tiles/decor — they must recede); rim light top-left in the sprite's lightest ramp step. Tiles stay ≤35% saturation and darker than value 0.3 so outlined actors always pop. Dither: 2×2 checker only, only on areas ≥4×4px; no banding gradients.

#### 2. Asset inventory (every horizontal-strip, square frames per height — public/assets/README.md convention)
- **Characters (4 in characters.json — currently all share sprite `"player"`; give each its own sprites.json entry `char_wanderer/acolyte/sworn/outrider` and point `sprite` fields at them):** idle(4f)+walk(6f)+hurt(2f, loop:false) ×4 = **12 strips**, 32×32 frames, origin [0.5,0.85].
- **Enemies (10 ids in enemies.json, rethemed as hunter army: bat→lantern drone, zombie→conscript, skeleton→pikeman, ghost→inquisitor shade, slime→alchemist ooze, wisp→torch wisp, swarmling→hound, brute→siege breaker, reaper→witch-hunter captain, warden→paladin warlord):** idle+walk each = **20 strips** (adds walk to ghost/slime/wisp/swarmling/warden). Frames: 16×16 (swarmling/wisp), 24×24 (bat/zombie/skeleton/ghost/slime), 32×32 (brute), 48×48 (reaper/warden).
- **Pickups:** 7 existing + `blood_drop` (blood economy) = **8 strips**, 16×16.
- **Weapons/FX:** 9 existing + 4 ultimate FX (one per character), blood-burst FX, blood-heal FX, capture-ring FX = **16 strips**, 3-6f.
- **Structures (castle defense):** 3 types (chapel, gate, blood obelisk) × anims idle/hurt/death (sprites.json already supports `hurt`/`death` loop:false) = **9 strips**, 48×48.
- **Tiles:** crypt 4, castle (retheme arena.json: floor/floor_alt/wall + banner_wall) 4, blood-meadow (retheme meadow.json: crimson grass ×3 + ash dirt) 4 = **12 tiles** (16px, arena 32px). **Decor:** 6 existing + banner, candelabra, statue, bonepile = **10 strips**.
- **UI pack (PNG via CSS, DOM over canvas):** 9-slice gothic frame, button 9-slice, blood-bar frame, 4 character portraits (64×64), 4 ability icons (24×24), title logo. **Store:** 1024² icon (knight bust, violet/crimson, no text), 5 screenshots 1290×2796 (gameplay at integer scale + caption bars in palette).
**Total: ~75 strips + 12 tiles + UI/store pack.**

#### 3. AI generation workflow (consistency protocol)
1. **Style key first:** generate one approved 4-sprite key sheet (player, pikeman, tile, pickup); all later generations use it as img2img/reference input.
2. **Prompt template:** `"pixel art game sprite, {subject}, {pose/frame}, gothic dark fantasy, palette: {10 hexes}, 1px black outline, side-facing 3/4 top-down, plain #00ff00 background, no anti-aliasing, {N}x{N} logical pixels"` — generate at **8× target (256² for 32px)**, one FRAME per image (models can't do aligned strips).
3. **Downscale + quantize:** `magick in.png -filter point -resize 32x32 -remap palette.png out.png`; chroma-key background to alpha.
4. **Manual cleanup (Aseprite):** fix outline breaks, re-cluster <2px noise, align feet to origin row (frame_h × 0.85).
5. **Assemble strips:** `magick +append frame*.png strip.png`.
6. **Validate:** new `scripts/validate-art.mjs` (npm script `validate:art`): for every anim in sprites.json + map tilesets, if PNG exists assert `width % height === 0` (square-frame convention in src/render/sprites.ts frameW logic) and tiles exactly match map `tileSize`; warn-don't-throw, matching content.ts philosophy. Gate: in-game screenshot review at 480×270 integer scale before accepting a batch.

#### 4. UI reskin (src/ui/style.css)
Restyle via the existing `:root` custom props (line 13): `--panel→#141020`, `--accent→#d94a5e`, `--gold→#d4a15a`, `--edge` violet ramps. Add self-hosted pixel font (`public/fonts/`, OFL-licensed e.g. "Jacquarda"/"m5x7") via `@font-face`, replacing the ui-monospace stack (line 51) for headings only; keep monospace for numbers. Gothic 9-slice frames via `border-image` on `.panel`/buttons. `image-rendering: pixelated` on any PNG UI. No hud.ts/screens.ts logic changes — class-level restyle only; blood bar reuses the existing hp-bar gradient pattern (lines 151-158) with `#8b1e2d→#d94a5e`.

#### 5. Execution checklist (artist-agent order)
1. palette.png + style key sheet → approval gate. 2. validate-art script. 3. 4 characters. 4. tiles ×3 maps. 5. 10 enemies. 6. pickups+FX. 7. structures. 8. decor. 9. UI pack + style.css. 10. icon + screenshots. Each step: generate → downscale/quantize → cleanup → strip → `npm run validate:art` → in-game screenshot diff.
### Integration points

- src/content/sprites.json — add entries: char_wanderer/char_acolyte/char_sworn/char_outrider (idle/walk/hurt), blood_drop, 3 structures (idle/hurt/death), 4 ultimate FX, blood/heal/capture FX, 4 new decor; retheme placeholder colors to palette anchors
- src/content/characters.json — change each character's "sprite" field from shared "player" to its own sprite id
- src/content/maps/arena.json → castle retheme (name, tileset srcs, voidColor #0a0a10, banner/candelabra props); maps/meadow.json → blood-meadow retheme (crimson grass tiles); maps/crypt.json — decor additions only
- src/ui/style.css — :root custom props (line 13) recolored to palette; @font-face pixel font replacing ui-monospace stack (line 51); border-image 9-slice gothic frames on panels/buttons; blood-bar style cloned from hp-bar block (lines ~151-158)
- public/assets/** — all PNG drops per existing folder layout (player/, enemies/, pickups/, weapons/, tiles/) + new structures/, ui/, ../fonts/; zero code change needed thanks to placeholder system
- scripts/validate-art.mjs (new) + package.json "validate:art" script — asserts width % height === 0 per sprites.json anims and tile PNGs match map tileSize; warn-don't-throw
- src/render/sprites.ts — no code change (square-frame/frameW convention is the validation target); SpriteTable.load() picks up PNGs automatically
- index.html — optional <link rel=preload> for the pixel font
### Risks

- AI style drift across ~75 strips → mitigate with approved style-key sheet used as img2img reference for every batch, fixed prompt template with palette hexes, and mandatory quantize-to-palette step; reject any batch failing in-game screenshot review at 480×270
- Models cannot produce aligned animation strips → never ask for strips; generate one frame per image at 8× and assemble with magick +append; validate width % height === 0 via scripts/validate-art.mjs before drop-in
- Downscaled AI output is mushy at 16-24px (small enemies) → for the four ≤16px sprites, budget hand-pixel from the AI concept rather than downscale; cleanup pass in Aseprite is non-optional for all characters
- Frame-count mismatch between idle(4f)/walk(6f) strips and JSON fps feel → fps values are already data-driven in sprites.json; tune fps after art lands, no code change, but lock frame counts per category up front so strips are interchangeable
- Pixel font licensing for App Store distribution → use OFL/CC0 font only, keep license file in public/fonts/; verify before ship-ready
- Retheming enemy names (hunter army) touches enemies.json "name" strings shown in-game — coordinate with the content/mechanics domain so ids stay stable (waves.json/tests reference ids, not names)
### Effort estimate

8-12 developer-days (1d pipeline script + palette/key sheet, 4-5d sprite generation+cleanup across ~75 strips, 1.5d tiles/decor, 1d UI reskin + font, 1d icon/screenshots, 1d integration review passes)

---

## 7. Total effort

| Domain | Estimate |
|---|---|
| Blood Economy | 3-4 developer-days |
| Character Active Abilities | 4-6 developer-days |
| Castle Defense Objectives | 4-6 developer-days |
| Meta-Progression & Monetization | 8-12 developer-days |
| Mobile Platform Layer | 8-10 developer-days |
| Art Direction & AI Pipeline | 8-12 developer-days |
| **Total** | **35-50 developer-days** |

Notes on the sum:
- The mobile-platform estimate **excludes AdMob/IAP integration** (counted under
  meta-monetization) and SFX asset production, so the two estimates do not double-count.
- Art-direction work is largely parallelizable with engineering: the placeholder-sprite system
  means every mechanic is playable before art lands, and PNG drop-ins require zero code changes.
- The three gameplay mechanics (blood economy, abilities, castle defense) all touch
  `Game.tick()` / `makeHarness()` ordering and `simulation.test.ts`; landing them sequentially
  (not in parallel branches) avoids harness merge conflicts and keeps the determinism tripwire
  test meaningful after each merge.

---

## 8. Top cross-cutting risks

1. **Bottom thumb-zone / multi-touch conflicts** *(blood-economy, active-abilities,
   mobile-platform)*. The virtual joystick (left thumb), the ability button (bottom-right), and
   the blood orb + Feast/Frenzy tap buttons (bottom-center) all compete for the same bottom
   screen band, and iOS landscape adds home-indicator/edge-gesture interference. Mitigation:
   strict `Touch.identifier` ownership per control, `stopPropagation`/`preventDefault` on
   `pointerdown` (never `click`), locked zones (joystick left, ability right, blood center),
   `preferredScreenEdgesDeferringSystemGestures` in the native shell, and 3-finger on-device
   testing **before** content work builds on top of these inputs.

2. **Engine-invariant regressions: determinism + harness mirror + `run.stats` immutability**
   *(blood-economy, active-abilities, castle-defense)*. All three mechanics insert systems into
   `Game.tick()` and must mirror the change verbatim in `makeHarness()`; all three add timers
   that must advance only on sim time (`run.time`/`dt`, never wall clock) and randomness that
   must stay on `ctx.rng`; frenzy and ability buffs must remain read-side multipliers
   (`effectiveStats`) or state-change `recomputeStats()` sources — never direct `run.stats`
   mutation. Mitigation: same-commit tick/harness edits, two-harness same-seed determinism
   tests, stats round-trip assertions, and the 15-minute seeded full-run test as the tripwire.

3. **Balance/economy unproven across stacked new power sources** *(blood-economy,
   active-abilities, castle-defense, meta-monetization)*. Frenzy (x1.4 dmg / x0.75 cd) can
   snowball with high-might builds; abilities stack on weapon DPS; Feast overlaps the existing
   Meat pickup (double sustain — halve `MEAT_CHANCE` in the same PR); the lost-structure
   difficulty multiplier (1 + 0.08/loss) may be too punishing or invisible; and the ~42k-gold
   Sanctum sink has no proven income curve. Mitigation: every number lives in hot-reloadable
   JSON (`blood.json`, ability params, `meta.json`, `difficultyAt` constant), plus headless
   balance tests (kills-delta sanity, per-run gold band) and dev-server tuning passes.

4. **iOS platform & App Store compliance cluster** *(meta-monetization, mobile-platform)*.
   AdMob requires the ATT prompt, `NSUserTrackingUsageDescription`, and a privacy manifest whose
   required-reason APIs/tracking domains churn between SDK versions; the "blood economy" theming
   risks pushing past a 12+ age rating if the questionnaire is answered carelessly; WKWebView
   may mute WebAudio via the ringer switch (AVAudioSession category); and resuming the
   fixed-timestep loop after a fullscreen ad overlay can burst catch-up updates. Mitigation:
   pin the AdMob SDK and re-validate `PrivacyInfo.xcprivacy` each release, keep blood
   pixel-stylized/cartoon ("infrequent/mild" — Vampire Survivors precedent is 12+), set the
   playback audio category natively and verify on device day 1, and drop accumulated loop time
   on resume before shipping the revive flow.

5. **AI art consistency at production scale** *(art-direction)*. ~75 sprite strips generated by
   AI risk style drift; models cannot produce aligned animation strips at all; and downscaled
   output goes mushy at 16-24px. Mitigation: an approved style-key sheet used as img2img
   reference for every batch, a fixed prompt template embedding the 10 palette hexes, mandatory
   quantize-to-palette + Aseprite cleanup, frame-per-image generation at 8x assembled with
   `magick +append`, `scripts/validate-art.mjs` asserting the square-frame convention, hand-
   pixeling the four <=16px sprites, and an in-game 480x270 screenshot review gate per batch.
