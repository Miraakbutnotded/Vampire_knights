# Meta-Progression Implementation Plan (Phase 4)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persistent progression: gold from every finished run (victory OR death) banks exactly once into a saved wallet; the wallet buys ranks in a 10-node Sanctum upgrade tree that feeds the next run's stats, and unlocks characters; everything survives reload through a versioned, checksummed, dual-slot local save.

**Architecture:** A new `src/services/` layer — `storage.ts` (async `StorageAdapter` with localStorage + in-memory implementations), `save.ts` (versioned codec: checksum, `migrate()`, dual-slot `SaveStore` with backup recovery), `meta.ts` (`MetaService`: wallet, `bankRun`, `buyNode`, `computeMetaMods`, character unlocks). The engine (`src/core`, `src/ecs`, `src/gameplay`, `src/render`) **never imports services** — only `main.ts`, `game.ts` and `src/ui/*` do, and a vitest isolation gate enforces it. The single engine touch-point is `Run`'s new optional `metaMods` constructor param, which seeds the `recomputeStats()` accumulator so every existing clamp applies to meta bonuses exactly as it does to passives; the default `{}` keeps all 76 existing tests green without editing any of them. Sanctum content is data-driven JSON (`src/content/meta.json`) normalized warn-don't-throw in `content.ts`. Run-end banking funnels through one new `Game.endRun()` used by both the death and victory paths.

**Tech Stack:** TypeScript strict with `verbatimModuleSyntax` (type-only imports MUST be separate `import type` lines), Vitest headless (`src/gameplay/simulation.test.ts` + new `src/services/meta.test.ts` + `src/services/isolation.test.ts`; the isolation gate uses Vite's `import.meta.glob` raw imports, so no `node:fs` and no `@types/node`), localStorage for persistence now — Phase 5 swaps in a Capacitor Preferences adapter behind the same interface. No new dependencies.

---

**Design source:** `docs/plans/2026-07-30-mobile-v1-design.md` §4 ("Meta-Progression + Monetization") and the roadmap's Phase 4 section. **Locked scope deviations (reassessment decisions — honor them):**

1. **Storage:** Capacitor arrives in Phase 5, so persistence goes through a `StorageAdapter` interface with a localStorage implementation now; the Preferences adapter is a Phase 5 drop-in. Services are never imported by engine code — enforced by a test (Task 7).
2. **Save schema:** versioned `{version, gold, unlockedCharacters, sanctum: {nodeId: rank}}` with dual-slot write + checksum and `migrate()` falling back to `.bak` then defaults on corruption. All save/meta modules work against the in-memory adapter in vitest — no DOM assumption inside the modules.
3. **Gold flow:** run end (victory OR death) banks `run.gold` into the wallet exactly once. The idempotency lives in the testable service seam — `MetaService.bankRun(runGold, runToken)` ignores a token it has already banked (pinned by a headless test) — while `Game.endRun()`'s `runEnded` flag keeps the `run:ended`/`meta:goldBanked` emits exactly-once as well. New events: `run:ended`, `meta:goldBanked`, `meta:purchased`, `character:unlocked`.
4. **EXCLUDED (Phase 6):** IAP catalog, StoreKit, rewarded ads, revive offers, gold doublers, daily chest, restore purchases, `adState`/`purchases` save fields. **EXCLUDED (Phase 5):** Capacitor Preferences adapter, `appStateChange` save hook.
5. **Numbers note:** the design prose says the tree costs "~42k", but its own cost table sums to **35,150** — the table is authoritative, the test asserts 35,150. Character unlocks (2,500 + 4,000 + 6,000 + 12,000 = 24,500) bring the combined gold sink to ≈59,650.

**Test placement:** headless gameplay/content tests go in a new `describe('meta progression', …)` block appended at the very end of `src/gameplay/simulation.test.ts` (after the closing `});` of `describe('castle defense', …)`). Service tests go in the new `src/services/meta.test.ts`; the isolation gate in `src/services/isolation.test.ts`. Vitest discovers both new files with its default glob — no config change.

## Setup

```bash
cd /Users/boraesen/Desktop/Vampire_knights
git checkout -b feat/phase-4-meta-progression
npm test   # confirm the suite is green (76 tests) before touching anything
```
Expected: all existing tests pass. (Git operations require user approval per house rules — ask before each commit/checkout.)

---

### Task 1: meta.json content file + normalizeMeta + MetaMods type

**Files:**
- Create: `src/content/meta.json`
- Modify: `src/gameplay/content.ts` (JSON import at top; new section after the `BLOOD_CONFIG` export, before `// --- shared ---` ~line 1021)
- Test: `src/gameplay/simulation.test.ts` (new describe block at end of file; content import ~line 16)

**Step 1: Write the failing tests**

In `src/gameplay/simulation.test.ts`, extend the content import block (lines 16–28) with three names:

```ts
import {
  BLOOD_CONFIG,
  CHARACTER_LIST,
  META_LIST,
  STRUCTURE_LIST,
  WEAPON_LIST,
  enemyDef,
  metaNodeDef,
  normalizeAbility,
  normalizeBlood,
  normalizeMeta,
  structureDef,
  structureDefByIndex,
  waveTable,
  weaponStatsAtLevel,
} from './content.ts';
```

Append at the very end of the file (after the closing `});` of `describe('castle defense', …)`):

```ts
describe('meta progression', () => {
  it('normalizes the 10-node sanctum tree with derived max ranks', () => {
    expect(META_LIST.length).toBe(10);
    const bloodthirst = metaNodeDef('bloodthirst')!;
    expect(bloodthirst.maxRank).toBe(5);
    expect(bloodthirst.costs).toEqual([100, 250, 600, 1400, 3000]);
    expect(bloodthirst.perRank).toEqual({ might: 0.05 });
    expect(metaNodeDef('second_wind')!.perRank).toEqual({ revives: 1 });
    expect(metaNodeDef('second_wind')!.maxRank).toBe(1);
    expect(metaNodeDef('nonsense')).toBeNull();
  });

  it('prices the full tree at the designed total sink', () => {
    const total = META_LIST.reduce((sum, node) => sum + node.costs.reduce((a, b) => a + b, 0), 0);
    // The design table sums to 35,150 (its "~42k" prose was arithmetic-off);
    // character unlocks add another 24,500 on top.
    expect(total).toBe(35150);
  });

  it('drops unknown perRank stats and cost-less nodes with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { list } = normalizeMeta({
      good: { costs: [100], perRank: { might: 0.1, banana: 3 } },
      broken: { perRank: { might: 0.1 } },
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.perRank).toEqual({ might: 0.1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "sanctum tree"`
Expected: FAIL — the whole suite file fails to load with `does not provide an export named 'META_LIST'`.

**Step 3: Write minimal implementation**

Create `src/content/meta.json` (costs are the design table verbatim; all tuning lives here):

```json
{
  "bloodthirst": {
    "name": "Bloodthirst",
    "description": "+5% might per rank. The hunger sharpens the blade.",
    "costs": [100, 250, 600, 1400, 3000],
    "perRank": { "might": 0.05 }
  },
  "vitality": {
    "name": "Vitality",
    "description": "+10% max health per rank.",
    "costs": [150, 400, 1000],
    "perRank": { "maxHpMul": 0.1 }
  },
  "iron_skin": {
    "name": "Iron Skin",
    "description": "+1 armor per rank.",
    "costs": [200, 500, 1200],
    "perRank": { "armor": 1 }
  },
  "swiftness": {
    "name": "Swiftness",
    "description": "+3% move speed per rank.",
    "costs": [150, 400, 1000],
    "perRank": { "moveSpeedMul": 0.03 }
  },
  "haste": {
    "name": "Haste",
    "description": "Weapons cool 2.5% faster per rank.",
    "costs": [250, 600, 1500, 3500],
    "perRank": { "cooldown": -0.025 }
  },
  "greed": {
    "name": "Greed",
    "description": "+10% gold from every source per rank.",
    "costs": [100, 250, 600, 1400, 3000],
    "perRank": { "greed": 0.1 }
  },
  "scholar": {
    "name": "Scholar",
    "description": "+8% experience per rank.",
    "costs": [120, 300, 700, 1600, 3200],
    "perRank": { "growth": 0.08 }
  },
  "magnetism": {
    "name": "Magnetism",
    "description": "+15% pickup range per rank.",
    "costs": [80, 200, 500],
    "perRank": { "magnetMul": 0.15 }
  },
  "fortune": {
    "name": "Fortune",
    "description": "+10% luck per rank.",
    "costs": [200, 500, 1200],
    "perRank": { "luck": 0.1 }
  },
  "second_wind": {
    "name": "Second Wind",
    "description": "Rise once more each night.",
    "costs": [5000],
    "perRank": { "revives": 1 }
  }
}
```

In `src/gameplay/content.ts`, add to the JSON imports at the top (after line 8, `import structuresJson …`):

```ts
import metaJson from '../content/meta.json';
```

Insert a new section after the `export const BLOOD_CONFIG` line (~1019), before `// --- shared ---`:

```ts
// --- meta (sanctum) -------------------------------------------------------

/**
 * Persistent stat mods from the Sanctum tree: every StatMods key plus extra
 * revives, which Run handles separately (revivesLeft, not derived stats).
 */
export interface MetaMods extends Partial<StatMods> {
  revives?: number;
}

export interface MetaNodeDef {
  id: string;
  index: number;
  name: string;
  description: string;
  /** Gold cost of buying rank r+1 is costs[r]; maxRank = costs.length. */
  costs: number[];
  maxRank: number;
  perRank: MetaMods;
}

/**
 * Same fail-soft contract as every other content file: an unknown perRank stat
 * warns and is dropped; a node with no valid costs warns and is skipped — a
 * typo costs one upgrade, not the Sanctum.
 *
 * Takes the raw record rather than reading the import directly so the fail-soft
 * paths are reachable from tests; production always passes meta.json.
 */
export function normalizeMeta(raw: Record<string, Record<string, unknown>>): {
  list: MetaNodeDef[];
  byId: Map<string, MetaNodeDef>;
} {
  const list: MetaNodeDef[] = [];
  const byId = new Map<string, MetaNodeDef>();

  for (const [id, def] of Object.entries(raw)) {
    const costsRaw = Array.isArray(def['costs']) ? (def['costs'] as unknown[]) : [];
    const costs: number[] = [];
    for (const c of costsRaw) {
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) costs.push(Math.round(c));
      else console.warn(`[content] meta node "${id}" has a non-positive cost; dropping it`);
    }
    if (costs.length === 0) {
      console.warn(`[content] meta node "${id}" has no valid costs; node skipped`);
      continue;
    }

    const perRankRaw = (def['perRank'] ?? {}) as Record<string, unknown>;
    const perRank: MetaMods = {};
    for (const key of Object.keys(perRankRaw)) {
      const known = key === 'revives' || STAT_MOD_KEYS.includes(key as keyof StatMods);
      if (!known) {
        console.warn(
          `[content] meta node "${id}" sets unknown stat "${key}"; it will have no effect. ` +
            `Valid: revives, ${STAT_MOD_KEYS.join(', ')}`,
        );
        continue;
      }
      const v = perRankRaw[key];
      if (typeof v === 'number' && Number.isFinite(v)) perRank[key as keyof MetaMods] = v;
    }

    const entry: MetaNodeDef = {
      id,
      index: list.length,
      name: typeof def['name'] === 'string' ? def['name'] : id,
      description: typeof def['description'] === 'string' ? def['description'] : '',
      costs,
      maxRank: costs.length,
      perRank,
    };
    list.push(entry);
    byId.set(id, entry);
  }

  return { list, byId };
}

const metaData = normalizeMeta(metaJson as unknown as Record<string, Record<string, unknown>>);
export const META_LIST: readonly MetaNodeDef[] = metaData.list;

export function metaNodeDef(id: string): MetaNodeDef | null {
  return metaData.byId.get(id) ?? null;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "sanctum tree"` then `npx vitest run -t "designed total sink"` then `npx vitest run -t "cost-less nodes"`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/content/meta.json src/gameplay/content.ts src/gameplay/simulation.test.ts
git commit -m "feat: add sanctum meta.json with the normalized 10-node upgrade tree"
```

---

### Task 2: services/storage.ts — StorageAdapter + adapters

**Files:**
- Create: `src/services/storage.ts`
- Create (test): `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Create `src/services/meta.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MemoryStorageAdapter } from './storage.ts';

describe('storage adapters', () => {
  it('round-trips values through the in-memory adapter', async () => {
    const store = new MemoryStorageAdapter();
    expect(await store.get('missing')).toBeNull();
    await store.set('k', 'v1');
    expect(await store.get('k')).toBe('v1');
    await store.set('k', 'v2');
    expect(await store.get('k')).toBe('v2');
  });

  it('removes keys', async () => {
    const store = new MemoryStorageAdapter();
    await store.set('k', 'v');
    await store.remove('k');
    expect(await store.get('k')).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/meta.test.ts`
Expected: FAIL — the file fails to load: `Failed to resolve import "./storage.ts"`.

**Step 3: Write minimal implementation**

Create `src/services/storage.ts`:

```ts
/**
 * Minimal async key-value contract the save system writes through.
 *
 * Everything is Promise-based even though localStorage is synchronous, so the
 * Phase 5 swap to Capacitor Preferences (genuinely async) changes no call
 * sites. The engine (core/ecs/gameplay/render) never imports this module —
 * see isolation.test.ts.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Browser adapter. Constructed only from main.ts — never in headless code. */
export class LocalStorageAdapter implements StorageAdapter {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(key);
  }
}

/** In-memory adapter for vitest and any future headless tooling. */
export class MemoryStorageAdapter implements StorageAdapter {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add src/services/storage.ts src/services/meta.test.ts
git commit -m "feat: add services storage adapters behind the engine boundary"
```

---

### Task 3: save codec — schema v1, checksum, migrate

**Files:**
- Create: `src/services/save.ts`
- Test: `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Append to `src/services/meta.test.ts` (and extend its imports):

```ts
import { checksum, decodeSave, defaultSave, encodeSave, migrate } from './save.ts';
import type { SaveData } from './save.ts';
```

```ts
describe('save codec', () => {
  it('round-trips SaveData through encode/decode', () => {
    const data: SaveData = {
      version: 1,
      gold: 1234,
      unlockedCharacters: ['acolyte'],
      sanctum: { greed: 2, haste: 1 },
    };
    expect(decodeSave(encodeSave(data))).toEqual(data);
  });

  it('rejects tampered or malformed slots via the checksum', () => {
    const encoded = encodeSave(defaultSave());
    // The payload is a nested JSON string, so its quotes are escaped.
    const tampered = encoded.replace('\\"gold\\":0', '\\"gold\\":9999');
    expect(tampered).not.toBe(encoded); // sanity: the replace found its target
    expect(decodeSave(tampered)).toBeNull();
    expect(decodeSave('not json at all')).toBeNull();
    expect(decodeSave('{"payload":123,"checksum":"x"}')).toBeNull();
    expect(checksum('a')).not.toBe(checksum('b'));
  });

  it('migrates a version-less v0 save to v1 defaults', () => {
    expect(migrate({ gold: 500 })).toEqual({
      version: 1,
      gold: 500,
      unlockedCharacters: [],
      sanctum: {},
    });
    // Garbage fields sanitize instead of poisoning the state: negative gold
    // clamps, fractional ranks drop, non-strings fall out of the unlock list.
    expect(migrate({ gold: -5, sanctum: { greed: 1.5, haste: 2 }, unlockedCharacters: ['a', 7] })).toEqual({
      version: 1,
      gold: 0,
      unlockedCharacters: ['a'],
      sanctum: { haste: 2 },
    });
  });

  it('rejects saves from the future and non-objects', () => {
    expect(migrate({ version: 2, gold: 10 })).toBeNull();
    expect(migrate('gold')).toBeNull();
    expect(migrate(null)).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/meta.test.ts`
Expected: FAIL — file fails to load: `Failed to resolve import "./save.ts"`.

**Step 3: Write minimal implementation**

Create `src/services/save.ts`:

```ts
import type { StorageAdapter } from './storage.ts';

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'vk-save';
export const SAVE_BACKUP_KEY = 'vk-save.bak';

/** Everything Vampire Knights persists between runs. Version 1 (Phase 4). */
export interface SaveData {
  version: number;
  gold: number;
  unlockedCharacters: string[];
  /** Sanctum node ranks by node id; absent key = rank 0. */
  sanctum: Record<string, number>;
}

export function defaultSave(): SaveData {
  return { version: SAVE_VERSION, gold: 0, unlockedCharacters: [], sanctum: {} };
}

/** FNV-1a over the payload string — a corruption tripwire, not security. */
export function checksum(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Serializes with the checksum computed over a stable-ordered payload. */
export function encodeSave(data: SaveData): string {
  const payload = JSON.stringify({
    version: data.version,
    gold: data.gold,
    unlockedCharacters: data.unlockedCharacters,
    sanctum: data.sanctum,
  });
  return JSON.stringify({ payload, checksum: checksum(payload) });
}

/**
 * Parses one slot. Returns null on any corruption — bad JSON, checksum
 * mismatch, a payload migrate() rejects — so the caller can fall through to
 * the backup slot or defaults. Never throws.
 */
export function decodeSave(rawSlot: string): SaveData | null {
  try {
    const outer = JSON.parse(rawSlot) as unknown;
    if (typeof outer !== 'object' || outer === null) return null;
    const { payload, checksum: stored } = outer as { payload?: unknown; checksum?: unknown };
    if (typeof payload !== 'string' || typeof stored !== 'string') return null;
    if (checksum(payload) !== stored) return null;
    return migrate(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * Coerces a decoded payload of any known version into the current SaveData.
 * Missing fields (a version-less early-dev "v0" save) fill from defaults —
 * the same warn-don't-throw spirit as content normalization. Unknown future
 * versions are rejected (null) rather than guessed at, so a downgraded build
 * falls back to the backup slot instead of mangling a newer save.
 */
export function migrate(raw: unknown): SaveData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const version = typeof rec['version'] === 'number' ? rec['version'] : 0;
  if (version > SAVE_VERSION) return null;

  const base = defaultSave();
  const gold =
    typeof rec['gold'] === 'number' && Number.isFinite(rec['gold'])
      ? Math.max(0, Math.floor(rec['gold']))
      : base.gold;
  const unlockedCharacters = Array.isArray(rec['unlockedCharacters'])
    ? (rec['unlockedCharacters'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : base.unlockedCharacters;
  const sanctumRaw =
    typeof rec['sanctum'] === 'object' && rec['sanctum'] !== null
      ? (rec['sanctum'] as Record<string, unknown>)
      : {};
  const sanctum: Record<string, number> = {};
  for (const [id, rank] of Object.entries(sanctumRaw)) {
    if (typeof rank === 'number' && Number.isInteger(rank) && rank > 0) sanctum[id] = rank;
  }
  return { version: SAVE_VERSION, gold, unlockedCharacters, sanctum };
}
```

(The `StorageAdapter` import is unused until Task 4 adds `SaveStore` — `noUnusedLocals`
would reject it, so **omit the import line until Task 4** if `tsc` complains; the code
above lists it for context.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (6 tests). Also run `npm run typecheck` — if the unused `StorageAdapter` import errors, delete that line (Task 4 restores it).

**Step 5: Commit**

```bash
git add src/services/save.ts src/services/meta.test.ts
git commit -m "feat: versioned save codec with checksum and v0 migration"
```

---

### Task 4: SaveStore — dual-slot write with backup recovery

**Files:**
- Modify: `src/services/save.ts` (append `SaveStore`; ensure the `StorageAdapter` type import is present)
- Test: `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Extend the save import in `src/services/meta.test.ts`:

```ts
import {
  SAVE_BACKUP_KEY,
  SAVE_KEY,
  SaveStore,
  checksum,
  decodeSave,
  defaultSave,
  encodeSave,
  migrate,
} from './save.ts';
```

Append:

```ts
describe('save store', () => {
  it('persists to both slots and loads the primary', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new SaveStore(adapter);
    await store.persist({ ...defaultSave(), gold: 777 });
    expect(await adapter.get(SAVE_KEY)).not.toBeNull();
    expect(await adapter.get(SAVE_BACKUP_KEY)).not.toBeNull();
    expect((await store.load()).gold).toBe(777);
  });

  it('recovers from the backup when the primary is corrupt, healing it', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new SaveStore(adapter);
    await store.persist({ ...defaultSave(), gold: 4242 });
    await adapter.set(SAVE_KEY, '{"payload": "garbage"');
    expect((await store.load()).gold).toBe(4242);
    // The corrupt primary was healed from the backup on the way through.
    expect(decodeSave((await adapter.get(SAVE_KEY))!)?.gold).toBe(4242);
  });

  it('falls back to defaults when both slots are corrupt or missing', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.set(SAVE_KEY, 'garbage');
    await adapter.set(SAVE_BACKUP_KEY, 'more garbage');
    expect(await new SaveStore(adapter).load()).toEqual(defaultSave());
    expect(await new SaveStore(new MemoryStorageAdapter()).load()).toEqual(defaultSave());
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/meta.test.ts`
Expected: FAIL — `does not provide an export named 'SaveStore'` (file-level load error).

**Step 3: Write minimal implementation**

Append to `src/services/save.ts` (and make sure `import type { StorageAdapter } from './storage.ts';` is at the top):

```ts
/**
 * Dual-slot persistence: every persist writes the primary slot first, then the
 * backup. A write interrupted between the two leaves the previous good save in
 * the backup, which load() falls back to (healing the primary) before giving
 * up and returning defaults. Adapter failures are logged, never thrown — a
 * failed save must not take the game down, and the next persist retries.
 */
export class SaveStore {
  constructor(private adapter: StorageAdapter) {}

  async load(): Promise<SaveData> {
    const primary = await this.readSlot(SAVE_KEY);
    if (primary) return primary;
    const backup = await this.readSlot(SAVE_BACKUP_KEY);
    if (backup) {
      await this.writeSlot(SAVE_KEY, backup);
      return backup;
    }
    return defaultSave();
  }

  async persist(data: SaveData): Promise<void> {
    await this.writeSlot(SAVE_KEY, data);
    await this.writeSlot(SAVE_BACKUP_KEY, data);
  }

  private async readSlot(key: string): Promise<SaveData | null> {
    try {
      const raw = await this.adapter.get(key);
      return raw === null ? null : decodeSave(raw);
    } catch (error) {
      console.error('[save] read failed:', error);
      return null;
    }
  }

  private async writeSlot(key: string, data: SaveData): Promise<void> {
    try {
      await this.adapter.set(key, encodeSave(data));
    } catch (error) {
      console.error('[save] write failed:', error);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (9 tests).

**Step 5: Commit**

```bash
git add src/services/save.ts src/services/meta.test.ts
git commit -m "feat: dual-slot save store with backup recovery"
```

---

### Task 5: MetaService — wallet, bankRun, flush

**Files:**
- Create: `src/services/meta.ts`
- Test: `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Add the import to `src/services/meta.test.ts`:

```ts
import { MetaService } from './meta.ts';
```

Append:

```ts
describe('meta service — wallet', () => {
  it('banks run gold and persists it for the next boot', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = new MetaService(adapter);
    await meta.load();
    expect(meta.gold).toBe(0);
    expect(meta.bankRun(320, 1)).toBe(320);
    expect(meta.bankRun(180, 2)).toBe(500);
    await meta.flush();
    const rebooted = new MetaService(adapter);
    await rebooted.load();
    expect(rebooted.gold).toBe(500);
  });

  it('ignores non-positive bank amounts and floors fractional gold', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(100, 1);
    expect(meta.bankRun(0, 2)).toBe(100);
    expect(meta.bankRun(-50, 3)).toBe(100);
    expect(meta.bankRun(12.9, 4)).toBe(112);
  });

  it('banks each run token exactly once', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.bankRun(300, 1)).toBe(300);
    // Same token again (a double-invoked end-of-run path) banks nothing.
    expect(meta.bankRun(300, 1)).toBe(300);
    expect(meta.bankRun(100, 2)).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/meta.test.ts`
Expected: FAIL — `Failed to resolve import "./meta.ts"`.

**Step 3: Write minimal implementation**

Create `src/services/meta.ts`:

```ts
import { SaveStore, defaultSave } from './save.ts';
import type { SaveData } from './save.ts';
import type { StorageAdapter } from './storage.ts';

/**
 * The persistent wallet and Sanctum progression, wrapped around one SaveData.
 *
 * All mutation goes through methods that persist fire-and-forget: UI code
 * never blocks a frame on storage, and a failed write costs at most the delta
 * since the previous successful one. State is replaced, never mutated, so a
 * half-applied purchase can't be persisted. The engine never imports this
 * module — main.ts, game.ts and the screens are the only callers.
 */
export class MetaService {
  private store: SaveStore;
  private data: SaveData = defaultSave();
  /** Last banked run token — bankRun's exactly-once guard (session-scoped, never persisted). */
  private lastBankedToken = 0;
  /** Serialized write chain; flush() awaits it (tests + future lifecycle hooks). */
  private pending: Promise<void> = Promise.resolve();

  constructor(adapter: StorageAdapter) {
    this.store = new SaveStore(adapter);
  }

  /** The second async boot step (after SpriteTable.load) — call before openTitle. */
  async load(): Promise<void> {
    this.data = await this.store.load();
  }

  get gold(): number {
    return this.data.gold;
  }

  /**
   * Banks a finished run's gold exactly once per run token: Game passes a
   * counter incremented in startRun, and a token that has already banked is
   * ignored. This is the headless-testable half of the "banks exactly once"
   * invariant — the browser-bound endRun double-invocation paths (death on
   * the victory-crossing tick; a second death after the die+level-up
   * same-tick resume) cannot bank twice even if Game's own guard is ever
   * refactored away. Returns the wallet total.
   */
  bankRun(runGold: number, runToken: number): number {
    if (runToken === this.lastBankedToken) return this.data.gold;
    this.lastBankedToken = runToken;
    const amount = Math.max(0, Math.floor(runGold));
    if (amount > 0) {
      this.data = { ...this.data, gold: this.data.gold + amount };
      this.persist();
    }
    return this.data.gold;
  }

  /** Awaits any in-flight writes. Tests and lifecycle hooks only — never per frame. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private persist(): void {
    // Chained, not raced: writes land in call order even on a slow adapter.
    this.pending = this.pending.then(() => this.store.persist(this.data));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (12 tests).

**Step 5: Commit**

```bash
git add src/services/meta.ts src/services/meta.test.ts
git commit -m "feat: meta service wallet with fire-and-forget persistence"
```

---

### Task 6: MetaService — buyNode, rankOf, computeMetaMods

**Files:**
- Modify: `src/services/meta.ts`
- Test: `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Append to `src/services/meta.test.ts`:

```ts
describe('meta service — sanctum', () => {
  it('buys ranks at exact costs and rejects when poor or maxed', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(760, 1); // magnetism costs 80/200/500
    expect(meta.buyNode('magnetism')).toBe(true);  // -80  → 680
    expect(meta.buyNode('magnetism')).toBe(true);  // -200 → 480
    expect(meta.buyNode('magnetism')).toBe(false); // rank 3 costs 500 > 480
    expect(meta.gold).toBe(480);
    expect(meta.rankOf('magnetism')).toBe(2);
    meta.bankRun(20, 2);
    expect(meta.buyNode('magnetism')).toBe(true);  // -500 → 0
    expect(meta.buyNode('magnetism')).toBe(false); // maxed
    expect(meta.rankOf('magnetism')).toBe(3);
    expect(meta.gold).toBe(0);
  });

  it('rejects unknown nodes without touching the wallet', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(1000, 1);
    expect(meta.buyNode('nonsense')).toBe(false);
    expect(meta.gold).toBe(1000);
  });

  it('sums owned ranks into meta mods including revives', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(20000, 1);
    meta.buyNode('bloodthirst');
    meta.buyNode('bloodthirst'); // might 0.05 × 2
    meta.buyNode('haste');       // cooldown -0.025
    meta.buyNode('second_wind'); // revives 1
    expect(meta.computeMetaMods()).toEqual({ might: 0.1, cooldown: -0.025, revives: 1 });
  });

  it('returns an empty mods bag for a fresh save', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.computeMetaMods()).toEqual({});
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "meta service — sanctum"`
Expected: FAIL — `meta.buyNode is not a function` (4 failures).

**Step 3: Write minimal implementation**

In `src/services/meta.ts`, add imports at the top:

```ts
import { META_LIST, metaNodeDef } from '../gameplay/content.ts';
import type { MetaMods } from '../gameplay/content.ts';
```

Append inside the `MetaService` class (after `bankRun`):

```ts
  rankOf(nodeId: string): number {
    return this.data.sanctum[nodeId] ?? 0;
  }

  /** Buys the next rank of a node. False = unknown node, maxed out, or too poor. */
  buyNode(nodeId: string): boolean {
    const def = metaNodeDef(nodeId);
    if (!def) return false;
    const rank = this.rankOf(nodeId);
    if (rank >= def.maxRank) return false;
    const cost = def.costs[rank]!;
    if (this.data.gold < cost) return false;
    this.data = {
      ...this.data,
      gold: this.data.gold - cost,
      sanctum: { ...this.data.sanctum, [nodeId]: rank + 1 },
    };
    this.persist();
    return true;
  }

  /** Sums every owned rank into the mods bag the Run constructor consumes. */
  computeMetaMods(): MetaMods {
    const mods: MetaMods = {};
    for (const node of META_LIST) {
      const rank = this.rankOf(node.id);
      if (rank <= 0) continue;
      for (const [key, perRank] of Object.entries(node.perRank)) {
        if (perRank === undefined) continue;
        const k = key as keyof MetaMods;
        mods[k] = (mods[k] ?? 0) + perRank * rank;
      }
    }
    return mods;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (16 tests).

**Step 5: Commit**

```bash
git add src/services/meta.ts src/services/meta.test.ts
git commit -m "feat: sanctum node purchases and computeMetaMods summation"
```

---

### Task 7: engine-isolation gate

Services exist now, so the boundary becomes enforceable: no file under `src/core`,
`src/ecs`, `src/gameplay`, `src/render` may import from `src/services`. The gate uses
`import.meta.glob` raw imports (Vite inlines every engine source as a string at
transform time), so it runs headless with zero node-API or `@types/node` dependency.

**Files:**
- Create: `src/services/isolation.test.ts`

**Step 1: Write the gate**

Create `src/services/isolation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

// Vite inlines every engine source as a raw string at transform time — no
// node:fs, so the gate runs in the same environment as every other test.
const engineSources = import.meta.glob(
  ['../core/**/*.ts', '../ecs/**/*.ts', '../gameplay/**/*.ts', '../render/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('engine isolation', () => {
  it('actually covers the four engine directories', () => {
    const files = Object.keys(engineSources);
    for (const dir of ['/core/', '/ecs/', '/gameplay/', '/render/']) {
      expect(files.some((f) => f.includes(dir)), `no files globbed under ${dir}`).toBe(true);
    }
  });

  it('never lets engine code import src/services', () => {
    const offenders = Object.entries(engineSources)
      .filter(([, source]) => /from\s+['"][^'"]*\/services\//.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
```

**Step 2: Prove the gate trips (deliberate RED)**

Temporarily add to the top of `src/gameplay/collision.ts`:

```ts
import type { StorageAdapter } from '../services/storage.ts';
```

Run: `npx vitest run src/services/isolation.test.ts`
Expected: FAIL — the offenders array contains `../gameplay/collision.ts`.
**Revert the temporary import immediately.**

**Step 3: Run tests to verify they pass**

Run: `npx vitest run src/services/isolation.test.ts`
Expected: PASS (2 tests). Also `npm run typecheck` — clean (the glob types come from `vite/client`).

**Step 4: Commit**

```bash
git add src/services/isolation.test.ts
git commit -m "test: engine-isolation gate - no services imports in engine code"
```

---

### Task 8: Run gains metaMods — seeded recomputeStats + revives

**Files:**
- Modify: `src/gameplay/run.ts` (type import line 3; new field after `revivesLeft` ~line 86; constructor ~line 119; `recomputeStats()` ~line 199)
- Test: `src/gameplay/simulation.test.ts` (inside `describe('meta progression')`)

**Step 1: Write the failing tests**

Append inside the `meta progression` describe block:

```ts
  it('seeds recomputeStats from metaMods with the existing clamps intact', () => {
    const run = new Run('wanderer', { might: 0.15, armor: 2, maxHpMul: 0.2 });
    expect(run.stats.might).toBeCloseTo(1.25); // 1.1 base + 0.15 meta
    expect(run.stats.armor).toBe(2);
    expect(run.stats.maxHp).toBe(120); // round(100 * 1.2)
    // The MIN_COOLDOWN_MUL floor holds against absurd meta stacking.
    expect(new Run('wanderer', { cooldown: -10 }).stats.cooldown).toBe(0.35);
  });

  it('keeps meta mods applied when passives recompute stats', () => {
    const run = new Run('wanderer', { might: 0.15 });
    run.addPassive('bloodthirst');
    expect(run.stats.might).toBeCloseTo(1.25);    // meta survived the recompute
    expect(run.stats.bloodGain).toBeCloseTo(1.1); // passive applied on top
  });

  it('grants extra revives from meta without touching derived stats', () => {
    const run = new Run('wanderer', { revives: 1 });
    expect(run.revivesLeft).toBe(1);   // wanderer base is 0
    expect(run.stats.revives).toBe(0); // stats keep the base value
  });

  it('defaults to no meta mods — Run(id) is identical to Run(id, {})', () => {
    const plain = new Run('wanderer');
    const empty = new Run('wanderer', {});
    expect(empty.stats).toEqual(plain.stats);
    expect(empty.revivesLeft).toBe(plain.revivesLeft);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "meta progression"`
Expected: 3 FAIL (`expected 1.1 to be close to 1.25`, `expected 0 to be 1`, …) and the
`defaults to no meta mods` test already PASSES — it is the regression tripwire that pins
the "all 76 existing tests stay green unchanged" guarantee, not a RED test.

**Step 3: Write minimal implementation**

`src/gameplay/run.ts`:

1. Extend the type import (line 3):
   ```ts
   import type { AbilityDef, BaseStats, CharacterDef, MetaMods, PassiveDef, StatMods, WeaponDef } from './content.ts';
   ```
2. Add a field after `revivesLeft: number;` (~line 86):
   ```ts
     /**
      * Persistent Sanctum bonuses for this run, immutable once constructed.
      * recomputeStats() folds them into its accumulator as the first source,
      * so every existing clamp treats meta exactly like passives. `revives`
      * is handled separately in the constructor (revivesLeft, not stats).
      */
     private readonly metaMods: MetaMods;
   ```
3. Replace the constructor's opening lines (~119–123):
   ```ts
     constructor(characterId: string, metaMods: MetaMods = {}) {
       this.character = characterDef(characterId);
       this.metaMods = metaMods;
       this.stats = { ...this.character.stats };
       this.xpNeeded = xpForLevel(1);
       this.revivesLeft =
         this.character.stats.revives + Math.max(0, Math.floor(this.metaMods.revives ?? 0));
   ```
   (the rest of the constructor is unchanged).
4. In `recomputeStats()`, insert immediately after the closing `};` of the
   `const sum: StatMods = { … }` literal (~line 219), before the passives loop:
   ```ts
       // First source: persistent Sanctum mods. Seeding the accumulator rather
       // than adding a separate pass means the clamps below (MIN_COOLDOWN_MUL,
       // the area/duration floors, the crit clamp) apply to meta bonuses
       // identically to passives and ability buffs.
       for (const [key, value] of Object.entries(this.metaMods)) {
         if (value === undefined || key === 'revives') continue;
         sum[key as keyof StatMods] += value;
       }
   ```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "meta progression"`
Expected: PASS (7 tests in the block).
Then run the FULL suite once: `npx vitest run src/gameplay/simulation.test.ts` — every
pre-existing test must pass untouched (allow ~3 minutes for the long runs). This is the
"default `{}` keeps all 76 existing tests byte-identical" exit criterion.

**Step 5: Commit**

```bash
git add src/gameplay/run.ts src/gameplay/simulation.test.ts
git commit -m "feat: seed Run stats from persistent meta mods"
```

---

### Task 9: harness metaMods + greed determinism + full-run gold band

**Files:**
- Modify: `src/gameplay/simulation.test.ts` (type import ~line 40; `makeHarness` ~line 128; new test in `meta progression`; two assertions appended to the existing bastion full-run test)

**Step 1: Extend makeHarness**

Add a separate type import after the content import block (`verbatimModuleSyntax` forbids mixing it into the value import):

```ts
import type { MetaMods } from './content.ts';
```

Change the `makeHarness` signature and Run construction (~lines 128–130):

```ts
function makeHarness(characterId = CHARACTER_LIST[0]!.id, seed = 12345, metaMods: MetaMods = {}): Harness {
  const world = new World();
  const run = new Run(characterId, metaMods);
```

**Step 2: Write the failing greed test**

Append inside the `meta progression` describe block:

```ts
  it('applies meta greed to banked run gold deterministically', () => {
    const goldAfter = (mods: MetaMods): number => {
      const harness = makeHarness('wanderer', 4141, mods);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(120);
      return ctx.run.gold;
    };
    const base = goldAfter({});
    const greedy = goldAfter({ greed: 1 });
    expect(base).toBeGreaterThan(0);
    expect(greedy).toBeGreaterThan(base);
    // Same seed + same mods ⇒ same wallet: greed multiplies payouts without
    // perturbing the sim, so any drift here is a determinism leak.
    expect(goldAfter({ greed: 1 })).toBe(greedy);
  });
```

Run: `npx vitest run -t "meta greed"`
Expected: PASS immediately if Task 8 landed correctly (greed flows through the existing
`gainGold` greed multiplier). If `base` is 0, no coins dropped in 120s — raise the run
to 180s rather than weakening the assertions. A FAIL on the last line is a determinism
leak — stop and investigate, do not retry.

**Step 3: Calibrate the full-run gold band**

In the existing `it('does not leak entities over a full bastion run with sieges', …)`
test (castle defense block), insert after the final line
(`expect(ctx.run.structuresLost + aliveStructures).toBe(2);`), still inside the test:

```ts
    // Phase 4 balance tripwire: a full run must bank a wallet big enough to
    // make Sanctum progress without trivializing the 35k tree. Calibration
    // sentinel — replaced with the real band in the next step:
    expect(ctx.run.gold).toBe(-1);
```

Run: `npx vitest run -t "does not leak entities over a full bastion run"`
Expected: FAIL with `expected N to be -1` — note the observed N (deterministic: seed 4242).

Replace the sentinel with the band, substituting the observed value (example shown for
N = 3000 — use the real number, half to double, rounded to friendly figures):

```ts
    // Phase 4 balance tripwire: a full seeded run banked ~N gold when this
    // band was calibrated. Half-to-double catches order-of-magnitude economy
    // regressions without pinning every balance tweak.
    expect(ctx.run.gold).toBeGreaterThan(1500);
    expect(ctx.run.gold).toBeLessThan(6000);
```

Run: `npx vitest run -t "does not leak entities over a full bastion run"`
Expected: PASS (allow ~2 minutes).

**Step 4: Full suite + commit**

Run: `npx vitest run src/gameplay/simulation.test.ts` — all green.

```bash
git add src/gameplay/simulation.test.ts
git commit -m "test: meta greed determinism and full-run gold band"
```

---

### Task 10: run:ended + meta events, gold banking wire, boot load

This task is UI/orchestration wiring (game.ts, main.ts are browser-bound — CLAUDE.md:
verify with `npm run dev`). Gates: `tsc`, the suite staying green, and the manual
checklist. "Exactly once" has two layers: the headless-tested seam is
`bankRun(runGold, runToken)` ignoring an already-banked token (Task 5's bank-token
test pins it), with `runToken` a counter incremented in `startRun`; browser-side,
`endRun`'s `runEnded` flag keeps the `run:ended`/`meta:goldBanked` emits single-shot.
Both double-invocation paths are real in the current sources: `player:died` is
emitted mid-tick (damage.ts) while `tick()` still runs the end-of-tick victory
check, so dying on the victory-crossing tick calls `endRun(false)` then
`endRun(true)`; and the pre-existing die+pendingLevelUps same-tick path (tick's
`openLevelUp` runs after the died handler, resuming `state='playing'` with a 0-hp
player) allows a later second `endRun(false)`.

**Files:**
- Modify: `src/core/events.ts` (GameEvents interface, after `'siege:defended'` line 51)
- Modify: `src/game.ts` (imports; constructor signature; new field; `wireEvents` died-handler; `declareVictory`; new `endRun`; `startRun`)
- Modify: `src/main.ts` (imports; boot sequence)

**Step 1: Add the events**

In `src/core/events.ts`, append inside `GameEvents` after the `'siege:defended'` line:

```ts
  'run:ended': { victory: boolean; survivedSeconds: number; kills: number; gold: number; level: number };
  'meta:goldBanked': { banked: number; total: number };
  'meta:purchased': { nodeId: string; rank: number };
  'character:unlocked': { id: string };
```

**Step 2: Wire the Game**

`src/game.ts`:

1. Add a type import after the ui imports (line 32):
   ```ts
   import type { MetaService } from './services/meta.ts';
   ```
2. Extend the constructor signature (~line 71):
   ```ts
     constructor(
       canvas: HTMLCanvasElement,
       uiRoot: HTMLElement,
       private sprites: SpriteTable,
       private meta: MetaService,
     ) {
   ```
3. Add two fields next to `siegeUntil` (~line 66):
   ```ts
     /** True once this run's summary events have fired — endRun's exactly-once guard. */
     private runEnded = false;
     /** Monotonic per-run token passed to bankRun — the service ignores repeats. */
     private runToken = 0;
   ```
4. Replace the whole `player:died` handler in `wireEvents` (lines 133–143) with:
   ```ts
       this.bus.on('player:died', () => {
         this.endRun(false);
       });
   ```
5. Replace `declareVictory` (lines 268–279) with:
   ```ts
     private declareVictory(): void {
       this.bus.emit('run:victory', { survivedSeconds: this.run.time, kills: this.run.kills });
       this.endRun(true);
     }
   ```
6. Add `endRun` after `declareVictory`:
   ```ts
     /**
      * The single funnel for both end-of-run paths (death and victory): emit
      * the summary event, bank gold into the persistent wallet exactly once,
      * then show the results screen. Persistence is fire-and-forget inside the
      * service — nothing here waits on storage.
      */
     private endRun(victory: boolean): void {
       this.state = 'results';
       this.hud.setVisible(false);
       // endRun can legitimately fire twice per run (death on the
       // victory-crossing tick; a second death after the die+level-up
       // same-tick resume), so the summary emits and the banking share one
       // exactly-once guard — a 'run:ended' listener must never see two
       // conflicting summaries for the same run. bankRun's token dedup is
       // the headless-tested belt to this browser-side brace. The state
       // transition and showResults stay unconditional so the final screen
       // always reflects the last transition.
       if (!this.runEnded) {
         this.runEnded = true;
         this.bus.emit('run:ended', {
           victory,
           survivedSeconds: this.run.time,
           kills: this.run.kills,
           gold: this.run.gold,
           level: this.run.level,
         });
         const total = this.meta.bankRun(this.run.gold, this.runToken);
         this.bus.emit('meta:goldBanked', { banked: this.run.gold, total });
       }
       this.screens.showResults(
         { victory, run: this.run },
         {
           onRetry: () => void this.startRun(this.lastCharacterId, this.lastMapId),
           onTitle: () => this.openTitle(),
         },
       );
     }
   ```
7. In `startRun`, replace `this.run = new Run(characterId);` (~line 204) with:
   ```ts
       this.run = new Run(characterId, this.meta.computeMetaMods());
   ```
   and next to `this.siegeUntil = 0;` (~line 226) add:
   ```ts
       this.runEnded = false;
       this.runToken++;
   ```

**Step 3: Boot sequence**

`src/main.ts` — add imports after line 3:

```ts
import { MetaService } from './services/meta.ts';
import { LocalStorageAdapter } from './services/storage.ts';
```

In `boot()`, replace the two lines `const sprites = …; const game = …;` with:

```ts
  const sprites = await SpriteTable.load();
  // Second async boot step: the wallet and sanctum ranks must exist before the
  // title screen renders and before the first Run is constructed.
  const meta = new MetaService(new LocalStorageAdapter());
  await meta.load();
  const game = new Game(canvas, uiRoot, sprites, meta);
```

**Step 4: Verify types and suite**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/services/`
Expected: PASS (18 tests) — the isolation gate confirms game.ts/main.ts are the only new importers.

**Step 5: Manual dev-server check**

Run: `npm run dev`, open http://localhost:5173:
- [ ] Start a run, collect some gold, die (or quit via pause → results is NOT a death — die properly)
- [ ] DevTools → Application → Local Storage: `vk-save` and `vk-save.bak` both present
- [ ] Console: `JSON.parse(JSON.parse(localStorage['vk-save']).payload).gold` equals the run's gold
- [ ] Die again on a second run — the stored gold accumulates (banked once per run, not per frame)
- [ ] Hard refresh — the value survives

**Step 6: Commit**

```bash
git add src/core/events.ts src/game.ts src/main.ts
git commit -m "feat: bank run gold into the persistent wallet at run end"
```

---

### Task 11: character unlock costs in content

**Files:**
- Modify: `src/gameplay/content.ts` (`CharacterDef` ~line 679; `normalizeCharacters` ~line 691)
- Modify: `src/content/characters.json` (four entries)
- Test: `src/gameplay/simulation.test.ts` (inside `meta progression`; add `characterDef` to the content value import)

**Step 1: Write the failing test**

Add `characterDef` to the content import block, then append inside `meta progression`:

```ts
  it('parses unlock costs, defaults to free, and keeps the first character free', () => {
    expect(characterDef('wanderer').unlock).toBeNull();
    expect(characterDef('acolyte').unlock).toEqual({ gold: 2500 });
    expect(characterDef('outrider').unlock).toEqual({ gold: 4000 });
    expect(characterDef('warden_knight').unlock).toEqual({ gold: 6000 });
    expect(characterDef('dragos').unlock).toEqual({ gold: 12000 });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "parses unlock costs"`
Expected: FAIL with `expected undefined to be null` (the `unlock` property does not exist).

**Step 3: Write minimal implementation**

`src/gameplay/content.ts`, `CharacterDef` — after `stats: BaseStats;` add:

```ts
  /** Gold price to unlock in the Sanctum era, or null when the character is free. */
  unlock: { gold: number } | null;
```

In `normalizeCharacters`, before the `entry: CharacterDef` literal add:

```ts
    const unlockRaw = def['unlock'];
    let unlock: { gold: number } | null = null;
    if (unlockRaw !== undefined) {
      const goldCost =
        typeof unlockRaw === 'object' && unlockRaw !== null
          ? (unlockRaw as Record<string, unknown>)['gold']
          : undefined;
      if (typeof goldCost === 'number' && Number.isFinite(goldCost) && goldCost > 0) {
        unlock = { gold: Math.round(goldCost) };
      } else {
        console.warn(`[content] character "${id}" has an invalid unlock block; treating as unlocked`);
      }
    }
```

and add `unlock,` to the `entry: CharacterDef` literal (after `stats,`).

After the character loop, before the `if (list.length === 0)` throw, enforce the
first-character-free rule:

```ts
  // The first character is the guaranteed free entry point — a paywalled
  // roster slot 0 would soft-lock a fresh save.
  if (list[0] && list[0].unlock) {
    console.warn(`[content] first character "${list[0].id}" must stay free; ignoring its unlock block`);
    const freed = { ...list[0], unlock: null };
    list[0] = freed;
    byId.set(freed.id, freed);
  }
```

`src/content/characters.json` — add after the `"startingWeapon"` line of each entry
(wanderer stays free — no block):

- acolyte: `"unlock": { "gold": 2500 },`
- warden_knight: `"unlock": { "gold": 6000 },`
- outrider: `"unlock": { "gold": 4000 },`
- dragos: `"unlock": { "gold": 12000 },`

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "parses unlock costs"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/content/characters.json src/gameplay/simulation.test.ts
git commit -m "feat: optional character unlock costs in characters.json"
```

---

### Task 12: MetaService — character unlock purchases

**Files:**
- Modify: `src/services/meta.ts`
- Test: `src/services/meta.test.ts`

**Step 1: Write the failing tests**

Add a value import to `src/services/meta.test.ts`:

```ts
import { characterDef } from '../gameplay/content.ts';
```

Append:

```ts
describe('meta service — character unlocks', () => {
  it('treats free characters as always unlocked', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.isUnlocked(characterDef('wanderer'))).toBe(true);
    expect(meta.isUnlocked(characterDef('acolyte'))).toBe(false);
    // Unlocking a free character is a no-op, not a purchase.
    expect(meta.unlockCharacter(characterDef('wanderer'))).toBe(false);
  });

  it('unlocks a character at the exact gold cost exactly once', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(3000, 1);
    const acolyte = characterDef('acolyte'); // costs 2500
    expect(meta.unlockCharacter(acolyte)).toBe(true);
    expect(meta.gold).toBe(500);
    expect(meta.isUnlocked(acolyte)).toBe(true);
    expect(meta.unlockCharacter(acolyte)).toBe(false); // no double-charge
    expect(meta.gold).toBe(500);
    expect(meta.unlockCharacter(characterDef('dragos'))).toBe(false); // 12000 > 500
  });

  it('persists unlocks across a reload', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = new MetaService(adapter);
    await meta.load();
    meta.bankRun(2500, 1);
    meta.unlockCharacter(characterDef('acolyte'));
    await meta.flush();
    const rebooted = new MetaService(adapter);
    await rebooted.load();
    expect(rebooted.isUnlocked(characterDef('acolyte'))).toBe(true);
    expect(rebooted.gold).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "character unlocks"`
Expected: FAIL — `meta.isUnlocked is not a function` (3 failures).

**Step 3: Write minimal implementation**

In `src/services/meta.ts`, extend the content type import:

```ts
import type { CharacterDef, MetaMods } from '../gameplay/content.ts';
```

Append inside `MetaService` (after `computeMetaMods`):

```ts
  isUnlocked(character: CharacterDef): boolean {
    return character.unlock === null || this.data.unlockedCharacters.includes(character.id);
  }

  /** Spends gold to unlock a character. False = free, already owned, or too poor. */
  unlockCharacter(character: CharacterDef): boolean {
    const cost = character.unlock?.gold;
    if (cost === undefined) return false;
    if (this.data.unlockedCharacters.includes(character.id)) return false;
    if (this.data.gold < cost) return false;
    this.data = {
      ...this.data,
      gold: this.data.gold - cost,
      unlockedCharacters: [...this.data.unlockedCharacters, character.id],
    };
    this.persist();
    return true;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/meta.test.ts`
Expected: PASS (19 tests).

**Step 5: Commit**

```bash
git add src/services/meta.ts src/services/meta.test.ts
git commit -m "feat: character unlock purchases on the meta service"
```

---

### Task 13: title screen — wallet, locked characters, Sanctum entry, results vault row

Browser-bound (CLAUDE.md: Screens have no headless coverage). Gates: `tsc`, suite
green, manual checklist. The map/character number-key indices must not shift, so the
SANCTUM button is appended **after** the character cards in the focusables order.

**Files:**
- Modify: `src/ui/screens.ts` (interfaces; `showTitle`/`renderTitle`; `ResultsData` + `showResults`; fields)
- Modify: `src/game.ts` (`openTitle`; `endRun` results data; content import)
- Modify: `src/ui/style.css` (append)

**Step 1: Screens interfaces and state**

In `src/ui/screens.ts`:

1. Replace the `TitleCallbacks` and `ResultsData` interfaces:
   ```ts
   export interface ResultsData {
     victory: boolean;
     run: Run;
     /** Persistent wallet total after this run banked its gold. */
     walletGold: number;
   }

   /** Read-only meta the title screen renders from; owned by MetaService. */
   export interface TitleMeta {
     gold: number;
     isUnlocked(character: CharacterDef): boolean;
   }

   export interface TitleCallbacks {
     onStart: (characterId: string, mapId: string) => void;
     onUnlock: (characterId: string) => void;
     onSanctum: () => void;
   }
   ```
2. Add a field next to `titleCallbacks` (~line 63):
   ```ts
     private titleMeta: TitleMeta | null = null;
   ```
3. Replace `showTitle`:
   ```ts
     showTitle(characters: readonly CharacterDef[], meta: TitleMeta, callbacks: TitleCallbacks): void {
       this.characters = characters;
       this.titleMeta = meta;
       this.titleCallbacks = callbacks;
       this.renderTitle();
     }
   ```

**Step 2: renderTitle**

Replace `renderTitle()` wholesale:

```ts
  private renderTitle(): void {
    this.current = 'title';
    this.root.classList.add('visible');
    this.root.replaceChildren();

    this.root.appendChild(el('h1', undefined, 'SURVIVORS'));
    this.root.appendChild(
      el('p', undefined, 'Stay alive for fifteen minutes. Pick up whatever will keep you standing.'),
    );
    this.root.appendChild(el('div', 'wallet', `VAULT ${this.titleMeta?.gold ?? 0} GOLD`));

    const focusables: HTMLElement[] = [];

    // Arena picker.
    const mapPicker = el('div', 'picker');
    mapPicker.appendChild(el('div', 'picker-label', 'ARENA'));
    const mapRow = el('div', 'button-row');
    for (const mapId of this.maps) {
      const button = el('button', 'btn');
      button.type = 'button';
      button.textContent = mapId;
      if (mapId === this.selectedMap) button.classList.add('primary');
      mapRow.appendChild(button);
      focusables.push(button);
    }
    mapPicker.appendChild(mapRow);
    this.root.appendChild(mapPicker);

    // Character picker: locked cards render greyed with their price and route
    // to the unlock flow instead of starting a run.
    const charPicker = el('div', 'picker');
    charPicker.appendChild(el('div', 'picker-label', 'SURVIVOR'));
    const cards = el('div', 'cards');
    for (let i = 0; i < this.characters.length; i++) {
      const character = this.characters[i]!;
      const locked = !(this.titleMeta?.isUnlocked(character) ?? true);
      const card = el('button', 'card');
      card.type = 'button';
      if (locked) card.classList.add('locked');

      const head = el('div', 'card-head');
      head.appendChild(this.sprites.iconCanvas(character.sprite, 32));
      const titles = el('div');
      titles.appendChild(el('div', 'card-title', character.name));
      titles.appendChild(
        el(
          'div',
          'card-tag',
          locked
            ? `LOCKED — ${character.unlock!.gold} GOLD`
            : `HP ${character.stats.maxHp} · SPD ${Math.round(character.stats.moveSpeed)}`,
        ),
      );
      head.appendChild(titles);
      card.appendChild(head);

      card.appendChild(el('div', 'card-body', character.description));
      card.appendChild(el('div', 'card-key', String(this.maps.length + i + 1)));

      cards.appendChild(card);
      focusables.push(card);
    }
    charPicker.appendChild(cards);
    this.root.appendChild(charPicker);

    // Sanctum entry — appended after the pickers so the map/character
    // number-key indices stay stable.
    const metaRow = el('div', 'button-row');
    const sanctumBtn = el('button', 'btn', 'THE SANCTUM');
    sanctumBtn.type = 'button';
    metaRow.appendChild(sanctumBtn);
    this.root.appendChild(metaRow);
    focusables.push(sanctumBtn);

    this.root.appendChild(
      el('div', 'hint', 'WASD or arrows to move · ESC to pause · number keys or click to choose'),
    );

    const mapCount = this.maps.length;
    const charCount = this.characters.length;
    this.setChoices(focusables, (index) => {
      if (index < mapCount) {
        this.selectedMap = this.maps[index]!;
        // Re-render so the highlighted arena updates, keeping focus in place.
        const keep = index;
        this.renderTitle();
        this.setFocus(keep);
        return;
      }
      if (index < mapCount + charCount) {
        const character = this.characters[index - mapCount];
        if (!character) return;
        if (!(this.titleMeta?.isUnlocked(character) ?? true)) {
          this.titleCallbacks?.onUnlock(character.id);
          return;
        }
        this.titleCallbacks?.onStart(character.id, this.selectedMap);
        return;
      }
      this.titleCallbacks?.onSanctum();
    });
    // Default focus to the first character rather than the arena buttons, since
    // starting a run is what the player is here to do.
    this.setFocus(mapCount);
  }
```

In `showResults`, add after the `'Gold collected'` row:

```ts
    appendResult(summary, 'Sanctum vault', String(data.walletGold));
```

**Step 3: Game side**

`src/game.ts`:

1. Extend the content import (line 18):
   ```ts
   import { CHARACTER_LIST, characterDef, structureDef, waveTable } from './gameplay/content.ts';
   ```
2. Replace `openTitle`:
   ```ts
     private openTitle(): void {
       this.state = 'title';
       this.hud.setVisible(false);
       this.screens.showTitle(
         CHARACTER_LIST,
         { gold: this.meta.gold, isUnlocked: (c) => this.meta.isUnlocked(c) },
         {
           onStart: (characterId, mapId) => void this.startRun(characterId, mapId),
           onUnlock: (characterId) => {
             const def = characterDef(characterId);
             if (this.meta.unlockCharacter(def)) {
               this.bus.emit('character:unlocked', { id: characterId });
             }
             // Re-render either way: success shows the unlocked card and the
             // smaller wallet; failure re-renders unchanged (priced card is
             // its own "not enough gold" message at v1).
             this.openTitle();
           },
           onSanctum: () => this.openSanctum(),
         },
       );
     }
   ```
   (`openSanctum` does not exist yet — add a placeholder so `tsc` stays green until Task 14:)
   ```ts
     private openSanctum(): void {
       // Replaced with the real Sanctum screen in the next task.
     }
   ```
3. In `endRun`, replace the `showResults` call's data argument with
   `{ victory, run: this.run, walletGold: walletTotal }` — restructure the guarded
   block so the total is always available (the emits stay inside the exactly-once
   guard; only `walletTotal` and `showResults` are unconditional):
   ```ts
       let walletTotal = this.meta.gold;
       if (!this.runEnded) {
         this.runEnded = true;
         this.bus.emit('run:ended', {
           victory,
           survivedSeconds: this.run.time,
           kills: this.run.kills,
           gold: this.run.gold,
           level: this.run.level,
         });
         walletTotal = this.meta.bankRun(this.run.gold, this.runToken);
         this.bus.emit('meta:goldBanked', { banked: this.run.gold, total: walletTotal });
       }
       this.screens.showResults(
         { victory, run: this.run, walletGold: walletTotal },
         {
           onRetry: () => void this.startRun(this.lastCharacterId, this.lastMapId),
           onTitle: () => this.openTitle(),
         },
       );
   ```

**Step 4: CSS**

Append to `src/ui/style.css`:

```css
/* --- Meta progression: wallet + locked characters ----------------------- */

.wallet {
  color: #e8c56a;
  font-size: calc(var(--u) * 5);
  letter-spacing: calc(var(--u) * 0.5);
  margin-bottom: calc(var(--u) * 2);
}

.card.locked {
  opacity: 0.55;
  filter: grayscale(0.8);
}

.card.locked .card-tag {
  color: #e8c56a;
}
```

**Step 5: Verify types and suite**

Run: `npm run typecheck` — clean.
Run: `npx vitest run src/services/` — PASS (isolation gate still green; `ui/` may import services-adjacent types freely, engine may not).

**Step 6: Manual dev-server check**

Run: `npm run dev`:
- [ ] Title shows `VAULT n GOLD` matching the banked total from Task 10's runs
- [ ] Locked characters greyed with `LOCKED — n GOLD`; free wanderer starts a run normally
- [ ] Clicking a locked card with enough vault gold unlocks it (card un-greys, wallet drops); refresh — still unlocked
- [ ] Clicking a locked card without enough gold does nothing visible (card stays priced)
- [ ] THE SANCTUM button focusable via arrows (does nothing yet — placeholder)
- [ ] Results screen shows the `Sanctum vault` row with the post-bank total
- [ ] Number keys still select the same maps/characters as before this task

**Step 7: Commit**

```bash
git add src/ui/screens.ts src/game.ts src/ui/style.css
git commit -m "feat: title screen wallet, locked characters and sanctum entry"
```

---

### Task 14: Sanctum screen — node grid, rank pips, buy flow

Browser-bound. Gates: `tsc`, suite green, manual checklist. The screen re-renders after
every buy, passing the bought node's index back in so gamepad focus doesn't jump to 0.

**Files:**
- Modify: `src/ui/screens.ts` (`ScreenName`; content import; `SanctumMeta`/`SanctumCallbacks`; `showSanctum`)
- Modify: `src/game.ts` (`State` union; real `openSanctum`; ESC handling; META_LIST import)
- Modify: `src/ui/style.css` (append)

**Step 1: Screens**

In `src/ui/screens.ts`:

1. Extend the screen union (line 8):
   ```ts
   export type ScreenName = 'none' | 'title' | 'levelup' | 'pause' | 'results' | 'sanctum';
   ```
2. Add a value import (content):
   ```ts
   import { META_LIST } from '../gameplay/content.ts';
   ```
   (keep the existing `import type { CharacterDef } …` line separate — `verbatimModuleSyntax`).
3. Add interfaces near the other callback interfaces:
   ```ts
   /** Read-only meta the sanctum renders from; owned by MetaService. */
   export interface SanctumMeta {
     gold: number;
     rankOf(nodeId: string): number;
   }

   export interface SanctumCallbacks {
     onBuy: (nodeId: string) => void;
     onBack: () => void;
   }
   ```
4. Add `showSanctum` after `showResults`:
   ```ts
     // --- sanctum ------------------------------------------------------------

     showSanctum(meta: SanctumMeta, callbacks: SanctumCallbacks, focus = 0): void {
       this.current = 'sanctum';
       this.root.classList.add('visible');
       this.root.replaceChildren();

       this.root.appendChild(el('h2', undefined, 'THE SANCTUM'));
       this.root.appendChild(
         el('p', undefined, 'Gold spent between nights stays spent. These vows persist.'),
       );
       this.root.appendChild(el('div', 'wallet', `VAULT ${meta.gold} GOLD`));

       const cards = el('div', 'cards sanctum-cards');
       const focusables: HTMLElement[] = [];

       for (const node of META_LIST) {
         const rank = meta.rankOf(node.id);
         const maxed = rank >= node.maxRank;
         const cost = maxed ? null : node.costs[rank]!;

         const card = el('button', 'card');
         card.type = 'button';
         if (maxed) card.classList.add('maxed');
         else if (cost !== null && cost > meta.gold) card.classList.add('poor');

         const head = el('div', 'card-head');
         const titles = el('div');
         titles.appendChild(el('div', 'card-title', node.name));
         titles.appendChild(el('div', 'card-tag', maxed ? 'MAX' : `RANK ${rank}/${node.maxRank}`));
         head.appendChild(titles);
         card.appendChild(head);

         card.appendChild(el('div', 'card-body', node.description));

         const pips = el('div', 'card-pips');
         for (let p = 0; p < node.maxRank; p++) {
           pips.appendChild(el('span', p < rank ? 'pip on' : 'pip'));
         }
         card.appendChild(pips);

         card.appendChild(el('div', 'card-cost', maxed ? 'COMPLETE' : `${cost} GOLD`));

         cards.appendChild(card);
         focusables.push(card);
       }
       this.root.appendChild(cards);

       const row = el('div', 'button-row');
       const back = el('button', 'btn primary', 'Back to title');
       back.type = 'button';
       row.appendChild(back);
       this.root.appendChild(row);
       focusables.push(back);

       this.root.appendChild(el('div', 'hint', 'Arrows to move · Enter to buy · ESC to leave'));

       this.setChoices(focusables, (index) => {
         if (index < META_LIST.length) {
           // A failed buy (too poor / maxed) re-renders unchanged — the dimmed
           // cost is its own feedback at v1.
           callbacks.onBuy(META_LIST[index]!.id);
           return;
         }
         callbacks.onBack();
       });
       this.setFocus(focus);
     }
   ```

**Step 2: Game**

`src/game.ts`:

1. Extend the state union (line 34):
   ```ts
   type State = 'title' | 'loading' | 'playing' | 'levelup' | 'paused' | 'results' | 'sanctum';
   ```
2. Extend the content import with `META_LIST`.
3. Replace the Task 13 placeholder `openSanctum` with:
   ```ts
     private openSanctum(focus = 0): void {
       this.state = 'sanctum';
       this.hud.setVisible(false);
       this.screens.showSanctum(
         { gold: this.meta.gold, rankOf: (id) => this.meta.rankOf(id) },
         {
           onBuy: (nodeId) => {
             if (this.meta.buyNode(nodeId)) {
               this.bus.emit('meta:purchased', { nodeId, rank: this.meta.rankOf(nodeId) });
             }
             // Re-render with the new wallet/ranks, keeping focus on the node.
             this.openSanctum(META_LIST.findIndex((n) => n.id === nodeId));
           },
           onBack: () => this.openTitle(),
         },
         focus,
       );
     }
   ```
4. In `beforeFrame`, inside the `if (this.screens.isOpen)` block, add a sanctum escape
   next to the pause escape (before `this.screens.handleInput(this.input);`):
   ```ts
       if (this.state === 'sanctum' && this.input.wasPressed('Escape')) {
         this.openTitle();
         return;
       }
   ```
5. Extend `render()`'s early-return (the `'title' || 'loading' || !this.map` check,
   ~line 397) to include the new state:
   ```ts
       if (this.state === 'title' || this.state === 'loading' || this.state === 'sanctum' || !this.map) {
   ```
   After any completed run `this.map` is still non-null, so without this the Sanctum
   opened from the title renders the previous run's frozen battlefield (stale
   entities, player corpse) through the translucent `.screen` overlay — and keeps
   `hud.update` running (the guard further down only excludes `'results'`). The
   early-return gives the Sanctum the same flat wash as the title and skips the HUD.

**Step 3: CSS**

Append to `src/ui/style.css`:

```css
/* --- The Sanctum -------------------------------------------------------- */

.sanctum-cards {
  flex-wrap: wrap;
  justify-content: center;
  max-width: calc(var(--u) * 320);
}

.card-cost {
  color: #e8c56a;
  font-size: calc(var(--u) * 4);
}

.card.maxed .card-cost {
  color: var(--ink-faint);
}

.card.poor .card-cost {
  color: #a33a44;
}
```

(If `.cards` is a grid rather than flex in the existing stylesheet, drop the two
flex lines and set a matching grid column count instead — match the existing idiom.)

**Step 4: Verify types and suite**

Run: `npm run typecheck` — clean.
Run: `npm test` — full suite green (allow ~4 minutes; services + isolation + simulation).

**Step 5: Manual dev-server check**

Run: `npm run dev`:
- [ ] Title → THE SANCTUM opens the node grid; ESC and "Back to title" both return
- [ ] Sanctum background is a flat wash, not the last run's battlefield (finish a run, return to title, then open the Sanctum)
- [ ] Ten nodes with names, descriptions, rank pips, next-rank cost; unaffordable ones dimmed
- [ ] Buying decrements the vault by the exact cost, fills a pip, keeps focus on the bought node
- [ ] A maxed node reads MAX / COMPLETE and no longer charges
- [ ] Purchases survive a hard refresh
- [ ] Buy Bloodthirst rank 1 and start a run — hits visibly larger (might 1.1 → 1.15 on wanderer)
- [ ] Buy Second Wind, start a run, die once — the revive triggers (revivesLeft came from meta)
- [ ] Arrow keys + Enter drive the whole shop without a mouse

**Step 6: Commit**

```bash
git add src/ui/screens.ts src/game.ts src/ui/style.css
git commit -m "feat: sanctum shop screen with rank pips and gamepad nav"
```

---

### Task 15: Full verification + squash merge

**Files:** none (verification only)

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean, zero errors.

**Step 2: Full suite**

Run: `npm test`
Expected: ALL tests pass, including:
- the pre-existing 76 (the 15-minute leak/determinism runs are the invariant tripwires)
- the extended bastion full-run test now asserting the gold band
- the **29 new tests** (8 + 19 + 2):
  - `simulation.test.ts` — meta progression (8): normalizes the 10-node sanctum tree · designed total sink · unknown perRank stats dropped · seeds recomputeStats with clamps intact · meta survives passive recompute · extra revives from meta · Run(id) identical to Run(id, {}) · meta greed deterministic
  - `services/meta.test.ts` (19): storage adapters (2) · save codec (4) · save store (3) · wallet (3 — the third is Task 5's "banks each run token exactly once" bank-token test) · sanctum (4) · character unlocks (3)
  - `services/isolation.test.ts` (2): glob coverage · no services imports in engine code

**Step 3: Engine-isolation double-check (belt and braces over the vitest gate)**

Run: `grep -rn "services/" src/core src/ecs src/gameplay src/render`
Expected: no matches.

**Step 4: Manual dev-server pass (roadmap exit criteria)**

Run: `npm run dev`:
- [ ] Save survives reload: bank gold, buy a node, unlock a character, hard refresh — all state intact
- [ ] Backup recovery: in the console run `localStorage['vk-save'] = 'corrupted'`, refresh — the wallet/ranks come back from `vk-save.bak` and the primary heals (inspect it)
- [ ] Both slots corrupted → fresh defaults, no crash, game playable
- [ ] Full loop: run → death → results shows run gold + vault total → sanctum spend → next run visibly stronger

**Step 5: Self-review the diff**

Run: `git diff main...HEAD --stat` then `git diff main...HEAD`
Check against the invariants:
- no engine file imports `services/` (the gate + grep already swear to it)
- `Game.tick()` and the harness tick untouched this phase — `git diff main...HEAD -- src/game.ts | grep "tick"` shows no sim-order changes
- `run.stats` never assigned outside `recomputeStats()`; metaMods only ever read
- no `Math.random`/wall-clock in anything the sim touches; MetaService is UI-side only
- services state replaced, never mutated (`this.data = { ...this.data, … }` throughout)
- no hardcoded balance numbers outside `meta.json` / `characters.json`

**Step 6: Squash merge (ask the user before each git command)**

```bash
git checkout main
git merge --squash feat/phase-4-meta-progression
git commit -m "feat: meta progression - sanctum tree, persistent saves and character unlocks (mobile v1 phase 4)"
```
Keep the phase branch until the user confirms deletion. Then reassess (per the
roadmap's just-in-time rule) before writing the Phase 5 plan.

---

## Notes for the executor

- **The sim is untouched this phase.** No `Game.tick()` edits, no harness edits beyond
  the `makeHarness` metaMods parameter (a constructor pass-through, not a tick change).
  If you find yourself editing tick order, stop — you've left the phase's scope.
- **Persistence is never awaited on a frame path.** `MetaService.persist` is
  fire-and-forget by design; `flush()` exists for tests and future lifecycle hooks only.
- If any test fails twice with the same error: stop, re-read the relevant source file
  in full, do not blind-retry (execution discipline rules).
- All tuning numbers live in `src/content/meta.json` and `src/content/characters.json`
  and hot-reload in the dev server — balance passes need no code changes.
- The gold-band and greed tests are calibrated against seeded runs; if a later phase
  deliberately changes the income curve, recalibrate the band in the same commit and
  say so — never silently widen it.
- Deliberately out of scope (locked decisions): IAP catalog, StoreKit receipts,
  rewarded ads, revive/gold-double/daily-chest offers (Phase 6); Capacitor Preferences
  adapter, `appStateChange` save hook (Phase 5); sanctum art pass; tree respec/refund;
  cloud sync.
- Known v1 UI warts (accepted): a failed unlock/buy gives no animated feedback beyond
  the dimmed price; the title re-render after unlock resets focus. Both are Phase 5+
  polish items.
