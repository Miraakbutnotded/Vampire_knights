# Active Abilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** One unique active ability per character on a cooldown (Space / HUD button / gamepad), five gothic character kits, and a cooldown-ring HUD button — design §2 of the mobile v1 design doc.

**Architecture:** Ability state lives on `Run` (`run.ability: AbilityState | null`, sim-time timers only). A new stateless system `src/gameplay/abilities.ts::updateAbility(ctx, dt)` runs immediately after the post-movement enemy-hash rebuild (rebuild #2) and before `updateWeapons` in both `Game.tick()` and `makeHarness()` — mirrored verbatim, same commit. Player intent is a latched `ctx.abilityQueued` boolean set frame-side (Space in `beforeFrame`, HUD tap and gamepad face button via a new `Input.injectPress()` on the existing synthetic-press path) and consumed sim-side. Abilities fire through the existing spawn primitives (`spawnProjectile` / `spawnHazard`, newly exported from weapons.ts), so damage, pierce dedup, lifetimes and rendering all ride the existing updaters. Buff abilities enter `recomputeStats()` as a third source **on state change only** (activation + expiry), never per tick.

**Tech Stack:** TypeScript strict, Vite, Vitest headless harness (`src/gameplay/simulation.test.ts`), data-driven JSON content normalized warn-don't-throw in `src/gameplay/content.ts`. No new dependencies.

---

**Design source:** `docs/plans/2026-07-30-mobile-v1-design.md` §2. **Invariants:** `CLAUDE.md` (tick order load-bearing, harness mirrors tick verbatim, `ctx.rng` only, `run.stats` immutable outside `recomputeStats()`, warn-don't-throw content, new Ctx field ⇒ init in Game constructor AND `makeHarness()`, reset in `startRun()`).

**Balance guardrails (from design §2, enforced by a content test in Task 2):** cooldowns 12–30s; buff uptime ≤ 40% (cooldown ≥ 2.5× duration); dash ≤ 100 units and always map-clamped; dash iframes ≤ 0.8s; nova/volley count ≤ 16; ability damage scales only via might/area/duration; neither the `cooldown` stat nor Frenzy's `cooldownMult` ever shortens an ability cooldown. The "ability ≤ ~25% of total DPS" guardrail is a manual balance-pass criterion (the kit numbers were authored against it) — it is not mechanically asserted; this is a deliberate, stated scope limit.

**Design-§2 deviations (declared, per the no-silent-trim rule):** (1) the `ability:used` payload ships `{ name, kind, cooldown }` instead of §2's `{ id: string }` — the HUD polls `run.ability` anyway, and the richer payload serves the same future SFX/analytics hook without a content lookup. (2) Castellan Dragos ships `bloodGain` 1.25 — §2's kit list doesn't specify it, but §1 reserved the 1.25 vampire-lord hook for exactly this character; Task 2 asserts it. (3) §2's headless-test list includes a 15-minute auto-press leak run; the pre-existing 15-minute test never presses the ability, so Task 12 adds a dedicated auto-press leak test to bound ability entity pressure (nova ring + zone + dash-trail hazards).

**Cap & multiplier contract (carried from the Phase 1 final review — the vial-vs-cap seam bug class):** every place an ability grants or consumes blood or stats states its cap interaction explicitly:

- **Buff mods** flow through `recomputeStats()` exactly like passives, so every existing clamp (cooldown floor `MIN_COOLDOWN_MUL`, `critChance` clamp, `Math.max` floors) applies identically; restore-on-expiry is exact because recompute derives from scratch rather than applying deltas. A tripwire test proves byte-identical `run.stats` after expiry.
- **Bulwark's instant heal** goes through `healPlayer()` and clamps at `run.stats.maxHp`; the heal runs *after* the buff recompute so a future maxHp-buffing kit would heal against the raised cap. Overheal is discarded, and the `player:healed` payload reports what actually landed.
- **Frenzy × buff stacking:** Frenzy stays strictly read-side (`run.frenzyT` in `effectiveStats`/`abilityStats`/`updatePlayer`); a buff active during Frenzy multiplies (buffed `run.stats.might` × `mightMult`). Intended and documented.
- **Ability damage** folds `run.stats.might` (including any active buff) × Frenzy's `mightMult` read-side. **Ability cooldown** is exempt from `run.stats.cooldown` AND Frenzy's `cooldownMult` (guardrail).
- **Dragos' `bloodGain` 1.25** multiplies per-kill grants *before* the intake cap in `gainBlood()` — excess above the 12/sec window is still discarded, same seam semantics Phase 1 shipped. Abilities grant no blood directly, so no new uncapped path is introduced (Blood Vials remain the only `uncapped` caller).
- **Dash** writes position only (through the map-resolution methods); it never touches blood, stats or caps.

**Test placement:** all new headless tests go in one new `describe('active abilities', …)` block appended at the end of `src/gameplay/simulation.test.ts` (after the closing `});` of `describe('blood economy', …)`, line 816). Task 1 creates the block; later tasks append `it(…)` cases inside it.

**Commits:** every `git commit` below ends with the standard trailer, appended to the message shown:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: <the executing session's claude.ai/code URL>
```

## Setup

```bash
cd /Users/boraesen/Desktop/Vampire_knights
git checkout main
git checkout -b feat/phase-2-active-abilities
npm test   # confirm the suite is green before touching anything
```
Expected: all existing tests pass (Phase 1 is squash-merged on main as `9c93684`). Git operations require user approval per house rules — ask before each commit/checkout.

---

### Task 1: AbilityDef schema + ABILITY_KINDS whitelist + normalization

**Files:**
- Modify: `src/gameplay/content.ts` (new `// --- abilities ---` section between `passiveDef` (line 418) and `// --- characters ---` (line 420); `CharacterDef` gains `ability` (line 471); `normalizeCharacters` entry literal (line 502))
- Test: `src/gameplay/simulation.test.ts` (new describe block after line 816; content import at line 16)

**Step 1: Write the failing test**

Extend the content import (lines 16–24) with `normalizeAbility`:

```ts
import {
  BLOOD_CONFIG,
  CHARACTER_LIST,
  WEAPON_LIST,
  enemyDef,
  normalizeAbility,
  normalizeBlood,
  waveTable,
  weaponStatsAtLevel,
} from './content.ts';
```

Append at the very end of the file (after the `blood economy` block's closing `});`):

```ts
describe('active abilities', () => {
  it('normalizes a valid ability block and defaults missing params', () => {
    const def = normalizeAbility(
      { name: 'Test Nova', kind: 'nova', cooldown: 15, params: { damage: 40, count: 10 } },
      'test',
    )!;
    expect(def).not.toBeNull();
    expect(def.kind).toBe('nova');
    expect(def.cooldown).toBe(15);
    expect(def.params.damage).toBe(40);
    expect(def.params.count).toBe(10);
    // Missing params fall back to per-key defaults rather than exploding.
    expect(def.params.pierce).toBe(1);
    expect(def.params.lifetime).toBe(1);
    expect(def.sprite).toBe('proj_bolt');
    expect(def.mods).toEqual({});
  });

  it('omits abilities with unknown kinds and warns instead of throwing', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      // Unknown kind: the ability is dropped, the character stays playable.
      expect(normalizeAbility({ name: 'Bad', kind: 'summon' }, 'test')).toBeNull();
      expect(normalizeAbility('not an object', 'test')).toBeNull();
      expect(warnings.some((w) => w.includes('summon'))).toBe(true);
      // Unknown mod keys are dropped with a warning; valid ones survive.
      const buff = normalizeAbility(
        { name: 'B', kind: 'buff', cooldown: 25, duration: 5, mods: { armor: 10, banana: 3 } },
        'test',
      )!;
      expect(buff.mods).toEqual({ armor: 10 });
      expect(warnings.some((w) => w.includes('banana'))).toBe(true);
      // No ability block at all is legal and silent.
      expect(normalizeAbility(undefined, 'test')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load with `does not provide an export named 'normalizeAbility'`.

**Step 3: Write minimal implementation**

In `src/gameplay/content.ts`, insert a new section between the passives section (`passiveDef`, ends line 418) and `// --- characters ---` (line 420):

```ts
// --- abilities ------------------------------------------------------------

/** Whitelisted active-ability kinds, same contract as WeaponBehavior. */
export const AbilityKind = {
  /** Radial burst of player projectiles around the caster. */
  Nova: 'nova',
  /** A paced burst of homing projectiles across a short window. */
  Volley: 'volley',
  /** One large lingering hazard at the caster's feet. */
  Zone: 'zone',
  /** Temporary stat mods through recomputeStats, plus an instant heal. */
  Buff: 'buff',
  /** Instant map-clamped reposition with iframes and a damaging trail. */
  Dash: 'dash',
} as const;
export type AbilityKind = (typeof AbilityKind)[keyof typeof AbilityKind];

const ABILITY_KINDS = new Set<string>(Object.values(AbilityKind));

/** Every tunable an ability can have. Kinds read the subset that applies. */
export interface AbilityParams {
  damage: number;
  count: number;
  speed: number;
  pierce: number;
  knockback: number;
  radius: number;
  interval: number;
  lifetime: number;
  turnRate: number;
  distance: number;
  trailCount: number;
  heal: number;
}

const ABILITY_PARAM_DEFAULTS: AbilityParams = {
  damage: 10,
  count: 1,
  speed: 120,
  pierce: 1,
  knockback: 0,
  radius: 20,
  interval: 0.5,
  lifetime: 1,
  turnRate: 0,
  distance: 60,
  trailCount: 0,
  heal: 0,
};

const ABILITY_PARAM_KEYS = Object.keys(ABILITY_PARAM_DEFAULTS) as (keyof AbilityParams)[];

export interface AbilityDef {
  name: string;
  description: string;
  /** HUD icon, through the same sprites.json placeholder pipeline as loadout icons. */
  icon: string;
  /** Sprite used for entities the ability spawns (projectiles / hazards). */
  sprite: string;
  kind: AbilityKind;
  /**
   * Seconds between casts. Deliberately outside the stat system: neither the
   * cooldown stat nor Frenzy's cooldownMult ever shortens it (design guardrail).
   */
  cooldown: number;
  /** Buff window / dash iframe seconds / volley burst window. */
  duration: number;
  params: AbilityParams;
  /** Buff kind only: folded into recomputeStats while the buff is active. */
  mods: Partial<StatMods>;
}

/**
 * Same fail-soft contract as the rest of the content pipeline: an unknown kind
 * or a malformed block costs the character its active, never the game. Takes
 * the raw value rather than reading JSON directly so the fail-soft paths are
 * reachable from tests (the normalizeBlood pattern).
 */
export function normalizeAbility(raw: unknown, owner: string): AbilityDef | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[content] character "${owner}" ability is not an object; ignoring it`);
    return null;
  }
  const def = raw as Record<string, unknown>;

  const kindRaw = typeof def['kind'] === 'string' ? (def['kind'] as string) : '';
  if (!ABILITY_KINDS.has(kindRaw)) {
    console.warn(
      `[content] character "${owner}" ability has unknown kind "${kindRaw}"; ` +
        `the character plays without an active. Valid: ${[...ABILITY_KINDS].join(', ')}`,
    );
    return null;
  }

  const num = (key: string, fallback: number): number => {
    const v = def[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const v = def[key];
    return typeof v === 'string' ? v : fallback;
  };

  const paramsRaw = (def['params'] ?? {}) as Record<string, unknown>;
  const params = { ...ABILITY_PARAM_DEFAULTS };
  for (const key of ABILITY_PARAM_KEYS) {
    const v = paramsRaw[key];
    if (typeof v === 'number' && Number.isFinite(v)) params[key] = v;
  }

  const modsRaw = (def['mods'] ?? {}) as Record<string, unknown>;
  const mods: Partial<StatMods> = {};
  for (const key of STAT_MOD_KEYS) {
    const v = modsRaw[key];
    if (typeof v === 'number' && Number.isFinite(v)) mods[key] = v;
  }
  for (const key of Object.keys(modsRaw)) {
    if (!STAT_MOD_KEYS.includes(key as keyof StatMods)) {
      console.warn(
        `[content] character "${owner}" ability sets unknown mod "${key}"; it will have no effect. ` +
          `Valid: ${STAT_MOD_KEYS.join(', ')}`,
      );
    }
  }

  return {
    name: str('name', 'Unnamed Rite'),
    description: str('description', ''),
    icon: str('icon', 'fx_star'),
    sprite: str('sprite', 'proj_bolt'),
    kind: kindRaw as AbilityKind,
    cooldown: Math.max(1, num('cooldown', 20)),
    duration: Math.max(0, num('duration', 0)),
    params,
    mods,
  };
}
```

In `CharacterDef` (line 464), add after `stats: BaseStats;`:

```ts
  /** The character's active ability, or null when the JSON defines none. */
  ability: AbilityDef | null;
```

In `normalizeCharacters()`, in the `entry: CharacterDef` literal (line 495), add after `stats,`:

```ts
      ability: normalizeAbility(def['ability'], id),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "active abilities"`
Expected: PASS (2 tests). Then `npm run typecheck` — clean (proves `CharacterDef.ability` is initialized everywhere).

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/gameplay/simulation.test.ts
git commit -m "feat: add ability schema and warn-don't-throw normalization to content"
```

---

### Task 2: five gothic kits in characters.json + ability icon sprites

**Files:**
- Rewrite: `src/content/characters.json` (keep the four existing ids, gothic names + ability blocks; add `dragos`)
- Modify: `src/content/sprites.json` (icon + hazard placeholder entries after `fx_star`, ~line 161)
- Test: `src/gameplay/simulation.test.ts` (3 tests inside the `active abilities` block)

**Step 1: Write the failing tests**

Append inside `describe('active abilities', …)`:

```ts
  it('gives every character a gothic kit with a whitelisted ability', () => {
    const expected: Record<string, string> = {
      wanderer: 'nova',      // Ser Valen — Crimson Cleave
      acolyte: 'volley',     // Lady Morrigan — Night Swarm
      warden_knight: 'buff', // Ser Aldric — Sanguine Bulwark
      outrider: 'dash',      // Vespera — Mist Dash
      dragos: 'zone',        // Castellan Dragos — Unhallowed Ground
    };
    expect(CHARACTER_LIST).toHaveLength(5);
    for (const [id, kind] of Object.entries(expected)) {
      const character = CHARACTER_LIST.find((c) => c.id === id);
      expect(character, `missing character "${id}"`).toBeDefined();
      expect(character!.ability, `"${id}" has no ability`).not.toBeNull();
      expect(character!.ability!.kind).toBe(kind);
    }
  });

  it('keeps every kit inside the ability guardrails', () => {
    for (const character of CHARACTER_LIST) {
      const a = character.ability!;
      expect(a, `${character.id} lost its ability in normalization`).not.toBeNull();
      expect(a.cooldown, `${character.id} cooldown`).toBeGreaterThanOrEqual(12);
      expect(a.cooldown, `${character.id} cooldown`).toBeLessThanOrEqual(30);
      if (a.kind === 'buff') {
        // Uptime ≤ 40%: cooldown at least 2.5x the buff window.
        expect(a.cooldown).toBeGreaterThanOrEqual(2.5 * a.duration);
      }
      if (a.kind === 'dash') {
        expect(a.params.distance).toBeLessThanOrEqual(100);
        expect(a.duration, `${character.id} iframes`).toBeLessThanOrEqual(0.8);
      }
      if (a.kind === 'nova' || a.kind === 'volley') {
        expect(a.params.count, `${character.id} pool pressure`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('ships Castellan Dragos as the bloodGain 1.25 vampire-lord', () => {
    const dragos = CHARACTER_LIST.find((c) => c.id === 'dragos')!;
    expect(dragos.stats.bloodGain).toBeCloseTo(1.25);
    expect(dragos.stats.area).toBeCloseTo(1.2);
    expect(dragos.stats.duration).toBeCloseTo(1.2);
    expect(dragos.stats.maxHp).toBe(120);
    expect(dragos.startingWeapon).toBe('brazier');
    // bloodGain multiplies kill grants BEFORE the intake cap in gainBlood —
    // the Run-level unit proof that the multiplier reached the stat sheet.
    const run = new Run('dragos');
    expect(run.stats.bloodGain).toBeCloseTo(1.25);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "gothic kit"`
Expected: FAIL — `CHARACTER_LIST` has length 4 and every `ability` is null (no blocks in the JSON yet).

**Step 3: Write minimal implementation**

Replace `src/content/characters.json` wholesale (ids are load-bearing — `wanderer` stays `CHARACTER_LIST[0]`, the harness default):

```json
{
  "wanderer": {
    "name": "Ser Valen, the Bloodsworn",
    "sprite": "player",
    "description": "The oath keeps him standing. A balanced knight with a ring of spectral blades.",
    "startingWeapon": "whip",
    "radius": 5,
    "stats": {
      "maxHp": 100,
      "recovery": 0,
      "armor": 0,
      "moveSpeed": 64,
      "might": 1.1,
      "area": 1,
      "projectileSpeed": 1,
      "duration": 1,
      "amount": 0,
      "cooldown": 1,
      "magnet": 30,
      "growth": 1,
      "greed": 1,
      "luck": 1,
      "critChance": 0.05,
      "critMult": 2,
      "revives": 0
    },
    "ability": {
      "name": "Crimson Cleave",
      "description": "A ring of spectral blades erupts outward.",
      "icon": "ability_cleave",
      "sprite": "fx_slash",
      "kind": "nova",
      "cooldown": 18,
      "params": { "count": 10, "damage": 40, "speed": 150, "pierce": 3, "knockback": 200, "lifetime": 0.6 }
    }
  },

  "acolyte": {
    "name": "Lady Morrigan of the Mist",
    "sprite": "player",
    "description": "Frail but quick to learn. Calls the night's swarm to hunt for her.",
    "startingWeapon": "wand",
    "radius": 5,
    "stats": {
      "maxHp": 80,
      "recovery": 0,
      "armor": 0,
      "moveSpeed": 66,
      "might": 1,
      "area": 1,
      "projectileSpeed": 1,
      "duration": 1,
      "amount": 0,
      "cooldown": 0.95,
      "magnet": 34,
      "growth": 1.3,
      "greed": 1,
      "luck": 1.1,
      "critChance": 0.08,
      "critMult": 2,
      "revives": 0
    },
    "ability": {
      "name": "Night Swarm",
      "description": "A dozen hunting bats pour out over a few heartbeats.",
      "icon": "ability_swarm",
      "sprite": "bat",
      "kind": "volley",
      "cooldown": 20,
      "duration": 2.4,
      "params": { "count": 12, "damage": 14, "speed": 160, "turnRate": 7, "pierce": 1, "lifetime": 3 }
    }
  },

  "warden_knight": {
    "name": "Ser Aldric the Sworn",
    "sprite": "player",
    "description": "Slow and armoured. His vow hardens to iron when it matters.",
    "startingWeapon": "garlic",
    "radius": 6,
    "stats": {
      "maxHp": 140,
      "recovery": 0.3,
      "armor": 2,
      "moveSpeed": 56,
      "might": 1.1,
      "area": 1,
      "projectileSpeed": 1,
      "duration": 1,
      "amount": 0,
      "cooldown": 1.05,
      "magnet": 26,
      "growth": 0.9,
      "greed": 1,
      "luck": 0.9,
      "critChance": 0.04,
      "critMult": 2,
      "revives": 1
    },
    "ability": {
      "name": "Sanguine Bulwark",
      "description": "Blood answers the vow: iron skin and a surge of vigour.",
      "icon": "ability_bulwark",
      "kind": "buff",
      "cooldown": 25,
      "duration": 5,
      "params": { "heal": 20 },
      "mods": { "armor": 10 }
    }
  },

  "outrider": {
    "name": "Vespera, the Pale Outrider",
    "sprite": "player",
    "description": "Built to kite. Steps through the mist and leaves it burning behind her.",
    "startingWeapon": "knife",
    "radius": 5,
    "stats": {
      "maxHp": 90,
      "recovery": 0,
      "armor": 0,
      "moveSpeed": 74,
      "might": 1,
      "area": 0.95,
      "projectileSpeed": 1.15,
      "duration": 1,
      "amount": 1,
      "cooldown": 1,
      "magnet": 40,
      "growth": 1,
      "greed": 1.1,
      "luck": 1,
      "critChance": 0.06,
      "critMult": 2.2,
      "revives": 0
    },
    "ability": {
      "name": "Mist Dash",
      "description": "A step through the veil — untouchable, trailing killing mist.",
      "icon": "ability_dash",
      "sprite": "hazard_mist",
      "kind": "dash",
      "cooldown": 12,
      "duration": 0.6,
      "params": { "distance": 80, "trailCount": 3, "damage": 6, "radius": 18, "interval": 0.5, "lifetime": 2.5 }
    }
  },

  "dragos": {
    "name": "Castellan Dragos",
    "sprite": "player",
    "description": "The castle's old master. Ground he claims stays claimed, and blood comes easier to him.",
    "startingWeapon": "brazier",
    "radius": 6,
    "stats": {
      "maxHp": 120,
      "recovery": 0,
      "armor": 1,
      "moveSpeed": 58,
      "might": 1,
      "area": 1.2,
      "projectileSpeed": 1,
      "duration": 1.2,
      "amount": 0,
      "cooldown": 1,
      "magnet": 30,
      "growth": 1,
      "greed": 1,
      "luck": 1,
      "critChance": 0.05,
      "critMult": 2,
      "bloodGain": 1.25,
      "revives": 0
    },
    "ability": {
      "name": "Unhallowed Ground",
      "description": "Consecrates the earth against the living.",
      "icon": "ability_zone",
      "sprite": "hazard_unhallowed",
      "kind": "zone",
      "cooldown": 22,
      "params": { "radius": 55, "damage": 12, "interval": 0.4, "knockback": 120, "lifetime": 6 }
    }
  }
}
```

In `src/content/sprites.json`, insert after the `"fx_star"` entry (~line 161), before `"tree"`:

```json
  "ability_cleave": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "ui/ability_cleave.png", "fps": 1 } },
    "placeholder": { "shape": "slash", "color": "#d94a5e", "accent": "#4a0d16", "size": 14, "bob": 0 }
  },
  "ability_swarm": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "ui/ability_swarm.png", "fps": 1 } },
    "placeholder": { "shape": "bat", "color": "#6b4a8f", "accent": "#241733", "size": 14, "bob": 0 }
  },
  "ability_bulwark": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "ui/ability_bulwark.png", "fps": 1 } },
    "placeholder": { "shape": "ring", "color": "#d4a15a", "accent": "#4a3013", "size": 14, "bob": 0 }
  },
  "ability_dash": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "ui/ability_dash.png", "fps": 1 } },
    "placeholder": { "shape": "ghost", "color": "#9fd8e8", "accent": "#2f5d6b", "size": 14, "bob": 0 }
  },
  "ability_zone": {
    "origin": [0.5, 0.5],
    "anims": { "idle": { "src": "ui/ability_zone.png", "fps": 1 } },
    "placeholder": { "shape": "square", "color": "#7a3fa0", "accent": "#2a1138", "size": 14, "bob": 0 }
  },
  "hazard_mist": {
    "origin": [0.5, 0.6],
    "anims": { "idle": { "src": "weapons/mist.png", "fps": 8 } },
    "placeholder": { "shape": "blob", "color": "#b8c8d8", "accent": "#3d4a5c", "size": 36, "bob": 1 }
  },
  "hazard_unhallowed": {
    "origin": [0.5, 0.6],
    "anims": { "idle": { "src": "weapons/unhallowed.png", "fps": 8 } },
    "placeholder": { "shape": "ring", "color": "#7a3fa0", "accent": "#2a1138", "size": 48, "bob": 0 }
  },
```

(Also add a test import for `Run` if not present — it already is, via `import { Run, xpForLevel } from './run.ts';` line 29.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: PASS — the 3 new tests AND the whole pre-existing suite. Two Phase 1 tests touch character data and must stay green: `folds bloodGain from character defaults` (wanderer stays `bloodGain` default 1 ✓) and the 15-minute full-run (wanderer's might 1 → 1.1 only speeds kills up).

**Step 5: Commit**

```bash
git add src/content/characters.json src/content/sprites.json src/gameplay/simulation.test.ts
git commit -m "feat: rework the roster into five gothic kits with active abilities"
```

---

### Task 3: AbilityState on Run

**Files:**
- Modify: `src/gameplay/run.ts` (type import line 3; `AbilityState` interface before the `Run` class; field after `graceT` line 83; constructor after `this.revivesLeft = …` line 89)
- Test: `src/gameplay/simulation.test.ts` (1 test)

**Step 1: Write the failing test**

Append inside the `active abilities` block:

```ts
  it('seeds Run.ability ready-to-cast from the character def', () => {
    const run = new Run('wanderer');
    expect(run.ability).not.toBeNull();
    expect(run.ability!.def.name).toBe('Crimson Cleave');
    expect(run.ability!.cooldownLeft).toBe(0); // ready from the first tick
    expect(run.ability!.activeLeft).toBe(0);
    expect(run.ability!.burstLeft).toBe(0);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "seeds Run.ability"`
Expected: FAIL — `Property 'ability' does not exist on type 'Run'` (the suite file fails to typecheck/load, or the assertion sees `undefined`).

**Step 3: Write minimal implementation**

`src/gameplay/run.ts` — extend the type import (line 3):

```ts
import type { AbilityDef, BaseStats, CharacterDef, PassiveDef, StatMods, WeaponDef } from './content.ts';
```

Add before `export class Run {` (line 49):

```ts
/**
 * Per-run active-ability state, mirroring the OwnedWeapon.timer precedent:
 * cooldowns live on Run structures and are ticked by gameplay systems
 * (updateAbility) on sim dt only.
 */
export interface AbilityState {
  def: AbilityDef;
  /** Seconds until the next cast. 0 = ready. */
  cooldownLeft: number;
  /** Buff window / volley burst window remaining. */
  activeLeft: number;
  /** Volley: shots still queued in the current burst. */
  burstLeft: number;
  /** Volley: seconds until the next queued shot. */
  burstTimer: number;
}
```

Add the field after `graceT = 0;` (line 83):

```ts
  /** Active-ability state, or null for a character without one. */
  ability: AbilityState | null = null;
```

In the constructor, after `this.revivesLeft = this.character.stats.revives;` (line 89):

```ts
    this.ability = this.character.ability
      ? { def: this.character.ability, cooldownLeft: 0, activeLeft: 0, burstLeft: 0, burstTimer: 0 }
      : null;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "seeds Run.ability"` → PASS. Then `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/gameplay/run.ts src/gameplay/simulation.test.ts
git commit -m "feat: seed per-run ability state on Run"
```

---

### Task 4: abilityStats helper + export the weapon spawn primitives

**Files:**
- Modify: `src/gameplay/content.ts` (`const WEAPON_STAT_DEFAULTS` → `export const`, line 205)
- Modify: `src/gameplay/weapons.ts` (`function spawnProjectile` → `export function`, line 107; `function spawnHazard` → `export function`, line 147)
- Create: `src/gameplay/abilities.ts`
- Test: `src/gameplay/simulation.test.ts` (2 tests; new import)

**Step 1: Write the failing tests**

Add to the test file's imports:

```ts
import { abilityStats } from './abilities.ts';
```

Append inside the `active abilities` block:

```ts
  it('builds ability stats scaled by might, area and duration only', () => {
    const run = new Run('dragos'); // area 1.2, duration 1.2, might 1
    const def = run.character.ability!;
    const stats = abilityStats(run, def);
    expect(stats.damage).toBeCloseTo(def.params.damage * run.stats.might);
    expect(stats.radius).toBeCloseTo(def.params.radius * run.stats.area); // 55 x 1.2 = 66
    expect(stats.lifetime).toBeCloseTo(def.params.lifetime * run.stats.duration); // 6 x 1.2 = 7.2
    // Explicitly NOT scaled: the guardrail says might/area/duration only.
    expect(stats.speed).toBe(def.params.speed); // projectileSpeed does not apply
    expect(stats.count).toBe(def.params.count); // amount does not apply
    expect(stats.pierce).toBe(def.params.pierce);
    expect(stats.knockback).toBe(def.params.knockback);
    expect(stats.interval).toBe(def.params.interval); // cooldown stat does not apply
  });

  it('applies frenzy to ability damage read-side, like effectiveStats', () => {
    const run = new Run('wanderer');
    const def = run.character.ability!;
    const calm = abilityStats(run, def);
    run.frenzyT = 5;
    const frenzied = abilityStats(run, def);
    expect(frenzied.damage).toBeCloseTo(calm.damage * BLOOD_CONFIG.frenzy.mightMult);
    run.frenzyT = 0;
    // Reverts with the timer; run.stats was never written.
    expect(abilityStats(run, def).damage).toBeCloseTo(calm.damage);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load with `Failed to resolve import "./abilities.ts"`. The whole file red is the expected signal at this step.

**Step 3: Write minimal implementation**

`src/gameplay/content.ts` line 205: change `const WEAPON_STAT_DEFAULTS: WeaponStats = {` to `export const WEAPON_STAT_DEFAULTS: WeaponStats = {`.

`src/gameplay/weapons.ts`: change line 107 `function spawnProjectile(` to `export function spawnProjectile(` and line 147 `function spawnHazard(` to `export function spawnHazard(`.

Create `src/gameplay/abilities.ts`:

```ts
import { BLOOD_CONFIG, WEAPON_STAT_DEFAULTS } from './content.ts';
import type { AbilityDef, WeaponStats } from './content.ts';
import type { Run } from './run.ts';

/**
 * Builds the WeaponStats an ability's spawned entities carry, so abilities can
 * ride spawnProjectile/spawnHazard and every downstream updater unchanged.
 *
 * Scaling is deliberately narrow (design guardrail): damage x might, sizes x
 * area, lifetime x duration — and nothing else. amount, cooldown and
 * projectileSpeed do not apply, and the ability cooldown itself never appears
 * here at all (it lives raw on AbilityDef, immune to cooldown scaling).
 *
 * Frenzy folds in read-side exactly as effectiveStats does — keyed off
 * run.frenzyT, never written to run.stats — so a buffed, frenzied cast is
 * (base x might-incl-buff x mightMult) with zero recompute involvement.
 */
export function abilityStats(run: Run, def: AbilityDef): WeaponStats {
  const p = def.params;
  const s = run.stats;
  const frenzyDamage = run.frenzyT > 0 ? BLOOD_CONFIG.frenzy.mightMult : 1;

  return {
    ...WEAPON_STAT_DEFAULTS,
    damage: p.damage * s.might * frenzyDamage,
    count: p.count,
    pierce: p.pierce,
    area: s.area,
    duration: p.lifetime * s.duration,
    knockback: p.knockback,
    speed: p.speed,
    lifetime: p.lifetime * s.duration,
    interval: p.interval,
    radius: p.radius * s.area,
    turnRate: p.turnRate,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gameplay/simulation.test.ts` → PASS (whole suite). `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/gameplay/content.ts src/gameplay/weapons.ts src/gameplay/abilities.ts src/gameplay/simulation.test.ts
git commit -m "feat: add abilityStats and export the weapon spawn primitives"
```

---

### Task 5: ctx.abilityQueued + updateAbility with the nova kind, wired into tick AND harness

This task is atomic by necessity (the Phase 1 Task 7 precedent): adding a required field to
`Ctx` forces `game.ts` and `makeHarness()` to change in the same commit, and the tick
insertion must be mirrored verbatim in both (CLAUDE.md rules).

**Files:**
- Modify: `src/gameplay/context.ts` (interface, after `bloodIntent` line 63)
- Modify: `src/gameplay/abilities.ts` (updateAbility + activate + castNova)
- Modify: `src/core/events.ts` (`GameEvents`, after `blood:frenzy` line 45)
- Modify: `src/game.ts` (import after line 22; ctx literal after `bloodIntent: null,` line 111; `startRun` after line 178; `tick` between lines 310 and 312)
- Modify: `src/gameplay/simulation.test.ts` (harness ctx literal line 129; harness tick loop after the second `enemyHash.build` line 155; imports; 2 tests)

**Step 1: Write the failing tests**

Add to the test file's imports: `Team` from components (line 7) and `updateAbility`:

```ts
import { Kind, Team } from '../ecs/components.ts';
```
```ts
import { abilityStats, updateAbility } from './abilities.ts';
```

In `makeHarness()`, add to the `ctx: Ctx` literal after `bloodIntent: null,` (line 129):

```ts
    abilityQueued: false,
```

In the harness tick loop, immediately after the **second** `ctx.enemyHash.build(world, world.list(Kind.Enemy));` (line 155 — the post-movement rebuild, directly above `updateEnemyProjectiles`), add:

```ts
        updateAbility(ctx, FIXED_DT);
```

Append inside the `active abilities` block:

```ts
  it('nova: fires Crimson Cleave as a ring of player projectiles on the latched press', () => {
    const harness = makeHarness('wanderer');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no weapon noise in the projectile list
    // The ability cooldown must ignore the cooldown stat entirely (guardrail).
    ctx.run.stats.cooldown = 0.5;

    const used: Array<{ name: string; kind: string; cooldown: number }> = [];
    ctx.bus.on('ability:used', (p) => {
      used.push(p);
    });

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    const blades = world.list(Kind.Projectile).filter((id) => world.team[id] === Team.Player);
    expect(blades.length).toBe(10);
    expect(ctx.abilityQueued).toBe(false); // latch consumed by the sim
    expect(used).toHaveLength(1);
    expect(used[0]!.name).toBe('Crimson Cleave');
    // 18s flat: neither run.stats.cooldown (0.5) nor anything else scaled it.
    // Exact, not 18 - FIXED_DT: updateAbility decrements the cooldown BEFORE
    // consuming the latch, so nothing ticks it down on the cast tick itself —
    // the same consume-after-tick ordering the Phase 1 frenzyT test asserts.
    expect(ctx.run.ability!.cooldownLeft).toBe(18);

    // The blades actually cut: something in the surrounding ring dies.
    const bat = enemyDef('bat')!;
    ctx.run.ability!.cooldownLeft = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 40, Math.sin(a) * 40);
      world.hp[id] = 1;
    }
    const kills = ctx.run.kills;
    ctx.abilityQueued = true;
    harness.run(0.5);
    expect(ctx.run.kills).toBeGreaterThan(kills);
  });

  it('drops an ability press made during cooldown instead of banking it', () => {
    const harness = makeHarness('wanderer');
    const { ctx } = harness;
    ctx.run.weapons.length = 0;
    let used = 0;
    ctx.bus.on('ability:used', () => {
      used++;
    });

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(used).toBe(1);

    // Pressed again inside the 18s cooldown: consumed and dropped, not banked.
    ctx.abilityQueued = true;
    harness.run(1);
    expect(used).toBe(1);
    expect(ctx.abilityQueued).toBe(false);

    // Once the cooldown is over, a fresh press casts again.
    let ready = 0;
    ctx.bus.on('ability:ready', () => {
      ready++;
    });
    ctx.run.ability!.cooldownLeft = FIXED_DT; // fast-forward to the last tick
    harness.run(FIXED_DT * 2);
    expect(ready).toBe(1);
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(used).toBe(2);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/gameplay/simulation.test.ts`
Expected: FAIL — the suite file fails to load: `'./abilities.ts' does not provide an export named 'updateAbility'` (and the Ctx literal would reject `abilityQueued` until context.ts changes). Whole file red is the expected signal.

**Step 3: Write minimal implementation**

`src/gameplay/context.ts` — add to the `Ctx` interface after the `bloodIntent` field (line 63):

```ts
  /**
   * Latched ability press from the input layer (Space / HUD button / gamepad),
   * consumed (and cleared) by updateAbility on the next sim tick. Same latch
   * pattern as bloodIntent: survives frames where the fixed timestep runs the
   * sim zero times, and menus clear it so no cast survives a pause.
   */
  abilityQueued: boolean;
```

`src/core/events.ts` — add to `GameEvents` after `'blood:frenzy'` (line 45):

```ts
  'ability:used': { name: string; kind: string; cooldown: number };
  'ability:ready': undefined;
```

`src/gameplay/abilities.ts` — extend the imports and append the system:

```ts
import { TAU } from '../core/math.ts';
import { AbilityKind, BLOOD_CONFIG, WEAPON_STAT_DEFAULTS } from './content.ts';
import type { AbilityDef, WeaponStats } from './content.ts';
import { spawnProjectile } from './weapons.ts';
import type { Ctx } from './context.ts';
import type { AbilityState, Run } from './run.ts';
```

```ts
/**
 * The active-ability system: ticks the cooldown, expires buff windows, pumps
 * volley bursts, and consumes the player's latched cast intent.
 *
 * Runs immediately after the post-movement enemy-hash rebuild (rebuild #2) and
 * before updateWeapons in the tick, mirrored verbatim in the test harness.
 * Casting before updateEnemyProjectiles means dash iframes granted this tick
 * already cover this tick's enemy fire, and entities spawned here are moved,
 * resolved and rendered by the ordinary updaters later in the same tick.
 * Every timer advances on sim dt only — wall clock would break determinism.
 */
export function updateAbility(ctx: Ctx, dt: number): void {
  const { run, world, bus } = ctx;
  const state = run.ability;
  if (!state) {
    ctx.abilityQueued = false;
    return;
  }

  if (state.cooldownLeft > 0) {
    state.cooldownLeft = Math.max(0, state.cooldownLeft - dt);
    if (state.cooldownLeft === 0) bus.emit('ability:ready', undefined);
  }

  if (state.activeLeft > 0) {
    state.activeLeft = Math.max(0, state.activeLeft - dt);
    if (state.activeLeft === 0 && state.def.kind === AbilityKind.Buff) {
      // Expiry is a state change — one of exactly two recompute sites the
      // buff owns (the other is activation). Never per tick.
      run.abilityMods = null;
      run.recomputeStats();
    }
  }

  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) {
    ctx.abilityQueued = false;
    return;
  }

  if (state.def.kind === AbilityKind.Volley && state.burstLeft > 0) {
    pumpVolley(ctx, state, dt);
  }

  if (ctx.abilityQueued) {
    // Consumed either way: a press during cooldown is dropped, not banked —
    // a queued cast firing seconds later would land where nobody aimed it.
    ctx.abilityQueued = false;
    if (state.cooldownLeft === 0) activate(ctx, state);
  }
}

function activate(ctx: Ctx, state: AbilityState): void {
  const def = state.def;
  // The one place the cooldown is written. run.stats.cooldown and Frenzy's
  // cooldownMult are deliberately absent (design guardrail).
  state.cooldownLeft = def.cooldown;

  switch (def.kind) {
    case AbilityKind.Nova:
      castNova(ctx, def);
      break;
    default:
      break;
  }

  ctx.bus.emit('ability:used', { name: def.name, kind: def.kind, cooldown: def.cooldown });
}

/** Radial burst around the player, riding the ordinary projectile pipeline. */
function castNova(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const px = world.x[ctx.player]!;
  const py = world.y[ctx.player]!;
  const stats = abilityStats(run, def);
  // Random phase (gameplay rng — determinism) so repeat casts vary their lanes.
  const phase = ctx.rng.angle();

  for (let i = 0; i < stats.count; i++) {
    const a = phase + (i / stats.count) * TAU;
    spawnProjectile(ctx, def.sprite, px, py, Math.cos(a) * stats.speed, Math.sin(a) * stats.speed, stats, false);
  }

  ctx.fx.shockwave(px, py, '#d94a5e', 0.4, 6);
  ctx.camera.shake(2, 0.2);
}

/** Volley pump — implemented in the volley task; a stub keeps this compiling. */
function pumpVolley(_ctx: Ctx, _state: AbilityState, _dt: number): void {
  // Task 6 fills this in.
}
```

(`run.abilityMods` does not exist yet — Task 8 adds it. To keep this task compiling, gate the expiry branch: write it now as shown but with the two `run.abilityMods` / `run.recomputeStats()` lines **omitted** — i.e. the `if (state.activeLeft === 0 && …)` branch body is empty except a `// Task 8: buff expiry recompute` comment — OR simply omit the whole `Buff` special-case until Task 8. Choose the omission; Task 8's diff adds the branch. The version above shows the final shape for orientation.)

`src/game.ts`:

1. Import, after `import { updateBlood } …` (line 22):
   ```ts
   import { updateAbility } from './gameplay/abilities.ts';
   ```
2. Constructor ctx literal, after `bloodIntent: null,` (line 111):
   ```ts
      abilityQueued: false,
   ```
3. `startRun`, after `this.ctx.bloodIntent = null;` (line 178):
   ```ts
       this.ctx.abilityQueued = false;
   ```
4. `tick()`, between the post-movement rebuild (line 310) and `updateEnemyProjectiles(ctx, dt);` (line 312):
   ```ts
       updateAbility(ctx, dt);
   ```
   (This exactly mirrors the harness line added in Step 1 — same relative position.)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/gameplay/simulation.test.ts` → PASS, everything including the two new tests (the 15-minute test runs; expect ~1–2 minutes).
Run: `npm run typecheck` → clean (proves game.ts and the Ctx change agree).

**Step 5: Commit**

```bash
git add src/gameplay/context.ts src/gameplay/abilities.ts src/core/events.ts src/game.ts src/gameplay/simulation.test.ts
git commit -m "feat: add updateAbility with nova kind, latch and tick wiring"
```

---

### Task 6: volley kind — paced burst fire

**Files:**
- Modify: `src/gameplay/abilities.ts` (fill in `pumpVolley`, add the `Volley` activation case + `fireVolleyShot`; `nearestEnemy` import)
- Test: `src/gameplay/simulation.test.ts` (1 test)

**Step 1: Write the failing test**

Append inside the `active abilities` block:

```ts
  it('volley: paces Night Swarm bats across the burst window', () => {
    const harness = makeHarness('acolyte');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    const state = ctx.run.ability!;
    // First bat leaves on the activation tick; eleven remain queued.
    expect(state.burstLeft).toBe(11);
    // Exact on the cast tick: the cooldown decrement runs before the latch is
    // consumed, so the fresh 20s value survives the tick untouched.
    expect(state.cooldownLeft).toBe(20);
    expect(
      world.list(Kind.Projectile).filter((id) => world.team[id] === Team.Player).length,
    ).toBeGreaterThanOrEqual(1);

    // Halfway through the 2.4s window roughly half the swarm is out — paced,
    // not dumped in one tick. (Range absorbs one tick of float drift.)
    harness.run(1.2);
    expect(state.burstLeft).toBeGreaterThanOrEqual(4);
    expect(state.burstLeft).toBeLessThanOrEqual(6);

    // Past the window the full dozen has launched.
    harness.run(1.5);
    expect(state.burstLeft).toBe(0);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "Night Swarm"`
Expected: FAIL — `burstLeft` stays 0 (activation has no volley case, the pump is a stub).

**Step 3: Write minimal implementation**

In `src/gameplay/abilities.ts`, extend the weapons import:

```ts
import { nearestEnemy, spawnProjectile } from './weapons.ts';
```

Add the activation case in `activate()`'s switch:

```ts
    case AbilityKind.Volley:
      state.activeLeft = def.duration; // the burst window
      state.burstLeft = def.params.count;
      state.burstTimer = 0;
      pumpVolley(ctx, state, 0); // first shot leaves on the cast tick
      break;
```

Replace the `pumpVolley` stub and add the shot helper:

```ts
/**
 * Releases queued volley shots on a fixed cadence: one every
 * duration/count seconds. Runs from updateAbility while burstLeft > 0, so a
 * burst continues (and finishes) even while the cooldown is already counting.
 */
function pumpVolley(ctx: Ctx, state: AbilityState, dt: number): void {
  state.burstTimer -= dt;
  const interval = state.def.duration / Math.max(1, state.def.params.count);
  while (state.burstTimer <= 0 && state.burstLeft > 0) {
    fireVolleyShot(ctx, state.def);
    state.burstLeft--;
    state.burstTimer += interval;
  }
}

/** One homing bat: aimed near the closest enemy, or a random lane when alone. */
function fireVolleyShot(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  // Recomputed per shot, like weapons re-reading stats per fire, so a passive
  // picked mid-burst applies to the tail of the swarm.
  const stats = abilityStats(run, def);

  const target = nearestEnemy(ctx, px, py);
  const angle =
    target >= 0
      ? Math.atan2(world.y[target]! - py, world.x[target]! - px) + ctx.rng.range(-0.35, 0.35)
      : ctx.rng.angle();

  spawnProjectile(ctx, def.sprite, px, py, Math.cos(angle) * stats.speed, Math.sin(angle) * stats.speed, stats, true);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "Night Swarm"` → PASS. Then the full file: `npx vitest run src/gameplay/simulation.test.ts` → all green.

**Step 5: Commit**

```bash
git add src/gameplay/abilities.ts src/gameplay/simulation.test.ts
git commit -m "feat: add volley ability kind with paced burst fire"
```

---

### Task 7: zone kind — Unhallowed Ground

**Files:**
- Modify: `src/gameplay/abilities.ts` (Zone activation case + `castZone`; `spawnHazard` import)
- Test: `src/gameplay/simulation.test.ts` (1 test)

**Step 1: Write the failing test**

Append inside the `active abilities` block:

```ts
  it('zone: Unhallowed Ground damages a ring over time and its blood obeys the intake cap', () => {
    const harness = makeHarness('dragos');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    const bat = enemyDef('bat')!;
    const ring: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 40, Math.sin(a) * 40);
      world.hp[id] = 1;
      ring.push(id);
    }

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    const zone = world.list(Kind.Hazard).find((id) => world.team[id] === Team.Player);
    expect(zone).toBeDefined();
    expect(world.radius[zone!]).toBeCloseTo(55 * 1.2); // radius x area stat = 66
    expect(world.lifetime[zone!]).toBeCloseTo(6 * 1.2, 1); // lifetime x duration stat

    harness.run(0.5);
    for (const id of ring) expect(world.isAlive(id)).toBe(false);
    // The cap seam, stated: 12 kills x 1 blood x bloodGain 1.25 = 15 offered,
    // but gainBlood multiplies BEFORE the per-second intake cap — the 3 above
    // the 12/sec window are discarded, exactly the Phase 1 semantics.
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run -t "Unhallowed Ground"`
Expected: FAIL — `zone` is undefined (activation has no Zone case yet).

**Step 3: Write minimal implementation**

Extend the weapons import in `src/gameplay/abilities.ts`:

```ts
import { nearestEnemy, spawnHazard, spawnProjectile } from './weapons.ts';
```

Add the activation case:

```ts
    case AbilityKind.Zone:
      castZone(ctx, def);
      break;
```

Add the cast function:

```ts
/**
 * One large lingering hazard at the caster's feet. Interval re-hits, pierce
 * dedup and expiry are all updateHazards' existing behavior — zero new damage
 * code, exactly like the weapon Drop behavior but bigger and on demand.
 */
function castZone(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const px = world.x[ctx.player]!;
  const py = world.y[ctx.player]!;
  const stats = abilityStats(run, def);

  spawnHazard(ctx, def.sprite, px, py, stats.radius, stats.lifetime, stats, stats.interval);
  ctx.fx.shockwave(px, py, '#7a3fa0', 0.45, 7);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run -t "Unhallowed Ground"` → PASS. Full file → all green.

**Step 5: Commit**

```bash
git add src/gameplay/abilities.ts src/gameplay/simulation.test.ts
git commit -m "feat: add zone ability kind"
```

---

### Task 8: buff kind — recompute-on-state-change third source + stats tripwire

**Files:**
- Modify: `src/gameplay/run.ts` (`abilityMods` field near `ability`; fold into `recomputeStats` after the passives loop, line 189)
- Modify: `src/gameplay/abilities.ts` (Buff activation case + `castBuff`; the expiry branch in `updateAbility`; `healPlayer` import)
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the failing tests**

Append inside the `active abilities` block:

```ts
  it('buff: Sanguine Bulwark recomputes stats on state change only and restores them exactly', () => {
    const harness = makeHarness('warden_knight');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills -> no level-ups -> no third-party recomputes
    world.hp[ctx.player] = 50;

    const armorBefore = ctx.run.stats.armor; // 2
    const statsBefore = JSON.stringify(ctx.run.stats);
    const spy = vi.spyOn(ctx.run, 'recomputeStats');
    try {
      ctx.abilityQueued = true;
      harness.run(FIXED_DT);
      expect(ctx.run.stats.armor).toBe(armorBefore + 10);
      // +20 instant heal plus one tick of Aldric's recovery 0.3: updatePlayer's
      // regen runs BEFORE updateAbility in the tick, so the cast tick has
      // already added 0.3 x FIXED_DT (= 0.005) hp when the heal lands.
      expect(world.hp[ctx.player]).toBeCloseTo(70 + 0.3 * FIXED_DT, 3);
      expect(spy).toHaveBeenCalledTimes(1); // activation

      // Ride out the 5s window plus a margin: exactly one more recompute (expiry),
      // and the stat sheet is byte-identical to before the cast — the invariant
      // that the buff never wrote through and never drifted the derived stats.
      harness.run(5.1);
      expect(ctx.run.stats.armor).toBe(armorBefore);
      expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);
      expect(spy).toHaveBeenCalledTimes(2); // activation + expiry, never per tick
    } finally {
      spy.mockRestore();
    }
  });

  it('buff: the instant heal clamps at max health and reports what landed', () => {
    const harness = makeHarness('warden_knight');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    const heals: number[] = [];
    ctx.bus.on('player:healed', (p) => {
      heals.push(p.amount);
    });

    const maxHp = ctx.run.stats.maxHp; // 140
    world.hp[ctx.player] = maxHp - 5; // room for 5 of the 20 the kit grants
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    // healPlayer clamps at run.stats.maxHp; overheal is discarded and the
    // event reports the landed delta, not the requested 20 (cap contract).
    expect(world.hp[ctx.player]).toBeCloseTo(maxHp);
    expect(heals).toHaveLength(1);
    // updatePlayer's recovery regen (0.3 x FIXED_DT) landed before the cast on
    // the same tick, so the heal tops up 5 minus that sliver — not a flat 5.
    expect(heals[0]).toBeCloseTo(5 - 0.3 * FIXED_DT, 3);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "Sanguine Bulwark"`
Expected: FAIL — armor stays 2, hp stays 50 (no Buff activation case, no `abilityMods`).

**Step 3: Write minimal implementation**

`src/gameplay/run.ts` — add after the `ability` field (from Task 3):

```ts
  /**
   * Stat mods from an active buff ability, or null. Set on activation and
   * cleared on expiry inside updateAbility — both state changes — and folded
   * into recomputeStats as its third source. Never touched per tick.
   */
  abilityMods: Partial<StatMods> | null = null;
```

In `recomputeStats()`, after the passives fold loop (closes line 189), before `const previousMaxHp` (line 191):

```ts
    // Third source: an active buff ability. It enters through the same summed
    // mods as passives, so every clamp below applies identically, and the
    // restore on expiry is exact because this derives from scratch.
    if (this.abilityMods) {
      for (const [key, value] of Object.entries(this.abilityMods)) {
        if (value === undefined) continue;
        sum[key as keyof StatMods] += value;
      }
    }
```

`src/gameplay/abilities.ts` — add the import:

```ts
import { healPlayer } from './pickups.ts';
```

Add the activation case:

```ts
    case AbilityKind.Buff:
      castBuff(ctx, def, state);
      break;
```

Fill the expiry branch in `updateAbility` (the `activeLeft` block from Task 5):

```ts
  if (state.activeLeft > 0) {
    state.activeLeft = Math.max(0, state.activeLeft - dt);
    if (state.activeLeft === 0 && state.def.kind === AbilityKind.Buff) {
      // Expiry is a state change — one of exactly two recompute sites the
      // buff owns (the other is activation). Never per tick.
      run.abilityMods = null;
      run.recomputeStats();
    }
  }
```

Add the cast function:

```ts
/**
 * Temporary stat mods through the recompute pipeline plus an instant heal.
 * Activation is state change #1 (mods in, one recompute); expiry in
 * updateAbility is #2 (mods out, one recompute). The heal runs AFTER the
 * recompute so a future maxHp-buffing kit heals against the raised cap;
 * healPlayer clamps at run.stats.maxHp, so overheal is discarded.
 */
function castBuff(ctx: Ctx, def: AbilityDef, state: AbilityState): void {
  const { world, run } = ctx;
  state.activeLeft = def.duration;

  run.abilityMods = def.mods;
  run.recomputeStats();
  if (def.params.heal > 0) healPlayer(ctx, def.params.heal);

  ctx.fx.shockwave(world.x[ctx.player]!, world.y[ctx.player]!, '#d4a15a', 0.4, 6);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "buff:"` → PASS (2 tests). Full file → all green (the Phase 1 frenzy stats-immutability test is the cross-check that the read-side rule survived).

**Step 5: Commit**

```bash
git add src/gameplay/run.ts src/gameplay/abilities.ts src/gameplay/simulation.test.ts
git commit -m "feat: add buff ability kind as a recompute-on-state-change stat source"
```

---

### Task 9: dash kind — map-clamped travel, iframes, mist trail

**Files:**
- Modify: `src/gameplay/abilities.ts` (Dash activation case + `castDash`)
- Test: `src/gameplay/simulation.test.ts` (2 tests)

**Step 1: Write the failing tests**

Append inside the `active abilities` block:

```ts
  it('dash: Mist Dash travels the configured distance, grants iframes and drops a mist trail', () => {
    const harness = makeHarness('outrider');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;

    // Aim persists from init (1, 0); the player stands still (stub input).
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    expect(world.x[ctx.player]).toBeCloseTo(80);
    expect(world.y[ctx.player]).toBeCloseTo(0);
    // Direct x/y write, deliberately NOT world.place: prev stays at the dash
    // origin, so the renderer lerps the dash across one frame (a fast smear).
    // place() would snap with no motion. This assertion is the tripwire.
    expect(world.prevX[ctx.player]).toBeCloseTo(0);
    // iframes = def.duration; set after updatePlayer ran, so exact this tick.
    expect(world.iframe[ctx.player]).toBeCloseTo(0.6, 5);

    const trail = world.list(Kind.Hazard).filter((id) => world.team[id] === Team.Player);
    expect(trail).toHaveLength(3);
    const xs = trail.map((id) => world.x[id]!).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(20);
    expect(xs[1]).toBeCloseTo(40);
    expect(xs[2]).toBeCloseTo(60);
  });

  it('dash: routes through map clamping', () => {
    const harness = makeHarness('outrider');
    const { ctx } = harness;
    ctx.run.weapons.length = 0;
    // A wall at x=30: if the dash teleported without consulting the map,
    // the player would land at 80.
    (ctx.map as { clampToBounds: (x: number, y: number, r: number) => [number, number] }).clampToBounds =
      (x: number, y: number) => [Math.min(x, 30), y];

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(ctx.world.x[ctx.player]).toBeCloseTo(30);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run -t "dash:"`
Expected: FAIL — the player stays at x=0 (no Dash activation case).

**Step 3: Write minimal implementation**

Add the activation case in `src/gameplay/abilities.ts`:

```ts
    case AbilityKind.Dash:
      castDash(ctx, def);
      break;
```

Add the cast function:

```ts
/**
 * Instant reposition along the persistent aim direction, resolved against the
 * map in substeps so the dash cannot tunnel through tiles or runtime solids —
 * the same resolveTiles/resolveSolids/clampToBounds contract updatePlayer
 * honours every tick, applied 8 units at a time (well under half a tile).
 *
 * Position is written to x/y directly, deliberately NOT world.place(): prev
 * keeps the dash origin from this tick's snapshot, so the renderer lerps the
 * whole dash across one frame — a fast, readable smear. place() would set
 * prev == current and hard-snap instead.
 *
 * Takes no AbilityState on purpose: the dash's only timer is the iframe window
 * on world.iframe (activeLeft stays 0), and tsconfig's noUnusedParameters
 * would reject an unused state parameter.
 */
function castDash(ctx: Ctx, def: AbilityDef): void {
  const { world, map, run } = ctx;
  const id = ctx.player;
  const p = def.params;

  // ctx.aimX/aimY is a persistent unit vector (never zero after init).
  const dirX = ctx.aimX;
  const dirY = ctx.aimY;
  const radius = world.radius[id]!;
  const startX = world.x[id]!;
  const startY = world.y[id]!;

  const steps = Math.max(1, Math.ceil(p.distance / 8));
  const step = p.distance / steps;
  let nx = startX;
  let ny = startY;
  for (let i = 0; i < steps; i++) {
    nx += dirX * step;
    ny += dirY * step;
    if (map.hasCollision) {
      [nx, ny] = map.resolveTiles(nx, ny, radius);
      [nx, ny] = map.resolveSolids(nx, ny, radius);
    }
    [nx, ny] = map.clampToBounds(nx, ny, radius);
  }

  world.x[id] = nx;
  world.y[id] = ny;
  world.iframe[id] = def.duration; // ≤ 0.8s by guardrail; updatePlayer ticks it down

  // Mist trail: evenly spaced along the segment actually travelled, so a
  // wall-shortened dash shortens its trail with it.
  const stats = abilityStats(run, def);
  for (let i = 1; i <= p.trailCount; i++) {
    const t = i / (p.trailCount + 1);
    spawnHazard(
      ctx,
      def.sprite,
      startX + (nx - startX) * t,
      startY + (ny - startY) * t,
      stats.radius,
      stats.lifetime,
      stats,
      stats.interval,
    );
  }

  ctx.fx.burst(startX, startY, 8, 70, '#b8c8d8', 0.3, 1);
  ctx.fx.burst(nx, ny, 8, 70, '#b8c8d8', 0.3, 1);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run -t "dash:"` → PASS (2 tests). Full file → all green. `npm run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/gameplay/abilities.ts src/gameplay/simulation.test.ts
git commit -m "feat: add dash ability kind with map-clamped travel and mist trail"
```

---

### Task 10: unify input — Input.injectPress, Space latch in beforeFrame, gamepad, menu clears

The design doc says `injectPress('Space')`; the real `input.ts` has no such method, but the
gamepad path already injects synthetic presses by adding codes to `pressedThisFrame`
(line 128). `injectPress` is that same mechanism made public, so keyboard, HUD tap and
gamepad all converge on one consuming `wasPressed('Space')` read.

This is browser-bound wiring (Input needs `window`; Game is untestable headless), so like
Phase 1's Task 11 the gates are `tsc`, the suite staying green, and a manual dev check.
The sim-side latch semantics are already covered headless (Task 5's latch tests).

**Files:**
- Modify: `src/core/input.ts` (new method after `wasPressed`, line 73; gamepad face button in `readGamepad`, line 128)
- Modify: `src/game.ts` (`beforeFrame` after the KeyQ/KeyE block, lines 266–267; `openLevelUp` line 193; `openPause` line 209)

**Step 1: Implement the wiring**

`src/core/input.ts` — add after `wasPressed()` (line 73):

```ts
  /**
   * Feeds a synthetic key press into the same edge-triggered stream real
   * keydown events use — the public form of what readGamepad already does
   * internally. The HUD ability button and gamepad face buttons route through
   * here so every input source shares one consuming wasPressed() path.
   * Cleared by endFrame() like any real press.
   */
  injectPress(code: string): void {
    this.pressedThisFrame.add(code);
  }
```

In `readGamepad()`, extend the synthetic-press block (lines 127–129):

```ts
    // Surface face/start buttons to menu code as synthetic key presses.
    if (pad.buttons[0]?.pressed) this.pressedThisFrame.add('Enter');
    if (pad.buttons[9]?.pressed) this.pressedThisFrame.add('Escape');
    // West face button (X on the standard mapping) casts the active ability.
    // A held button re-injects every frame — harmless: the sim latch is
    // consumed per tick and the cooldown drops repeat presses anyway.
    if (pad.buttons[2]?.pressed) this.pressedThisFrame.add('Space');
```

`src/game.ts` — in `beforeFrame`, after the KeyQ/KeyE lines (266–267):

```ts
    // Ability cast latches exactly like the blood intents: edge input lives
    // frame-side, updateAbility consumes the latch on the next sim tick.
    if (this.input.wasPressed('Space')) this.ctx.abilityQueued = true;
```

In `openLevelUp()`, next to `this.ctx.bloodIntent = null;` (line 193):

```ts
    this.ctx.abilityQueued = false;
```

In `openPause()`, next to `this.ctx.bloodIntent = null;` (line 209):

```ts
    this.ctx.abilityQueued = false;
```

(The `startRun` reset already landed in Task 5 — no cast survives a menu, a pause or a
restart, mirroring the blood-intent rule.)

**Step 2: Verify types and suite**

Run: `npm run typecheck` → clean. Run: `npx vitest run src/gameplay/simulation.test.ts` → all green (nothing sim-side changed).

**Step 3: Manual dev-server check (browser-bound behavior)**

Run: `npm run dev`, start a run, then confirm:
- Space casts the ability; a second press during cooldown does nothing (no queue-up).
- Open the pause menu with a cast "charged", press Space while paused, resume: no cast fires on resume.
- Space does not scroll the page (the existing preventDefault covers it).
- With a gamepad connected: the west face button casts.

**Step 4: Commit**

```bash
git add src/core/input.ts src/game.ts
git commit -m "feat: unify ability input through injectPress, Space latch and menu clears"
```

---

### Task 11: HUD ability button with conic-gradient cooldown ring

The HUD is browser-bound and deliberately has no headless coverage (CLAUDE.md: verify UI
with `npm run dev`). Gates: `tsc` + suite green + manual check.

**Files:**
- Modify: `src/ui/hud.ts` (fields after `bloodReady` line 45; `cache` line 56; constructor after the frenzy button block ends line 122; `bindAbilityButton` next to `bindBloodButtons` line 138; `update()` after the blood section line 194)
- Modify: `src/ui/style.css` (append after the `@media (pointer: coarse)` block, line 589)
- Modify: `src/game.ts` (constructor, after the `bindBloodButtons` call ends line 117)

**Step 1: Implement the HUD button**

`src/ui/hud.ts` — the Hud class needs `Run`'s ability read; the existing `Run` type import
covers it. Add fields after `private bloodReady = false;` (line 45):

```ts
  private abilityBtn: HTMLButtonElement;
  private abilityIcon: HTMLElement;
  private abilityCd: HTMLElement;
  private abilityCb: (() => void) | null = null;
  private abilityIconName = '';
  private abilityActive = false;
```

Extend the cache literal (line 56) with `abilityCd: -1`:

```ts
  private cache = { hp: '', xp: -1, time: '', level: '', kills: '', gold: '', blood: -1, abilityCd: -1 };
```

In the constructor, after the frenzy-button listener lines (ends line 122), build the
button and add it to the blood cluster (the bottom-centre thumb zone):

```ts
    // Ability button rides the same thumb cluster as the blood taps.
    this.abilityBtn = el('button', 'ability-btn');
    this.abilityIcon = el('div', 'ability-icon');
    this.abilityCd = el('div', 'ability-cd');
    this.abilityBtn.append(this.abilityIcon, this.abilityCd, el('span', 'key-hint', 'SPACE'));
    this.abilityBtn.addEventListener('pointerdown', (ev: PointerEvent) => {
      // Same rules as the blood buttons: primary button only, pointerdown not
      // click (kills the iOS tap delay), stopPropagation away from the future
      // virtual joystick sharing the bottom band.
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.abilityCb?.();
    });
    this.bloodWrap.appendChild(this.abilityBtn);
```

Add next to `bindBloodButtons` (line 138):

```ts
  /** Game injects the callback; the HUD never touches gameplay or Input itself. */
  bindAbilityButton(cb: () => void): void {
    this.abilityCb = cb;
  }
```

In `update()`, after the blood-ready block (ends line 194):

```ts
    // Ability button: poll run.ability, cache-guarded to whole percents like
    // every other per-frame write in this class.
    const ability = run.ability;
    this.abilityBtn.hidden = ability === null;
    if (ability) {
      if (ability.def.icon !== this.abilityIconName) {
        this.abilityIconName = ability.def.icon;
        this.abilityBtn.title = `${ability.def.name} — ${ability.def.description}`;
        this.abilityIcon.replaceChildren(this.sprites.iconCanvas(ability.def.icon, 32));
      }
      const cdPercent =
        ability.def.cooldown > 0
          ? Math.round((ability.cooldownLeft / ability.def.cooldown) * 100)
          : 0;
      if (cdPercent !== this.cache.abilityCd) {
        this.cache.abilityCd = cdPercent;
        this.abilityCd.style.setProperty('--cd', `${cdPercent}%`);
        this.abilityBtn.classList.toggle('ready', cdPercent === 0);
      }
      const active = ability.activeLeft > 0;
      if (active !== this.abilityActive) {
        this.abilityActive = active;
        this.abilityBtn.classList.toggle('active', active);
      }
    }
```

**Step 2: Add the CSS**

Append to `src/ui/style.css` (after line 589):

```css
/* --- Ability button, in the blood cluster ------------------------------- */

.ability-btn {
  position: relative;
  width: calc(var(--u) * 18);
  height: calc(var(--u) * 18);
  border-radius: 50%;
  border: var(--u) solid var(--edge);
  background: var(--panel);
  color: var(--ink-faint);
  font: inherit;
  font-size: calc(var(--u) * 3.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(var(--u) * 0.5);
  padding: 0;
  overflow: hidden;
  touch-action: none;
}

/* The display: flex above beats the UA stylesheet's [hidden] { display: none },
   so the fail-soft path (ability dropped by the normalizer -> hidden attribute
   set in update()) needs an explicit author rule or the dead button stays. */
.ability-btn[hidden] {
  display: none;
}

.ability-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.ability-icon canvas {
  width: calc(var(--u) * 9);
  height: calc(var(--u) * 9);
  image-rendering: pixelated;
}

/* Cooldown sweep: --cd is the REMAINING fraction as a percent, so the shade
   shrinks clockwise toward zero and vanishes when the ability is ready. */
.ability-cd {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(rgba(0, 0, 0, 0.65) var(--cd, 0%), transparent 0);
  pointer-events: none;
}

.ability-btn.ready {
  color: var(--ink);
  border-color: #d4a15a;
  animation: ability-pulse 1.2s ease-in-out infinite;
}

.ability-btn.active {
  border-color: #d94a5e;
}

@keyframes ability-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(212, 161, 90, 0);
  }
  50% {
    box-shadow: 0 0 0 calc(var(--u) * 2) rgba(212, 161, 90, 0.35);
  }
}
```

(The `SPACE` hint reuses the existing `.key-hint` class, already hidden under
`@media (pointer: coarse)`.)

**Step 3: Wire the button in Game**

`src/game.ts` constructor, after the `bindBloodButtons` call (ends line 117):

```ts
    this.hud.bindAbilityButton(() => {
      // Through the synthetic-press path, not a direct latch write: touch,
      // keyboard and gamepad all converge on the one consuming wasPressed
      // read in beforeFrame.
      if (this.state === 'playing') this.input.injectPress('Space');
    });
```

**Step 4: Verify types, suite, and the browser**

Run: `npm run typecheck` → clean. Run: `npx vitest run src/gameplay/simulation.test.ts` → all green.
Then `npm run dev` and confirm: the ring fills as the cooldown runs and vanishes at ready;
the button pulses gold when ready and shows a red border while a buff/volley window is
active; tapping it casts (and does nothing during cooldown); each character shows its own
icon; the SPACE hint hides in responsive/touch emulation.

**Step 5: Commit**

```bash
git add src/ui/hud.ts src/ui/style.css src/game.ts
git commit -m "feat: add HUD ability button with conic-gradient cooldown ring"
```

---

### Task 12: kit activation sweep + seeded-run determinism + auto-press leak bound

**Files:**
- Test: `src/gameplay/simulation.test.ts` (3 tests)

**Step 1: Write the failing tests**

(They fail only if earlier tasks regressed — this is the integration tripwire pair the
design's test list asks for.)

Append inside the `active abilities` block:

```ts
  it('activates every character kit without error and engages its cooldown', () => {
    for (const character of CHARACTER_LIST) {
      const harness = makeHarness(character.id);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;

      const used: string[] = [];
      ctx.bus.on('ability:used', (p) => {
        used.push(p.kind);
      });

      ctx.abilityQueued = true;
      harness.run(1);

      const state = ctx.run.ability;
      expect(state, `${character.id} has no ability state`).not.toBeNull();
      expect(used, `${character.id} did not cast`).toHaveLength(1);
      expect(used[0]).toBe(character.ability!.kind);
      expect(state!.cooldownLeft).toBeCloseTo(state!.def.cooldown - 1, 1);
      expect(ctx.abilityQueued).toBe(false);
    }
  });

  it('keeps seeded runs deterministic with an ability cast mid-run', () => {
    const fingerprint = () => {
      const harness = makeHarness('dragos', 4242);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(5);
      ctx.abilityQueued = true;
      harness.run(25);
      return [
        ctx.run.kills,
        ctx.run.blood,
        ctx.run.gold,
        ctx.run.level,
        ctx.world.entityCount,
        ctx.run.ability!.cooldownLeft,
      ];
    };
    // Identical seed + identical inputs => identical world. Any Math.random or
    // wall-clock leak in the ability path breaks this instantly.
    expect(fingerprint()).toEqual(fingerprint());
  });

  // The design-§2 leak variant: the pre-existing 15-minute test never presses
  // the ability, so this is the only bound on ability entity pressure (nova
  // ring + zone + dash-trail hazards, cycle after cycle). Mirrors the existing
  // leak test's shape: immortal player, chunked run, 4000-entity ceiling.
  it('does not leak entities over a 15-minute run that auto-presses the ability', { timeout: 120_000 }, () => {
    const harness = makeHarness('dragos', 4242);
    const { ctx } = harness;
    const world = ctx.world;
    const victory = ctx.wave.victorySeconds;
    const chunk = 15;
    for (let elapsed = 0; elapsed < victory; elapsed += chunk) {
      world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      // Cast whenever the ability is off cooldown at a chunk boundary.
      if (ctx.run.ability!.cooldownLeft === 0) ctx.abilityQueued = true;
      harness.run(chunk);
      // The pool is 16384; anything approaching that is a leak, not load.
      expect(world.entityCount).toBeLessThan(4000);
    }
    expect(ctx.run.time).toBeGreaterThan(victory - FIXED_DT);
  });
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run -t "active abilities"`
Expected: PASS — all 19 tests in the block (the auto-press leak run takes 1–2 minutes,
like the existing 15-minute test). If the sweep or determinism test fails, an earlier task
regressed: stop and diagnose, don't patch the test.

**Step 3: Commit**

```bash
git add src/gameplay/simulation.test.ts
git commit -m "test: cover kit activation, seeded-run determinism and ability leak pressure"
```

---

### Task 13: full verification + squash merge

**Files:** none (verification only)

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean, zero errors.

**Step 2: Full suite**

Run: `npm test`
Expected: ALL tests pass, including:
- the pre-existing suite (content, progression, simulation, difficulty scaling, blood
  economy — the 15-minute full-run determinism/leak test is the invariant tripwire and
  MUST be green)
- the 19 new `active abilities` tests:
  1. normalizes a valid ability block and defaults missing params
  2. omits abilities with unknown kinds and warns instead of throwing
  3. gives every character a gothic kit with a whitelisted ability
  4. keeps every kit inside the ability guardrails
  5. ships Castellan Dragos as the bloodGain 1.25 vampire-lord
  6. seeds Run.ability ready-to-cast from the character def
  7. builds ability stats scaled by might, area and duration only
  8. applies frenzy to ability damage read-side, like effectiveStats
  9. nova: fires Crimson Cleave as a ring of player projectiles on the latched press
  10. drops an ability press made during cooldown instead of banking it
  11. volley: paces Night Swarm bats across the burst window
  12. zone: Unhallowed Ground damages a ring over time and its blood obeys the intake cap
  13. buff: Sanguine Bulwark recomputes stats on state change only and restores them exactly
  14. buff: the instant heal clamps at max health and reports what landed
  15. dash: Mist Dash travels the configured distance, grants iframes and drops a mist trail
  16. dash: routes through map clamping
  17. activates every character kit without error and engages its cooldown
  18. keeps seeded runs deterministic with an ability cast mid-run
  19. does not leak entities over a 15-minute run that auto-presses the ability

**Step 3: Self-review the diff**

Run: `git diff main...HEAD --stat` then `git diff main...HEAD`
Check against the invariants: no `Math.random` in gameplay paths, no wall-clock timers,
`Game.tick()` and the harness tick identical around `updateAbility`, `run.stats` never
assigned outside `recomputeStats()`, every spawn site tolerating `create() === -1` (the
spawn primitives already do), `registerHit` riding the existing updaters, ability cooldown
untouched by `run.stats.cooldown` and `frenzy.cooldownMult`.

**Step 4: Manual device sanity (browser-bound surface)**

`npm run dev`: play one run per character; confirm the crypt map (`hasCollision`) stops a
dash at walls, the HUD ring/pulse behaves, and no cast survives pause or level-up.

**Step 5: Squash merge (ask the user before each git command)**

```bash
git checkout main
git merge --squash feat/phase-2-active-abilities
git commit -m "feat: character active abilities — five gothic kits on cooldown (mobile v1 phase 2)"
```
Keep the phase branch until the user confirms deletion. Then reassess (per the roadmap's
just-in-time rule) before writing the Phase 3 plan.

---

## Notes for the executor

- **Never edit `Game.tick()` without the identical harness edit in the same commit** —
  Task 5 is the only task that touches tick order. `updateAbility` sits between the
  post-movement `enemyHash.build` and `updateEnemyProjectiles` in BOTH.
- If any test fails twice with the same error: stop, re-read the relevant source file in
  full, do not blind-retry (execution discipline rules).
- All kit tuning lives in `src/content/characters.json` and hot-reloads in the dev
  server — balance passes need no code changes.
- Task 5 ships `updateAbility` with the buff-expiry branch *empty* (Task 8 fills it) and
  `pumpVolley` as a stub (Task 6 fills it) — the file compiles green at every commit.
- In `updateAbility` the cooldown decrement stays ABOVE the latch consumption — do not
  reorder them. On the cast tick nothing decrements the freshly set cooldown, which is why
  the nova/volley tests assert the exact `def.cooldown` value, and moving activation above
  the decrement would double-count the cast tick and break the `ability:ready` ordering in
  the "drops an ability press" test.
- The dash writes `world.x/y` directly on purpose; the `prevX` assertion in the dash test
  is the tripwire against someone "fixing" it to `world.place()`.
- The volley mid-window assertion uses a ±1 range because burst cadence accumulates
  float dt; the endpoints (1 fired on cast tick, 0 left after the window) are exact.
- Deliberately out of scope (stated, per the no-silent-trim rule): automated ≤25%-DPS
  share check (manual balance-pass criterion), real ability icon art (placeholders ship),
  gamepad held-button re-injection debounce (cooldown makes it harmless), rewarded-ad
  cooldown resets (Phase 6), touch joystick interplay (Phase 5), a blood payout on
  `siege:defended` (Phase 3).

