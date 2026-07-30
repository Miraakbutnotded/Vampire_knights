# Castle Defense Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Defendable structures on siege maps — siege waves march on gates and shrines, holding the wall pays out a chest and gold, losing structures makes the hunters bolder (a difficulty penalty, never a fail state) — design §3 of the mobile v1 design doc.

**Architecture:** Structures are a new ECS kind (`Kind.Structure`, KIND_COUNT 6→7 — the first phase to touch the ECS): static player-team entities with `Transform | Sprite | Health | Collider`, no Velocity, so `snapshotPositions` gives free interpolation. Solidity rides the existing `TileMap.solids` array through new runtime-solid methods (`addRuntimeSolid` / `removeRuntimeSolid` / `clearRuntimeSolids`), reset every `startRun()` because maps are cached. Enemy siege targeting is a **handle, not a Behavior**: `world.targetHandle` (Float64 because handles pack id + gen*16384 — beyond Float32's exact-integer range once gen >= 1024, and future-proof if handleOf's current Int32-truncating `id | gen*MAX_ENTITIES` encoding is ever widened to plain addition) substitutes the structure's position for the player's at the top of `updateEnemies`, so the existing melee movement code marches at the wall unchanged; touch attacks are gated by `hitCooldown` (safe: only melee behaviors ever carry a handle, and only Ranged used `hitCooldown` before). A new stateless system `src/gameplay/structures.ts::updateStructures(ctx, dt)` runs after `updateHazards`, before the pickup-hash rebuild, in both `Game.tick()` and `makeHarness()` — mirrored verbatim, same commit. `Spawner.updateSieges()` mirrors `updateBosses()` off a `sieges[]` cursor in the wave table and degrades gracefully to player-chasers when a map has no structures. **No new Ctx fields** — the Ctx-field rule (init in Game constructor AND harness, reset in startRun) is untriggered this phase.

**Tech Stack:** TypeScript strict, Vite, Vitest headless harness (`src/gameplay/simulation.test.ts`), data-driven JSON content normalized warn-don't-throw in `src/gameplay/content.ts`. No new dependencies.

---

**Design source:** `docs/plans/2026-07-30-mobile-v1-design.md` §3. **Invariants:** `CLAUDE.md` (tick order load-bearing, harness mirrors tick verbatim, `ctx.rng` for gameplay / `fxRng` for cosmetics, new Kind ⇒ KIND_COUNT bump + `World.create()` reset lines, handles not raw ids across ticks, every spawn site tolerates `create() === -1`, warn-don't-throw content, `world.place()` for spawns). **Carried tuning notes from Phases 1–2:** none block Phase 3 (per the roadmap reassessment).

**Optionality is a hard requirement:** structures are opt-in per map. Meadow, crypt and arena have no `structures` array and the `default` wave table gets no `sieges` entry, so every shipped map and every pre-existing test keeps the exact same spawn stream. Task 3 lands an explicit tripwire test for this before any siege behavior exists.

**Design-§3 deviations (declared, per the no-silent-trim rule):**

1. **`structure:destroyed` payload ships `{ name, remaining, index }`** instead of §3's `{ name, remaining }` — the HUD needs the pip slot to mark dead without a lookup (same payload-enrichment precedent as Phase 2's `ability:used`). `structure:damaged` keeps §3's `{ hp, maxHp, index }` exactly.
2. **Runtime solids are removed by index-stable tombstone, not splice:** `removeRuntimeSolid(index)` zeroes the entry's radius in place and `clearRuntimeSolids()` truncates back to the hand-authored prop count; `resolveSolids` skips `r <= 0`. Splicing would shift the indices other structures hold in `world.value`. This is *how* §3's "tracked by index so destroyStructure removes exactly its own" promise is kept.
3. **`stubMap()` gets a functional three-method runtime-solid mini-implementation**, not §3's "no-op solid methods" — so the gate-breach bookkeeping (spawn registers a solid, destruction disables exactly its own) is provable headless. `hasCollision` stays `false`, so movement in every existing test is untouched.
4. **Sieges ship on a new `bastion` wave table**; `default` normalizes to `sieges: []`. §3 didn't pin the table, and putting sieges on `default` would alter every shipped map's spawn stream and the Phase 1–2 balance. `waveTable('default').sieges` being empty is asserted (the optionality tripwire).
5. **The HUD pip row is created by a direct `Game.startRun() → hud.setStructurePips(...)` call**; only updates/destruction are event-driven. §3's "updated event-driven like hp-fill" is honored for updates — creation has no event because none of the four design events fires at spawn time, and Game already calls Hud directly (`setVisible`, `showBanner`).
6. **The pip slot index lives in `world.aiPhase`** — `aiPhase` is polymorphic *by Kind* and Structure is a new Kind, so claiming it is sanctioned (CLAUDE.md forbids repurposing on an *existing* Kind). Documented at the write site.
7. **Smoulder fx below 30% hp draws from `fxRng`, not `ctx.rng`** — particles are cosmetic; burning gameplay-RNG draws on them would couple visuals to the sim stream (the two-RNG rule).
8. **The touch check carries a +0.5u slack** (`radius + structRadius + 0.5`): on solid gates, `resolveSolids` parks attackers at exactly `radius + structRadius`, and the epsilon keeps the float boundary from starving the attack. §3 said "on touch (radius + structRadius)"; the slack is the practical reading of it.
9. **The 56u peel clears the handle permanently** (until a later siege wave assigns fresh spawns). Re-acquire logic would need per-enemy cooldowns for no design gain; peeled enemies simply become normal hunters.
10. **Stated scope limits:** the non-melee-siege-type content warning is verified by code review, not headless test (`normalizeWaves` runs at module load, unlike the raw-taking `normalizeBlood`/`normalizeAbility`); a blood payout on `siege:defended` stays unbuilt (§3 explicitly defers it — the event payload already supports it); TileMap's runtime-solid methods themselves are dev-server-verified (TileMap is browser-bound, per CLAUDE.md's test-scope note), while their *contract* is exercised headless through the functional stub.

**Handle / solid / cull contract (the seam-bug class for this phase — every consumer states its rule):**

- **Handles across ticks, always.** `world.targetHandle` stores `world.handleOf(id)`, and every read goes through `world.resolve()` — a structure that died and had its id recycled resolves to -1, never to the squatter. A dedicated recycle test proves it (Task 1) and a system-level one proves no misdirected attacks (Task 7).
- **`world.value` on a structure = its runtime-solid index, or -1** for walk-through structures (shrines) and for pool-exhaustion spawns on the stub. `removeRuntimeSolid(-1)` is never called (guarded by `>= 0`); prop solids are protected inside `removeRuntimeSolid` by the prop-count floor.
- **Cull exemption is exactly as wide as the handle is live.** The `CULL_DISTANCE` destroy is skipped only while `resolve()` returns a living structure; the moment the structure falls or the enemy peels, normal culling resumes. Siege durations are bounded (45–50s) and the full-run leak test covers siege windows (Task 13).
- **`hitCooldown` reuse is collision-free by construction:** `updateSieges` assigns handles only to Chase/Hopper/Charger spawns, and `Behavior.Ranged` (the only prior `hitCooldown` user) never receives one. A non-melee type in a siege entry warns at content load and spawns as a plain player-chaser.
- **Deferred destruction discipline:** `damageStructure` → `destroyStructure` → `world.destroy(id)`. `resolve()` returns -1 from the moment `destroy()` marks the structure dead — same tick, before `flush()` (resolve checks `alive`, not just generation). Attackers processed later in the same `updateEnemies` pass already retarget within the death tick; survivor counts use `isAlive` because the id stays in the kind list until `flush()`.

**Test placement:** all new headless tests go in one new `describe('castle defense', …)` block appended at the very end of `src/gameplay/simulation.test.ts` (after the closing `});` of `describe('active abilities', …)`, line 1326). Task 1 creates the block; later tasks append `it(…)` cases inside it. The suite must be green after **every** commit.

**Commits:** every `git commit` below ends with the standard trailer, appended to the message shown:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: <the executing session's claude.ai/code URL>
```

## Setup

```bash
cd /Users/boraesen/Desktop/Vampire_knights
git checkout main
git checkout -b feat/phase-3-castle-defense
npm test   # confirm the suite is green before touching anything
```
Expected: all existing tests pass (Phases 1–2 are squash-merged on main). Git operations require user approval per house rules — ask before each commit/checkout.

---

### Task 1: Kind.Structure + KIND_COUNT 7 + world.targetHandle (smallest possible ECS diff)

**Files:**
- Modify: `src/ecs/components.ts` (one entry in the `Kind` const)
- Modify: `src/ecs/world.ts` (KIND_COUNT, one new array, one reset line in `create()`)
- Test: `src/gameplay/simulation.test.ts` (new describe block at end of file, after line 1326)

**Step 1: Write the failing tests**

Append at the very end of `src/gameplay/simulation.test.ts` (after the `active abilities` block's closing `});`):

```ts
describe('castle defense', () => {
  it('registers Kind.Structure as a seventh kind with its own live list', () => {
    const world = new World();
    const id = world.create(Kind.Structure);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(world.kind[id]).toBe(Kind.Structure);
    expect(world.list(Kind.Structure)).toContain(id);
    // The other kind lists are untouched by the new kind.
    expect(world.list(Kind.Enemy)).toHaveLength(0);
  });

  it('resets targetHandle on recycled ids and resolves stale handles to -1', () => {
    const world = new World();
    const structure = world.create(Kind.Structure);
    const enemy = world.create(Kind.Enemy);
    const stale = world.handleOf(structure);
    world.targetHandle[enemy] = stale;

    world.destroy(structure);
    world.flush();
    // Generation bump: the handle is dead even before the id is reused.
    expect(world.resolve(stale)).toBe(-1);

    world.destroy(enemy);
    world.flush();
    const recycled = world.create(Kind.Enemy);
    // The freelist is LIFO, so the enemy id comes straight back — the classic
    // recycled-id stale-value trap the create() reset line exists to close.
    expect(recycled).toBe(enemy);
    expect(world.targetHandle[recycled]).toBe(-1);
  });
});
```

`World`, `Kind` are already imported (lines 7–8). No import changes needed.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "castle defense"`
Expected: FAIL — `Kind.Structure` is `undefined` at runtime (esbuild strips types without checking), so `world.create(undefined)` hits `this.lists[undefined]!.push` → `TypeError: Cannot read properties of undefined (reading 'push')`; the second test additionally reads the missing `world.targetHandle` array.

**Step 3: Write minimal implementation**

In `src/ecs/components.ts`, extend the `Kind` const (after `Hazard: 5,`):

```ts
  /** Persistent damaging area — auras, lingering fire, garlic. */
  Hazard: 5,
  /** Defendable castle objective — gates, shrines. Static, player-team, has HP. */
  Structure: 6,
} as const;
```

In `src/ecs/world.ts`:

1. Bump the count (line 5) — it must match the Kind values in components.ts:

```ts
const KIND_COUNT = 7;
```

2. Add the array after the `// --- ai ---` block (after `readonly aiPhase = new Float32Array(MAX_ENTITIES);`):

```ts
  // --- siege targeting ----------------------------------------------------
  /**
   * Handle of the structure this enemy is ordered to attack, or -1.
   * Float64 because handles pack id + gen*16384 — beyond Float32's exact-integer
   * range once gen >= 1024, and future-proof if handleOf's current Int32-
   * truncating `id | gen*MAX_ENTITIES` encoding is ever widened to plain
   * addition. (Generations >= 131072 would silently truncate — a pre-existing
   * engine-wide caveat, unreachable in practice; do not change handleOf.)
   * Handles, not raw ids: structures die and their ids recycle mid-siege.
   */
  readonly targetHandle = new Float64Array(MAX_ENTITIES).fill(-1);
```

3. Add the reset line in `create()` (a new component array ⇒ a new reset line, or recycled ids leak stale values), after `this.aiPhase[id] = 0;`:

```ts
    this.targetHandle[id] = -1;
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"`
Expected: PASS (2 tests). Then `npm run typecheck` — clean — and `npm test` — the full pre-existing suite stays green (the new kind changes nothing for existing entities).

**Step 5: Commit**

```bash
git add src/ecs/components.ts src/ecs/world.ts src/gameplay/simulation.test.ts
git commit -m "feat: add Kind.Structure and per-enemy target handles to the ECS"
```

---

### Task 2: structures.json + normalizeStructures + placeholder sprites

**Files:**
- Create: `src/content/structures.json`
- Modify: `src/gameplay/content.ts` (import at top; new `// --- structures ---` section after `enemyDefByIndex`, line 138, before `// --- weapons ---` at line 140)
- Modify: `src/content/sprites.json` (two placeholder entries after the `chest` entry)
- Test: `src/gameplay/simulation.test.ts` (1 test inside the `castle defense` block; content import)

**Step 1: Write the failing test**

Extend the content import block (lines 16–25) with `STRUCTURE_LIST`, `structureDef`, `structureDefByIndex` (keep the existing names):

```ts
import {
  BLOOD_CONFIG,
  CHARACTER_LIST,
  STRUCTURE_LIST,
  WEAPON_LIST,
  enemyDef,
  normalizeAbility,
  normalizeBlood,
  structureDef,
  structureDefByIndex,
  waveTable,
  weaponStatsAtLevel,
} from './content.ts';
```

Append inside `describe('castle defense', …)`:

```ts
  it('normalizes structure defs and fails soft on unknown ids', () => {
    expect(STRUCTURE_LIST).toHaveLength(2);

    const gate = structureDef('gate')!;
    expect(gate).not.toBeNull();
    expect(gate.name).toBe('Bastion Gate');
    expect(gate.hp).toBe(300);
    expect(gate.radius).toBe(14);
    expect(gate.solid).toBe(true);
    expect(gate.gold).toBe(25);
    expect(gate.index).toBe(0);

    const shrine = structureDef('shrine')!;
    expect(shrine.solid).toBe(false);
    expect(shrine.gold).toBe(40);

    // Unknown id: warn-don't-throw, null return — the caller skips the spawn.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(structureDef('barbican')).toBeNull();
    } finally {
      spy.mockRestore();
    }

    // Index lookup mirrors enemyDefByIndex: out of range falls back to entry 0.
    expect(structureDefByIndex(0).id).toBe('gate');
    expect(structureDefByIndex(99).id).toBe('gate');
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load with `does not provide an export named 'STRUCTURE_LIST'`.

**Step 3: Write minimal implementation**

Create `src/content/structures.json`:

```json
{
  "gate": {
    "name": "Bastion Gate",
    "sprite": "structure_gate",
    "hp": 300,
    "radius": 14,
    "solid": true,
    "gold": 25
  },
  "shrine": {
    "name": "Blood Shrine",
    "sprite": "structure_shrine",
    "hp": 180,
    "radius": 10,
    "solid": false,
    "gold": 40
  }
}
```

In `src/gameplay/content.ts`, add the import at the top (with the other content imports):

```ts
import structuresJson from '../content/structures.json';
```

Insert the new section after `enemyDefByIndex` (line 138), before `// --- weapons ---`:

```ts
// --- structures -----------------------------------------------------------

export interface StructureDef {
  id: string;
  index: number;
  name: string;
  sprite: string;
  hp: number;
  radius: number;
  /** Registers a runtime solid on spawn (gates). False = walk-through (shrines). */
  solid: boolean;
  /** Gold paid out when a siege ends with this structure alive. */
  gold: number;
}

function normalizeStructures(): { list: StructureDef[]; byId: Map<string, StructureDef> } {
  const raw = structuresJson as unknown as Record<string, Record<string, unknown>>;
  const list: StructureDef[] = [];
  const byId = new Map<string, StructureDef>();

  for (const [id, def] of Object.entries(raw)) {
    const num = (key: string, fallback: number): number => {
      const v = def[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
    const str = (key: string, fallback: string): string => {
      const v = def[key];
      return typeof v === 'string' ? v : fallback;
    };

    const entry: StructureDef = {
      id,
      index: list.length,
      name: str('name', id),
      sprite: str('sprite', 'structure_gate'),
      hp: Math.max(1, num('hp', 200)),
      radius: Math.max(1, num('radius', 12)),
      solid: def['solid'] === true,
      gold: Math.max(0, num('gold', 20)),
    };

    list.push(entry);
    byId.set(id, entry);
  }

  // Unlike enemies, an empty structures.json is legal: structures are an
  // optional per-map feature, and a game without them must keep working.
  return { list, byId };
}

const structureData = normalizeStructures();
export const STRUCTURE_LIST: readonly StructureDef[] = structureData.list;

export function structureDef(id: string): StructureDef | null {
  const def = structureData.byId.get(id);
  if (!def) {
    warnOnce(`[content] unknown structure "${id}"`);
    return null;
  }
  return def;
}

export function structureDefByIndex(index: number): StructureDef {
  return structureData.list[index] ?? structureData.list[0]!;
}
```

In `src/content/sprites.json`, add two entries after the `chest` entry (fail-soft: the PNGs don't exist yet, so the generated placeholders ship — playable before art):

```json
  "structure_gate": {
    "origin": [0.5, 0.8],
    "anims": { "idle": { "src": "structures/gate.png", "fps": 4 } },
    "placeholder": { "shape": "square", "color": "#6b6273", "accent": "#241f2e", "size": 30, "bob": 0 }
  },
  "structure_shrine": {
    "origin": [0.5, 0.8],
    "anims": { "idle": { "src": "structures/shrine.png", "fps": 6 } },
    "placeholder": { "shape": "diamond", "color": "#8a2f3f", "accent": "#2e0d14", "size": 22, "bob": 0 }
  },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "castle defense"`
Expected: PASS (3 tests). Then `npm run typecheck` — clean.

**Step 5: Commit**

```bash
git add src/content/structures.json src/content/sprites.json src/gameplay/content.ts src/gameplay/simulation.test.ts
git commit -m "feat: add structure content defs with warn-don't-throw normalization"
```

---

### Task 3: TileMap structures parsing + runtime solids + the optionality tripwire

**Files:**
- Modify: `src/render/tilemap.ts` (`MapJson.structures`, `TileMap.structures`, `propSolidCount`, three runtime-solid methods, one skip line in `resolveSolids`)
- Modify: `src/gameplay/simulation.test.ts` (`stubMap()` parity — same commit as the TileMap change, or typecheck breaks; 1 new test)

**Step 1: Write the failing test**

Append inside `describe('castle defense', …)`:

```ts
  it('keeps structure-less maps untouched: a default run spawns no structures', () => {
    // The meadow case: no "structures" array in the map, no sieges in the
    // table. Everything that shipped in Phases 1-2 must behave identically.
    const harness = makeHarness();
    harness.run(30);
    const { ctx } = harness;
    expect(ctx.map.structures).toHaveLength(0);
    expect(ctx.world.list(Kind.Structure)).toHaveLength(0);
    expect(ctx.world.isAlive(ctx.player)).toBe(true);
    expect(ctx.run.kills).toBeGreaterThan(0);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "structure-less"`
Expected: FAIL — `ctx.map.structures` is `undefined` (`expected undefined to have a length of 0`). (`npm run typecheck` would also flag the missing `TileMap.structures` property.)

**Step 3: Write minimal implementation**

In `src/render/tilemap.ts`:

1. Extend `MapJson` (after the `waves?` field):

```ts
  /** Defendable structures spawned at run start. Optional; most maps have none. */
  structures?: { type: string; x: number; y: number }[];
```

2. Add the public field on `TileMap` (after `readonly solids: Solid[] = [];`) and a private counter (next to the other private fields):

```ts
  readonly structures: { type: string; x: number; y: number }[];
```

```ts
  private propSolidCount = 0;
```

3. In the constructor (next to `this.props = def.props ?? [];`):

```ts
    this.structures = def.structures ?? [];
```

4. In `buildSolids()`, record the prop floor at the end:

```ts
  private buildSolids(): void {
    for (const prop of this.props) {
      if (prop.solid && prop.solid > 0) {
        this.solids.push({ x: prop.x, y: prop.y, r: prop.solid });
      }
    }
    // Everything below this index is hand-authored and permanent; everything
    // above is a runtime structure solid and lives run-to-run.
    this.propSolidCount = this.solids.length;
  }
```

5. Add the runtime-solid methods after `resolveSolids()`:

```ts
  // --- runtime solids (castle structures) ---------------------------------

  /**
   * Registers a circular obstacle at runtime (a solid structure). Returns its
   * index into `solids`, valid for the structure's whole life: removal
   * tombstones the entry (r = 0) rather than splicing, so the indices other
   * structures hold in `world.value` never shift.
   */
  addRuntimeSolid(x: number, y: number, r: number): number {
    this.solids.push({ x, y, r });
    return this.solids.length - 1;
  }

  /** Disables one runtime solid (a gate breach opens the wall). Prop solids are untouchable. */
  removeRuntimeSolid(index: number): void {
    if (index < this.propSolidCount) return;
    const solid = this.solids[index];
    if (solid) solid.r = 0;
  }

  /**
   * Drops every runtime solid, keeping the hand-authored prop solids. Maps are
   * cached across runs in Game.mapCache, so startRun() must call this or a
   * restarted run would collide with the previous run's structures.
   */
  clearRuntimeSolids(): void {
    this.solids.length = this.propSolidCount;
  }
```

6. In `resolveSolids()`, skip tombstones — first line inside the loop:

```ts
    for (const solid of this.solids) {
      if (solid.r <= 0) continue;
```

In `src/gameplay/simulation.test.ts`, replace `stubMap()` (lines 79–94) wholesale — a captured `solids` array plus a functional mini-implementation of the runtime-solid contract (declared deviation 3), and add `Solid` to the tilemap type import (line 12):

```ts
import type { Solid, TileMap } from '../render/tilemap.ts';
```

```ts
/** Open, unbounded map with no collision — the meadow case. */
function stubMap(): TileMap {
  const solids: Solid[] = [];
  return {
    name: 'test',
    tileSize: 16,
    bounds: null,
    spawnX: 0,
    spawnY: 0,
    wavesTable: 'default',
    solids,
    structures: [],
    hasCollision: false,
    clampToBounds: (x: number, y: number) => [x, y] as [number, number],
    resolveSolids: (x: number, y: number) => [x, y] as [number, number],
    resolveTiles: (x: number, y: number) => [x, y] as [number, number],
    isSolidTile: () => false,
    // Functional mini-implementation of TileMap's runtime-solid contract (not
    // no-ops) so headless tests can prove the gate-breach bookkeeping.
    // hasCollision stays false, so movement in tests is unchanged.
    addRuntimeSolid: (x: number, y: number, r: number) => {
      solids.push({ x, y, r });
      return solids.length - 1;
    },
    removeRuntimeSolid: (index: number) => {
      const solid = solids[index];
      if (solid) solid.r = 0;
    },
    clearRuntimeSolids: () => {
      solids.length = 0;
    },
  } as unknown as TileMap;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (4 tests). Then `npm run typecheck` — clean — and `npm test` — the **full** suite green: this is the optionality gate. Nothing in any existing test may change.

**Step 5: Commit**

```bash
git add src/render/tilemap.ts src/gameplay/simulation.test.ts
git commit -m "feat: parse map structures and add runtime solids to TileMap"
```

---

### Task 4: structures.ts — spawn, damage, destruction + Run counters + 2 events

**Files:**
- Create: `src/gameplay/structures.ts`
- Modify: `src/gameplay/run.ts` (two counter fields)
- Modify: `src/core/events.ts` (two events)
- Test: `src/gameplay/simulation.test.ts` (2 tests; new import)

**Step 1: Write the failing tests**

Add the import (after the `./spawner.ts` import, line 31):

```ts
import { damageStructure, spawnStructure } from './structures.ts';
```

(`updateStructures` joins this import in Task 5 — importing it now would trip `noUnusedLocals` at this task's typecheck gate.)

Append inside `describe('castle defense', …)`:

```ts
  it('damages a structure through the hit pipeline and reports each hit', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const gate = structureDef('gate')!;
    const id = spawnStructure(ctx, gate, 80, 0);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(ctx.world.team[id]).toBe(Team.Player);
    expect(ctx.world.maxHp[id]).toBe(gate.hp);
    // The gate registered a runtime solid at its own radius; the pip slot is 0.
    expect(ctx.map.solids).toHaveLength(1);
    expect(ctx.map.solids[0]!.r).toBe(gate.radius);
    expect(ctx.world.aiPhase[id]).toBe(0);

    const events: { hp: number; maxHp: number; index: number }[] = [];
    ctx.bus.on('structure:damaged', (e) => events.push(e));
    damageStructure(ctx, id, 40);
    expect(ctx.world.hp[id]).toBe(gate.hp - 40);
    expect(ctx.world.hitFlash[id]).toBeGreaterThan(0);
    expect(events).toEqual([{ hp: gate.hp - 40, maxHp: gate.hp, index: 0 }]);
  });

  it('destroys a fallen structure: solid tombstoned, penalty banked, event fired', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const gate = structureDef('gate')!;
    const gateId = spawnStructure(ctx, gate, 80, 0);
    spawnStructure(ctx, structureDef('shrine')!, -80, 0);
    // Only the gate is solid; the shrine is walk-through.
    expect(ctx.map.solids).toHaveLength(1);

    const destroyed: { name: string; remaining: number; index: number }[] = [];
    ctx.bus.on('structure:destroyed', (e) => destroyed.push(e));
    damageStructure(ctx, gateId, gate.hp);

    expect(destroyed).toEqual([{ name: 'Bastion Gate', remaining: 1, index: 0 }]);
    expect(ctx.run.structuresLost).toBe(1);
    // Gate breach opens the wall: the solid is disabled in place, not spliced.
    expect(ctx.map.solids).toHaveLength(1);
    expect(ctx.map.solids[0]!.r).toBe(0);
    // Deferred destruction: dead immediately, recycled at flush.
    expect(ctx.world.isAlive(gateId)).toBe(false);
    ctx.world.flush();
    expect(ctx.world.list(Kind.Structure)).toHaveLength(1);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load: `Failed to resolve import "./structures.ts"`.

**Step 3: Write minimal implementation**

In `src/gameplay/run.ts`, add after the `abilityMods` field (line 110):

```ts
  // --- castle defense -----------------------------------------------------

  /** Structures spawned this run, in spawn order — the HUD pip count. */
  structuresSpawned = 0;
  /** Structures lost this run; difficultyAt turns each into +8% damage/speed. */
  structuresLost = 0;
```

In `src/core/events.ts`, extend `GameEvents` (after `'ability:ready'`):

```ts
  'structure:damaged': { hp: number; maxHp: number; index: number };
  'structure:destroyed': { name: string; remaining: number; index: number };
```

Create `src/gameplay/structures.ts`:

```ts
import { Comp, Kind, Team } from '../ecs/components.ts';
import { fxRng } from '../core/rng.ts';
import { structureDefByIndex } from './content.ts';
import type { StructureDef } from './content.ts';
import type { Ctx } from './context.ts';

/** Seconds a structure flashes white after taking a hit (damageEnemy parity). */
const HIT_FLASH = 0.12;
/** Below this hp fraction a structure smoulders. */
const SMOKE_THRESHOLD = 0.3;
/** Expected smoke puffs per second while smouldering. Cosmetic — fxRng, never ctx.rng. */
const SMOKE_RATE = 3;

/**
 * Places a defendable structure: static (no Velocity — snapshotPositions makes
 * prev == current, so interpolation is free), player-team so weapons — which
 * only query enemyHash — can never friendly-fire it.
 */
export function spawnStructure(ctx: Ctx, def: StructureDef, x: number, y: number): number {
  const { world } = ctx;
  const id = world.create(Kind.Structure);
  if (id < 0) return -1;

  world.add(id, Comp.Transform | Comp.Sprite | Comp.Health | Comp.Collider);
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(def.sprite);
  world.radius[id] = def.radius;
  world.defIndex[id] = def.index;
  world.team[id] = Team.Player;
  world.hp[id] = def.hp;
  world.maxHp[id] = def.hp;
  // HUD pip slot, in spawn order. aiPhase is polymorphic by Kind, and
  // Structure is a new Kind, so claiming it here is sanctioned (CLAUDE.md).
  world.aiPhase[id] = ctx.run.structuresSpawned++;
  // Runtime-solid index for gates, -1 for walk-through structures. The index
  // stays valid for life: removal tombstones in place, never splices.
  world.value[id] = def.solid ? ctx.map.addRuntimeSolid(x, y, def.radius) : -1;
  return id;
}

/**
 * Applies damage to a structure — the damageEnemy of castle defense, minus
 * crits and knockback (walls don't dodge). At zero hp the structure falls.
 * Returns the damage dealt, or 0 if the target was already gone.
 */
export function damageStructure(ctx: Ctx, id: number, amount: number): number {
  const { world, fx, bus } = ctx;
  if (!world.isAlive(id) || world.kind[id] !== Kind.Structure) return 0;

  world.hp[id] = world.hp[id]! - amount;
  world.hitFlash[id] = HIT_FLASH;
  fx.damageNumber(world.x[id]!, world.y[id]! - world.radius[id]! - 4, amount, false);
  bus.emit('structure:damaged', {
    hp: Math.max(0, world.hp[id]!),
    maxHp: world.maxHp[id]!,
    index: world.aiPhase[id]!,
  });

  if (world.hp[id]! <= 0) destroyStructure(ctx, id);
  return amount;
}

/**
 * The fall of a structure: its solid is removed (a gate breach opens the
 * wall), the difficulty penalty is banked, and the entity is destroyed.
 * resolve() returns -1 from this same tick, before flush() (resolve checks
 * alive, not just generation), so attackers processed later in this same
 * updateEnemies pass already retarget within the death tick.
 */
function destroyStructure(ctx: Ctx, id: number): void {
  const { world, run, fx, bus } = ctx;
  const def = structureDefByIndex(world.defIndex[id]!);
  const x = world.x[id]!;
  const y = world.y[id]!;

  const solidIndex = world.value[id]!;
  if (solidIndex >= 0) ctx.map.removeRuntimeSolid(solidIndex);

  run.structuresLost++;
  fx.shockwave(x, y, '#c9a86a', 0.7, 14);
  fx.burst(x, y, 24, 110, '#8a7a66', 0.7, 2);
  ctx.camera.shake(4, 0.4);

  world.destroy(id);
  // destroy() only marks dead, so count survivors by aliveness, never by
  // list length — the list still holds this id until flush().
  let remaining = 0;
  for (const sid of world.list(Kind.Structure)) {
    if (world.isAlive(sid)) remaining++;
  }
  bus.emit('structure:destroyed', { name: def.name, remaining, index: world.aiPhase[id]! });
}

/**
 * Per-tick upkeep: hit-flash decay, idle animation, smoulder fx below 30% hp.
 * Deals no damage, so its slot in the tick (after updateHazards, before the
 * pickup-index rebuild) has no enemyHash dependency — but it is mirrored
 * verbatim in the test harness all the same.
 */
export function updateStructures(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const ids = world.list(Kind.Structure);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    world.animTime[id] = world.animTime[id]! + dt;
    if (world.hitFlash[id]! > 0) world.hitFlash[id] = Math.max(0, world.hitFlash[id]! - dt);
    if (world.hp[id]! / world.maxHp[id]! < SMOKE_THRESHOLD && fxRng.chance(SMOKE_RATE * dt)) {
      ctx.fx.particle(
        world.x[id]! + fxRng.range(-4, 4),
        world.y[id]! - world.radius[id]! * 0.6,
        fxRng.range(-4, 4),
        -18,
        0.8,
        1,
        '#5a5462',
      );
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (6 tests). `npm run typecheck` — clean. `npm test` — green.

**Step 5: Commit**

```bash
git add src/gameplay/structures.ts src/gameplay/run.ts src/core/events.ts src/gameplay/simulation.test.ts
git commit -m "feat: add structure spawn, damage and destruction with siege events"
```

---

### Task 5: tick wiring (Game.tick + harness, same commit) + startRun spawning + rendering

**Files:**
- Modify: `src/game.ts` (imports; `startRun()`; `tick()`; `render()`; `updateDebug()`)
- Modify: `src/gameplay/simulation.test.ts` (harness tick — **must mirror `Game.tick` verbatim, same commit**; 1 test)

**Step 1: Write the failing test**

Append inside `describe('castle defense', …)`:

```ts
  it('runs structures through the tick with hit-flash decay and free interpolation', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const id = spawnStructure(ctx, structureDef('gate')!, 60, 0);
    damageStructure(ctx, id, 10);
    expect(ctx.world.hitFlash[id]).toBeGreaterThan(0);

    harness.run(1);

    // updateStructures ran: the flash decayed to zero over the second.
    expect(ctx.world.hitFlash[id]).toBe(0);
    expect(ctx.world.isAlive(id)).toBe(true);
    // Static entity: snapshotPositions keeps prev == current every tick.
    expect(ctx.world.prevX[id]).toBe(ctx.world.x[id]);
    expect(ctx.world.prevY[id]).toBe(ctx.world.y[id]);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "hit-flash decay"`
Expected: FAIL — `updateStructures` is never called by the harness tick, so `hitFlash` stays at 0.12 (`expected 0.11999… to be +0`).

**Step 3: Write minimal implementation**

In `src/gameplay/simulation.test.ts`, first extend the structures import (from Task 4) with the system function:

```ts
import { damageStructure, spawnStructure, updateStructures } from './structures.ts';
```

Then, inside `makeHarness()`'s `run()` (the harness tick), add one line after `updateHazards(ctx, FIXED_DT);` (line 164), before `ctx.pickupHash.build(...)`:

```ts
        updateHazards(ctx, FIXED_DT);
        updateStructures(ctx, FIXED_DT);

        ctx.pickupHash.build(world, world.list(Kind.Pickup));
```

In `src/game.ts` — the identical edit in the same commit (the tick-order-drift risk from design §3):

1. Imports: add to the content import (line 18) and a new system import (after the abilities import, line 23):

```ts
import { CHARACTER_LIST, structureDef, waveTable } from './gameplay/content.ts';
```

```ts
import { spawnStructure, updateStructures } from './gameplay/structures.ts';
```

2. In `tick()`, after `updateHazards(ctx, dt);` (line 331), before `ctx.pickupHash.build(...)`:

```ts
    updateHazards(ctx, dt);
    updateStructures(ctx, dt);

    ctx.pickupHash.build(this.world, this.world.list(Kind.Pickup));
```

3. In `startRun()`, immediately after `this.map = map;` (line 170) — maps are cached, so the previous run's structure solids must go before this run spawns its own:

```ts
    this.map = map;
    // Maps persist across runs in the cache: strip the previous run's
    // structure solids before this run registers its own.
    map.clearRuntimeSolids();
```

4. In `startRun()`, after `this.ctx.player = spawnPlayer(this.ctx, map.spawnX, map.spawnY);` (line 189):

```ts
    this.ctx.player = spawnPlayer(this.ctx, map.spawnX, map.spawnY);
    for (const entry of map.structures) {
      const def = structureDef(entry.type);
      if (!def) continue; // warn-don't-throw: a typo costs one structure, not the run
      spawnStructure(this.ctx, def, entry.x, entry.y);
    }
```

5. In `render()`, queue the new kind into the depth-sorted pass, right after the Hazard line (line 374):

```ts
    this.queueKind(Kind.Hazard, alpha);
    this.queueKind(Kind.Structure, alpha);
```

6. In `updateDebug()`, add one line after the `hazards` line:

```ts
      `structures ${world.list(Kind.Structure).length}`,
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (7 tests). `npm run typecheck` — clean (this is what proves the game.ts wiring compiles). `npm test` — full suite green: the 15-minute test still passes with the extra no-op system in the tick.

**Step 5: Commit**

```bash
git add src/game.ts src/gameplay/simulation.test.ts
git commit -m "feat: run structure upkeep in the tick and spawn map structures at run start"
```

---

### Task 6: enemy siege targeting — substitute, park, batter, peel

**Files:**
- Modify: `src/gameplay/enemies.ts` (`updateEnemies` loop top + a standoff block before integration; two constants; one import)
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the failing tests**

Append inside `describe('castle defense', …)`:

```ts
  it('marches a siege enemy to the wall, parks it, and swings on the 0.8s cadence', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    // Empty field: no stage spawns muddying the assertions.
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    // Player parked far away: outside peel range, contact damage irrelevant.
    world.place(ctx.player, -400, 0);
    world.hp[ctx.player] = 1e9;

    const gate = structureDef('gate')!;
    const gateId = spawnStructure(ctx, gate, 120, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 40, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    harness.run(8);

    // Parked at a stable standoff just outside the touch radius, not culled,
    // not orbiting the player.
    expect(world.isAlive(zombie)).toBe(true);
    const dist = Math.hypot(world.x[gateId]! - world.x[zombie]!, world.y[gateId]! - world.y[zombie]!);
    const touch = world.radius[zombie]! + world.radius[gateId]! + 0.5;
    expect(dist).toBeLessThanOrEqual(touch);
    expect(dist).toBeGreaterThan(touch - 3);

    // ~5.5s of contact at the 0.8s cadence: several whole swings landed, each
    // for exactly the zombie's contact damage — never a per-tick shred.
    const lost = gate.hp - world.hp[gateId]!;
    const perSwing = world.damage[zombie]!;
    expect(lost).toBeGreaterThanOrEqual(3 * perSwing);
    expect(lost).toBeLessThan(gate.hp);
    expect(lost % perSwing).toBe(0);
  });

  it('peels a siege enemy off the gate when the player closes in', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;

    const gateId = spawnStructure(ctx, structureDef('gate')!, 200, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 150, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    // The player steps to 40u from the attacker — inside the 56u peel radius.
    world.place(ctx.player, 110, 0);
    harness.run(0.5);

    // The siege order is dropped and the zombie hunts the player again
    // (the player is to its left, so its velocity points left).
    expect(world.targetHandle[zombie]).toBe(-1);
    expect(world.vx[zombie]).toBeLessThan(0);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "siege enemy"`
Expected: FAIL — without targeting code the handle is ignored, so the zombie chases the player at (-400, 0): the standoff test's `dist ≤ touch` assertion fails (distance in the hundreds), and the peel test fails on `expect(world.targetHandle[zombie]).toBe(-1)` (still holds the handle).

**Step 3: Write minimal implementation**

In `src/gameplay/enemies.ts`:

1. Add the import (after the `damagePlayer` import, line 4) and two constants (after `CROWD_STRENGTH`, line 14):

```ts
import { damageStructure } from './structures.ts';
```

```ts
/** Siege enemies whose target's player gets this close switch back to the player. */
const PEEL_DISTANCE = 56;
/** Seconds between structure hits while parked at the wall. */
const SIEGE_HIT_INTERVAL = 0.8;
```

2. In `updateEnemies`, replace the top of the per-enemy loop (lines 149–168: from `const id = ids[i]!;` through the `towardX/towardY` lines) with:

```ts
    const id = ids[i]!;
    const def = enemyDefByIndex(world.defIndex[id]!);

    const ex = world.x[id]!;
    const ey = world.y[id]!;

    // Siege targeting: a live target handle substitutes the structure's
    // position for the player's in everything below, so the existing melee
    // movement code marches at the wall unchanged. Handles, not ids: a
    // recycled id resolves to -1, never to the squatter.
    let tx = px;
    let ty = py;
    let structTarget = -1;
    if (world.targetHandle[id]! >= 0) {
      const sid = world.resolve(world.targetHandle[id]!);
      if (sid < 0) {
        // Structure destroyed (or its id recycled): resume the player hunt.
        world.targetHandle[id] = -1;
      } else if (
        hasPlayer &&
        (px - ex) * (px - ex) + (py - ey) * (py - ey) <= PEEL_DISTANCE * PEEL_DISTANCE
      ) {
        // The player closing in outranks the siege order — peeling enemies
        // off the gate is the intended counterplay. Cleared for good; the
        // next siege wave brings fresh attackers.
        world.targetHandle[id] = -1;
      } else {
        structTarget = sid;
        tx = world.x[sid]!;
        ty = world.y[sid]!;
      }
    }

    const dx = tx - ex;
    const dy = ty - ey;
    const d2 = dx * dx + dy * dy;

    // Culling is exempt while a live target holds this enemy on the field —
    // otherwise attackers evaporate the moment the player kites away.
    if (structTarget < 0 && !world.has(id, Comp.Persistent) && d2 > cullDist2) {
      // Silent removal — no drops, no kill credit. The spawner will replace it.
      world.destroy(id);
      continue;
    }

    const speed = world.speed[id]!;
    const dist = Math.sqrt(d2) || 1;
    const towardX = dx / dist;
    const towardY = dy / dist;
```

(The behavior `switch` below is untouched — Chase/Hopper/Charger now steer at `(tx, ty)` through `towardX/towardY`; Orbiter/Ranged/Drifter never receive handles.)

3. After the behavior `switch`, **before** the knockback-decay/integration block (before `const decay = Math.exp(...)`, line 282), insert the standoff block:

```ts
    // Parked at the wall: stop and swing on the hitCooldown cadence. Only
    // melee behaviors ever carry a target handle (updateSieges enforces it),
    // so this reuse of hitCooldown never collides with Ranged shooting. The
    // +0.5 slack keeps resolveSolids' exact-touch parking from starving the
    // attack at the float boundary.
    if (structTarget >= 0) {
      const touch = world.radius[id]! + world.radius[structTarget]! + 0.5;
      if (d2 <= touch * touch) {
        world.vx[id] = 0;
        world.vy[id] = 0;
        world.hitCooldown[id] = world.hitCooldown[id]! - dt;
        if (world.hitCooldown[id]! <= 0) {
          world.hitCooldown[id] = SIEGE_HIT_INTERVAL;
          damageStructure(ctx, structTarget, world.damage[id]!);
        }
      }
    }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (9 tests). `npm run typecheck` — clean. `npm test` — full suite green (every pre-existing enemy has `targetHandle === -1`, so the new branches never fire for them; the 15-minute test is the tripwire).

**Step 5: Commit**

```bash
git add src/gameplay/enemies.ts src/gameplay/simulation.test.ts
git commit -m "feat: let siege enemies march on, park at and batter structures"
```

---

### Task 7: retargeting, stale handles and cull exemption (test-only)

**Files:**
- Test: `src/gameplay/simulation.test.ts` (3 tests — no implementation; these pin behavior Task 6 already shipped, exactly like the design's test list demands)

**Step 1: Write the tests**

Append inside `describe('castle defense', …)`:

```ts
  it('retargets to the player after its structure falls', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -200, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 100, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 60, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    damageStructure(ctx, gateId, 1e9); // the gate falls
    harness.run(1);                    // flush recycles it; the handle dies

    expect(world.targetHandle[zombie]).toBe(-1);
    // Marching at the player again (player at -200: velocity points left).
    expect(world.vx[zombie]).toBeLessThan(0);
  });

  it('never lets a stale handle point at a recycled id', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -300, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 100, 0);
    const staleHandle = world.handleOf(gateId);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 50, 0);
    world.targetHandle[zombie] = staleHandle;

    damageStructure(ctx, gateId, 1e9);
    world.flush(); // recycle immediately, mid-scenario
    const squatter = world.create(Kind.Enemy);
    // LIFO freelist hands the gate's id straight back — the recycle trap.
    expect(squatter).toBe(gateId);
    // The generation bump means the stale handle can never reach the squatter.
    expect(world.resolve(staleHandle)).toBe(-1);

    harness.run(0.5);
    // updateEnemies saw the dead handle and cleared it — no misdirected attacks.
    expect(world.targetHandle[zombie]).toBe(-1);
    expect(world.hp[squatter]).toBe(1); // the squatter was never "attacked"
  });

  it('exempts enemies with a live siege target from distance culling', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;

    // Both enemies are ~680u from the player at (0,0) — past CULL_DISTANCE 620.
    const gateId = spawnStructure(ctx, structureDef('gate')!, 700, 0);
    const attacker = spawnEnemy(ctx, enemyDef('zombie')!, 680, 0);
    world.targetHandle[attacker] = world.handleOf(gateId);
    const wanderer = spawnEnemy(ctx, enemyDef('zombie')!, 680, 40);

    harness.run(1);

    // The siege order holds the attacker on the field; the untargeted twin
    // is silently culled on the first tick.
    expect(world.isAlive(attacker)).toBe(true);
    expect(world.isAlive(wanderer)).toBe(false);
  });
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"`
Expected: PASS (12 tests) — first try. If any of the three fails, Task 6's implementation has a real defect: stop and fix `enemies.ts`, do not adjust the tests.

**Step 3: Commit**

```bash
git add src/gameplay/simulation.test.ts
git commit -m "test: cover retargeting, stale handles and siege cull exemption"
```

---

### Task 8: siege schedules in the wave tables + the bastion table

**Files:**
- Modify: `src/gameplay/content.ts` (`SiegeEvent` interface, `WaveTable.sieges`, parsing in `normalizeWaves()`)
- Modify: `src/content/waves.json` (new `bastion` table; `default` untouched)
- Test: `src/gameplay/simulation.test.ts` (1 test)

**Step 1: Write the failing test**

Append inside `describe('castle defense', …)`:

```ts
  it('parses siege schedules with defaults and keeps default siege-free', () => {
    // The optionality tripwire for waves: shipping maps on the default table
    // keep their exact spawn stream — no sieges materialize from nowhere.
    expect(waveTable('default').sieges).toEqual([]);

    const bastion = waveTable('bastion');
    expect(bastion.sieges.length).toBeGreaterThanOrEqual(3);
    for (const siege of bastion.sieges) {
      expect(enemyDef(siege.type), `unknown siege enemy "${siege.type}"`).not.toBeNull();
      expect(siege.count).toBeGreaterThanOrEqual(1);
      expect(siege.duration).toBeGreaterThanOrEqual(1);
    }
    // Sorted by time so the spawner can walk a cursor through them.
    for (let i = 1; i < bastion.sieges.length; i++) {
      expect(bastion.sieges[i]!.at).toBeGreaterThanOrEqual(bastion.sieges[i - 1]!.at);
    }
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "siege schedules"`
Expected: FAIL — `waveTable('default').sieges` is `undefined` (`expected undefined to deeply equal []`). `npm run typecheck` would also flag the missing `WaveTable.sieges`.

**Step 3: Write minimal implementation**

In `src/gameplay/content.ts`:

1. Add the interface next to `BossSpawn` (line 692) and the field on `WaveTable` (after `bosses: BossSpawn[];`):

```ts
export interface SiegeEvent {
  at: number;
  type: string;
  count: number;
  /** Seconds the siege window stays open after `at`. */
  duration: number;
}
```

```ts
  bosses: BossSpawn[];
  sieges: SiegeEvent[];
```

2. In `normalizeWaves()`, after the `bosses` block (line 769), add:

```ts
    const siegesRaw = Array.isArray(def['sieges']) ? (def['sieges'] as Record<string, unknown>[]) : [];
    const sieges: SiegeEvent[] = siegesRaw
      .filter((s) => {
        const type = s['type'];
        if (typeof type !== 'string' || !enemyData.byId.has(type)) {
          console.warn(`[content] wave table "${id}" siege references unknown enemy "${String(type)}"`);
          return false;
        }
        return true;
      })
      .map((s) => ({
        at: numFrom(s, 'at', 0),
        type: s['type'] as string,
        count: Math.max(1, Math.round(numFrom(s, 'count', 6))),
        duration: Math.max(1, numFrom(s, 'duration', 45)),
      }))
      .sort((a, b) => a.at - b.at);

    // Siege attackers park at the wall and swing through hitCooldown, which
    // Ranged already uses for shooting — so only melee behaviors may target
    // structures. A non-melee type still spawns, but as a plain player-chaser.
    for (const siege of sieges) {
      const behavior = enemyData.byId.get(siege.type)!.behavior;
      if (behavior !== Behavior.Chase && behavior !== Behavior.Hopper && behavior !== Behavior.Charger) {
        console.warn(
          `[content] wave table "${id}" siege at ${siege.at}s uses non-melee "${siege.type}"; ` +
            `those enemies will chase the player instead of a structure`,
        );
      }
    }
```

3. Add `sieges,` to the `tables.set(id, { … })` literal (after `bosses,`).

(`Behavior` is already imported at line 1 of content.ts.)

In `src/content/waves.json`, add the `bastion` table after the `default` table (the `default` table is **not** modified):

```json
  "bastion": {
    "victorySeconds": 900,
    "maxAlive": 400,
    "scaling": {
      "hpPerMinute": 0.2,
      "damagePerMinute": 0.05,
      "speedPerMinute": 0.012,
      "hpExponent": 1.05
    },
    "waves": [
      {
        "at": 0,
        "spawnInterval": 1.4,
        "perSpawn": 2,
        "enemies": [{ "type": "bat", "weight": 10 }]
      },
      {
        "at": 50,
        "spawnInterval": 1.1,
        "perSpawn": 3,
        "enemies": [
          { "type": "bat", "weight": 7 },
          { "type": "swarmling", "weight": 5 }
        ]
      },
      {
        "at": 110,
        "spawnInterval": 1.0,
        "perSpawn": 3,
        "enemies": [
          { "type": "zombie", "weight": 6 },
          { "type": "bat", "weight": 5 },
          { "type": "slime", "weight": 4 }
        ]
      },
      {
        "at": 200,
        "spawnInterval": 0.9,
        "perSpawn": 4,
        "enemies": [
          { "type": "skeleton", "weight": 6 },
          { "type": "zombie", "weight": 5 },
          { "type": "wisp", "weight": 2 }
        ]
      },
      {
        "at": 320,
        "spawnInterval": 0.8,
        "perSpawn": 5,
        "enemies": [
          { "type": "ghost", "weight": 5 },
          { "type": "skeleton", "weight": 5 },
          { "type": "slime", "weight": 4 },
          { "type": "wisp", "weight": 3 }
        ]
      },
      {
        "at": 470,
        "spawnInterval": 0.7,
        "perSpawn": 6,
        "enemies": [
          { "type": "swarmling", "weight": 8 },
          { "type": "skeleton", "weight": 6 },
          { "type": "drifter", "weight": 4 },
          { "type": "ghost", "weight": 4 }
        ]
      },
      {
        "at": 620,
        "spawnInterval": 0.55,
        "perSpawn": 7,
        "enemies": [
          { "type": "skeleton", "weight": 7 },
          { "type": "ghost", "weight": 6 },
          { "type": "zombie", "weight": 5 },
          { "type": "wisp", "weight": 4 }
        ]
      },
      {
        "at": 780,
        "spawnInterval": 0.45,
        "perSpawn": 9,
        "enemies": [
          { "type": "swarmling", "weight": 10 },
          { "type": "skeleton", "weight": 7 },
          { "type": "ghost", "weight": 6 },
          { "type": "drifter", "weight": 6 },
          { "type": "wisp", "weight": 4 }
        ]
      }
    ],
    "elites": {
      "startAt": 150,
      "interval": 60,
      "type": "brute",
      "count": 1,
      "countGrowthPerMinute": 0.15
    },
    "bosses": [
      { "at": 240, "type": "warden", "count": 1 },
      { "at": 540, "type": "warden", "count": 2 },
      { "at": 880, "type": "reaper", "count": 1 }
    ],
    "sieges": [
      { "at": 120, "type": "zombie", "count": 10, "duration": 45 },
      { "at": 300, "type": "skeleton", "count": 12, "duration": 45 },
      { "at": 480, "type": "slime", "count": 14, "duration": 45 },
      { "at": 660, "type": "skeleton", "count": 16, "duration": 50 },
      { "at": 840, "type": "zombie", "count": 18, "duration": 50 }
    ]
  }
```

(All five siege types are melee — zombie/skeleton chase, slime hops — so the non-melee warning stays silent on shipped content.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (13 tests). `npm run typecheck` — clean. `npm test` — green (Tasks 6–7's `ctx.wave` spreads now silently carry `sieges: []` from the default table).

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/content/waves.json src/gameplay/simulation.test.ts
git commit -m "feat: add siege schedules to the wave tables and a bastion table"
```

---

### Task 9: Spawner.updateSieges — spawn, assign nearest structure, degrade gracefully

**Files:**
- Modify: `src/gameplay/spawner.ts` (cursor fields + `updateSieges()` mirroring `updateBosses()`; imports)
- Modify: `src/core/events.ts` (`siege:started`)
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the failing tests**

Append inside `describe('castle defense', …)`:

```ts
  it('spawns a siege wave aimed at the nearest living structure', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;

    const gateId = spawnStructure(ctx, structureDef('gate')!, 150, 0);
    const shrineId = spawnStructure(ctx, structureDef('shrine')!, -150, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 6, duration: 30 }],
    };

    let started = 0;
    ctx.bus.on('siege:started', ({ duration }) => {
      started++;
      expect(duration).toBe(30);
    });

    harness.run(2);

    expect(started).toBe(1);
    const enemies = world.list(Kind.Enemy);
    expect(enemies).toHaveLength(6);
    for (const id of enemies) {
      // Every attacker holds a live handle to one of the two structures.
      const target = world.resolve(world.targetHandle[id]!);
      expect([gateId, shrineId]).toContain(target);
    }
  });

  it('degrades a siege to player-chasers on a structure-less map', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    ctx.world.hp[ctx.player] = 1e9;
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 5, duration: 20 }],
    };

    harness.run(2);

    // No structures anywhere: the siege still spawns, nobody crashes, and
    // every attacker simply hunts the player (handle stays -1).
    const enemies = ctx.world.list(Kind.Enemy);
    expect(enemies).toHaveLength(5);
    for (const id of enemies) {
      expect(ctx.world.targetHandle[id]).toBe(-1);
    }
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "siege wave"`
Expected: FAIL — no `updateSieges` exists, so nothing spawns: `started` is 0 and `enemies` has length 0.

**Step 3: Write minimal implementation**

In `src/core/events.ts`, extend `GameEvents`:

```ts
  'siege:started': { duration: number };
```

In `src/gameplay/spawner.ts`:

1. Extend the imports (line 1–5):

```ts
import { Behavior, Kind } from '../ecs/components.ts';
```

2. Add a ring constant next to `BOSS_RING`/`ELITE_RING`:

```ts
/** Siege attackers arrive between elites and trash: visible, not instant. */
const SIEGE_RING = 300;
```

3. Add cursor fields next to `nextBoss` and reset them in `reset()`:

```ts
  private nextSiege = 0;
  /** Sim time the open siege window closes, or -1 when no siege is active. */
  private siegeEndsAt = -1;
```

```ts
  reset(): void {
    this.stageIndex = -1;
    this.spawnTimer = 0;
    this.eliteTimer = 0;
    this.nextBoss = 0;
    this.nextSiege = 0;
    this.siegeEndsAt = -1;
    this.stageWeights = [];
  }
```

4. Call it from `update()` (after `this.updateBosses(ctx, time);`):

```ts
    this.updateBosses(ctx, time);
    this.updateSieges(ctx, time);
```

5. Add the method after `updateBosses()`:

```ts
  /** True for behaviors that fight at touch range — the only valid siege attackers. */
  private static isMelee(behavior: number): boolean {
    return (
      behavior === Behavior.Chase || behavior === Behavior.Hopper || behavior === Behavior.Charger
    );
  }

  /**
   * Mirrors updateBosses: a forward-only cursor over wave.sieges. Each due
   * entry spawns its attackers off screen and hands each one a handle to the
   * nearest living structure. With no living structure the handle stays -1 and
   * the attacker hunts the player — sieges degrade gracefully on
   * structure-less maps, never crash, never stall.
   */
  private updateSieges(ctx: Ctx, time: number): void {
    const sieges = ctx.wave.sieges;
    while (this.nextSiege < sieges.length && sieges[this.nextSiege]!.at <= time) {
      const entry = sieges[this.nextSiege]!;
      this.nextSiege++;
      const def = enemyDef(entry.type);
      if (!def) continue;

      const structures = ctx.world.list(Kind.Structure);
      for (let i = 0; i < entry.count; i++) {
        const [x, y] = offscreenSpawnPoint(ctx, SIEGE_RING);
        const id = spawnEnemy(ctx, def, x, y);
        if (id < 0) continue;
        // Non-melee types were warned at content load; they chase the player.
        if (!Spawner.isMelee(def.behavior)) continue;

        // Nearest living structure — ≤4 per map, a linear scan beats a hash.
        let best = -1;
        let bestD2 = Infinity;
        for (let s = 0; s < structures.length; s++) {
          const sid = structures[s]!;
          if (!ctx.world.isAlive(sid)) continue;
          const dx = ctx.world.x[sid]! - x;
          const dy = ctx.world.y[sid]! - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = sid;
          }
        }
        if (best >= 0) ctx.world.targetHandle[id] = ctx.world.handleOf(best);
      }

      // Overlapping sieges extend one shared window; the reward resolves once.
      this.siegeEndsAt = Math.max(this.siegeEndsAt, time + entry.duration);
      ctx.bus.emit('siege:started', { duration: entry.duration });
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (15 tests). `npm run typecheck` — clean. `npm test` — green (`default` has `sieges: []`, so no shipped table triggers the new path).

**Step 5: Commit**

```bash
git add src/gameplay/spawner.ts src/core/events.ts src/gameplay/simulation.test.ts
git commit -m "feat: schedule siege waves that target the nearest living structure"
```

---

### Task 10: siege resolution — defended = chest + gold at the wall

**Files:**
- Modify: `src/gameplay/spawner.ts` (window-close check + `resolveSiege()`; imports)
- Modify: `src/core/events.ts` (`siege:defended`)
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the failing tests**

Append inside `describe('castle defense', …)`:

```ts
  it('pays out a chest and gold when the siege window closes with a survivor', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;
    // Player parked far from the reward site so the chest is not auto-collected.
    world.place(ctx.player, -400, 0);

    spawnStructure(ctx, structureDef('gate')!, 300, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 1, duration: 5 }],
    };

    const defended: { gold: number }[] = [];
    ctx.bus.on('siege:defended', (e) => defended.push(e));

    harness.run(8); // window opens at 1s, closes at 6s; the lone zombie never reaches the gate

    expect(defended).toEqual([{ gold: structureDef('gate')!.gold }]);
    const pickups = world.list(Kind.Pickup).map((id) => world.defIndex[id]);
    expect(pickups).toContain(PickupKind.Chest);
    expect(pickups).toContain(PickupKind.Coin);
  });

  it('pays nothing when every structure fell before the window closed', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -400, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 300, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 1, duration: 5 }],
    };
    const defended: unknown[] = [];
    ctx.bus.on('siege:defended', (e) => defended.push(e));

    harness.run(2);
    damageStructure(ctx, gateId, 1e9); // the gate falls mid-siege
    harness.run(6);                    // the window closes with nothing standing

    expect(defended).toEqual([]);
    expect(ctx.run.structuresLost).toBe(1);
    const pickups = world.list(Kind.Pickup).map((id) => world.defIndex[id]);
    expect(pickups).not.toContain(PickupKind.Chest);
    // Not a fail state: the run continues, only the difficulty penalty banks.
    expect(world.isAlive(ctx.player)).toBe(true);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "siege window"`
Expected: FAIL — nothing resolves the window, so `defended` stays `[]` in the first test and no chest/coin pickups exist.

**Step 3: Write minimal implementation**

In `src/core/events.ts`, extend `GameEvents`:

```ts
  'siege:defended': { gold: number };
```

In `src/gameplay/spawner.ts`:

1. Extend the imports:

```ts
import { enemyDef, structureDefByIndex } from './content.ts';
import { spawnChest, spawnCoin } from './pickups.ts';
```

2. At the end of `updateSieges()` (after the `while` loop), close the window:

```ts
    if (this.siegeEndsAt >= 0 && time >= this.siegeEndsAt) {
      this.siegeEndsAt = -1;
      this.resolveSiege(ctx);
    }
```

3. Add the method after `updateSieges()`:

```ts
  /**
   * The window closed. Defended = at least one structure still stands: the
   * reward (chest + gold) lands at the first survivor, so walking back to the
   * wall you held is the loop. Every structure down = no reward and nothing
   * else — the difficulty penalty is already banked in run.structuresLost,
   * and player death stays the only fail state.
   */
  private resolveSiege(ctx: Ctx): void {
    const structures = ctx.world.list(Kind.Structure);
    for (let i = 0; i < structures.length; i++) {
      const sid = structures[i]!;
      if (!ctx.world.isAlive(sid)) continue;
      const def = structureDefByIndex(ctx.world.defIndex[sid]!);
      const x = ctx.world.x[sid]!;
      const y = ctx.world.y[sid]!;
      spawnChest(ctx, x, y + 6);
      spawnCoin(ctx, x + 10, y + 2, def.gold);
      ctx.bus.emit('siege:defended', { gold: def.gold });
      return;
    }
  }
```

(Both spawn helpers already tolerate `create() === -1` internally, so pool exhaustion costs the reward, never the run.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"` → PASS (17 tests). `npm run typecheck` — clean. `npm test` — green.

**Step 5: Commit**

```bash
git add src/gameplay/spawner.ts src/core/events.ts src/gameplay/simulation.test.ts
git commit -m "feat: reward a defended siege with a chest and gold at the wall"
```

---

### Task 11: difficulty penalty — the hunters grow bolder

**Files:**
- Modify: `src/gameplay/spawner.ts` (`difficultyAt()`; one constant)
- Test: `src/gameplay/simulation.test.ts` (1 test)

**Step 1: Write the failing test**

Append inside `describe('castle defense', …)`:

```ts
  it('raises damage and speed difficulty by 8% per lost structure', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const base = difficultyAt(ctx, 60);

    ctx.run.structuresLost = 2;
    const bolder = difficultyAt(ctx, 60);

    // hp is untouched: sponginess would punish weapons, aggression punishes
    // the player — the penalty should feel like the latter.
    expect(bolder.hp).toBe(base.hp);
    expect(bolder.damage).toBeCloseTo(base.damage * 1.16);
    expect(bolder.speed).toBeCloseTo(base.speed * 1.16);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "bolder"`
Expected: FAIL — `bolder.damage` equals `base.damage` (`expected 1.05 to be close to 1.218`).

**Step 3: Write minimal implementation**

In `src/gameplay/spawner.ts`, add a constant near the ring constants and fold it into `difficultyAt()`:

```ts
/** Extra damage/speed multiplier per structure lost — "the hunters grow bolder". */
const BOLDER_PER_STRUCTURE = 0.08;
```

```ts
export function difficultyAt(ctx: Ctx, seconds: number): {
  hp: number;
  damage: number;
  speed: number;
} {
  const table = ctx.wave;
  const minutes = seconds / 60;
  // Losing a structure is not a fail state; the world just leans harder on
  // you. Consumed at spawn time only, like the rest of these multipliers —
  // enemies already on the field never rescale.
  const bolder = 1 + BOLDER_PER_STRUCTURE * ctx.run.structuresLost;
  return {
    // The exponent lets late-game health outpace linear weapon growth, which is
    // what forces build decisions rather than letting one weapon carry forever.
    hp: Math.pow(1 + table.hpPerMinute * minutes, table.hpExponent),
    damage: (1 + table.damagePerMinute * minutes) * bolder,
    speed: (1 + table.speedPerMinute * minutes) * bolder,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "castle defense"` → PASS (18 tests). `npm run typecheck` — clean. `npm test` — green (`structuresLost` is 0 everywhere else, so every existing difficulty expectation holds bit-for-bit).

**Step 5: Commit**

```bash
git add src/gameplay/spawner.ts src/gameplay/simulation.test.ts
git commit -m "feat: make the hunters bolder for each structure lost"
```

---

### Task 12: bastion map + HUD pips, siege banners and off-screen edge markers

**Files:**
- Create: `src/content/maps/bastion.json` (auto-discovered via `import.meta.glob` — no registration)
- Modify: `src/ui/hud.ts` (pip row + three methods)
- Modify: `src/ui/style.css` (pip-row rules, appended at end)
- Modify: `src/game.ts` (`siegeUntil` field; event wiring; startRun pip setup; render markers)

This surface is browser-bound (Hud/Renderer/TileMap have no headless coverage, per CLAUDE.md) — verification is `npm run typecheck` + the manual dev-server pass in Step 3. No new headless tests.

**Step 1: Implement the HUD pip row**

In `src/ui/hud.ts`:

1. Fields (next to the other private element fields):

```ts
  private structureRow: HTMLElement;
  private structurePips: { wrap: HTMLElement; fill: HTMLElement }[] = [];
```

2. In the constructor, create the row (next to `this.banner = el('div', 'boss-banner');`) and include it in the final append:

```ts
    this.structureRow = el('div', 'structure-pips');
```

```ts
    this.root.append(xpTrack, left, center, right, loadout, this.bloodWrap, this.banner, this.structureRow);
```

3. Methods (after `bindAbilityButton`):

```ts
  /**
   * Builds one HP pip per structure at run start (Game calls this from
   * startRun — creation has no gameplay event; updates are event-driven).
   * An empty list hides the row: structure-less maps show nothing new.
   */
  setStructurePips(structures: { name: string; hp: number }[]): void {
    this.structurePips = [];
    this.structureRow.replaceChildren();
    this.structureRow.classList.toggle('visible', structures.length > 0);
    for (const s of structures) {
      const wrap = el('div', 'structure-pip');
      wrap.title = s.name;
      const fill = el('div', 'structure-pip-fill');
      wrap.appendChild(fill);
      this.structureRow.appendChild(wrap);
      this.structurePips.push({ wrap, fill });
    }
  }

  /** Driven by the structure:damaged event, like hp-fill. */
  updateStructurePip(index: number, hp: number, maxHp: number): void {
    const pip = this.structurePips[index];
    if (!pip) return;
    const percent = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
    pip.fill.style.width = `${percent}%`;
  }

  /** Driven by the structure:destroyed event. The slot stays, marked lost. */
  destroyStructurePip(index: number): void {
    const pip = this.structurePips[index];
    if (!pip) return;
    pip.fill.style.width = '0%';
    pip.wrap.classList.add('lost');
  }
```

Append to `src/ui/style.css` (everything in `--u` units, per the DOM-over-canvas convention):

```css
/* Structure HP pips, top-centre under the clock (castle-defense maps only). */
.structure-pips {
  position: absolute;
  top: calc(var(--u) * 30);
  left: 50%;
  transform: translateX(-50%);
  display: none;
  gap: calc(var(--u) * 3);
}

.structure-pips.visible {
  display: flex;
}

.structure-pip {
  width: calc(var(--u) * 24);
  height: calc(var(--u) * 4);
  background: var(--panel);
  border: var(--u) solid #0a0508;
  overflow: hidden;
}

.structure-pip-fill {
  height: 100%;
  width: 100%;
  background: #c9a86a;
}

.structure-pip.lost {
  border-color: #5c1024;
  background: #2a0910;
}
```

**Step 2: Wire Game — banners, pips, siege window, edge markers**

In `src/game.ts`:

1. Field (next to `private debugVisible = false;`):

```ts
  /** Sim time the current siege banner/marker window closes. Frame-side only. */
  private siegeUntil = 0;
```

2. In `wireEvents()`, after the `boss:spawned` handler:

```ts
    this.bus.on('siege:started', ({ duration }) => {
      this.siegeUntil = this.run.time + duration;
      this.hud.showBanner('SIEGE! DEFEND THE BASTION');
    });

    this.bus.on('siege:defended', () => {
      this.siegeUntil = 0;
      this.hud.showBanner('SIEGE REPELLED');
    });

    this.bus.on('structure:damaged', ({ hp, maxHp, index }) => {
      this.hud.updateStructurePip(index, hp, maxHp);
    });

    this.bus.on('structure:destroyed', ({ name, remaining, index }) => {
      this.hud.destroyStructurePip(index);
      this.hud.showBanner(
        remaining > 0 ? `THE ${name.toUpperCase()} HAS FALLEN` : 'EVERY WALL HAS FALLEN',
      );
    });
```

3. In `startRun()`, replace Task 5's structure-spawning loop so it also feeds the HUD, and reset the window (next to the other per-run resets):

```ts
    this.ctx.player = spawnPlayer(this.ctx, map.spawnX, map.spawnY);
    const pips: { name: string; hp: number }[] = [];
    for (const entry of map.structures) {
      const def = structureDef(entry.type);
      if (!def) continue; // warn-don't-throw: a typo costs one structure, not the run
      if (spawnStructure(this.ctx, def, entry.x, entry.y) >= 0) {
        pips.push({ name: def.name, hp: def.hp });
      }
    }
    this.hud.setStructurePips(pips);
    this.siegeUntil = 0;
```

4. In `render()`, after `this.queuePlayer(alpha);` and before `this.renderer.flushSprites();` — the off-screen edge markers, inline math, zero allocation:

```ts
    // Off-screen structure markers during an active siege: the structure's own
    // sprite at half scale, clamped 8px inside the 480x270 buffer edge, always
    // on top of the sprite pass (flat decor uses -1e6; this is its ceiling twin).
    if (this.siegeUntil > this.run.time) {
      const view = this.renderer.visibleBounds();
      const ids = world.list(Kind.Structure);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const x = lerp(world.prevX[id]!, world.x[id]!, alpha);
        const y = lerp(world.prevY[id]!, world.y[id]!, alpha);
        if (x >= view.left && x <= view.right && y >= view.top && y <= view.bottom) continue;
        const mx = Math.max(view.left + 8, Math.min(view.right - 8, x));
        const my = Math.max(view.top + 8, Math.min(view.bottom - 8, y));
        this.renderer.queue(world.spriteId[id]!, world.animState[id]!, world.animTime[id]!, mx, my, {
          scale: 0.5,
          depth: 1e6,
        });
      }
    }

    this.renderer.flushSprites();
```

**Step 3: Create the bastion map + manual dev-server verification**

Create `src/content/maps/bastion.json` — a bounded scatter map with a rock wall on the west flank, the gate plugging its gap (the breach literally opens the wall), and a walk-through shrine in the open:

```json
{
  "name": "The Broken Bastion",
  "tileSize": 16,
  "ground": { "mode": "scatter" },
  "bounds": { "left": -560, "top": -420, "right": 560, "bottom": 420 },
  "spawnPoint": [0, 60],
  "waves": "bastion",
  "voidColor": "#0c0a12",
  "tileset": [
    { "src": "tiles/flagstone.png", "weight": 22, "placeholder": { "color": "#33303c", "detail": 0.5 } },
    { "src": "tiles/flagstone_b.png", "weight": 10, "placeholder": { "color": "#2b2834", "detail": 0.7 } },
    { "src": "tiles/flagstone_cracked.png", "weight": 5, "placeholder": { "color": "#262230", "detail": 1 } },
    { "src": "tiles/blood_moss.png", "weight": 3, "placeholder": { "color": "#3a2430", "detail": 0.8 } }
  ],
  "decor": [
    { "sprite": "rock", "density": 0.04 },
    { "sprite": "grave", "density": 0.03 },
    { "sprite": "puddle", "density": 0.04, "flat": true }
  ],
  "props": [
    { "sprite": "rock", "x": -240, "y": -90, "solid": 9 },
    { "sprite": "rock", "x": -240, "y": -60, "solid": 9 },
    { "sprite": "rock", "x": -240, "y": -30, "solid": 9 },
    { "sprite": "rock", "x": -240, "y": 30, "solid": 9 },
    { "sprite": "rock", "x": -240, "y": 60, "solid": 9 },
    { "sprite": "rock", "x": -240, "y": 90, "solid": 9 },
    { "sprite": "tree", "x": 380, "y": -280, "solid": 10 },
    { "sprite": "tree", "x": -380, "y": 300, "solid": 10 }
  ],
  "structures": [
    { "type": "gate", "x": -240, "y": 0 },
    { "type": "shrine", "x": 180, "y": -120 }
  ]
}
```

(The tileset PNGs don't exist — placeholders generate, fail-soft. The gate at (-240, 0) radius 14 plugs the y ∈ (-30, 30) gap in the rock wall.)

Run `npm run dev`, pick bastion, and verify the checklist from the roadmap's exit criteria:

- [ ] bastion appears in the map list (auto-discovery) and loads
- [ ] two pips appear top-centre; meadow/crypt/arena show no pip row
- [ ] at 2:00 the SIEGE banner fires and zombies march at the gate, not you
- [ ] walking within ~56u of an attacker peels it onto you
- [ ] gate at 0 hp: shockwave, pip marked lost, "THE BASTION GATE HAS FALLEN" banner, and you can now walk through the wall gap (breach opens)
- [ ] surviving a siege drops a chest + coin at the surviving structure and banners "SIEGE REPELLED"
- [ ] during a siege, an off-screen structure shows as a half-scale sprite pinned to the buffer edge; it vanishes when the window ends
- [ ] restart the run: solids don't stack (walk the wall line), pips reset

**Step 4: Verify**

Run: `npm run typecheck` — clean. `npm test` — full suite green (nothing headless changed).

**Step 5: Commit**

```bash
git add src/content/maps/bastion.json src/ui/hud.ts src/ui/style.css src/game.ts
git commit -m "feat: add the bastion map with HUD pips, siege banners and edge markers"
```

---

### Task 13: sweep — seeded-siege determinism + full-run leak bound over siege windows

**Files:**
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the tests**

Append inside `describe('castle defense', …)`:

```ts
  it('keeps a seeded bastion siege deterministic', { timeout: 60_000 }, () => {
    const fingerprint = (): number[] => {
      const harness = makeHarness('wanderer', 777);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      ctx.wave = waveTable('bastion');
      // The stub map has no structures; stand the bastion pair up manually.
      spawnStructure(ctx, structureDef('gate')!, -240, 0);
      spawnStructure(ctx, structureDef('shrine')!, 180, -120);
      harness.run(150); // covers the 120s siege start plus 30s of fighting
      let structureHp = 0;
      for (const sid of ctx.world.list(Kind.Structure)) {
        structureHp += ctx.world.hp[sid]!;
      }
      return [
        ctx.run.kills,
        ctx.run.gold,
        ctx.run.structuresLost,
        ctx.world.entityCount,
        Math.round(structureHp),
      ];
    };
    // Identical seed => identical world. Any Math.random or wall-clock leak in
    // the siege path (spawn points, targeting, rewards) breaks this instantly.
    expect(fingerprint()).toEqual(fingerprint());
  });

  it('does not leak entities over a full bastion run with sieges', { timeout: 120_000 }, () => {
    const harness = makeHarness('wanderer', 4242);
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = waveTable('bastion');
    spawnStructure(ctx, structureDef('gate')!, -240, 0);
    spawnStructure(ctx, structureDef('shrine')!, 180, -120);

    const victory = ctx.wave.victorySeconds;
    const chunk = 15;
    for (let elapsed = 0; elapsed < victory; elapsed += chunk) {
      world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(chunk);
      // The cull exemption must never balloon the field: siege durations are
      // bounded, so attackers either die, land their handle on a corpse and
      // resume normal culling, or the window ends. 4000 = leak, not load.
      expect(world.entityCount).toBeLessThan(4000);
    }
    expect(ctx.run.time).toBeGreaterThan(victory - FIXED_DT);

    // Counter coherence across the whole run: every spawned structure is
    // either lost or still alive — no double-counts, no ghosts.
    let aliveStructures = 0;
    for (const sid of world.list(Kind.Structure)) {
      if (world.isAlive(sid)) aliveStructures++;
    }
    expect(ctx.run.structuresLost + aliveStructures).toBe(2);
  });
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run -t "castle defense"`
Expected: PASS — all 20 tests (the leak run takes 1–2 minutes, like the existing 15-minute tests). If the determinism test fails, something in Tasks 4–11 drew from the wrong RNG or a wall clock: stop and diagnose, don't patch the test.

**Step 3: Commit**

```bash
git add src/gameplay/simulation.test.ts
git commit -m "test: bound entity pressure and determinism across bastion sieges"
```

---

### Task 14: full verification + squash merge

**Files:** none (verification only)

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean, zero errors.

**Step 2: Full suite**

Run: `npm test`
Expected: ALL tests pass, including:
- the pre-existing suite (content, progression, simulation, difficulty scaling, blood economy, active abilities — both 15-minute full-run tests are the invariant tripwires and MUST be green)
- the 20 new `castle defense` tests:
  1. registers Kind.Structure as a seventh kind with its own live list
  2. resets targetHandle on recycled ids and resolves stale handles to -1
  3. normalizes structure defs and fails soft on unknown ids
  4. keeps structure-less maps untouched: a default run spawns no structures
  5. damages a structure through the hit pipeline and reports each hit
  6. destroys a fallen structure: solid tombstoned, penalty banked, event fired
  7. runs structures through the tick with hit-flash decay and free interpolation
  8. marches a siege enemy to the wall, parks it, and swings on the 0.8s cadence
  9. peels a siege enemy off the gate when the player closes in
  10. retargets to the player after its structure falls
  11. never lets a stale handle point at a recycled id
  12. exempts enemies with a live siege target from distance culling
  13. parses siege schedules with defaults and keeps default siege-free
  14. spawns a siege wave aimed at the nearest living structure
  15. degrades a siege to player-chasers on a structure-less map
  16. pays out a chest and gold when the siege window closes with a survivor
  17. pays nothing when every structure fell before the window closed
  18. raises damage and speed difficulty by 8% per lost structure
  19. keeps a seeded bastion siege deterministic
  20. does not leak entities over a full bastion run with sieges

**Step 3: Self-review the diff**

Run: `git diff main...HEAD --stat` then `git diff main...HEAD`
Check against the invariants: `KIND_COUNT` is 7 and matches components.ts; `targetHandle` has its `create()` reset line; every read of `targetHandle` goes through `world.resolve()`; no raw structure ids stored across ticks anywhere; `Game.tick()` and the harness tick identical around `updateStructures`; no `Math.random` or wall clock in gameplay paths (smoulder fx on `fxRng` is the sanctioned cosmetic exception); every spawn site treats `create() === -1` as skip; `clearRuntimeSolids()` unconditional in `startRun()`; `hitCooldown` reuse confined to melee handles; no `run.stats` mutation; `world.flush()` still called exactly once, last.

**Step 4: Manual device sanity (browser-bound surface)**

`npm run dev`: one full bastion run (win or die trying) plus one meadow run. Bastion: the Task 12 checklist holds end-to-end. Meadow: zero visual or behavioral difference from main — no pip row, no banners, no markers.

**Step 5: Squash merge (ask the user before each git command)**

```bash
git checkout main
git merge --squash feat/phase-3-castle-defense
git commit -m "feat: castle defense objectives — siege waves, structures and the bastion map (mobile v1 phase 3)"
```
Keep the phase branch until the user confirms deletion. Then reassess (per the roadmap's just-in-time rule) before writing the Phase 4 plan — in particular whether the 0.08 bolder step and the 300/180 structure hp survived the balance pass, and whether Phase 4's meta layer wants a `siege:defended` blood or gold hook.

---

## Notes for the executor

- **Never edit `Game.tick()` without the identical harness edit in the same commit** — Task 5 is the only task that touches tick order. `updateStructures` sits between `updateHazards` and the pickup-hash rebuild in BOTH, and test 7 fails immediately if the harness lags.
- **Task order is load-bearing:** ECS (1) → content (2) → map/solids (3) → structure system (4–5) → targeting (6–7) → sieges (8–10) → difficulty (11) → browser surface (12) → sweeps (13). Tasks 6–7's `ctx.wave` spreads compile before Task 8 only because they don't name `sieges`; don't reorder 8 before 6.
- The standoff check runs **before** knockback/integration and zeroes `vx/vy` — moving it after integration makes attackers jitter against the gate's own solid (design §3 risk 4). The `d2` it reads is this tick's pre-movement distance; that one-tick lag is what makes the parking stable.
- The cull exemption tests and the leak test are the two ends of one contract: exemption exactly while the handle resolves alive. If the leak test creeps toward 4000, check that peeled/orphaned attackers actually clear their handles (`world.targetHandle[id] = -1` on both the dead-resolve and peel branches).
- `world.value` on structures is a **solid index**, `world.aiPhase` is a **pip slot** — both documented at the write sites in `spawnStructure`. Don't swap them; the tombstone contract and the HUD both depend on which is which.
- All siege/structure tuning lives in `src/content/structures.json` and `src/content/waves.json` and hot-reloads in the dev server — balance passes need no code changes. The one code-side knob is `BOLDER_PER_STRUCTURE` in spawner.ts (deliberately a named constant, design §3 risk 6).
- If any test fails twice with the same error: stop, re-read the relevant source file in full, do not blind-retry (execution discipline rules).
- Deliberately out of scope (stated, per the no-silent-trim rule): blood payout on `siege:defended` (event payload ready; Phase 4+ decides), non-melee siege warn test (module-load path), repairable structures, more than one reward per overlapping siege window, structure art (placeholders ship), touch-input interaction with pips (Phase 5).


