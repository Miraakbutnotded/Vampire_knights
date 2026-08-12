# Balance tables

Every shipped number, extracted from `src/content/`. For the *schema* of these files read
[`../../README.md`](../../README.md); for *why* the numbers sit where they do read
[`progression.md`](progression.md).

> These tables were computed from the JSON, not transcribed, but nothing enforces that they stay
> in sync. **`src/content/*.json` is the source of truth.** If a number here disagrees, the JSON
> is right and this file is stale.

- [Enemies](#enemies)
- [Weapons](#weapons)
- [Evolutions](#evolutions)
- [Passives](#passives)
- [Characters](#characters)
- [Abilities](#abilities)
- [Blood](#blood)
- [Structures](#structures)
- [Sanctum](#sanctum)
- [Maps](#maps)
- [Waves](#waves)

---

## Enemies

`src/content/enemies.json`. Contact damage is dealt on overlap; the exploder deals **none** — the
blast is its whole damage budget, so killing it on the fuse costs the player nothing.

### Trash

| id | name | behavior | hp | dmg | speed | radius | xp | kb resist | coin (chance × value) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `swarmling` | Swarmling | chase | 4 | 4 | 54 | 4 | 1 | 0 | 1% × 1 |
| `bat` | Bat | chase | 8 | 6 | 44 | 5 | 1 | 0.10 | 2% × 1 |
| `slime` | Slime | hopper | 16 | 7 | 40 | 5 | 2 | 0.20 | 3% × 1 |
| `zombie` | Rotter | chase | 24 | 9 | 27 | 6 | 2 | 0.25 | 4% × 1 |
| `ghost` | Wraith | orbiter | 28 | 10 | 42 | 5 | 3 | 0.15 | 5% × 2 |
| `wisp` | Ember Wisp | ranged | 20 | 6 | 30 | 4 | 4 | 0 | 8% × 2 |
| `drifter` | Cinder Drifter | drifter | 30 | 12 | 64 | 5 | 4 | 0.60 | 6% × 2 |
| `fusebearer` | Fusebearer | exploder | 30 | 26 | 48 | 7 | 4 | 0.15 | 5% × 2 |
| `skeleton` | Bonepicker | chase | 34 | 11 | 35 | 6 | 3 | 0.30 | 5% × 2 |
| `prior` | Censer Prior | splitter | 58 | 12 | 26 | 9 | 5 | 0.45 | 6% × 2 |

Behavior-specific tunables:

| enemy | tunables |
| --- | --- |
| `slime` | `hopTime 0.45`, `restTime 0.35` |
| `ghost` | `orbitRadius 46`, `orbitSpeed 1.5` |
| `wisp` | `preferredRange 110`, `shootInterval 2.4`, projectile: speed 70, damage 8, radius 4, lifetime 4 |
| `fusebearer` | `fuseRange 28`, `fuseTime 0.85`, `blastRadius 44` |
| `prior` | `splitInto slime`, `splitCount 3` |

**Blood on kill** defaults to `1` for trash and `8` for anything flagged `elite` or `boss`
(`normalizeEnemies` in `content.ts`). Only `swarmling` overrides it, at **0.5** — it arrives in
floods, and at the default a swarm stage would bank a Frenzy faster than the 12/second intake cap
was written to allow.

### Elite and bosses

| id | name | behavior | hp | dmg | speed | radius | xp | kb resist | coin | flags |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `brute` | Brute | charger | 160 | 20 | 26 | 11 | 14 | 0.75 | 60% × 6 | `elite` |
| `warden` | The Warden | charger | 1100 | 26 | 24 | 14 | 70 | 1.0 | 100% × 40 | `boss`, `dropsChest` |
| `reaper` | The Reaper | chase | 4200 | 45 | 30 | 17 | 260 | 1.0 | 100% × 150 | `boss`, `dropsChest` |

Charger timings — `windup / dash / dashSpeed / rest`: brute `0.7 / 0.55 / 150 / 1.1`,
warden `0.85 / 0.7 / 170 / 1.4`.

Elites and bosses **additionally leave a Blood Vial**, and both are spawned with
`Comp.Persistent`, so neither is ever culled for drifting off screen (an enemy that has been given
a structure to attack is likewise exempt, for the duration of its siege). **Bosses only** are
exempt from the revive nuke — wiping one with a revive would be anticlimactic.

---

## Weapons

`src/content/weapons.json`. Levels are **additive deltas** on `base`, and `maxLevel = levels.length
+ 1` implicitly — every base weapon ships 7 level entries, so every one maxes at **8**.

Raw numbers, before `effectiveStats()` folds in might/area/duration/cooldown/amount/pierce and
Frenzy.

| id | name | behavior | weight | L1 damage | L1 cooldown | L1 count | L8 damage | L8 cooldown | L8 count |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `whip` | Bone Whip | arc | 100 | 12 | 1.35 | 1 | 42 | 1.20 | 3 |
| `wand` | Hex Wand | homing | 100 | 11 | 1.10 | 1 | 30 | 0.86 | 4 |
| `knife` | Throwing Knives | straight | 100 | 8 | 0.85 | 1 | 23 | 0.75 | 4 |
| `garlic` | Warding Circle | aura | 90 | 6 | — | 1 | 18 | — | 1 |
| `tome` | Bound Tomes | orbit | 90 | 10 | 3.20 | 2 | 28 | 2.70 | 5 |
| `bloodlink` | Bloodlink | tether | 85 | 15 | 1.50 | 1 | 39 | 1.30 | 3 |
| `corpselight` | Corpselight | chain | 85 | 19 | 2.20 | 3 | 47 | 1.60 | 7 |
| `brazier` | Ember Flask | drop | 85 | 16 | 3.20 | 1 | 40 | 2.70 | 4 |
| `nova` | Starfall | nova | 80 | 15 | 4.60 | 8 | 39 | 3.50 | 18 |
| `wake` | Red Wake | trail | 80 | 9 | 0.45 | 1 | 21 | 0.45 | 3 |
| `ironfall` | Ironfall | slam | 80 | 28 | 3.40 | 1 | 70 | 3.00 | 3 |
| `moonshear` | Moonshear | spiral | 80 | 13 | 2.40 | 4 | 32 | 2.05 | 8 |
| `storm` | Stormcall | lightning | 75 | 34 | 3.00 | 1 | 84 | 2.25 | 5 |

Aura weapons are cooldown-exempt — they maintain one persistent entity and tick on `interval`.

Other L1 → L8 movements worth knowing:

| weapon | shape stat | L1 → L8 |
| --- | --- | --- |
| `whip` | `reach 34`, `area` | area 1 → 1.3 |
| `garlic` | `radius 40`, `interval` | interval 0.5 → 0.36, area 1 → 1.6 |
| `tome` | `radius`, `duration` | radius 42 → 50, duration 3.5 → 4.2 |
| `brazier` | `spawnRadius 80`, `duration` | duration 2.6 → 3.4, area 1 → 1.2 |
| `bloodlink` | `reach`, `radius` | reach 100 → 122, radius 5 → 6 |
| `corpselight` | `spawnRadius` (leap range) | 70 → 90 |
| `wake` | `interval`, `duration` | interval 0.45 → 0.35, duration 2.2 → 3.8 |
| `ironfall` | `spawnRadius` (ring reach) | 92 → 136 |
| `moonshear` | `pierce`, `lifetime` | pierce 2 → 4, lifetime 2.4 → 2.9 |
| `knife` | `pierce`, `speed` | pierce 1 → 3, speed 195 → 235 |
| `storm` | `area` | 1 → 1.2 |

`WEAPON_STAT_DEFAULTS` (what an omitted field falls back to): `damage 10, cooldown 1, count 1,
pierce 1, area 1, duration 0, knockback 0, speed 0, lifetime 2, interval 0, radius 0, orbitSpeed 2,
spawnRadius 0, reach 0, spread 0, turnRate 0`.

`pierce: -1` is a **sentinel for unlimited**, not a number to add to.

---

## Evolutions

Thirteen base weapons, thirteen evolutions. Each is earned at a **chest** — never drafted —
by holding the base weapon at max level and its paired passive at max level. Every evolution is a
terminal entry: `weight: 0`, `levels: []`, so `maxLevel` is 1.

| base | + passive | → evolution | damage | cooldown | count | pierce | headline |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `whip` | `widelens` | **Crimson Reap** | 52 | 1.00 | 8 | ∞ | Ring of 8 scythes, reach 44, area 1.5 |
| `wand` | `twinsigil` | **Hex Choir** | 34 | 0.80 | 5 | 6 | 5 s flight, turnRate 13 |
| `knife` | `tensioncord` | **Bladewind** | 26 | 0.70 | 9 | 4 | Speed 330, zero spread |
| `garlic` | `ironplate` | **Sanctum** | 24 | — | 1 | ∞ | Radius 44, area 1.9, interval 0.28, knockback 75 |
| `tome` | `longcandle` | **Eternal Vigil** | 34 | 2.00 | 7 | ∞ | Duration 8 s, radius 58, orbitSpeed 3.4 |
| `brazier` | `whetstone` | **Hellpyre** | 52 | 2.20 | 5 | ∞ | 6 s burn, radius 26, spawnRadius 96 |
| `nova` | `quickglyph` | **Nightfall** | 46 | 1.90 | 24 | 5 | 24 stars every 1.9 s |
| `storm` | `luckycoin` | **Judgment** | 110 | 1.50 | 9 | ∞ | 9 strikes, radius 22, area 1.5 |
| `bloodlink` | `bloodthirst` | **Crimson Meridian** | 78 | 0.90 | 5 | ∞ | Reach 165, radius 7 |
| `corpselight` | `duelistspoise` | **Wildfire Sermon** | 66 | 1.20 | 14 | ∞ | 14 leaps, spawnRadius 120 |
| `wake` | `swiftboots` | **Hemorrhage** | 34 | 0.30 | 3 | ∞ | 3 lanes, 3.6 s lingering |
| `ironfall` | `graveiron` | **Ruinbell** | 96 | 2.00 | 3 | ∞ | 3 rings, spawnRadius 155, knockback 130 |
| `moonshear` | `serratededge` | **Eclipse** | 52 | 1.40 | 12 | 6 | 12 blades, 3.2 s flight |

Every base weapon pairs with a **different** passive, so an evolution build is a real commitment
of two slots out of six-and-six.

---

## Passives

`src/content/passives.json`. Six slots.

| id | name | max | weight | per level | at max |
| --- | --- | ---: | ---: | --- | --- |
| `whetstone` | Whetstone | 5 | 100 | might +0.10 | +0.50 might |
| `vitalember` | Vital Ember | 5 | 100 | maxHpMul +0.15 | +75% health |
| `ironplate` | Iron Plate | 5 | 95 | armor +1 | +5 armour |
| `swiftboots` | Swift Boots | 5 | 95 | moveSpeedMul +0.08 | +40% speed |
| `widelens` | Wide Lens | 5 | 90 | area +0.12 | +0.60 area |
| `quickglyph` | Quick Glyph | 5 | 90 | cooldown −0.07 | −0.35 cooldown |
| `bloodroot` | Bloodroot | 5 | 85 | recovery +0.25/s | +1.25 hp/s |
| `tensioncord` | Tension Cord | 5 | 80 | projectileSpeed +0.12 | +0.60 |
| `longcandle` | Long Candle | 5 | 80 | duration +0.12 | +0.60 |
| `lodestone` | Lodestone | 5 | 75 | magnetMul +0.30 | +150% pickup range |
| `scholarscrown` | Scholar's Crown | 5 | 70 | growth +0.10 | +50% XP |
| `luckycoin` | Lucky Coin | 5 | 70 | luck +0.10, critChance +0.015 | +0.50 luck, +7.5% crit |
| `bloodthirst` | Bloodthirst | 5 | 70 | bloodGain +0.10 | +50% blood |
| `duelistspoise` | Duelist's Poise | 5 | 70 | critChance +0.04 | +20% crit |
| `graveiron` | Grave Iron | 3 | 60 | armor +2, moveSpeedMul −0.03 | +6 armour, −9% speed |
| `misersmask` | Miser's Mask | 5 | 55 | greed +0.15 | +75% gold |
| `executionersmark` | Executioner's Mark | 3 | 50 | critMult +0.35 | +1.05 crit damage |
| `serratededge` | Serrated Edge | 3 | 45 | pierce +1 | +3 pierce |
| `hollowvow` | Hollow Vow | 5 | 45 | might +0.20, maxHpMul −0.08 | +1.00 might, −40% health |
| `twinsigil` | Twin Sigil | 2 | 30 | amount +1 | +2 projectiles |

**Trade passives** — `hollowvow`, `graveiron` — are the only ones with a negative term, and they
are the reason `recomputeStats()` floors `maxHp` at 1 rather than assuming multipliers are
positive.

`twinsigil` is the rarest thing in the pool (weight 30, max 2) because `amount` applies to *every*
weapon at once. The aura is exempt: `+projectile` is meaningless for a single persistent ring.

### Stat clamps in `Run.recomputeStats()`

| stat | clamp |
| --- | --- |
| `maxHp` | `≥ 1`, rounded |
| `cooldown` | `≥ 0.35` (`MIN_COOLDOWN_MUL`) |
| `area`, `projectileSpeed`, `duration` | `≥ 0.2` |
| `growth` | `≥ 0.1` |
| `greed`, `luck`, `bloodGain` | `≥ 0` |
| `critChance` | `[0, 0.95]` |
| `pierce` | `≥ 0`, whole |

Health, move speed and magnet range are **multiplicative** because they scale an existing
quantity; everything else is additive, so "+10% might" reads as exactly `+0.1` and stacking stays
predictable.

---

## Characters

`src/content/characters.json`. Five, all with an active ability.

| | Ser Valen | Lady Morrigan | Ser Aldric | Vespera | Castellan Dragos |
| --- | ---: | ---: | ---: | ---: | ---: |
| id | `wanderer` | `acolyte` | `warden_knight` | `outrider` | `dragos` |
| starting weapon | whip | wand | garlic | knife | brazier |
| maxHp | 100 | 80 | **140** | 90 | 120 |
| moveSpeed | 64 | 66 | 56 | **74** | 58 |
| armor | 0 | 0 | **2** | 0 | 1 |
| recovery | 0 | 0 | 0.3 | 0 | 0 |
| might | **1.1** | 1.0 | **1.1** | 1.0 | 1.0 |
| area | 1.0 | 1.0 | 1.0 | 0.95 | **1.2** |
| duration | 1.0 | 1.0 | 1.0 | 1.0 | **1.2** |
| cooldown | 1.0 | **0.95** | 1.05 | 1.0 | 1.0 |
| projectileSpeed | 1.0 | 1.0 | 1.0 | **1.15** | 1.0 |
| amount | 0 | 0 | 0 | **1** | 0 |
| magnet | 56 | 64 | 48 | **74** | 56 |
| growth | 1.0 | **1.3** | 0.9 | 1.0 | 1.0 |
| greed | 1.0 | 1.0 | 1.0 | **1.1** | 1.0 |
| luck | 1.0 | **1.1** | 0.9 | 1.0 | 1.0 |
| critChance | 0.05 | **0.08** | 0.04 | 0.06 | 0.05 |
| critMult | 2.0 | 2.0 | 2.0 | **2.2** | 2.0 |
| bloodGain | — | — | — | — | **1.25** |
| revives | 0 | 0 | **1** | 0 | 0 |
| radius | 5 | 5 | 6 | 5 | 6 |

### Unlocks

| character | gold | feat requirement | mode |
| --- | ---: | --- | --- |
| `wanderer` | free | — | — |
| `acolyte` | 2 500 | Reach level 20 in one run (`level ≥ 20`) | best |
| `outrider` | 4 000 | Last ten minutes in one run (`survive ≥ 600`) | best |
| `warden_knight` | 6 000 | Hold the Bastion with every wall standing (`walls ≥ 1`) | best |
| `dragos` | 12 000 | Survive a full night (`victory ≥ 1`) | best |

Gated **twice**: the feat first, then the price. `MetaService.lockStateOf` is the single answer to
"why is this locked" — the title card renders it and `unlockCharacter` enforces it, so the screen
and the purchase cannot disagree.

---

## Abilities

Scaling is a narrow guardrail: **damage ×might, sizes ×area, lifetime ×duration, nothing else.**
The cooldown below is raw and immune to cooldown scaling.

| character | ability | kind | cooldown | duration | params |
| --- | --- | --- | ---: | ---: | --- |
| `wanderer` | Crimson Cleave | nova | 18 s | — | count 10, damage 40, speed 150, pierce 3, knockback 200, lifetime 0.6 |
| `acolyte` | Night Swarm | volley | 20 s | 2.4 s | count 12, damage 14, speed 160, turnRate 7, pierce 1, lifetime 3 |
| `warden_knight` | Sanguine Bulwark | buff | 25 s | 5 s | heal 20; mods `armor +10` |
| `outrider` | Mist Dash | dash | 12 s | 0.6 s | distance 80, trailCount 3, damage 6, radius 18, interval 0.5, lifetime 2.5 |
| `dragos` | Unhallowed Ground | zone | 22 s | — | radius 55, damage 12, interval 0.4, knockback 120, lifetime 6 |

`Sanguine Bulwark` is the only `abilityMods` in the game, and it is the third and last source
`recomputeStats()` reads — set on activation, cleared on expiry, both of which are state changes.

---

## Blood

`src/content/blood.json`.

| field | value | meaning |
| --- | ---: | --- |
| `barMax` | 100 | Bar capacity. |
| `threshold` | 50 | Spendable at or above this. The whole bar is spent, never part of it. |
| `intakePerSec` | 12 | Anti-farm cap per **sim** second. Excess is discarded, not banked. |
| `decayPerSec` | 1.5 | Bleed-down rate above `threshold - 1`. |
| `decayGrace` | 4 s | Hold time after the last gain, before decay starts. |
| `healPerBlood` | 0.005 | Feast heals `spent × 0.005 × maxHp` — a full 100 bar is **50% of max health**. |
| `vialValue` | 25 | Blood Vial, granted **uncapped** (sidesteps the intake window in both directions). |

### Frenzy

| field | value |
| --- | ---: |
| `baseDuration` | 3 s |
| `durationPerBlood` | 0.06 s |
| `mightMult` | ×1.4 damage |
| `cooldownMult` | ×0.75 cooldown **and** ×0.75 aura interval |
| `moveSpeedMult` | ×1.15 |
| `novaDamage` | 30 (×might) |
| `novaRadius` | 80 |

A full 100-blood Frenzy therefore runs **9 seconds** (3 + 0.06 × 100). All of it folds in
**read-side** off `run.frenzyT`; `run.stats` is never touched.

---

## Structures

`src/content/structures.json`. A map that ships a `structures` array is a siege map.

| id | name | hp | radius | solid | gold | armed |
| --- | --- | ---: | ---: | --- | ---: | --- |
| `gate` | Bastion Gate | 300 | 14 | yes | 25 | no |
| `shrine` | Blood Shrine | 180 | 10 | no | 40 | no |
| `tower` | Watchtower | 140 | 10 | yes | 30 | **range 170**, interval 1.4 s, damage 14, speed 190, lifetime 1.2 |

A positive `range` arms it (`Comp.Shooter`); `0` makes it a passive wall. Only **walls** (passive
structures) feed `run.wallsLost` and therefore the +8%-per-wall difficulty lean — a watchtower is
expendable hardware, so mounting more towers cannot silently raise a map's ceiling.

---

## Sanctum

`src/content/meta.json`. Permanent, bought with banked gold, folded in as `recomputeStats()`'s
**first** source — so every clamp applies to meta exactly as it does to passives.

| id | name | ranks | costs | per rank | at max |
| --- | --- | ---: | --- | --- | --- |
| `magnetism` | Magnetism | 3 | 80 / 200 / 500 | magnetMul +0.15 | +45% pickup range |
| `bloodthirst` | Bloodthirst | 5 | 100 / 250 / 600 / 1400 / 3000 | might +0.05 | +0.25 might |
| `greed` | Greed | 5 | 100 / 250 / 600 / 1400 / 3000 | greed +0.10 | +50% gold |
| `scholar` | Scholar | 5 | 120 / 300 / 700 / 1600 / 3200 | growth +0.08 | +40% XP |
| `vitality` | Vitality | 3 | 150 / 400 / 1000 | maxHpMul +0.10 | +30% health |
| `swiftness` | Swiftness | 3 | 150 / 400 / 1000 | moveSpeedMul +0.03 | +9% speed |
| `iron_skin` | Iron Skin | 3 | 200 / 500 / 1200 | armor +1 | +3 armour |
| `fortune` | Fortune | 3 | 200 / 500 / 1200 | luck +0.10 | +30% luck |
| `haste` | Haste | 4 | 250 / 600 / 1500 / 3500 | cooldown −0.025 | −0.10 cooldown |
| `second_wind` | Second Wind | 1 | 5 000 | revives +1 | 1 extra revive |

**Total cost of everything: 35 150 gold.** `revives` is handled separately in `Run`'s
constructor (`revivesLeft`, not `stats`).

---

## Maps

Auto-discovered from `src/content/maps/` via `import.meta.glob` — filename is the map id, no
registration.

| id | name | order | tile | bounds | waves | structures |
| --- | --- | ---: | ---: | --- | --- | --- |
| `bastion` | The Broken Bastion | 0 | 16 | bounded | `bastion` | gate, shrine, 2 towers |
| `meadow` | Moonlit Meadow | 1 | 16 | **unbounded** | `default` | — |
| `crypt` | The Sunken Crypt | 2 | 16 | bounded | `default` | — |
| `ruins` | The Ruined Courtyard | 3 | 16 | bounded | `default` | — |
| `arena` | Warden's Arena | 3 | 32 | 20×14 grid | `default` | — |

Bastion's structures: gate at `(-240, 0)`, shrine at `(180, -120)`, towers at `(-190, ±76)` —
the towers flank the gate, so holding the gate is where the towers help most.

---

## Waves

`src/content/waves.json`. Two tables. Both share the same scaling and cap:

| field | value |
| --- | ---: |
| `victorySeconds` | 900 (15 minutes) |
| `maxAlive` | 400 |
| `hpPerMinute` | 0.20 |
| `hpExponent` | 1.30 |
| `damagePerMinute` | 0.05 |
| `speedPerMinute` | 0.012 |

### `default` — 13 stages

| at | interval | perSpawn | roster (weights) |
| ---: | ---: | ---: | --- |
| 0 | 1.30 | 2 | bat 10 |
| 45 | 1.10 | 3 | bat 8, swarmling 5 |
| 105 | 1.00 | 3 | bat 6, swarmling 5, zombie 4 |
| 165 | 0.95 | 4 | zombie 6, slime 5, bat 4 |
| 225 | 0.90 | 4 | skeleton 5, zombie 5, slime 4, wisp 2 |
| 300 | 0.85 | 5 | ghost 5, skeleton 5, bat 4, wisp 3 |
| 375 | 0.75 | 6 | swarmling 10, drifter 4, wisp 3 |
| 450 | 0.75 | 7 | skeleton 6, ghost 5, zombie 4, wisp 3 |
| 525 | 0.70 | 8 | slime 6, skeleton 6, drifter 5, ghost 4, fusebearer 3 |
| 600 | 0.60 | 9 | swarmling 8, ghost 6, skeleton 5, wisp 4, zombie 4, fusebearer 4 |
| 690 | 0.55 | 11 | drifter 7, skeleton 6, ghost 6, wisp 5, fusebearer 4, prior 3 |
| 780 | 0.45 | 13 | skeleton 9, swarmling 7, zombie 6, drifter 5, wisp 4, fusebearer 4, prior 3 |
| 855 | 0.40 | 18 | skeleton 7, ghost 7, swarmling 7, drifter 6, wisp 5, zombie 5, fusebearer 5, prior 3 |

Elites: `brute` from 150 s, every 60 s, count `1 + 0.15/min` (rounded, min 1).
Bosses: warden ×1 at 240 s, ×2 at 480 s, ×3 at 720 s, **reaper** ×1 at 880 s.

### `bastion` — 8 stages, plus sieges

| at | interval | perSpawn | roster (weights) |
| ---: | ---: | ---: | --- |
| 0 | 1.40 | 2 | bat 10 |
| 50 | 1.10 | 3 | bat 7, swarmling 5 |
| 110 | 1.00 | 3 | zombie 6, bat 5, slime 4 |
| 200 | 0.90 | 4 | skeleton 6, zombie 5, wisp 2 |
| 320 | 0.80 | 5 | ghost 5, skeleton 5, slime 4, wisp 3 |
| 470 | 0.70 | 7 | swarmling 8, skeleton 6, drifter 4, ghost 4 |
| 620 | 0.55 | 9 | skeleton 7, ghost 6, zombie 5, wisp 4, fusebearer 4 |
| 780 | 0.45 | 13 | swarmling 10, skeleton 7, ghost 6, drifter 6, wisp 4, fusebearer 4, prior 3 |

Elites: identical to `default`. Bosses: warden ×1 at 240 s, ×2 at 540 s, reaper ×1 at 880 s —
one fewer warden wave than `default`, because the sieges occupy that space.

Sieges:

| at | type | count | duration |
| ---: | --- | ---: | ---: |
| 60 | zombie | 4 | 20 s |
| 120 | zombie | 10 | 45 s |
| 300 | skeleton | 12 | 45 s |
| 480 | slime | 14 | 45 s |
| 660 | skeleton | 16 | 50 s |
| 840 | zombie | 18 | 50 s |

The 60 s entry is a **tutorial siege**: four attackers, twenty seconds, at a point where the
player's build is barely started — long enough to learn what the pips mean and short enough to
survive learning it.
