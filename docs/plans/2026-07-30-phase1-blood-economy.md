# Blood Economy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the run-scoped Blood Economy — kills bank blood into a capped bar; at ≥50 the player spends it all on Feast (heal) or Frenzy (damage/speed buff + nova), with grace-then-decay above the threshold.

**Architecture:** Blood state lives on `Run` (sim-time timers only, determinism preserved); a new stateless system `src/gameplay/blood.ts::updateBlood(ctx, dt)` runs after `updatePickups` in both `Game.tick()` and `makeHarness()` (mirrored verbatim, same commit). Player intent is a latched `ctx.bloodIntent` field set frame-side (HUD taps / KeyQ / KeyE in `beforeFrame`) and consumed sim-side. Frenzy is strictly read-side: multipliers keyed off `run.frenzyT` inside `effectiveStats()` and `updatePlayer()` — `run.stats` is never mutated.

**Tech Stack:** TypeScript strict, Vite, Vitest headless harness (`src/gameplay/simulation.test.ts`), data-driven JSON content normalized warn-don't-throw in `src/gameplay/content.ts`. No new dependencies.

---

**Design source:** `docs/plans/2026-07-30-mobile-v1-design.md` §1. **Invariants:** `CLAUDE.md` (tick order load-bearing, harness mirrors tick verbatim, `ctx.rng` only, `run.stats` immutable outside `recomputeStats()`, warn-don't-throw content, new Ctx field ⇒ init in Game constructor AND `makeHarness()`, reset in `startRun()`).

**Test placement:** all new headless tests go in one new `describe('blood economy', …)` block appended at the end of `src/gameplay/simulation.test.ts` (after the closing `});` of `describe('difficulty scaling', …)`). Task 1 creates the block; later tasks append `it(…)` cases inside it.

## Setup

```bash
cd /Users/boraesen/Desktop/Vampire_knights
git checkout -b feat/phase-1-blood-economy
npm test   # confirm the suite is green before touching anything
```
Expected: all existing tests pass. (Git operations require user approval per house rules — ask before each commit/checkout.)

---

### Task 1: blood.json content file + BLOOD_CONFIG normalization

**Files:**
- Create: `src/content/blood.json`
- Modify: `src/gameplay/content.ts` (imports at top; new section before `// --- shared ---` at line 640)
- Test: `src/gameplay/simulation.test.ts` (new describe block at end of file; imports at line 16)

**Step 1: Write the failing test**

In `src/gameplay/simulation.test.ts`, extend the content import (line 16) to include `BLOOD_CONFIG`:

```ts
import { BLOOD_CONFIG, CHARACTER_LIST, WEAPON_LIST, enemyDef, waveTable, weaponStatsAtLevel } from './content.ts';
```

Append at the very end of the file:

```ts
describe('blood economy', () => {
  it('normalizes blood.json into a typed config with the design defaults', () => {
    expect(BLOOD_CONFIG.barMax).toBe(100);
    expect(BLOOD_CONFIG.threshold).toBe(50);
    expect(BLOOD_CONFIG.intakePerSec).toBe(12);
    expect(BLOOD_CONFIG.decayPerSec).toBeCloseTo(1.5);
    expect(BLOOD_CONFIG.decayGrace).toBe(4);
    expect(BLOOD_CONFIG.healPerBlood).toBeCloseTo(0.005);
    expect(BLOOD_CONFIG.frenzy.baseDuration).toBe(3);
    expect(BLOOD_CONFIG.frenzy.durationPerBlood).toBeCloseTo(0.06);
    expect(BLOOD_CONFIG.frenzy.mightMult).toBeCloseTo(1.4);
    expect(BLOOD_CONFIG.frenzy.cooldownMult).toBeCloseTo(0.75);
    expect(BLOOD_CONFIG.frenzy.moveSpeedMult).toBeCloseTo(1.15);
    expect(BLOOD_CONFIG.frenzy.novaDamage).toBe(30);
    expect(BLOOD_CONFIG.frenzy.novaRadius).toBe(80);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "normalizes blood.json"`
Expected: FAIL — the whole suite file fails to load with `The requested module './content.ts' does not provide an export named 'BLOOD_CONFIG'`.

**Step 3: Write minimal implementation**

Create `src/content/blood.json`:

```json
{
  "barMax": 100,
  "threshold": 50,
  "intakePerSec": 12,
  "decayPerSec": 1.5,
  "decayGrace": 4,
  "healPerBlood": 0.005,
  "frenzy": {
    "baseDuration": 3,
    "durationPerBlood": 0.06,
    "mightMult": 1.4,
    "cooldownMult": 0.75,
    "moveSpeedMult": 1.15,
    "novaDamage": 30,
    "novaRadius": 80
  }
}
```

In `src/gameplay/content.ts`, add to the JSON imports at the top (after line 6, `import wavesJson …`):

```ts
import bloodJson from '../content/blood.json';
```

Insert a new section just before `// --- shared ---` (line 640):

```ts
// --- blood ----------------------------------------------------------------

export interface FrenzyConfig {
  baseDuration: number;
  durationPerBlood: number;
  mightMult: number;
  cooldownMult: number;
  moveSpeedMult: number;
  novaDamage: number;
  novaRadius: number;
}

export interface BloodConfig {
  barMax: number;
  threshold: number;
  intakePerSec: number;
  decayPerSec: number;
  decayGrace: number;
  healPerBlood: number;
  frenzy: FrenzyConfig;
}

const BLOOD_DEFAULTS: BloodConfig = {
  barMax: 100,
  threshold: 50,
  intakePerSec: 12,
  decayPerSec: 1.5,
  decayGrace: 4,
  healPerBlood: 0.005,
  frenzy: {
    baseDuration: 3,
    durationPerBlood: 0.06,
    mightMult: 1.4,
    cooldownMult: 0.75,
    moveSpeedMult: 1.15,
    novaDamage: 30,
    novaRadius: 80,
  },
};

/** Same fail-soft contract as the other content files: a bad value warns and
 *  falls back to the default rather than taking the game down. */
function normalizeBlood(): BloodConfig {
  const raw = bloodJson as unknown as Record<string, unknown>;
  const num = (obj: Record<string, unknown>, key: string, fallback: number): number => {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v !== undefined) {
      console.warn(`[content] blood.json "${key}" is not a finite number; using ${fallback}`);
    }
    return fallback;
  };
  const frenzyRaw =
    typeof raw['frenzy'] === 'object' && raw['frenzy'] !== null
      ? (raw['frenzy'] as Record<string, unknown>)
      : {};
  const d = BLOOD_DEFAULTS;
  return {
    barMax: num(raw, 'barMax', d.barMax),
    threshold: num(raw, 'threshold', d.threshold),
    intakePerSec: num(raw, 'intakePerSec', d.intakePerSec),
    decayPerSec: num(raw, 'decayPerSec', d.decayPerSec),
    decayGrace: num(raw, 'decayGrace', d.decayGrace),
    healPerBlood: num(raw, 'healPerBlood', d.healPerBlood),
    frenzy: {
      baseDuration: num(frenzyRaw, 'baseDuration', d.frenzy.baseDuration),
      durationPerBlood: num(frenzyRaw, 'durationPerBlood', d.frenzy.durationPerBlood),
      mightMult: num(frenzyRaw, 'mightMult', d.frenzy.mightMult),
      cooldownMult: num(frenzyRaw, 'cooldownMult', d.frenzy.cooldownMult),
      moveSpeedMult: num(frenzyRaw, 'moveSpeedMult', d.frenzy.moveSpeedMult),
      novaDamage: num(frenzyRaw, 'novaDamage', d.frenzy.novaDamage),
      novaRadius: num(frenzyRaw, 'novaRadius', d.frenzy.novaRadius),
    },
  };
}

export const BLOOD_CONFIG: BloodConfig = normalizeBlood();
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "normalizes blood.json"`
Expected: PASS (1 passed).

**Step 5: Commit**

```bash
git add src/content/blood.json src/gameplay/content.ts src/gameplay/simulation.test.ts
git commit -m "feat: add blood.json content file with normalized BLOOD_CONFIG"
```

---

### Task 2: per-enemy blood field

**Files:**
- Modify: `src/gameplay/content.ts` (`EnemyDef` interface ~line 30; `normalizeEnemies` entry literal ~line 86)
- Modify: `src/content/enemies.json` (swarmling entry, line 10)
- Test: `src/gameplay/simulation.test.ts` (inside `describe('blood economy')`)

**Step 1: Write the failing test**

Append inside the `blood economy` describe block:

```ts
  it('defaults per-enemy blood by tier and honours explicit values', () => {
    expect(enemyDef('bat')!.blood).toBe(1);          // normal default
    expect(enemyDef('swarmling')!.blood).toBe(0.5);  // explicit in enemies.json
    expect(enemyDef('brute')!.blood).toBe(8);        // elite default
    expect(enemyDef('warden')!.blood).toBe(8);       // boss default
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "defaults per-enemy blood"`
Expected: FAIL with `expected undefined to be 1` (the `blood` property does not exist yet).

**Step 3: Write minimal implementation**

In `src/gameplay/content.ts`, `EnemyDef` interface — after `xp: number;` (line 30) add:

```ts
  /** Blood granted directly on kill, before the player's bloodGain multiplier. */
  blood: number;
```

In `normalizeEnemies`, in the `entry: EnemyDef` literal — after `xp: num('xp', 1),` add:

```ts
      blood: num('blood', bool('elite') || bool('boss') ? 8 : 1),
```

In `src/content/enemies.json`, in the `swarmling` entry, after `"xp": 1,` (line 10) add:

```json
    "blood": 0.5,
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "defaults per-enemy blood"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/content/enemies.json src/gameplay/simulation.test.ts
git commit -m "feat: add per-enemy blood field with tier defaults"
```

---

### Task 3: bloodGain stat + Bloodthirst passive

**Files:**
- Modify: `src/gameplay/content.ts` (`StatMods` ~line 322, `STAT_MOD_KEYS` ~line 341, `BaseStats` ~line 416, `BASE_STAT_DEFAULTS` ~line 436)
- Modify: `src/gameplay/run.ts` (`recomputeStats()` line 148)
- Modify: `src/content/passives.json` (append entry)
- Test: `src/gameplay/simulation.test.ts` (needs `Run` — already imported at line 20)

**Step 1: Write the failing test**

Append inside the `blood economy` describe block:

```ts
  it('folds bloodGain from character defaults and the Bloodthirst passive', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    expect(run.stats.bloodGain).toBe(1);
    run.addPassive('bloodthirst');
    expect(run.stats.bloodGain).toBeCloseTo(1.1);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "folds bloodGain"`
Expected: FAIL with `expected undefined to be 1`.

**Step 3: Write minimal implementation**

`src/gameplay/content.ts`:

1. `StatMods` interface — after `critMult: number;` add:
   ```ts
     bloodGain: number;
   ```
2. `STAT_MOD_KEYS` array — after `'critMult',` add:
   ```ts
     'bloodGain',
   ```
3. `BaseStats` interface — after `critMult: number;` (before `revives`) add:
   ```ts
     bloodGain: number;
   ```
4. `BASE_STAT_DEFAULTS` — after `critMult: 2,` add:
   ```ts
     bloodGain: 1,
   ```
   (`normalizeCharacters` iterates `Object.keys(BASE_STAT_DEFAULTS)`, so every character
   picks up the default automatically — `characters.json` needs no edit in this phase;
   a 1.25 vampire-lord ships with the Phase 2 kits.)

`src/gameplay/run.ts`, `recomputeStats()`:

5. In the `sum: StatMods` literal (lines 150–167) — after `critMult: 0,` add:
   ```ts
       bloodGain: 0,
   ```
6. In the `this.stats = { … }` literal (lines 178–196) — after the `critMult` line add:
   ```ts
       bloodGain: Math.max(0, base.bloodGain + sum.bloodGain),
   ```

`src/content/passives.json` — append before the closing `}` (add a comma after the
`misersmask` block):

```json
  "bloodthirst": {
    "name": "Bloodthirst",
    "description": "+10% blood gained from kills per level.",
    "maxLevel": 5,
    "weight": 70,
    "perLevel": { "bloodGain": 0.1 }
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "folds bloodGain"`
Expected: PASS. Also run `npx vitest run -t "never exceeds the slot caps"` — still PASS
(the new passive enters the offer pool; the generic cap test must stay green).

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/gameplay/run.ts src/content/passives.json src/gameplay/simulation.test.ts
git commit -m "feat: add bloodGain stat and Bloodthirst passive"
```

---

### Task 4: Run blood state + capped gainBlood

**Files:**
- Modify: `src/gameplay/run.ts` (import line 2; fields after `revivesLeft` line 69; method after `gainGold` line 231)
- Test: `src/gameplay/simulation.test.ts`

**Step 1: Write the failing test**

Append inside the `blood economy` describe block:

```ts
  it('caps blood intake inside one window and clamps at the bar max', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    expect(run.gainBlood(5)).toBe(5);
    expect(run.blood).toBe(5);
    expect(run.graceT).toBe(BLOOD_CONFIG.decayGrace);

    // 5 already absorbed this window; only 7 more fit under the 12/sec cap.
    expect(run.gainBlood(100)).toBe(BLOOD_CONFIG.intakePerSec - 5);
    expect(run.blood).toBe(BLOOD_CONFIG.intakePerSec);
    expect(run.gainBlood(1)).toBe(0);

    // A fresh window still clamps at the bar max.
    run.bloodIntakeWindow = 0;
    run.blood = run.bloodMax - 2;
    expect(run.gainBlood(10)).toBe(2);
    expect(run.blood).toBe(run.bloodMax);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "caps blood intake inside one window"`
Expected: FAIL with `run.gainBlood is not a function`.

**Step 3: Write minimal implementation**

`src/gameplay/run.ts` — extend the content import (line 2):

```ts
import { BLOOD_CONFIG, characterDef, passiveDef, weaponDef } from './content.ts';
```

After `revivesLeft: number;` (line 69) add the state fields:

```ts
  // --- blood economy ------------------------------------------------------
  // All timers advance only inside updateBlood on sim dt — never wall clock —
  // so a run stays reproducible from its seed.

  /** Banked blood, 0..bloodMax. */
  blood = 0;
  bloodMax = BLOOD_CONFIG.barMax;
  /** Blood absorbed during the current sim-second, for the anti-farm cap. */
  bloodIntakeWindow = 0;
  /** Seconds of Frenzy remaining. Read-side multipliers key off this. */
  frenzyT = 0;
  /** Seconds of decay grace left after the most recent gain. */
  graceT = 0;
```

After `gainGold` (line 231) add:

```ts
  /**
   * Grants blood, honouring the per-second intake cap and the bar maximum.
   * Excess above either limit is discarded, not banked — the anti-farm rule.
   * Returns the blood actually gained.
   */
  gainBlood(amount: number): number {
    const room = BLOOD_CONFIG.intakePerSec - this.bloodIntakeWindow;
    const granted = Math.min(amount, room, this.bloodMax - this.blood);
    if (granted <= 0) return 0;
    this.bloodIntakeWindow += granted;
    this.blood += granted;
    this.graceT = BLOOD_CONFIG.decayGrace;
    return granted;
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "caps blood intake inside one window"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/gameplay/run.ts src/gameplay/simulation.test.ts
git commit -m "feat: add blood state and capped gainBlood to Run"
```

---

### Task 5: blood events + grantBlood + killEnemy hook + MEAT_CHANCE halving

**Files:**
- Modify: `src/core/events.ts` (`GameEvents` interface, line 31)
- Modify: `src/gameplay/pickups.ts` (imports; new helper next to `healPlayer` line 223)
- Modify: `src/gameplay/damage.ts` (import line 3; `MEAT_CHANCE` line 12; `killEnemy` line 79)
- Test: `src/gameplay/simulation.test.ts` (imports at top + two tests)

**Step 1: Write the failing tests**

Add to the test file's imports (there is no damage.ts import yet — add one after line 17):

```ts
import { damageEnemy } from './damage.ts';
```

Append inside the `blood economy` describe block:

```ts
  it('grants blood per enemy def on kill and signals readiness at the threshold', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    let readyFired = false;
    let gainedEvents = 0;
    ctx.bus.on('blood:ready', () => {
      readyFired = true;
    });
    ctx.bus.on('blood:gained', () => {
      gainedEvents++;
    });

    const bat = enemyDef('bat')!;
    const swarmling = enemyDef('swarmling')!;
    const ids = [
      spawnEnemy(ctx, bat, 60, 0),
      spawnEnemy(ctx, bat, 70, 0),
      spawnEnemy(ctx, bat, 80, 0),
      spawnEnemy(ctx, swarmling, 90, 0),
      spawnEnemy(ctx, swarmling, 100, 0),
    ];
    for (const id of ids) damageEnemy(ctx, id, 1e9, 0, 0, 0, false);

    // 3 x 1 + 2 x 0.5 with bloodGain 1, all inside the intake window.
    expect(ctx.run.blood).toBeCloseTo(4);
    expect(gainedEvents).toBe(5);
    expect(readyFired).toBe(false);

    // Crossing the threshold announces readiness exactly once.
    ctx.run.blood = BLOOD_CONFIG.threshold - 1;
    const last = spawnEnemy(ctx, bat, 110, 0);
    damageEnemy(ctx, last, 1e9, 0, 0, 0, false);
    expect(ctx.run.blood).toBeCloseTo(BLOOD_CONFIG.threshold);
    expect(readyFired).toBe(true);
  });

  it('discards blood above the per-second intake cap', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const bat = enemyDef('bat')!;
    for (let i = 0; i < 100; i++) {
      const id = spawnEnemy(ctx, bat, 300 + (i % 10) * 8, 300 + Math.floor(i / 10) * 8);
      damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    }
    // 100 blood offered inside one window; everything past the cap is gone.
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "grants blood per enemy def"`
Expected: FAIL with `expected +0 to be close to 4` (kills do not grant blood yet).
Run: `npx vitest run -t "discards blood above the per-second"`
Expected: FAIL with `expected +0 to be 12`.

**Step 3: Write minimal implementation**

`src/core/events.ts` — add to the `GameEvents` interface (after `'stats:changed': undefined;`):

```ts
  'blood:gained': { amount: number; blood: number; max: number };
  'blood:ready': undefined;
  'blood:feast': { spent: number; healed: number };
  'blood:frenzy': { spent: number; duration: number };
```

(All four event types land now; feast/frenzy are emitted in Tasks 7–8.)

`src/gameplay/pickups.ts` — add an import after line 3:

```ts
import { BLOOD_CONFIG } from './content.ts';
```

Add after `healPlayer` (end of file):

```ts
/**
 * Grants blood through the Run's capped intake and reports it on the bus.
 * Lives here beside healPlayer so kills and Blood Vial pickups share one path.
 */
export function grantBlood(ctx: Ctx, amount: number): number {
  const { run, bus } = ctx;
  const wasReady = run.blood >= BLOOD_CONFIG.threshold;
  const granted = run.gainBlood(amount);
  if (granted <= 0) return 0;
  bus.emit('blood:gained', { amount: granted, blood: run.blood, max: run.bloodMax });
  if (!wasReady && run.blood >= BLOOD_CONFIG.threshold) bus.emit('blood:ready', undefined);
  return granted;
}
```

`src/gameplay/damage.ts`:

1. Extend the pickups import (line 3):
   ```ts
   import { grantBlood, spawnCoin, spawnChest, spawnGem, spawnMagnet, spawnMeat } from './pickups.ts';
   ```
2. Halve the meat chance (line 12) — blood Feast is now the reliable sustain, so the
   luck-rolled meat drop is halved in the same change (design §1 risk mitigation):
   ```ts
   /** Halved when the blood economy landed: Feast is the reliable sustain now. */
   const MEAT_CHANCE = 0.004;
   ```
3. In `killEnemy`, directly after `run.kills++;` (line 79):
   ```ts
     run.kills++;
     grantBlood(ctx, def.blood * run.stats.bloodGain);
   ```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "blood"`
Expected: PASS (all blood-economy tests so far).

**Step 5: Commit**

```bash
git add src/core/events.ts src/gameplay/pickups.ts src/gameplay/damage.ts src/gameplay/simulation.test.ts
git commit -m "feat: grant capped blood on kills and halve meat drops"
```

---

### Task 6: Blood Vial pickup from elites and bosses

**Files:**
- Modify: `src/gameplay/pickups.ts` (`PickupKind` line 5; new spawn fn; `collect` switch line 168)
- Modify: `src/gameplay/damage.ts` (import; `killEnemy` after the fx branches, ~line 92)
- Modify: `src/content/sprites.json` (new entry after the `"meat"` block, line 101)
- Test: `src/gameplay/simulation.test.ts` (extend the pickups import at line 19)

**Step 1: Write the failing test**

Extend the test file's pickups import (line 19):

```ts
import { PickupKind, spawnBloodVial, updatePickups } from './pickups.ts';
```

Append inside the `blood economy` describe block:

```ts
  it('drops a Blood Vial from elites that collects as capped blood', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;

    // Collection: a vial under the player grants through the same intake cap.
    spawnBloodVial(ctx, 0, 0);
    harness.run(FIXED_DT * 2);
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec); // 25 offered, 12 kept

    // Drop: an elite kill leaves a vial pickup behind.
    const brute = enemyDef('brute')!;
    const id = spawnEnemy(ctx, brute, 300, 0);
    damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    const vial = world
      .list(Kind.Pickup)
      .find((p) => world.defIndex[p] === PickupKind.BloodVial && world.x[p]! > 200);
    expect(vial).toBeDefined();
    expect(world.value[vial!]).toBe(25);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "drops a Blood Vial"`
Expected: FAIL — suite file fails to load with `The requested module './pickups.ts' does not provide an export named 'spawnBloodVial'`.

**Step 3: Write minimal implementation**

`src/gameplay/pickups.ts`:

1. `PickupKind` const (line 5) — after `Chest: 4,` add:
   ```ts
     BloodVial: 5,
   ```
2. After `spawnChest` (line 107) add:
   ```ts
   /** Blood granted by an elite/boss Blood Vial. Magnet-attracted like gems. */
   const BLOOD_VIAL_VALUE = 25;

   export function spawnBloodVial(ctx: Ctx, x: number, y: number): number {
     return spawnPickup(ctx, PickupKind.BloodVial, 'blood_vial', x, y, BLOOD_VIAL_VALUE, 7);
   }
   ```
3. In `collect`'s switch (line 168), after the `PickupKind.Meat` case add:
   ```ts
       case PickupKind.BloodVial: {
         const granted = grantBlood(ctx, value);
         if (granted > 0) fx.floatingText(x, y - 6, `+${Math.round(granted)}`, '#d94a5e');
         fx.burst(x, y, 8, 60, '#d94a5e', 0.3, 1);
         break;
       }
   ```

`src/gameplay/damage.ts`:

4. Extend the pickups import:
   ```ts
   import { grantBlood, spawnBloodVial, spawnCoin, spawnChest, spawnGem, spawnMagnet, spawnMeat } from './pickups.ts';
   ```
5. In `killEnemy`, after the boss/elite/normal fx `if/else` chain (after line 92, before `spawnGem`):
   ```ts
     // Elites and bosses additionally leave a Blood Vial behind.
     if (def.elite || def.boss) spawnBloodVial(ctx, x, y - 2);
   ```

`src/content/sprites.json` — insert after the closing `},` of the `"meat"` entry (line 101):

```json
  "blood_vial": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "pickups/blood_vial.png", "fps": 6 } },
    "placeholder": { "shape": "gem", "color": "#d94a5e", "accent": "#4a0e16", "size": 10, "bob": 1 }
  },
```

(No PNG exists yet — the placeholder system draws the shape; art lands later with zero code change.)

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "drops a Blood Vial"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/gameplay/pickups.ts src/gameplay/damage.ts src/content/sprites.json src/gameplay/simulation.test.ts
git commit -m "feat: add Blood Vial pickup dropped by elites and bosses"
```

---

### Task 7: ctx.bloodIntent + updateBlood system, wired into tick AND harness

This task is atomic by necessity: adding a required field to `Ctx` forces `game.ts` and
`makeHarness()` to change in the same commit, and the tick insertion must be mirrored
verbatim in both (CLAUDE.md rules).

**Files:**
- Modify: `src/gameplay/context.ts` (interface, after `speedScale` line 56)
- Create: `src/gameplay/blood.ts`
- Modify: `src/game.ts` (import ~line 25; ctx literal line 89; `startRun` line 168; `tick` line 296)
- Modify: `src/gameplay/simulation.test.ts` (harness ctx literal line 99 + tick loop line 152 + import + 4 tests)

**Step 1: Write the failing tests**

Add to the test file's imports:

```ts
import { updateBlood } from './blood.ts';
```

In `makeHarness()`, add to the `ctx: Ctx` literal after `speedScale: 1,` (line 118):

```ts
    bloodIntent: null,
```

In the harness tick loop, immediately after `updatePickups(ctx, FIXED_DT);` (line 152) add:

```ts
        updateBlood(ctx, FIXED_DT);
```

Append inside the `blood economy` describe block:

```ts
  it('feast consumes all banked blood and heals per blood spent', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    const feasts: Array<{ spent: number; healed: number }> = [];
    ctx.bus.on('blood:feast', (p) => {
      feasts.push(p);
    });

    world.hp[ctx.player] = 10;
    ctx.run.blood = 100;
    ctx.bloodIntent = 'heal';
    harness.run(FIXED_DT);

    // 100 blood x 0.005 x 100 maxHp = 50 hp healed.
    expect(world.hp[ctx.player]).toBeCloseTo(60);
    expect(ctx.run.blood).toBe(0);
    expect(ctx.bloodIntent).toBeNull();
    expect(feasts).toHaveLength(1);
    expect(feasts[0]!.spent).toBe(100);
    expect(feasts[0]!.healed).toBeCloseTo(50);
  });

  it('ignores and clears blood intent below the spend threshold', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 40;
    ctx.run.blood = 30;
    ctx.bloodIntent = 'heal';
    harness.run(FIXED_DT);
    expect(world.hp[ctx.player]).toBeCloseTo(40);
    expect(ctx.run.blood).toBe(30);
    expect(ctx.bloodIntent).toBeNull();
  });

  it('decays banked blood to just below the threshold after the grace period', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills, so nothing refreshes the grace timer
    world.hp[ctx.player] = 1e9; // stray contact damage must not end the test
    ctx.run.stats.maxHp = 1e9;
    ctx.run.blood = 60; // set directly: graceT stays 0, decay starts immediately
    harness.run(8);
    // 8s x 1.5/s = 12 wanted; the floor stops it at threshold - 1.
    expect(ctx.run.blood).toBeCloseTo(BLOOD_CONFIG.threshold - 1);
  });

  it('reopens the intake window on the next sim-second', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    ctx.run.weapons.length = 0; // weapon kills would muddy the exact count
    const bat = enemyDef('bat')!;
    for (let i = 0; i < 30; i++) {
      const id = spawnEnemy(ctx, bat, 300 + i * 6, 300);
      damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    }
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);

    harness.run(1.1); // run.time crosses a whole second → window resets
    const straggler = spawnEnemy(ctx, bat, 300, 300);
    damageEnemy(ctx, straggler, 1e9, 0, 0, 0, false);
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec + 1);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load with `Failed to resolve import "./blood.ts"` (blood.ts does not exist yet). This is the expected signal; the whole file red is fine at this step.

**Step 3: Write minimal implementation**

`src/gameplay/context.ts` — add to the `Ctx` interface after `speedScale: number;` (line 56):

```ts
  /**
   * Latched Feast/Frenzy intent from the input layer, consumed (and cleared) by
   * updateBlood on the next sim tick. Latching survives frames where the fixed
   * timestep runs the sim zero times, so a press is never lost.
   */
  bloodIntent: 'heal' | 'burst' | null;
```

Create `src/gameplay/blood.ts`:

```ts
import { BLOOD_CONFIG } from './content.ts';
import { healPlayer } from './pickups.ts';
import type { Ctx } from './context.ts';

/**
 * The blood economy system: resets the anti-farm intake window each
 * sim-second, counts down Frenzy, consumes the player's latched spend intent,
 * then decays banked blood above the threshold after a grace period.
 *
 * Runs after updatePickups in the tick (all damage and collection for the tick
 * has resolved) and is mirrored verbatim in the test harness. Every timer here
 * advances on sim dt only — wall-clock time would break seed reproducibility.
 */
export function updateBlood(ctx: Ctx, dt: number): void {
  const { run, bus } = ctx;
  const cfg = BLOOD_CONFIG;

  // The intake window is keyed to run.time: it reopens on each whole-second
  // boundary of sim time, never on wall clock.
  if (Math.floor(run.time) !== Math.floor(run.time - dt)) run.bloodIntakeWindow = 0;

  if (run.frenzyT > 0) run.frenzyT = Math.max(0, run.frenzyT - dt);

  // Consume the latched intent BEFORE the decay step below: a press landing on
  // the same tick as a decay step must spend the full banked amount, and a bar
  // the HUD shows as ready must never be dipped under the threshold by this
  // tick's decay before the press is honoured.
  const intent = ctx.bloodIntent;
  if (intent !== null) {
    ctx.bloodIntent = null;
    // Below the threshold the press is swallowed: no partial spends.
    if (run.blood >= cfg.threshold) {
      const spent = run.blood;
      run.blood = 0;

      if (intent === 'heal') {
        const healed = spent * cfg.healPerBlood * run.stats.maxHp;
        healPlayer(ctx, healed);
        bus.emit('blood:feast', { spent, healed });
      } else {
        run.frenzyT = cfg.frenzy.baseDuration + cfg.frenzy.durationPerBlood * spent;
        bus.emit('blood:frenzy', { spent, duration: run.frenzyT });
      }
    }
  }

  // Use-it-or-lose-it: at or above the threshold, blood holds through a short
  // grace after the last gain, then bleeds down — but never below ready-minus-one.
  // (After a spend, blood is 0, so this block is a no-op on the cast tick.)
  if (run.blood >= cfg.threshold) {
    if (run.graceT > 0) run.graceT = Math.max(0, run.graceT - dt);
    else run.blood = Math.max(cfg.threshold - 1, run.blood - cfg.decayPerSec * dt);
  }
}
```

`src/game.ts`:

1. Add the import after the pickups import (line 21):
   ```ts
   import { updateBlood } from './gameplay/blood.ts';
   ```
2. In the constructor's `this.ctx = { … }` literal, after `speedScale: 1,` (line 109):
   ```ts
       bloodIntent: null,
   ```
3. In `startRun`, after `this.ctx.speedScale = 1;` (line 172):
   ```ts
       this.ctx.bloodIntent = null;
   ```
4. In `tick()`, immediately after `updatePickups(ctx, dt);` (line 296):
   ```ts
       updateBlood(ctx, dt);
   ```
   (This exactly mirrors the harness line added in Step 1 — same relative position.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: PASS — every test including the four new ones. (The 15-minute test runs here
too; expect the file to take ~1–2 minutes.)
Run: `npm run typecheck`
Expected: clean (proves game.ts and the Ctx change agree).

**Step 5: Commit**

```bash
git add src/gameplay/context.ts src/gameplay/blood.ts src/game.ts src/gameplay/simulation.test.ts
git commit -m "feat: add updateBlood system with feast, decay and intent latch"
```

---

### Task 8: Frenzy cast nova

**Files:**
- Modify: `src/gameplay/blood.ts` (import; burst branch; new function at end)
- Test: `src/gameplay/simulation.test.ts`

**Step 1: Write the failing test**

Append inside the `blood economy` describe block:

```ts
  it('casts a blood nova on frenzy that clears a ring around the player', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    const bat = enemyDef('bat')!;

    // A ring inside the nova radius (80) but outside whip reach, plus one
    // enemy well outside the nova that must survive.
    const ring: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 60, Math.sin(a) * 60);
      world.hp[id] = 1;
      ring.push(id);
    }
    const outside = spawnEnemy(ctx, bat, 200, 0);
    world.hp[outside] = 1;

    const frenzies: Array<{ spent: number; duration: number }> = [];
    ctx.bus.on('blood:frenzy', (p) => {
      frenzies.push(p);
    });

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT);

    // 3s base + 0.06 x 100 = 9s. updateBlood runs the countdown BEFORE it
    // consumes the intent, so the value is exact right after the cast tick.
    expect(ctx.run.frenzyT).toBeCloseTo(9, 5);
    expect(frenzies).toHaveLength(1);
    expect(frenzies[0]!.spent).toBe(100);
    expect(frenzies[0]!.duration).toBeCloseTo(9, 5);
    for (const id of ring) expect(world.isAlive(id)).toBe(false);
    expect(world.isAlive(outside)).toBe(true);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "casts a blood nova"`
Expected: FAIL with `expected true to be false` on the first ring assertion (frenzy
starts but nothing dies — no nova exists yet).

**Step 3: Write minimal implementation**

`src/gameplay/blood.ts`:

1. Add the import:
   ```ts
   import { damageEnemy } from './damage.ts';
   ```
2. In the burst branch of `updateBlood`, call the nova before emitting:
   ```ts
         } else {
           run.frenzyT = cfg.frenzy.baseDuration + cfg.frenzy.durationPerBlood * spent;
           castBloodNova(ctx);
           bus.emit('blood:frenzy', { spent, duration: run.frenzyT });
         }
   ```
3. Append at the end of the file:
   ```ts
   /**
    * Single-tick burst around the player when Frenzy begins.
    *
    * One damage call per enemy in one tick, so no registerHit bookkeeping is
    * needed. The enemyHash from this tick's post-movement rebuild is still
    * current (pickups don't move enemies), and candidates land in ctx.scratch —
    * zero allocations. Query results are candidates only: exact distance test
    * plus isAlive, as the spatial hash contract demands.
    */
   function castBloodNova(ctx: Ctx): void {
     const { world, run } = ctx;
     const player = ctx.player;
     if (player < 0 || !world.isAlive(player)) return;

     const cfg = BLOOD_CONFIG.frenzy;
     const px = world.x[player]!;
     const py = world.y[player]!;
     const damage = cfg.novaDamage * run.stats.might;

     const found = ctx.enemyHash.query(px, py, cfg.novaRadius, ctx.scratch);
     for (let i = 0; i < found; i++) {
       const id = ctx.scratch[i]!;
       if (!world.isAlive(id)) continue;
       const dx = world.x[id]! - px;
       const dy = world.y[id]! - py;
       if (dx * dx + dy * dy > cfg.novaRadius * cfg.novaRadius) continue;
       damageEnemy(ctx, id, damage, 0, px, py);
     }

     ctx.fx.shockwave(px, py, '#d94a5e', 0.5, 10);
     ctx.camera.shake(3, 0.3);
   }
   ```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "casts a blood nova"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/gameplay/blood.ts src/gameplay/simulation.test.ts
git commit -m "feat: cast a blood nova when frenzy begins"
```

---

### Task 9: Frenzy read-side multipliers (weapons + movement) with stats-immutability proof

**Files:**
- Modify: `src/gameplay/weapons.ts` (import line 3; `effectiveStats` lines 21–46)
- Modify: `src/gameplay/player.ts` (new import; `updatePlayer` line 32)
- Test: `src/gameplay/simulation.test.ts` (extend the weapons import at line 23)

**Step 1: Write the failing tests**

Extend the test file's weapons import (line 23):

```ts
import { effectiveStats, updateHazards, updatePlayerProjectiles, updateWeapons } from './weapons.ts';
```

Append inside the `blood economy` describe block:

```ts
  it('frenzy multiplies weapon stats read-side and reverts on expiry without touching run.stats', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills → no level-ups → run.stats must stay put
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    // A detached OwnedWeapon: effectiveStats is pure, so this probes the
    // multiplier without letting a real weapon kill anything.
    const whip = WEAPON_LIST.find((w) => w.id === 'whip')!;
    const owned = { def: whip, level: 1, cooldown: 0, activeIds: [], activeTimer: 0, active: false };
    const calm = effectiveStats(ctx.run, owned);
    const statsBefore = JSON.stringify(ctx.run.stats);

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT);

    expect(ctx.run.frenzyT).toBeGreaterThan(0);
    const frenzied = effectiveStats(ctx.run, owned);
    expect(frenzied.damage).toBeCloseTo(calm.damage * BLOOD_CONFIG.frenzy.mightMult);
    expect(frenzied.cooldown).toBeCloseTo(calm.cooldown * BLOOD_CONFIG.frenzy.cooldownMult);
    // The invariant: the buff never wrote through to run.stats.
    expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);

    harness.run(9.5); // outlive the 9-second frenzy
    expect(ctx.run.frenzyT).toBe(0);
    const after = effectiveStats(ctx.run, owned);
    expect(after.damage).toBeCloseTo(calm.damage);
    expect(after.cooldown).toBeCloseTo(calm.cooldown);
    expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);
  });

  it('frenzy speeds the player up read-side', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT); // consume the intent; frenzy is now active

    const x0 = world.x[ctx.player]!;
    harness.run(FIXED_DT, stubInput(1, 0));
    const dx = world.x[ctx.player]! - x0;
    expect(dx).toBeCloseTo(
      ctx.run.stats.moveSpeed * BLOOD_CONFIG.frenzy.moveSpeedMult * FIXED_DT,
      5,
    );
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "frenzy multiplies weapon stats"`
Expected: FAIL with `expected 6.6 to be close to 9.24…` (actual numbers depend on whip
base damage — the point is `frenzied.damage` still equals `calm.damage`).
Run: `npx vitest run -t "frenzy speeds the player up"`
Expected: FAIL — `dx` matches base speed, not ×1.15.

**Step 3: Write minimal implementation**

`src/gameplay/weapons.ts`:

1. Extend the content import (line 3):
   ```ts
   import { BLOOD_CONFIG, WeaponBehavior, weaponStatsAtLevel } from './content.ts';
   ```
2. Replace the body of `effectiveStats` (lines 21–46) with:
   ```ts
   export function effectiveStats(run: Run, weapon: OwnedWeapon): WeaponStats {
     const base = weaponStatsAtLevel(weapon.def, weapon.level);
     const s = run.stats;
     const isAura = weapon.def.behavior === WeaponBehavior.Aura;
     // Frenzy is a read-side buff keyed off run.frenzyT. run.stats itself is
     // never touched, preserving the recompute-only-on-loadout-change invariant.
     const frenzied = run.frenzyT > 0;
     const frenzyDamage = frenzied ? BLOOD_CONFIG.frenzy.mightMult : 1;
     const frenzyCooldown = frenzied ? BLOOD_CONFIG.frenzy.cooldownMult : 1;

     return {
       damage: base.damage * s.might * frenzyDamage,
       cooldown: Math.max(0.08, base.cooldown * s.cooldown * frenzyCooldown),
       // The +projectile stat is meaningless for a single persistent ring.
       count: Math.max(1, Math.round(base.count + (isAura ? 0 : s.amount))),
       pierce: base.pierce,
       area: base.area * s.area,
       duration: base.duration * s.duration,
       knockback: base.knockback,
       speed: base.speed * s.projectileSpeed,
       lifetime: base.lifetime * s.duration,
       // Faster ticking is a buff, so cooldown reduction shortens it too —
       // including the Frenzy factor, so aura weapons (interval-driven,
       // cooldown-exempt in updateWeapons) get the same ×0.75 cadence buff.
       interval: Math.max(0.06, base.interval * s.cooldown * frenzyCooldown),
       radius: base.radius * base.area * s.area,
       orbitSpeed: base.orbitSpeed,
       spawnRadius: base.spawnRadius,
       reach: base.reach * base.area * s.area,
       spread: base.spread,
       turnRate: base.turnRate,
     };
   }
   ```
   (`damage` gains the ×1.4 frenzy factor; `cooldown` AND `interval` both gain the ×0.75
   factor — the existing convention is that cooldown reduction also scales `interval`, so
   interval-driven weapons like the warding-circle aura speed up during Frenzy the same
   as everything else.)

`src/gameplay/player.ts`:

3. Add an import after line 2:
   ```ts
   import { BLOOD_CONFIG } from './content.ts';
   ```
4. In `updatePlayer`, replace `const speed = run.stats.moveSpeed;` (line 32) with:
   ```ts
     // Frenzy movement bonus is read-side, same rule as effectiveStats.
     const frenzySpeed = run.frenzyT > 0 ? BLOOD_CONFIG.frenzy.moveSpeedMult : 1;
     const speed = run.stats.moveSpeed * frenzySpeed;
   ```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "frenzy"`
Expected: PASS (nova test from Task 8 plus both new tests).

**Step 5: Commit**

```bash
git add src/gameplay/weapons.ts src/gameplay/player.ts src/gameplay/simulation.test.ts
git commit -m "feat: apply frenzy read-side multipliers to weapons and movement"
```

---

### Task 10: HUD blood orb + Feast/Frenzy buttons + CSS

The HUD is browser-bound and deliberately has no headless coverage (CLAUDE.md: verify
UI with `npm run dev`). The gates for this task are `tsc` and the suite staying green;
the visual check happens in Task 11 once input is wired.

**Files:**
- Modify: `src/ui/hud.ts` (import; fields; constructor line 53; `cache` line 51; `update` line 106)
- Modify: `src/ui/style.css` (append at end of file)

**Step 1: Implement the HUD cluster**

`src/ui/hud.ts`:

1. Add an import after line 2:
   ```ts
   import { BLOOD_CONFIG } from '../gameplay/content.ts';
   ```
2. Add fields after `private banner: HTMLElement;` (line 40):
   ```ts
     private bloodWrap: HTMLElement;
     private bloodFill: HTMLElement;
     private bloodIntentCb: ((intent: 'heal' | 'burst') => void) | null = null;
     private bloodReady = false;
   ```
3. Extend the `cache` literal (line 51) with a blood slot:
   ```ts
     private cache = { hp: '', xp: -1, time: '', level: '', kills: '', gold: '', blood: -1 };
   ```
4. In the constructor, after the `this.banner = el('div', 'boss-banner');` line (line 90), build the cluster:
   ```ts
       // Bottom-centre thumb zone: the blood orb flanked by Feast / Frenzy taps.
       this.bloodWrap = el('div', 'blood-cluster');
       const feastBtn = el('button', 'blood-btn feast');
       feastBtn.append(el('span', 'blood-btn-label', 'FEAST'), el('span', 'key-hint', 'Q'));
       const orb = el('div', 'blood-orb');
       this.bloodFill = el('div', 'blood-fill');
       orb.appendChild(this.bloodFill);
       const frenzyBtn = el('button', 'blood-btn frenzy');
       frenzyBtn.append(el('span', 'blood-btn-label', 'FRENZY'), el('span', 'key-hint', 'E'));
       this.bloodWrap.append(feastBtn, orb, frenzyBtn);

       const press = (intent: 'heal' | 'burst') => (ev: PointerEvent) => {
         // pointerdown, not click: kills the iOS tap delay/double-fire.
         // stopPropagation keeps this touch away from the future virtual
         // joystick that will share the bottom band (design §8 risk 1).
         ev.preventDefault();
         ev.stopPropagation();
         this.bloodIntentCb?.(intent);
       };
       feastBtn.addEventListener('pointerdown', press('heal'));
       frenzyBtn.addEventListener('pointerdown', press('burst'));
   ```
5. Change the root append (line 92) to include the cluster:
   ```ts
       this.root.append(xpTrack, left, center, right, loadout, this.bloodWrap, this.banner);
   ```
6. Add a binding method after `showBanner` (line 103):
   ```ts
     /** Game injects the callback; the HUD never touches gameplay state itself. */
     bindBloodButtons(cb: (intent: 'heal' | 'burst') => void): void {
       this.bloodIntentCb = cb;
     }
   ```
7. In `update()`, after the gold block (line 145), add the cache-guarded orb write:
   ```ts
       // Quantised to whole percents, same guard as the hp bar.
       const bloodPercent = Math.round((run.blood / run.bloodMax) * 100);
       if (bloodPercent !== this.cache.blood) {
         this.cache.blood = bloodPercent;
         this.bloodFill.style.height = `${bloodPercent}%`;
       }
       const ready = run.blood >= BLOOD_CONFIG.threshold;
       if (ready !== this.bloodReady) {
         this.bloodReady = ready;
         this.bloodWrap.classList.toggle('ready', ready);
       }
   ```

**Step 2: Add the CSS**

Append at the end of `src/ui/style.css`:

```css
/* --- Blood economy cluster, bottom-centre thumb zone -------------------- */

.blood-cluster {
  position: absolute;
  left: 50%;
  bottom: calc(var(--u) * 5);
  transform: translateX(-50%);
  display: flex;
  align-items: flex-end;
  gap: calc(var(--u) * 3);
}

.blood-orb {
  position: relative;
  width: calc(var(--u) * 22);
  height: calc(var(--u) * 22);
  border-radius: 50%;
  overflow: hidden;
  background: #2a0a10;
  border: var(--u) solid #0a0508;
}

.blood-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 0%;
  background: linear-gradient(180deg, #d94a5e 0%, #8b1e2d 100%);
  transition: height 120ms ease-out;
}

.blood-btn {
  width: calc(var(--u) * 16);
  height: calc(var(--u) * 16);
  border-radius: 50%;
  border: var(--u) solid var(--edge);
  background: var(--panel);
  color: var(--ink-faint);
  font: inherit;
  font-size: calc(var(--u) * 4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(var(--u) * 1);
  padding: 0;
  touch-action: none;
}

/* Below the threshold the buttons read as disabled; at/above they pulse. */
.blood-cluster.ready .blood-btn {
  color: var(--ink);
  border-color: #d94a5e;
  animation: blood-pulse 1.2s ease-in-out infinite;
}

@keyframes blood-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(217, 74, 94, 0);
  }
  50% {
    box-shadow: 0 0 0 calc(var(--u) * 2) rgba(217, 74, 94, 0.35);
  }
}

.key-hint {
  font-size: calc(var(--u) * 3.5);
  color: var(--ink-dim);
}

@media (pointer: coarse) {
  .key-hint {
    display: none;
  }
}
```

**Step 3: Verify types and suite**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run -t "blood"`
Expected: PASS (HUD changes cannot affect the headless suite — confirm nothing broke).

**Step 4: Commit**

```bash
git add src/ui/hud.ts src/ui/style.css
git commit -m "feat: add blood orb and feast/frenzy buttons to the HUD"
```

---

### Task 11: Wire input — KeyQ/KeyE in beforeFrame + HUD callback

**Files:**
- Modify: `src/game.ts` (constructor after `this.wireEvents();` line 112; `beforeFrame` lines 243–245)

**Step 1: Implement the wiring**

`src/game.ts`:

1. In the constructor, after `this.wireEvents();` (line 112):
   ```ts
       this.hud.bindBloodButtons((intent) => {
         if (this.state === 'playing') this.ctx.bloodIntent = intent;
       });
   ```
2. In `beforeFrame`, replace the trailing block (lines 243–245):
   ```ts
       if (this.state === 'playing' && this.input.wasPressed('Escape')) {
         this.openPause();
       }
   ```
   with:
   ```ts
       if (this.state !== 'playing') return;

       if (this.input.wasPressed('Escape')) {
         this.openPause();
         return;
       }

       // Blood intents latch here — edge-triggered input lives frame-side only
       // (the sim may run 0..5 times per frame) — and updateBlood consumes the
       // latch on the next sim tick. Distinct codes from Escape, so wasPressed
       // consumption order stays safe.
       if (this.input.wasPressed('KeyQ')) this.ctx.bloodIntent = 'heal';
       else if (this.input.wasPressed('KeyE')) this.ctx.bloodIntent = 'burst';
   ```

**Step 2: Verify types and suite**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: PASS (full file, including the 15-minute run — allow ~2 minutes).

**Step 3: Manual dev-server check (browser-bound behavior)**

Run: `npm run dev` and verify at http://localhost:5173:
- [ ] Orb sits bottom-centre, fills as kills land, buttons dim below 50
- [ ] At ≥50 the cluster pulses; pressing Q heals (green floating text), E bursts
      (red shockwave + faster attacks + faster movement for the duration)
- [ ] Below 50, Q/E and taps do nothing
- [ ] Clicking the FEAST/FRENZY buttons works; Q/E hints visible on desktop
- [ ] Elite kill (survive to the brute) drops a red vial that magnets in

**Step 4: Commit**

```bash
git add src/game.ts
git commit -m "feat: wire blood intents to KeyQ/KeyE and the HUD buttons"
```

---

### Task 12: Full verification + squash merge

**Files:** none (verification only)

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean, zero errors.

**Step 2: Full suite**

Run: `npm test`
Expected: ALL tests pass, including:
- the pre-existing suite (content, progression, simulation, difficulty scaling — the
  15-minute full-run determinism/leak test is the invariant tripwire and MUST be green)
- the 14 new `blood economy` tests:
  1. normalizes blood.json into a typed config with the design defaults
  2. defaults per-enemy blood by tier and honours explicit values
  3. folds bloodGain from character defaults and the Bloodthirst passive
  4. caps blood intake inside one window and clamps at the bar max
  5. grants blood per enemy def on kill and signals readiness at the threshold
  6. discards blood above the per-second intake cap
  7. drops a Blood Vial from elites that collects as capped blood
  8. feast consumes all banked blood and heals per blood spent
  9. ignores and clears blood intent below the spend threshold
  10. decays banked blood to just below the threshold after the grace period
  11. reopens the intake window on the next sim-second
  12. casts a blood nova on frenzy that clears a ring around the player
  13. frenzy multiplies weapon stats read-side and reverts on expiry without touching `run.stats`
  14. frenzy speeds the player up read-side

**Step 3: Self-review the diff**

Run: `git diff main...HEAD --stat` then `git diff main...HEAD`
Check against the invariants: no `Math.random` in gameplay paths, no wall-clock timers,
`Game.tick()` and the harness tick identical around `updateBlood`, `run.stats` never
assigned outside `recomputeStats()`.

**Step 4: Squash merge (ask the user before each git command)**

```bash
git checkout main
git merge --squash feat/phase-1-blood-economy
git commit -m "feat: blood economy — feast/frenzy resource system (mobile v1 phase 1)"
```
Keep the phase branch until the user confirms deletion. Then reassess (per the roadmap's
just-in-time rule) before writing the Phase 2 plan.

---

## Notes for the executor

- **Never edit `Game.tick()` without the identical harness edit in the same commit** —
  Task 7 is the only task that touches tick order.
- If any test fails twice with the same error: stop, re-read the relevant source file
  in full, do not blind-retry (execution discipline rules).
- All tuning numbers live in `src/content/blood.json` and hot-reload in the dev server —
  balance passes need no code changes.
- Deliberately out of scope (YAGNI, per design): frenzy soft-cap on duration, blood
  payout on `siege:defended` (Phase 3), the 1.25-bloodGain vampire-lord character
  (Phase 2 kits), touch joystick interplay (Phase 5).


