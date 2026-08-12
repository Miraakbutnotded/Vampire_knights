# Progression and design rationale

Why the numbers in [`balance-tables.md`](balance-tables.md) are what they are, and what a new
piece of content has to respect to fit alongside them.

- [The shape of a run](#the-shape-of-a-run)
- [Experience](#experience)
- [Difficulty scaling](#difficulty-scaling)
- [Wave pressure](#wave-pressure)
- [The draft](#the-draft)
- [Evolutions](#evolutions)
- [The blood economy](#the-blood-economy)
- [Castle defense](#castle-defense)
- [The gold economy](#the-gold-economy)
- [Dailies](#dailies)
- [The unlock graph](#the-unlock-graph)
- [Map design](#map-design)
- [Rules for new content](#rules-for-new-content)

---

## The shape of a run

Fifteen minutes (`victorySeconds: 900`), one character, one map, six weapon slots and six passive
slots. You survive or you die; there is no other fail state — losing every structure on a siege
map costs you a reward and leans the difficulty, but the run continues.

```
0:00   one enemy type, 1.5 spawns/sec        establish a build
2:30   elites begin (a brute every 60 s)     the first real threat
4:00   first boss (warden)                   the first check on your damage
6:15   ranged and drifters thicken           positioning starts to matter
8:00   two wardens                           the mid-run wall
11:30  splitters, fusebearers, everything     crowd control or die
14:40  the reaper                             4200 hp, the closing exam
15:00  victory
```

The pacing target is that **you should feel your build come online around 3–4 minutes** and feel
it start losing to the HP curve around 11–12, so the last three minutes are decided by the
choices you made rather than by the ones you're about to make.

---

## Experience

```
xpForLevel(n) = floor(5 + 4·(n−1) + (n−1)^1.6)
```

Linear plus a mild power term: early levels come fast enough to establish a build in the first
minute, later ones slow down without ever stalling out.

| level | to next | cumulative |
| ---: | ---: | ---: |
| 1 | 5 | 5 |
| 2 | 10 | 15 |
| 3 | 16 | 31 |
| 5 | 30 | 83 |
| 10 | 74 | 360 |
| 15 | 129 | 891 |
| 20 | 192 | 1 721 |
| 25 | 262 | 2 887 |
| 30 | 339 | 4 426 |
| 40 | 512 | 8 749 |

Level 20 — the `acolyte` unlock requirement and a `core` daily objective — costs **1 721 XP
cumulative**. Trash gives 1–5 XP, the brute 14, the warden 70, the reaper 260, so that is a
target you reach by clearing waves rather than by farming any one thing.

`growth` multiplies XP on the way in (`gainXp` applies `run.stats.growth`), so Scholar's Crown at
max (+50%) and the Sanctum's Scholar at max (+40%) compound into roughly **level 20 at the cost
of level 15's XP**. A single large gem can cross several thresholds at once, which is why
`pendingLevelUps` is a queue and the draft chains.

---

## Difficulty scaling

```
hp     = (1 + 0.20·minutes) ^ 1.30
damage = (1 + 0.05·minutes) · (1 + 0.08·wallsLost)
speed  = (1 + 0.012·minutes) · (1 + 0.08·wallsLost)
```

| time | hp × | damage × | speed × |
| ---: | ---: | ---: | ---: |
| 0:00 | 1.00 | 1.00 | 1.000 |
| 1:00 | 1.27 | 1.05 | 1.012 |
| 2:00 | 1.55 | 1.10 | 1.024 |
| 4:00 | 2.15 | 1.20 | 1.048 |
| 5:00 | 2.46 | 1.25 | 1.060 |
| 7:00 | 3.12 | 1.35 | 1.084 |
| 10:00 | 4.17 | 1.50 | 1.120 |
| 13:00 | 5.29 | 1.65 | 1.156 |
| 15:00 | 6.06 | 1.75 | 1.180 |

Three deliberate asymmetries:

1. **HP is exponential, damage and speed are linear.** The exponent (1.3) is what lets late-game
   health outpace linear weapon growth, and that is what forces build decisions rather than
   letting one weapon carry forever. A weapon that goes 12 → 42 damage across eight levels has
   tripled; enemy HP has sextupled.
2. **Speed barely moves at all** (+18% over the whole run). Enemies getting faster is the least
   interesting way to raise difficulty — it removes counterplay rather than demanding it. The
   pressure comes from *how many* and *how tough*, not *how fast*.
3. **These are consumed at spawn time only.** Enemies already on the field never rescale, so a
   crowd you failed to clear does not silently become a harder crowd while you fight it.

`wallsLost` adds **+8% damage and speed per wall**, multiplied on top. It is counted off
`run.wallsLost` (passive structures) rather than `structuresLost` (everything), so a map that
mounts more watchtowers does not raise its own ceiling.

---

## Wave pressure

The one content gate in `simulation.test.ts`:

> **No wave stage may drop below 75% of the pressure the stage before it set.**
>
> `pressure = mean enemy hp × (perSpawn / spawnInterval) × hpScale(at)`

Every other assertion about a run is a safety bound — no leak, no stall, cap respected — and a run
that gets **easier** violates none of them. That is how `default`'s 780 s stage once sat at a 44%
collapse unnoticed. **Dips are legal; collapses are not.**

### `default`

| at | mean hp | spawns/s | hp × | pressure | vs previous |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 8.0 | 1.54 | 1.00 | 12 | — |
| 45 | 6.5 | 2.73 | 1.20 | 21 | 172% |
| 105 | 10.9 | 3.00 | 1.48 | 48 | 231% |
| 165 | 17.1 | 4.21 | 1.77 | 127 | 264% |
| 225 | 24.6 | 4.44 | 2.07 | 227 | 178% |
| 300 | 23.6 | 5.88 | 2.46 | 343 | 151% |
| 375 | 12.9 | 8.00 | 2.87 | 297 | **87%** ← the sharpest legal dip |
| 450 | 27.8 | 9.33 | 3.29 | 853 | 287% |
| 525 | 27.2 | 11.43 | 3.73 | 1 157 | 136% |
| 600 | 21.5 | 15.00 | 4.17 | 1 344 | 116% |
| 690 | 31.5 | 20.00 | 4.72 | 2 973 | 221% |
| 780 | 26.4 | 28.89 | 5.29 | 4 027 | 135% |
| 855 | 26.4 | 45.00 | 5.77 | 6 842 | 170% |

The 375 s dip is intentional and is the clearest example of what the gate permits: the roster
switches to a swarmling flood (mean HP drops from 23.6 to 12.9) while the spawn rate jumps from
5.9 to 8.0/s. Same pressure, different *shape* — a test of area damage rather than single-target
damage. The gate exists to allow exactly that while catching an accidental collapse.

### `bastion`

| at | mean hp | spawns/s | hp × | pressure | vs previous |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 8.0 | 1.43 | 1.00 | 11 | — |
| 50 | 6.3 | 2.73 | 1.22 | 21 | 187% |
| 110 | 16.5 | 3.00 | 1.50 | 74 | 355% |
| 200 | 28.0 | 4.44 | 1.94 | 242 | 326% |
| 320 | 25.5 | 6.25 | 2.57 | 410 | 169% |
| 470 | 21.3 | 10.00 | 3.41 | 724 | 177% |
| 620 | 27.9 | 16.36 | 4.29 | 1 961 | 271% |
| 780 | 25.0 | 28.89 | 5.29 | 3 818 | 195% |

Bastion runs **fewer, longer stages** — eight against thirteen — and peaks slightly lower, because
the siege events occupy attention that `default` spends on wave escalation. Its two lulls (the
320 s and 470 s stages both dip in mean HP) sit where sieges do not, so the player has room to
walk back to the wall.

`maxAlive: 400` is a hard cap for both, enforced in one place — the wave director — plus a
re-check inside `splitEnemy`, which is the only spawn path that bypasses the director.

---

## The draft

Three offers, drawn **without replacement** from a weighted pool of every eligible weapon and
passive.

- **Owning something already multiplies its weight by 1.6** (`EXISTING_WEIGHT_BONUS`). Builds
  deepen into a specialty instead of spreading thin across six level-one weapons.
- **Evolutions are never offered.** Three lines of defence: `EVOLVED_WEAPON_IDS` is checked in
  `rollOffers`, `maxLevel 1` keeps them out of the upgrade branch once owned, and `weight: 0` in
  the content is the third.
- **A base whose evolution you already own is also skipped.** The fusion overwrote its slot, so it
  reads as level 0 again — offering it back would sell a weapon slot and eight picks for a weapon
  that can never fuse again.
- **A maxed-out loadout falls back** to Restoration (40% max health) and Miser's Reward (20–60
  gold before greed) rather than an empty screen.

Level-ups **chain**: several can bank during a single large gem, and `openLevelUp` re-enters
itself until the queue empties. That is why the frame gate is a latch — the second draft's frame
carries real HUD changes even though the state never left `levelup`.

The `draft:picked` event carries **every id in the draft**, including the declined ones.
Popularity without a denominator is confounded by the draft's own weighting, so take-rate needs
the offers that were turned down — and once the screen closes they exist nowhere else.

---

## Evolutions

Each of the thirteen base weapons pairs with a **different** passive, so an evolution is a real
commitment: two of your twelve slots, both taken to max.

Requirements: base weapon at max level (8), paired passive at max level, and a **chest**.
Chests come from bosses (`dropsChest`) and from successfully defended sieges — so an evolution is
gated on beating something, not on time.

`tryEvolve` is deliberately **rng-free**: having earned it, you get it. A draw on a conditional
path would shift every later draw in the run and silently rewrite the expected values of every
seeded test — which is why the tie-break below is positional rather than random.

Three consequences worth knowing as a designer:

- **Exactly one evolution resolves per chest.** The winner is the eligible pairing whose base sits
  lowest in `run.weapons` — the weapon you have carried longest. The loser stays eligible and
  fires on the next chest; resolving both at once would halve the weight of the moment and double
  the power spike in the same second.
- **Each evolution fires at most once per run**, enforced on the *target* rather than the base.
  The swap overwrites the slot, so the base reads as level 0 again — without this check a
  re-drafted copy carried back to the ceiling would mint a second evolved weapon sharing one def.
- **The required passive is not consumed.** Taking it back would cut the player's stats at the
  exact moment they were rewarded.

Mechanically, `tryEvolve` must `world.destroy` the base weapon's `activeIds` before the swap, or
an orbit satellite or aura ring outlives its owner as an immortal entity still dealing the old
weapon's numbers. `Run.evolveWeapon` replaces the weapon **in place**, so the HUD slot keeps its
position — "this weapon became that weapon" is the whole readability of the moment.

Evolutions land at roughly **2.5–4× the base weapon's max-level output** and, more importantly,
change its shape: Bone Whip's directional sweep becomes Crimson Reap's omnidirectional ring;
Starfall's 18 stars every 3.5 s become Nightfall's 24 every 1.9 s. A new evolution needs a
block on the base plus a terminal entry (`weight: 0`, `levels: []`) — **no code**.

---

## The blood economy

Kills fill a bar; at 50 the whole bar is spendable, on one of two things:

| | Feast | Frenzy |
| --- | --- | --- |
| effect | Heal `spent × 0.5%` of max HP | ×1.4 damage, ×0.75 cooldown, ×1.15 move speed, plus a one-tick 30-damage nova in radius 80 |
| a full 100 bar | +50% max health | 9 seconds |
| answers | "I am going to die" | "I need this crowd gone" |

Four rules make it a decision rather than a resource:

1. **All or nothing.** No partial spends. Below the threshold the press is swallowed.
2. **An intake cap of 12/second.** Excess is discarded, not banked, so standing in a meat grinder
   does not bank a Frenzy per second. The window is keyed to `run.time` crossing a whole **sim**
   second — never wall clock, or a run stops being reproducible from its seed.
3. **Use it or lose it.** Above `threshold - 1`, blood holds for 4 seconds after the last gain and
   then bleeds at 1.5/s — down to `threshold - 1` and no further. So a full bar you sit on decays
   toward "still spendable, but no longer a *big* spend", and never toward nothing.
4. **Blood Vials are uncapped** (25 each, from elites and bosses) — they land whole and neither
   consume nor are limited by the intake window, so a vial cannot eat the allowance kills need.

Frenzy folds in **read-side**, keyed off `run.frenzyT`, and `run.stats` is never written. That is
the invariant the whole three-source `recomputeStats()` design exists to protect: nothing that
changes per tick may reach the stat block.

`bloodGain` scales intake (Dragos ships 1.25; the Bloodthirst passive adds up to +50%), which
makes "spend blood often" a build you can actually commit to rather than a universal constant.

---

## Castle defense

A map with a `structures` array is a siege map, and the picker derives its tag from that alone.

The loop: a siege window opens, attackers spawn on the 300-unit ring already targeting the nearest
living structure, and you choose between defending the wall and continuing to farm. When the window
closes:

- **At least one structure standing** → a chest and that structure's gold, dropped **at the
  survivor**. Walking back to the wall you held is the reward loop.
- **Everything down** → no reward, and nothing else. The penalty was already banked when each wall
  fell: +8% enemy damage and speed, permanently, at spawn time.

Losing walls is a **difficulty lean, not a fail state.** Player death remains the only way to lose,
which is what keeps a siege map from becoming an escort mission.

Watchtowers exist to make the choice non-binary — they hold a wall you have walked away from, so
they are exempt from the engagement-range gate and answer to their own `range` (170) instead. They
fire from `TOWER_STATS`, built from `WEAPON_STAT_DEFAULTS` and **never** `effectiveStats()`: a
passive or Frenzy multiplier reaching a tower would turn terrain into part of the build.

---

## The gold economy

### Sources, per run

| source | amount |
| --- | --- |
| Trash coins | 1–8% chance × 1–2 gold |
| Brute | 60% × 6 |
| Warden | 100% × 40 |
| Reaper | 100% × 150 |
| Siege defended | the surviving structure's `gold` (25–40) |
| Miser's Reward draft offer | 20–60 |

All of it multiplied by `greed` (Miser's Mask up to +75%, Sanctum Greed up to +50%, Vespera +10%).

A full seeded fifteen-minute run banks roughly **600 gold** — `simulation.test.ts` pins it in the
300–1 200 band as a balance tripwire, with ~603 observed. A diff there means the economy moved and
wants a look, not a number to update reflexively.

### Sinks

| sink | cost |
| --- | ---: |
| All four locked characters | 24 500 |
| Every Sanctum rank | 35 150 |
| **Total** | **59 650** |

At ~600 gold per completed run that is roughly **100 runs to buy everything** — before the Greed
node and Miser's Mask, which are self-funding and are why they exist. The curve is deliberately
front-loaded: the cheapest rank in the game is Magnetism at 80, and the first rank of every
headline node is 100–250, so the first two or three runs already buy something you feel.

Nothing about that total is a paywall — there is no purchase path, no leaderboard and no PvP.
It is a long tail for a player who wants one.

---

## Dailies

Three objectives a day: **two `core` and one `flavour`**, drawn from a pool of ten by shuffling
each tier separately with an `Rng` seeded on the day index.

| | pool |
| --- | --- |
| `core` (any map, any character) | kills 400 · level 20 · picks 12 · gold 400 · survive 600 s |
| `flavour` (mechanic-specific) | frenzy ×5 · feast 200 hp · siege ×2 · evolve ×1 · walls ×1 |

The tier split is the whole reason `tier` exists: a day is never all-blood or all-bastion, so a
player who only wants to play Moonlit Meadow can always clear two of three, and the third is the
nudge.

Payout: **150 per objective + 150 for clearing all three = 600**, roughly one good run. A player
who shows up daily earns about double; a player who grinds ten runs in one day earns nothing
extra. The set is derived from the day index alone and never persisted, so it cannot drift out of
sync with the stored progress.

**Anti-cheat is the monotonic floor and nothing else.** A new set is granted only when the observed
local day is *strictly above* the stored one, and the floor never descends:

- Clock forward to farm → one set immediately, and the floor rises permanently. Restore the real
  clock and you get nothing until calendar time catches up. **N farmed sets cost N real days.**
- Clock backward → absorbed. No re-roll, progress untouched.
- Flying west → at most one skipped set; flying east → the next set a few hours early. Never a
  lost reward, never a reset bar.

Anything heavier — a signed server timestamp, an uptime accumulator — buys defence nobody needs
for a soft currency in a single-player game, and costs the honest player real correctness.
Proportionality is the argument.

Rollover is evaluated at **exactly three points, none of them during a run**: boot, the title
screen, and resume from background (which refuses to roll unless the title is up). A run that
starts at 23:59 and ends at 00:02 must not watch its own progress bar reset.

---

## The unlock graph

```
wanderer  (free)
   │
   ├─ level ≥ 20 in one run ────────────► acolyte           2 500 g
   ├─ survive ≥ 600 s in one run ───────► outrider          4 000 g
   ├─ walls: hold Bastion intact ───────► warden_knight     6 000 g
   └─ victory: survive a full night ────► dragos           12 000 g
```

Every character is gated **twice** — a feat and then a price — and the two gates are read off the
same `LockState` the card renders, in the order the player has to satisfy them. `lockStateOf` is
the single answer to "why is this locked", so the screen and the purchase cannot disagree.

The requirements are ordered by what they teach, not by cost: reach level 20 (learn the draft),
last ten minutes (learn to survive), hold the Bastion (learn the siege map), win (learn all of it).
The prices then re-order them, which is deliberate — you often *earn* `warden_knight` before you
can *afford* `acolyte`.

Requirements resolve against the **same per-run signals the daily oaths use** (`featDelta` is
`dailyDelta` plus a victory flag), so adding a new one needs nothing new tracked in the simulation.
Only a **finished** run folds into the record — quitting mid-run records nothing, exactly as it
banks nothing.

An existing player arrives with an empty feat record and has to earn the requirements. The
alternative — backfilling from telemetry — would credit feats from runs played before the
requirements existed, which is a guess dressed up as history. Characters already bought stay
bought: `unlockedCharacters` is the record of what was purchased, and nothing re-derives it.

---

## Map design

Five maps, four distinct answers to "what does the terrain do to you":

| map | the question it asks |
| --- | --- |
| **Moonlit Meadow** (unbounded) | Nothing. Pure kiting, infinite room. The baseline read on a build. |
| **The Sunken Crypt** (bounded, hard corners) | Can you avoid being cornered? Props break line of retreat. |
| **The Ruined Courtyard** (bounded, solid decor) | Same, but the walls are *scattered* rather than structural — 53 props plus solid decor at density. |
| **Warden's Arena** (20×14 grid, 32 px tiles) | A closed floor with no door. Wall to wall, fifteen minutes. |
| **The Broken Bastion** (bounded, 4 structures) | Will you leave the fight to defend something? |

Design constraints that fall out of the engine:

- **An unbounded map is free** — the spatial hash wraps coordinates modulo its grid, so there is no
  "outside the world" blind spot. Bounded maps clamp the camera, which is why `withinEngagement`
  measures from the camera and not the player.
- **Spawn rings are fixed**: trash 330, sieges 300, elites 290, bosses 210. A map cannot be so
  small that the ring lands inside the play area, or enemies spawn on top of you.
- **A siege map is defined by having structures at all** — no flag, no tag, no registration.
- **A new map is a JSON file**, auto-discovered by `import.meta.glob`; the filename is the id.

---

## Rules for new content

Everything below is enforced by a test, a whitelist, or both.

### A new enemy

- Fits one of the eight `Behavior` values, or needs a new one (which means code: `Behavior` +
  `behaviorFromName` in `components.ts`, an init case in **`spawn.ts`**, an AI case in
  `updateEnemies`, and defaulted fields in `EnemyDef` + `normalizeEnemies`).
- HP sits on the ladder: trash 4–58, elite 160, boss 1100/4200. Remember that everything is
  multiplied by up to **6× by minute fifteen**.
- XP tracks difficulty, not HP: the wisp is 20 HP and 4 XP because it is annoying to reach.
- `coinChance × coin` is the gold contribution — keep a full run near the 600 mark.

### A new weapon

- Add the behavior to the `WeaponBehavior` const in `content.ts` first — that const **is** the JSON
  validation whitelist. New tunables go in `WeaponStats` + `WEAPON_STAT_KEYS` +
  `WEAPON_STAT_DEFAULTS`.
- Seven level entries, so it maxes at 8 like everything else.
- Level deltas should roughly **triple** L1 damage by L8, with count and cooldown carrying the
  rest. A weapon that only gains damage is a weapon whose L8 feels like its L1.
- Pair its evolution with a passive **no other weapon uses**.
- `weight` positions it against the existing 75–100 band.

### A new passive

- One clear axis. The two trade passives (`hollowvow`, `graveiron`) are the exceptions and they
  earn it by being genuinely build-defining.
- `weight` is the balancing lever: 100 for a staple, 30 for `twinsigil`, whose `+amount` applies
  to every weapon at once.
- If it is the pair for a new evolution, it must not already be paired.

### A new wave stage

- **Never drop below 75% of the previous stage's pressure.** Compute it before you commit:
  `mean hp × (perSpawn / spawnInterval) × hpScale(at)`.
- Changing the *shape* (more, weaker enemies) is the interesting move; the gate exists to permit
  it while catching a collapse.

### A new unlock signal

- Add it to the `UnlockSignal` const in `content.ts` (the JSON whitelist) **and** emit it from
  `featDelta` in `services/feats.ts`. The two lists are duplicated rather than imported because
  `save.ts`'s import closure is walled off from `gameplay/`; `feats.test.ts` asserts they stay
  equal. **Change one, change both.**
- It must resolve against a signal `dailyDelta` already derives — nothing new is tracked in the
  simulation.

### A new ability

- A block on a character in `characters.json`. A new *kind* means adding to `AbilityKind` (the
  whitelist) plus a case in `abilities.ts`.
- Respect the scaling guardrail: **damage ×might, sizes ×area, lifetime ×duration, nothing else.**
  The cooldown stays raw.

### A new structure

- An entry in `structures.json` plus a `structures` array on the map. A positive `range` arms it;
  `0` makes it a passive wall — and **only passive walls feed the difficulty lean**.
