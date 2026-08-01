# Mobile Platform Layer Implementation Plan (Phase 5)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The game runs as a landscape iOS Capacitor app: a floating left-half touch joystick and a pause button feed the existing `Input` seams, backgrounding auto-pauses an active run, a bus-driven WebAudio engine makes the game audible with zero asset files (oscillator synth placeholders), Capacitor haptics buzz on the big moments, and the DOM UI respects notch/home-indicator safe areas — all without touching the simulation or `simulation.test.ts`.

**Architecture:** A new `src/platform/` layer — `joystick.ts` (pure touch-point→axis math), `voices.ts` (pure voice-cap/throttle logic), `audio-map.ts` (fail-soft normalization of the new `src/content/audio.json`), `touch.ts` (`TouchControls`: DOM joystick + pause button), `lifecycle.ts` (visibilitychange + Capacitor App pause → `Game.autoPause()`), `audio.ts` (`AudioEngine`, subscribes to the EventBus), `haptics.ts` (`HapticsDriver`, ditto). The engine (`src/core`, `src/ecs`, `src/gameplay`, `src/render`) **never imports platform** — the Phase-4 isolation gate is extended to enforce it, and a second direction is added: platform imports only `src/core` types and `src/content` JSON, never gameplay/ecs/render/services. The two engine touch-points are both in `src/core/input.ts` and both additive: the existing `injectPress()` seam (Phase 2) carries touch buttons unchanged, and a new `attachAxisSource()` seam carries joystick movement into the same `normalize()` path the keyboard and gamepad already share. `game.ts` and `main.ts` (orchestrators, outside the gate) do all the wiring. Capacitor wraps `dist/` — vite already has `base: './'` and `assetsInlineLimit: 0`, so the web build is Capacitor-ready without config changes.

**Tech Stack:** TypeScript strict with `verbatimModuleSyntax` (type-only imports MUST be separate `import type` lines), Vitest headless in the node environment (no jsdom — headless tests construct `Input` with a plain `EventTarget` and test platform logic as pure functions or against hand-rolled fakes). New dependencies are **`@capacitor/core`, `@capacitor/ios`, `@capacitor/app`, `@capacitor/haptics`** (dependencies) and **`@capacitor/cli`** (devDependency) — *nothing else*, per the locked constraint (no `@capacitor-community/*`, no audio libs, no asset pipelines).

---

**Design source:** `docs/plans/2026-07-30-mobile-v1-design.md` §5 ("Mobile Platform Layer") and the roadmap's Phase 5 section. **Locked scope deviations (reassessment decisions — honor them):**

1. **`TouchControls` lives in `src/platform/touch.ts`, not `src/core/touch.ts`** (the design doc predates the Phase-4 layering). Core gains only the minimal seam that cannot live outside it: `Input.attachAxisSource()`. `injectPress()` already exists (Phase 2, `input.ts:84`) — do not add a second press seam.
2. **`audio.json` normalization lives in the platform layer** (`src/platform/audio-map.ts`), NOT in `src/gameplay/content.ts` — the design's "content.ts style" means the *warn-don't-throw philosophy*, not the file. Gameplay never learns audio exists; the isolation gate stays green in both directions.
3. **`@capacitor-community/keep-awake` is EXCLUDED** (constraint: `@capacitor/*` only). Keep-awake behavior is *documented* instead: the one-line native option (`application.isIdleTimerDisabled = true` in `AppDelegate.swift`) is a manual checklist item in Task 12, applied by hand on the Mac, never an npm dependency.
4. **Music (`title_theme`, `battle_loop`) is deferred** — Phase 5 ships synth SFX only (zero asset files). `audio.json`'s schema does not need to change when real recorded SFX/music land later; that is an asset swap plus an `audio.ts` decode path, a follow-up.
5. **EXCLUDED (Phase 6):** AdMob, IAP, StoreKit, ATT prompt, PrivacyInfo.xcprivacy tracking-domain merges, App Store metadata/rating work. The plist edits in this phase are only what the *app itself* needs (landscape lock, non-exempt encryption).
6. **Mac-toolchain steps are manual-checklist items, not agent steps:** `pod install`, Xcode builds, signing, on-device runs. The agent's gate for scaffold tasks is `npm run build && npx cap sync ios` succeeding (the copy step) plus `tsc`/suite green.

**Test placement:** pure platform logic tests go in a new `src/platform/platform.test.ts` (joystick, voices, audio-map, lifecycle — one file, four describes, mirroring how Phase 4 pooled service tests in `meta.test.ts`). The input-seam tests go in a new `src/core/input.test.ts`. The isolation gate stays in `src/services/isolation.test.ts` and is extended in place. Vitest discovers all of these with its default glob — no config change. **`src/gameplay/simulation.test.ts` is not edited in this phase. If you find yourself editing it, stop — you've left the phase's scope.**

## Setup

```bash
cd /Users/boraesen/Desktop/Vampire_knights
git checkout -b feat/phase-5-mobile-platform
npm test   # confirm the suite is green (106 tests at Phase 4 close; the runner's count is authoritative) before touching anything
```
Expected: all existing tests pass. (Git operations and `npm install` require user approval per house rules — ask before each commit/checkout/install.)

---

### Task 1: Capacitor iOS scaffold — deps, config, .gitignore, ios/ project

Non-TDD (toolchain + generated project — nothing headless can assert). Gates: `tsc` clean, suite green, `npx cap sync ios` copy step succeeding, manual checklist. **This task must run before Tasks 8 and 10** — their `import('@capacitor/app')` / `import('@capacitor/haptics')` dynamic imports need the packages resolvable or `tsc` and the vite build fail.

**Files:**
- Create: `capacitor.config.ts` (repo root)
- Modify: `.gitignore`, `package.json` (+`cap:sync` script)
- Generated: `ios/` (committed per Capacitor convention, minus the ignored artifacts)

**Step 1: Install the five packages (ask the user first — house rule)**

```bash
npm install @capacitor/core @capacitor/ios @capacitor/app @capacitor/haptics
npm install -D @capacitor/cli
```
Expected: `package.json` gains exactly these five; nothing else. Any transitive prompt to add another package → stop and report.

**Step 2: Write `capacitor.config.ts`**

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stimilon.vampireknights',
  appName: 'Vampire Knights',
  webDir: 'dist',
  // Matches the body background in src/ui/style.css so the letterbox and any
  // pre-paint flash are the same black as the game's own frame.
  backgroundColor: '#05060a',
  ios: {
    // The canvas letterboxes itself; WKWebView must never add its own insets.
    contentInset: 'never',
  },
};

export default config;
```

Note: `tsconfig.json` includes only `src/`, so this file is compiled by the Capacitor CLI, not by `npm run typecheck` — keep it dependency-free and boring.

**Step 3: Add the `cap:sync` script to `package.json`**

Add one entry to the `"scripts"` block — exact edit, appended after `"test:watch"`:

```json
"cap:sync": "npm run build && npx cap sync ios"
```

so the block reads:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview --port 4173",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "cap:sync": "npm run build && npx cap sync ios"
}
```

Nothing else in `package.json` changes by hand (Step 1's install already touched `dependencies`/`devDependencies`).

**Step 4: Extend `.gitignore`**

Append:

```
# Capacitor iOS — the project is committed, build artifacts are not
ios/App/Pods/
ios/App/build/
ios/App/output/
ios/App/App/public/
ios/App/App/capacitor.config.json
ios/capacitor-cordova-ios-plugins/
ios/DerivedData/
```

(`ios/App/App/public/` is the `cap sync` copy of `dist/` — regenerated every sync, never hand-edited, so it stays out of git exactly like `dist/` itself.)

**Step 5: Generate the iOS project and first sync**

```bash
npm run build
npx cap add ios
npx cap sync ios
```
Expected: `ios/` appears; `cap sync` reports `Sync finished` after copying web assets. If `cap add`/`cap sync` warns that CocoaPods is missing, that is acceptable at this step — the copy phase still completes; `pod install` is a Task 12 manual item. Any *other* error → stop and report.

**Step 6: Landscape-lock the plist**

Edit `ios/App/App/Info.plist`: replace the `UISupportedInterfaceOrientations` array (and add the `~ipad` variant + encryption key) so the only entries are:

```xml
<key>UISupportedInterfaceOrientations</key>
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
<key>UISupportedInterfaceOrientations~ipad</key>
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

**Step 7: Verify nothing regressed**

Run: `npm run typecheck` — clean.
Run: `npm test` — suite green, unchanged count (no test touches Capacitor).
Run: `git status` — `ios/App/Pods/` etc. must NOT appear (the ignore works).

**Manual checklist (deferred to Task 12 if no Mac/Xcode session now):**
- [ ] `cd ios/App && pod install` succeeds (CocoaPods toolchain)
- [ ] Project opens in Xcode via `npx cap open ios`, signs with the team, builds

**Step 8: Commit (ask the user first)**

```bash
git add capacitor.config.ts .gitignore package.json package-lock.json ios/
git commit -m "chore: capacitor ios scaffold - config, landscape plist and gitignored artifacts"
```

---

### Task 2: Pure joystick math — `src/platform/joystick.ts`

**Files:**
- Create: `src/platform/joystick.ts`
- Create: `src/platform/platform.test.ts`

**Step 1: Write the failing tests**

Create `src/platform/platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { joystickVector, nubOffset } from './joystick.ts';

describe('joystick math', () => {
  it('returns zero inside the deadzone', () => {
    expect(joystickVector(100, 100, 104, 103, 10)).toEqual([0, 0]);
    expect(joystickVector(100, 100, 100, 100, 10)).toEqual([0, 0]);
  });

  it('returns the unit direction toward the touch beyond the deadzone', () => {
    const [x, y] = joystickVector(100, 100, 160, 100, 10);
    expect(x).toBeCloseTo(1, 5);
    expect(y).toBeCloseTo(0, 5);
    const [ux, uy] = joystickVector(0, 0, -30, 40, 10);
    expect(ux).toBeCloseTo(-0.6, 5);
    expect(uy).toBeCloseTo(0.8, 5);
  });

  it('is direction-only: any distance past the deadzone is full deflection', () => {
    const near = joystickVector(0, 0, 11, 11, 10);
    const far = joystickVector(0, 0, 500, 500, 10);
    expect(near[0]).toBeCloseTo(far[0], 5);
    expect(near[1]).toBeCloseTo(far[1], 5);
    expect(Math.hypot(far[0], far[1])).toBeCloseTo(1, 5);
  });

  it('nubOffset passes raw offsets inside the radius', () => {
    expect(nubOffset(100, 100, 110, 105, 24)).toEqual([10, 5]);
  });

  it('nubOffset clamps to the radius while keeping direction', () => {
    const [x, y] = nubOffset(0, 0, 60, 80, 24);
    expect(Math.hypot(x, y)).toBeCloseTo(24, 5);
    expect(x).toBeCloseTo(14.4, 5);
    expect(y).toBeCloseTo(19.2, 5);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/`
Expected: FAIL — cannot resolve `./joystick.ts`.

**Step 3: Write minimal implementation**

Create `src/platform/joystick.ts`:

```ts
/**
 * Pure math for the floating touch joystick. Direction-only on purpose: like
 * the keyboard, the stick controls heading, never speed — `Input` runs the
 * result through the same `normalize()` the arrow keys use, so movement is
 * always full speed and diagonal isn't faster than cardinal. Distances are in
 * CSS pixels (Touch.clientX space).
 */

/**
 * Touch point → movement direction. Inside `deadzone` px of the anchor the
 * stick is neutral; beyond it, the unit vector from anchor to touch.
 */
export function joystickVector(
  baseX: number,
  baseY: number,
  curX: number,
  curY: number,
  deadzone: number,
): [number, number] {
  const dx = curX - baseX;
  const dy = curY - baseY;
  const len = Math.hypot(dx, dy);
  if (len < deadzone) return [0, 0];
  return [dx / len, dy / len];
}

/**
 * Visual nub position relative to the joystick base: the raw finger offset,
 * clamped to `radius` px so the nub never escapes the base ring.
 */
export function nubOffset(
  baseX: number,
  baseY: number,
  curX: number,
  curY: number,
  radius: number,
): [number, number] {
  const dx = curX - baseX;
  const dy = curY - baseY;
  const len = Math.hypot(dx, dy);
  if (len <= radius) return [dx, dy];
  return [(dx / len) * radius, (dy / len) * radius];
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/`
Expected: PASS (5 tests).
Run: `npm run typecheck`
Expected: clean.

**Step 5: Commit**

```bash
git add src/platform/joystick.ts src/platform/platform.test.ts
git commit -m "feat: pure joystick math for the touch platform layer"
```

---

### Task 3: Voice cap + throttle logic — `src/platform/voices.ts`

**Files:**
- Create: `src/platform/voices.ts`
- Test: `src/platform/platform.test.ts` (new describe)

**Step 1: Write the failing tests**

Append to `src/platform/platform.test.ts` (and extend the import line):

```ts
import { MAX_VOICES, RateGate, VoiceAllocator } from './voices.ts';
```

```ts
describe('voice allocation', () => {
  it('caps concurrent voices at MAX_VOICES', () => {
    const voices = new VoiceAllocator();
    for (let i = 0; i < MAX_VOICES; i++) {
      expect(voices.tryAcquire(`sound-${i}`, 1000, 500, 0)).toBe(true);
    }
    expect(voices.tryAcquire('one-too-many', 1000, 500, 0)).toBe(false);
    expect(voices.active).toBe(MAX_VOICES);
  });

  it('frees voices whose duration has elapsed', () => {
    const voices = new VoiceAllocator();
    for (let i = 0; i < MAX_VOICES; i++) voices.tryAcquire(`sound-${i}`, 1000, 100, 0);
    // At t=1100 every 100ms voice has ended; a new one fits again.
    expect(voices.tryAcquire('later', 1100, 100, 0)).toBe(true);
    expect(voices.active).toBe(1);
  });

  it('throttles repeats of the same sound inside its window', () => {
    const voices = new VoiceAllocator();
    expect(voices.tryAcquire('hit', 1000, 60, 50)).toBe(true);
    expect(voices.tryAcquire('hit', 1030, 60, 50)).toBe(false); // 30ms later: blocked
    expect(voices.tryAcquire('hit', 1050, 60, 50)).toBe(true); // window elapsed
  });

  it('throttles per sound id, not globally', () => {
    const voices = new VoiceAllocator();
    expect(voices.tryAcquire('hit', 1000, 60, 50)).toBe(true);
    expect(voices.tryAcquire('coin', 1010, 60, 50)).toBe(true); // different id: free to play
  });

  it('RateGate blocks inside the interval and reopens after it', () => {
    const gate = new RateGate(100);
    expect(gate.try(1000)).toBe(true);
    expect(gate.try(1099)).toBe(false);
    expect(gate.try(1100)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/`
Expected: FAIL — cannot resolve `./voices.ts`.

**Step 3: Write minimal implementation**

Create `src/platform/voices.ts`:

```ts
/**
 * Pure scheduling logic for the platform layer's outputs, kept free of
 * WebAudio/Capacitor so it runs headless. Times are caller-supplied
 * milliseconds (performance.now() in the browser, literals in tests) — no
 * wall-clock reads in here.
 */

/** WebAudio voice budget: 400 enemies must not machine-gun the mixer. */
export const MAX_VOICES = 8;

/** Simple "no more than one per interval" gate (haptics, global limits). */
export class RateGate {
  private last = -Infinity;

  constructor(private readonly intervalMs: number) {}

  try(nowMs: number): boolean {
    if (nowMs - this.last < this.intervalMs) return false;
    this.last = nowMs;
    return true;
  }
}

/**
 * Concurrent-voice cap plus a per-sound throttle. `tryAcquire` is the single
 * question the audio engine asks before synthesizing: "may this sound start
 * right now?" — false means drop it silently (overflow policy matches the fx
 * pools: drop, never queue).
 */
export class VoiceAllocator {
  /** End timestamps (ms) of currently sounding voices. */
  private readonly ends: number[] = [];
  private readonly lastBySound = new Map<string, number>();

  constructor(private readonly maxVoices: number = MAX_VOICES) {}

  tryAcquire(soundId: string, nowMs: number, durationMs: number, throttleMs: number): boolean {
    const last = this.lastBySound.get(soundId);
    if (last !== undefined && nowMs - last < throttleMs) return false;

    // Retire finished voices before counting.
    for (let i = this.ends.length - 1; i >= 0; i--) {
      if (this.ends[i]! <= nowMs) this.ends.splice(i, 1);
    }
    if (this.ends.length >= this.maxVoices) return false;

    this.ends.push(nowMs + durationMs);
    this.lastBySound.set(soundId, nowMs);
    return true;
  }

  get active(): number {
    return this.ends.length;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/`
Expected: PASS (10 tests).

**Step 5: Commit**

```bash
git add src/platform/voices.ts src/platform/platform.test.ts
git commit -m "feat: voice allocator and rate gate for audio and haptic throttling"
```

---
### Task 4: audio.json + fail-soft normalization — `src/platform/audio-map.ts`

**Files:**
- Create: `src/content/audio.json`
- Create: `src/platform/audio-map.ts`
- Test: `src/platform/platform.test.ts` (new describe)

**Step 1: Write the failing tests**

Append to `src/platform/platform.test.ts` (extend imports; `vi` joins the vitest import):

```ts
import { describe, expect, it, vi } from 'vitest';

import audioJson from '../content/audio.json';
import { AUDIO_MAP, normalizeAudioMap } from './audio-map.ts';
```

```ts
describe('audio map', () => {
  it('normalizes the production audio.json without warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // AUDIO_MAP was built at module load, before this spy existed — so
    // re-normalize the same source *under* the spy: a typo in audio.json
    // fails here, not on a device.
    const defs = normalizeAudioMap(audioJson as Record<string, Record<string, unknown>>);
    expect(defs.length).toBe(Object.keys(audioJson).length); // nothing dropped
    expect(AUDIO_MAP.length).toBe(defs.length); // the module-load build matches
    for (const def of defs) {
      expect(def.duration).toBeGreaterThan(0);
      expect(def.volume).toBeGreaterThan(0);
      expect(def.volume).toBeLessThanOrEqual(1);
      expect(def.throttleMs).toBeGreaterThanOrEqual(0);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops entries for unknown events with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = normalizeAudioMap({
      'player:damaged': { wave: 'square', freq: 200, duration: 0.1, volume: 0.5 },
      'player:exploded': { wave: 'square', freq: 200, duration: 0.1, volume: 0.5 },
    });
    expect(defs).toHaveLength(1);
    expect(defs[0]!.event).toBe('player:damaged');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops entries with an unknown wave or unusable freq, keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs = normalizeAudioMap({
      'player:damaged': { wave: 'kazoo', freq: 200, duration: 0.1, volume: 0.5 },
      'player:levelup': { wave: 'sine', freq: -5, duration: 0.1, volume: 0.5 },
      'blood:ready': { wave: 'sine', freq: 300, duration: 0.1, volume: 0.5 },
    });
    expect(defs).toHaveLength(1);
    expect(defs[0]!.event).toBe('blood:ready');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('defaults and clamps duration, volume, freqEnd and throttle', () => {
    const defs = normalizeAudioMap({
      'player:levelup': { wave: 'triangle', freq: 500, duration: 99, volume: 7 },
    });
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.duration).toBe(2); // clamped to the 2s ceiling
    expect(def.volume).toBe(1); // clamped into 0..1
    expect(def.freqEnd).toBe(500); // defaults to freq (no sweep)
    expect(def.throttleMs).toBe(50); // design default: per-sound 50ms
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/`
Expected: FAIL — cannot resolve `./audio-map.ts`.

**Step 3: Write minimal implementation**

Create `src/content/audio.json` — every key is a `GameEvents` name; every value is a synth recipe (all tuning lives here, hot-reloads in dev):

```json
{
  "player:damaged": { "wave": "square", "freq": 190, "freqEnd": 70, "duration": 0.14, "volume": 0.55, "throttleMs": 120 },
  "player:healed": { "wave": "sine", "freq": 420, "freqEnd": 620, "duration": 0.18, "volume": 0.35, "throttleMs": 150 },
  "player:died": { "wave": "sawtooth", "freq": 220, "freqEnd": 40, "duration": 0.9, "volume": 0.6, "throttleMs": 0 },
  "player:levelup": { "wave": "triangle", "freq": 520, "freqEnd": 1040, "duration": 0.3, "volume": 0.5, "throttleMs": 200 },
  "run:victory": { "wave": "triangle", "freq": 392, "freqEnd": 784, "duration": 0.8, "volume": 0.6, "throttleMs": 0 },
  "enemy:killed": { "wave": "square", "freq": 140, "freqEnd": 60, "duration": 0.06, "volume": 0.18, "throttleMs": 70 },
  "gold:gained": { "wave": "sine", "freq": 880, "freqEnd": 1320, "duration": 0.07, "volume": 0.2, "throttleMs": 90 },
  "xp:gained": { "wave": "sine", "freq": 660, "freqEnd": 720, "duration": 0.05, "volume": 0.12, "throttleMs": 120 },
  "boss:spawned": { "wave": "sawtooth", "freq": 110, "freqEnd": 55, "duration": 0.6, "volume": 0.6, "throttleMs": 0 },
  "blood:ready": { "wave": "triangle", "freq": 300, "freqEnd": 600, "duration": 0.25, "volume": 0.45, "throttleMs": 300 },
  "blood:feast": { "wave": "sine", "freq": 500, "freqEnd": 250, "duration": 0.35, "volume": 0.5, "throttleMs": 200 },
  "blood:frenzy": { "wave": "sawtooth", "freq": 160, "freqEnd": 320, "duration": 0.4, "volume": 0.55, "throttleMs": 200 },
  "ability:used": { "wave": "square", "freq": 340, "freqEnd": 170, "duration": 0.2, "volume": 0.5, "throttleMs": 150 },
  "ability:ready": { "wave": "triangle", "freq": 440, "freqEnd": 880, "duration": 0.15, "volume": 0.4, "throttleMs": 300 },
  "structure:destroyed": { "wave": "sawtooth", "freq": 90, "freqEnd": 30, "duration": 0.5, "volume": 0.6, "throttleMs": 200 },
  "siege:started": { "wave": "sawtooth", "freq": 130, "freqEnd": 90, "duration": 0.5, "volume": 0.55, "throttleMs": 0 },
  "siege:defended": { "wave": "triangle", "freq": 392, "freqEnd": 588, "duration": 0.4, "volume": 0.5, "throttleMs": 0 },
  "character:unlocked": { "wave": "triangle", "freq": 523, "freqEnd": 1046, "duration": 0.5, "volume": 0.55, "throttleMs": 0 },
  "meta:purchased": { "wave": "sine", "freq": 700, "freqEnd": 1050, "duration": 0.12, "volume": 0.4, "throttleMs": 100 }
}
```

Create `src/platform/audio-map.ts`:

```ts
import type { GameEvents } from '../core/events.ts';

import audioJson from '../content/audio.json';

export type WaveKind = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface SoundDef {
  event: keyof GameEvents;
  wave: WaveKind;
  /** Oscillator start frequency, Hz. */
  freq: number;
  /** Sweep target; equal to freq means a flat tone. */
  freqEnd: number;
  /** Seconds, clamped to 0.02..2 — placeholder blips, not songs. */
  duration: number;
  /** 0..1 pre-master gain. */
  volume: number;
  /** Per-sound minimum gap; the design default is 50ms. */
  throttleMs: number;
}

const WAVES: readonly WaveKind[] = ['sine', 'square', 'sawtooth', 'triangle'];

// Typed as keyof GameEvents so a typo here is a compile error, and membership
// checks against it catch typos in audio.json at runtime (warn, not throw).
const KNOWN_EVENTS: ReadonlySet<string> = new Set<keyof GameEvents>([
  'player:damaged',
  'player:healed',
  'player:died',
  'player:levelup',
  'run:victory',
  'xp:gained',
  'enemy:killed',
  'gold:gained',
  'boss:spawned',
  'stats:changed',
  'blood:gained',
  'blood:ready',
  'blood:feast',
  'blood:frenzy',
  'ability:used',
  'ability:ready',
  'structure:damaged',
  'structure:destroyed',
  'siege:started',
  'siege:defended',
  'run:ended',
  'meta:goldBanked',
  'meta:purchased',
  'character:unlocked',
]);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Same fail-soft contract as gameplay content: a typo in audio.json costs one
 * sound, never the game (and never a throw on a device). Takes the raw record
 * rather than reading the import directly so the fail-soft paths are reachable
 * from tests; production always passes audio.json.
 */
export function normalizeAudioMap(raw: Record<string, Record<string, unknown>>): SoundDef[] {
  const defs: SoundDef[] = [];

  for (const [event, entry] of Object.entries(raw)) {
    if (!KNOWN_EVENTS.has(event)) {
      console.warn(`[audio] "${event}" is not a GameEvents name; entry skipped`);
      continue;
    }
    const wave = entry['wave'];
    if (typeof wave !== 'string' || !WAVES.includes(wave as WaveKind)) {
      console.warn(`[audio] "${event}" has unknown wave "${String(wave)}"; entry skipped`);
      continue;
    }
    const freq = entry['freq'];
    if (typeof freq !== 'number' || !Number.isFinite(freq) || freq <= 0) {
      console.warn(`[audio] "${event}" has unusable freq ${String(freq)}; entry skipped`);
      continue;
    }

    const freqEndRaw = entry['freqEnd'];
    const durationRaw = entry['duration'];
    const volumeRaw = entry['volume'];
    const throttleRaw = entry['throttleMs'];

    defs.push({
      event: event as keyof GameEvents,
      wave: wave as WaveKind,
      freq,
      freqEnd:
        typeof freqEndRaw === 'number' && Number.isFinite(freqEndRaw) && freqEndRaw > 0
          ? freqEndRaw
          : freq,
      duration:
        typeof durationRaw === 'number' && Number.isFinite(durationRaw)
          ? clamp(durationRaw, 0.02, 2)
          : 0.1,
      volume:
        typeof volumeRaw === 'number' && Number.isFinite(volumeRaw)
          ? clamp(volumeRaw, 0, 1)
          : 0.5,
      throttleMs:
        typeof throttleRaw === 'number' && Number.isFinite(throttleRaw) && throttleRaw >= 0
          ? throttleRaw
          : 50,
    });
  }

  return defs;
}

/** The normalized production mapping, built once at module load. */
export const AUDIO_MAP: readonly SoundDef[] = normalizeAudioMap(
  audioJson as Record<string, Record<string, unknown>>,
);
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/`
Expected: PASS (14 tests).
Run: `npm run typecheck`
Expected: clean — in particular, every string in `KNOWN_EVENTS`'s initializer type-checks against `keyof GameEvents`.

**Step 5: Commit**

```bash
git add src/content/audio.json src/platform/audio-map.ts src/platform/platform.test.ts
git commit -m "feat: audio.json event-to-synth mapping with fail-soft normalization"
```

---

### Task 5: Extend the engine-isolation gate to the platform layer

The platform directory exists now (Tasks 2–4), so both new boundaries become enforceable: the engine must never import `src/platform`, and platform must stay a leaf that only sees `src/core` types and `src/content` JSON.

**Files:**
- Modify: `src/services/isolation.test.ts`

**Step 1: Extend the gate**

Replace the file's contents with:

```ts
import { describe, expect, it } from 'vitest';

// Vite inlines every source as a raw string at transform time — no node:fs,
// so the gate runs in the same environment as every other test.
const engineSources = import.meta.glob(
  ['../core/**/*.ts', '../ecs/**/*.ts', '../gameplay/**/*.ts', '../render/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const platformSources = import.meta.glob(['../platform/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('engine isolation', () => {
  it('actually covers the four engine directories and the platform layer', () => {
    const files = Object.keys(engineSources);
    for (const dir of ['/core/', '/ecs/', '/gameplay/', '/render/']) {
      expect(files.some((f) => f.includes(dir)), `no files globbed under ${dir}`).toBe(true);
    }
    expect(Object.keys(platformSources).length, 'no files globbed under /platform/').toBeGreaterThan(0);
  });

  it('never lets engine code import src/services or src/platform', () => {
    const offenders = Object.entries(engineSources)
      .filter(([, source]) => /from\s+['"][^'"]*\/(services|platform)\//.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('keeps the platform layer a leaf: no gameplay, ecs, render or services imports', () => {
    const offenders = Object.entries(platformSources)
      .filter(([, source]) => /from\s+['"][^'"]*\/(gameplay|ecs|render|services)\//.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
```

**Step 2: Prove the gate trips (deliberate RED)**

Temporarily add `import { joystickVector } from '../platform/joystick.ts';` plus a `void joystickVector;` reference to the top of `src/core/rng.ts`, run `npx vitest run src/services/isolation.test.ts`, and confirm the engine test FAILS naming `../core/rng.ts`. Then temporarily add `import { enemyDef } from '../gameplay/content.ts';` + `void enemyDef;` to `src/platform/joystick.ts` and confirm the leaf test FAILS naming `../platform/joystick.ts`. **Revert both edits.** A gate that has never been seen red proves nothing.

**Step 3: Run tests to verify they pass**

Run: `npx vitest run src/services/isolation.test.ts`
Expected: PASS (3 tests) with both temporary imports reverted.

**Step 4: Commit**

```bash
git add src/services/isolation.test.ts
git commit -m "test: extend engine-isolation gate to the platform layer"
```

---

### Task 6: Input axis-source seam — `attachAxisSource` + headless input tests

`injectPress()` already exists (Phase 2) and carries every touch *button* untouched. Movement needs the one missing seam: an attachable axis source read in `beginFrame()` exactly where the gamepad axes join, ahead of the shared `normalize()`. To make `Input` constructible headless (vitest node environment has `EventTarget` but no `window`), the two `window.addEventListener` calls in the constructor get a guard — behavior in the browser is unchanged.

**Files:**
- Modify: `src/core/input.ts`
- Create: `src/core/input.test.ts`

**Step 1: Write the failing tests**

Create `src/core/input.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { Input } from './input.ts';

// A plain EventTarget instead of window: keyboard events never fire in these
// tests — they cover the injection and axis seams, which is exactly what the
// touch layer uses. Browser behavior stays covered by `npm run dev`.
function makeInput(): Input {
  return new Input(new EventTarget());
}

describe('input seams', () => {
  it('injectPress is consumed by exactly one wasPressed caller, like a real key', () => {
    const input = makeInput();
    input.injectPress('Escape');
    input.beginFrame();
    expect(input.wasPressed('Escape')).toBe(true); // first caller wins…
    expect(input.wasPressed('Escape')).toBe(false); // …later callers see nothing
  });

  it('endFrame clears injected presses like real keydowns', () => {
    const input = makeInput();
    input.injectPress('Space');
    input.beginFrame();
    input.endFrame();
    input.beginFrame();
    expect(input.wasPressed('Space')).toBe(false);
  });

  it('an attached axis source drives normalized axes', () => {
    const input = makeInput();
    const stick = { axisX: 1, axisY: 1 };
    input.attachAxisSource(stick);
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(Math.SQRT1_2, 5);
    expect(input.axisY).toBeCloseTo(Math.SQRT1_2, 5);
    stick.axisX = -1;
    stick.axisY = 0;
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(-1, 5);
    expect(input.axisY).toBeCloseTo(0, 5);
  });

  it('a detached axis source stops contributing', () => {
    const input = makeInput();
    const stick = { axisX: 1, axisY: 0 };
    const detach = input.attachAxisSource(stick);
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(1, 5);
    detach();
    input.beginFrame();
    expect(input.axisX).toBe(0);
    expect(input.axisY).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/input.test.ts`
Expected: FAIL — `attachAxisSource` does not exist (and construction may throw on `window` before the guard lands).

**Step 3: Write minimal implementation**

In `src/core/input.ts`:

1. Add the interface above the class (after the `MOVE_KEYS` const):

   ```ts
   /**
    * Anything that contributes movement each frame — the touch joystick
    * implements this shape. A structural interface rather than an import so
    * core never depends on the platform layer (isolation gate).
    */
   export interface AxisSource {
     readonly axisX: number;
     readonly axisY: number;
   }
   ```

2. Add the field next to `private gamepadIndex` (~line 25):

   ```ts
   private axisSources: AxisSource[] = [];
   ```

3. Guard the two window listeners in the constructor. Replace lines 55–56 (`window.addEventListener('blur', …)` / `('gamepadconnected', …)`) and the matching removals inside `this.detach` with:

   ```ts
   // window is absent under headless vitest; the guard costs nothing in the
   // browser and lets tests construct Input with a bare EventTarget.
   const win = typeof window === 'undefined' ? null : window;
   win?.addEventListener('blur', onBlur);
   win?.addEventListener('gamepadconnected', onGamepad);

   this.detach = () => {
     target.removeEventListener('keydown', onKeyDown);
     target.removeEventListener('keyup', onKeyUp);
     win?.removeEventListener('blur', onBlur);
     win?.removeEventListener('gamepadconnected', onGamepad);
   };
   ```

4. Add the seam after `injectPress` (~line 87):

   ```ts
   /**
    * Registers a per-frame movement contributor (the touch joystick). Read in
    * beginFrame() alongside keyboard and gamepad, ahead of the shared
    * normalize(), so no source can move the player faster than another.
    * Returns a detach function.
    */
   attachAxisSource(source: AxisSource): () => void {
     this.axisSources.push(source);
     return () => {
       const i = this.axisSources.indexOf(source);
       if (i >= 0) this.axisSources.splice(i, 1);
     };
   }
   ```

5. In `beginFrame()`, after the gamepad block (`if (pad) { … }`, lines 105–108) and before `const [nx, ny] = normalize(x, y);`:

   ```ts
   for (const source of this.axisSources) {
     x += source.axisX;
     y += source.axisY;
   }
   ```

Note: `readGamepad()` is safe headless without changes — `gamepadIndex` is `null` so it returns before touching `navigator`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/input.test.ts`
Expected: PASS (4 tests).
Run: `npm test`
Expected: full suite green — `simulation.test.ts` stubs `Input` as a plain object, so nothing there notices.
Run: `npm run typecheck`
Expected: clean.

**Step 5: Commit**

```bash
git add src/core/input.ts src/core/input.test.ts
git commit -m "feat: input axis-source seam for touch movement"
```

---
### Task 7: TouchControls — floating joystick, pause button, game wiring

Browser-bound (DOM + TouchEvent; CLAUDE.md: no headless coverage for input devices). The math is already TDD'd (Task 2); this task is wiring. Gates: `tsc`, suite green, manual checklist.

**Files:**
- Create: `src/platform/touch.ts`
- Modify: `src/game.ts` (touch field ~line 52; constructor wiring after the `uiRoot.append` ~line 98; `beforeFrame` ~line 413; `dispose` ~line 671)
- Modify: `src/ui/style.css` (append the touch-layer block)

**Step 1: Write `src/platform/touch.ts`**

```ts
import type { Input } from '../core/input.ts';

import { joystickVector, nubOffset } from './joystick.ts';

/** Neutral zone around the anchor, CSS px — small flicks shouldn't move. */
const DEADZONE_PX = 10;

/**
 * Floating virtual joystick + pause button, DOM-over-canvas like all UI.
 *
 * Left half of the play area: the first touch anchors the joystick base under
 * the thumb; dragging yields a unit direction. Right-thumb taps (ability,
 * Feast/Frenzy, pause) are ordinary DOM buttons — the HUD already owns the
 * ability/blood buttons, this layer adds only the joystick and pause.
 *
 * Ownership: the joystick tracks its Touch.identifier, so a second finger on
 * a button can never steal or recenter the stick, and the stick never eats
 * button taps (they happen outside the left zone).
 *
 * Feeds Input through its two seams and nothing else: implements AxisSource
 * ({axisX, axisY}, read in Input.beginFrame ahead of normalize) and calls
 * injectPress('Escape') for pause — so ordering, consumption and menu
 * semantics are byte-identical to keyboard play.
 */
export class TouchControls {
  axisX = 0;
  axisY = 0;

  readonly root: HTMLElement;

  private joyId: number | null = null;
  private baseX = 0;
  private baseY = 0;
  private clampRadius = 48;
  private enabled = false;

  private readonly zone: HTMLElement;
  private readonly base: HTMLElement;
  private readonly nub: HTMLElement;
  private readonly detach: () => void;

  constructor(private readonly input: Input) {
    this.root = document.createElement('div');
    this.root.className = 'touch-layer';

    this.zone = document.createElement('div');
    this.zone.className = 'touch-zone';

    this.base = document.createElement('div');
    this.base.className = 'joy-base';
    this.nub = document.createElement('div');
    this.nub.className = 'joy-nub';
    this.base.appendChild(this.nub);

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'touch-pause';
    pauseBtn.textContent = 'II';
    pauseBtn.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      // Through the synthetic-press seam: consumed in Game.beforeFrame exactly
      // like keyboard Escape — including being ignored on the level-up draft.
      this.input.injectPress('Escape');
    });

    this.root.append(this.zone, this.base, pauseBtn);

    const onStart = (ev: TouchEvent) => {
      if (!this.enabled) return;
      ev.preventDefault();
      if (this.joyId !== null) return;
      const touch = ev.changedTouches[0];
      if (!touch) return;
      this.joyId = touch.identifier;
      this.baseX = touch.clientX;
      this.baseY = touch.clientY;
      // Anchor the visual base under the thumb; radius follows the CSS size.
      this.base.style.left = `${touch.clientX}px`;
      this.base.style.top = `${touch.clientY}px`;
      this.base.classList.add('active');
      this.clampRadius = this.base.clientWidth / 2 || 48;
      this.moveNub(touch.clientX, touch.clientY);
    };
    const onMove = (ev: TouchEvent) => {
      if (this.joyId === null) return;
      ev.preventDefault();
      for (const touch of Array.from(ev.changedTouches)) {
        if (touch.identifier !== this.joyId) continue;
        const [x, y] = joystickVector(this.baseX, this.baseY, touch.clientX, touch.clientY, DEADZONE_PX);
        this.axisX = x;
        this.axisY = y;
        this.moveNub(touch.clientX, touch.clientY);
      }
    };
    const onEnd = (ev: TouchEvent) => {
      for (const touch of Array.from(ev.changedTouches)) {
        if (touch.identifier === this.joyId) this.reset();
      }
    };
    // Mirrors Input's blur handler: a hidden tab must not keep walking.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.reset();
    };

    this.zone.addEventListener('touchstart', onStart, { passive: false });
    this.zone.addEventListener('touchmove', onMove, { passive: false });
    this.zone.addEventListener('touchend', onEnd);
    this.zone.addEventListener('touchcancel', onEnd);
    document.addEventListener('visibilitychange', onVisibility);

    this.detach = () => {
      this.zone.removeEventListener('touchstart', onStart);
      this.zone.removeEventListener('touchmove', onMove);
      this.zone.removeEventListener('touchend', onEnd);
      this.zone.removeEventListener('touchcancel', onEnd);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /**
   * Gameplay-only visibility: Game flips this per frame from its state, so
   * menus and drafts never show a joystick zone (Screens are plain DOM and
   * remain tappable through the disabled layer).
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.root.classList.toggle('disabled', !on);
    if (!on) this.reset();
  }

  private moveNub(curX: number, curY: number): void {
    const [nx, ny] = nubOffset(this.baseX, this.baseY, curX, curY, this.clampRadius);
    this.nub.style.transform = `translate(${nx}px, ${ny}px)`;
  }

  private reset(): void {
    this.joyId = null;
    this.axisX = 0;
    this.axisY = 0;
    this.base.classList.remove('active');
    this.nub.style.transform = 'translate(0px, 0px)';
  }

  dispose(): void {
    this.detach();
    this.root.remove();
  }
}
```

**Step 2: Wire `src/game.ts`**

1. Import (value import — it's constructed) after the ui imports (~line 32):

   ```ts
   import { TouchControls } from './platform/touch.ts';
   ```

2. Field next to `private input: Input;` (~line 57):

   ```ts
   private touch: TouchControls | null = null;
   ```

3. In the constructor, directly after `uiRoot.append(this.hud.root, this.screens.root, this.debugEl);` (~line 98):

   ```ts
   // Touch controls exist only where touch exists; prepended so the HUD's own
   // buttons (later siblings) stack above the joystick capture zone.
   if (navigator.maxTouchPoints > 0) {
     this.touch = new TouchControls(this.input);
     uiRoot.prepend(this.touch.root);
     this.input.attachAxisSource(this.touch);
   }
   ```

4. In `beforeFrame()`, first line (~line 413, before `this.input.beginFrame();`):

   ```ts
   this.touch?.setEnabled(this.state === 'playing');
   ```

5. In `dispose()` (~line 671):

   ```ts
   this.touch?.dispose();
   ```

**Step 3: Append the CSS**

Append to `src/ui/style.css`:

```css
/* --- Touch layer (coarse pointers only) ---------------------------------- */

/* Hidden entirely on mouse/trackpad machines; the JS side also only builds it
   when the device reports touch points, so this is belt and braces. */
.touch-layer {
  display: none;
}

@media (pointer: coarse) {
  .touch-layer {
    display: block;
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .touch-layer.disabled {
    display: none;
  }

  /* Left half of the play area is joystick territory. Buttons live on the
     right/bottom edges, outside this zone, so identifiers never contend. */
  .touch-zone {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 50%;
    pointer-events: auto;
    touch-action: none;
  }

  /* The floating base is positioned in viewport px by JS (touch coords are
     viewport-relative); sized in --u so it scales with the art. */
  .joy-base {
    position: fixed;
    width: calc(var(--u) * 48);
    height: calc(var(--u) * 48);
    margin-left: calc(var(--u) * -24);
    margin-top: calc(var(--u) * -24);
    border-radius: 50%;
    border: var(--u) solid var(--edge-bright);
    background: rgba(14, 12, 20, 0.35);
    display: none;
    pointer-events: none;
  }

  .joy-base.active {
    display: block;
  }

  .joy-nub {
    position: absolute;
    left: 50%;
    top: 50%;
    width: calc(var(--u) * 16);
    height: calc(var(--u) * 16);
    margin-left: calc(var(--u) * -8);
    margin-top: calc(var(--u) * -8);
    border-radius: 50%;
    background: rgba(201, 168, 106, 0.5);
  }

  .touch-pause {
    position: absolute;
    top: calc(var(--u) * 4);
    right: calc(var(--u) * 4);
    width: calc(var(--u) * 14);
    height: calc(var(--u) * 14);
    border-radius: 50%;
    border: var(--u) solid var(--edge);
    background: var(--panel);
    color: var(--ink-dim);
    font: inherit;
    font-size: calc(var(--u) * 5);
    letter-spacing: calc(var(--u) * 0.5);
    padding: 0;
    pointer-events: auto;
    touch-action: none;
  }
}
```

**Step 4: Verify types and suite**

Run: `npm run typecheck` — clean.
Run: `npm test` — full suite green, including the extended isolation gate (touch.ts imports only `core/input` and `platform/joystick` — both allowed).

**Step 5: Manual dev-server check**

Run: `npm run dev`, open http://localhost:5173, DevTools → toggle device toolbar (iPhone landscape, touch emulation ON):
- [ ] Touching the left half spawns the joystick base under the finger; dragging moves the player; the nub clamps to the ring
- [ ] Releasing stops movement instantly (axes reset)
- [ ] Ability + FEAST/FRENZY buttons still fire while the joystick is held (multi-touch in DevTools is limited — full 3-finger test is Task 12 on-device)
- [ ] The pause button opens the pause screen; tapping RESUME resumes; the joystick layer is hidden while any screen is up
- [ ] Pause injected during a level-up draft is ignored (exactly like keyboard ESC)
- [ ] On a desktop pointer (device toolbar off) nothing of the touch layer renders or intercepts clicks

**Step 6: Commit**

```bash
git add src/platform/touch.ts src/game.ts src/ui/style.css
git commit -m "feat: floating touch joystick and pause button through the input seams"
```

---

### Task 8: Lifecycle — `shouldAutoPause` + `wireLifecycle` + `Game.autoPause()`

The dispatch logic is headless-tested against fakes; the `game.ts`/`main.ts` wiring is browser-bound with a manual check.

**Files:**
- Create: `src/platform/lifecycle.ts`
- Modify: `src/game.ts` (public `autoPause()` after `openPause` ~line 311)
- Modify: `src/main.ts` (wiring after `loop.start()`; HMR dispose)
- Test: `src/platform/platform.test.ts` (new describe)

**Step 1: Write the failing tests**

Append to `src/platform/platform.test.ts` (extend imports):

```ts
import { shouldAutoPause, wireCapacitorLifecycle, wireLifecycle } from './lifecycle.ts';
import type { VisibilityHost } from './lifecycle.ts';
```

```ts
class FakeDoc implements VisibilityHost {
  visibilityState = 'visible';
  private handlers = new Set<() => void>();

  addEventListener(_type: string, cb: () => void): void {
    this.handlers.add(cb);
  }

  removeEventListener(_type: string, cb: () => void): void {
    this.handlers.delete(cb);
  }

  flip(state: 'hidden' | 'visible'): void {
    this.visibilityState = state;
    for (const cb of [...this.handlers]) cb();
  }
}

describe('lifecycle', () => {
  it('shouldAutoPause is true for playing and nothing else', () => {
    expect(shouldAutoPause('playing')).toBe(true);
    for (const state of ['title', 'loading', 'levelup', 'paused', 'dying', 'results', 'sanctum']) {
      expect(shouldAutoPause(state), state).toBe(false);
    }
  });

  it('hiding the document calls autoPause exactly once per hide', () => {
    const doc = new FakeDoc();
    let calls = 0;
    wireLifecycle({ autoPause: () => calls++ }, doc);
    doc.flip('hidden');
    expect(calls).toBe(1);
    doc.flip('visible');
    expect(calls).toBe(1); // resume never auto-unpauses — the player does
  });

  it('the returned detach stops further calls', () => {
    const doc = new FakeDoc();
    let calls = 0;
    const detach = wireLifecycle({ autoPause: () => calls++ }, doc);
    detach();
    doc.flip('hidden');
    expect(calls).toBe(0);
  });

  it('capacitor wiring resolves (no throw) whether or not the runtime exists', async () => {
    // In node the @capacitor/app import resolves but its web shim may reject
    // when it touches window; either way the wrapper must settle, never throw.
    const result = await wireCapacitorLifecycle({ autoPause: () => {} });
    expect(result.ok).toBeTypeOf('boolean');
    expect(result.detach).toBeTypeOf('function');
    result.detach(); // no-op when ok is false; removes the native listener when true
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/`
Expected: FAIL — cannot resolve `./lifecycle.ts`.

**Step 3: Write minimal implementation**

Create `src/platform/lifecycle.ts`:

```ts
/**
 * Background/foreground handling. Two triggers converge on Game.autoPause():
 * the web visibilitychange event (covers WKWebView too) and, on device, the
 * Capacitor App 'pause' event. autoPause is idempotent (guarded by
 * shouldAutoPause), so double-firing on native is harmless.
 *
 * Resume is deliberately not handled: the game returns to the pause screen
 * and the *player* resumes. Loop's frameDt clamp already prevents a
 * catch-up tick burst after a long background.
 */

export interface AutoPausable {
  autoPause(): void;
}

/** The subset of Document the wiring needs — a hand-rolled fake in tests. */
export interface VisibilityHost {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  readonly visibilityState?: string;
}

/** The one rule, kept pure and testable: only an active run auto-pauses. */
export function shouldAutoPause(state: string): boolean {
  return state === 'playing';
}

/** visibilitychange → autoPause. Returns a detach function (HMR dispose). */
export function wireLifecycle(game: AutoPausable, doc: VisibilityHost): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') game.autoPause();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => doc.removeEventListener('visibilitychange', onVisibility);
}

/**
 * Capacitor App pause → autoPause. Dynamic import + catch-all so web builds
 * and headless tests run identically whether the plugin loads or not; ok is
 * true only when the native listener is actually registered, and detach
 * removes it again (HMR dispose) — a no-op when nothing was registered.
 */
export async function wireCapacitorLifecycle(
  game: AutoPausable,
): Promise<{ ok: boolean; detach: () => void }> {
  try {
    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('pause', () => game.autoPause());
    return { ok: true, detach: () => void handle.remove() };
  } catch {
    return { ok: false, detach: () => {} };
  }
}
```

In `src/game.ts`:

1. Import (after the TouchControls import):

   ```ts
   import { shouldAutoPause } from './platform/lifecycle.ts';
   ```

2. Add after `openPause()` (~line 311):

   ```ts
   /**
    * Platform hook: backgrounding/hiding pauses an active run and touches
    * nothing else — menus, drafts, results and the sanctum stay as they are.
    */
   autoPause(): void {
     if (!shouldAutoPause(this.state)) return;
     this.openPause();
   }
   ```

In `src/main.ts`, after `loop.start();`:

```ts
  const detachLifecycle = wireLifecycle(game, document);
  let detachCapacitorLifecycle: () => void = () => {};
  void wireCapacitorLifecycle(game).then(({ detach }) => {
    detachCapacitorLifecycle = detach;
  });
```

with the imports (value imports, they're called):

```ts
import { wireCapacitorLifecycle, wireLifecycle } from './platform/lifecycle.ts';
```

and inside the existing HMR `dispose` callback, alongside `loop.stop()`:

```ts
      detachLifecycle();
      detachCapacitorLifecycle();
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/`
Expected: PASS (18 tests).
Run: `npm run typecheck` — clean.
Run: `npm test` — full suite green (game.ts/main.ts are outside the gate globs; importing platform there is the sanctioned direction).

**Step 5: Manual dev-server check**

Run: `npm run dev`:
- [ ] Start a run, switch to another tab (or minimize) — on return the pause screen is up
- [ ] Resume plays on from the same sim time; no burst of catch-up ticks (watch the timer)
- [ ] Backgrounding on the title/results/sanctum changes nothing
- [ ] Backgrounding while already paused stays on the pause screen (no double-open)

**Step 6: Commit**

```bash
git add src/platform/lifecycle.ts src/game.ts src/main.ts src/platform/platform.test.ts
git commit -m "feat: lifecycle auto-pause on hide and capacitor pause"
```

---
### Task 9: AudioEngine — bus-driven WebAudio synth + `Game.bus` exposure

Browser-bound (`AudioContext` does not exist headless). The testable halves already landed: the mapping (Task 4) and the voice budget (Task 3). This engine is deliberately thin glue. Gates: `tsc`, suite green, manual checklist.

**Files:**
- Create: `src/platform/audio.ts`
- Modify: `src/game.ts` (one word: `private bus` → `readonly bus`, ~line 49)
- Modify: `src/main.ts` (construct the engine; HMR dispose)

**Step 1: Write `src/platform/audio.ts`**

```ts
import type { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';

import { AUDIO_MAP } from './audio-map.ts';
import type { SoundDef } from './audio-map.ts';
import { VoiceAllocator } from './voices.ts';

/**
 * Bus-driven WebAudio synth. Gameplay never imports this (isolation gate);
 * it subscribes to GameEvents and turns them into oscillator blips — zero
 * asset files, so the game is audible before real SFX land.
 *
 * iOS rules shape the whole design: an AudioContext may only start from a
 * user gesture, so the context is created/resumed on the first pointerdown/
 * touchend and every play() before that is silently dropped. Hidden tab →
 * suspend (ducking); visible → resume. performance.now() timing lives here
 * on the frame side only — the sim never sees it (determinism untouched).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices = new VoiceAllocator();
  private readonly unsubs: (() => void)[] = [];
  private readonly detachDom: () => void;

  constructor(bus: EventBus<GameEvents>, defs: readonly SoundDef[] = AUDIO_MAP) {
    for (const def of defs) {
      this.unsubs.push(bus.on(def.event, () => this.play(def)));
    }

    const unlock = () => this.unlock();
    const onVisibility = () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend();
      else void this.ctx.resume();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    this.detachDom = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchend', unlock);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  private unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private play(def: SoundDef): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running') return;
    if (!this.voices.tryAcquire(def.event, performance.now(), def.duration * 1000, def.throttleMs)) {
      return; // over budget or throttled: drop, never queue (fx-pool policy)
    }

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = def.wave;
    osc.frequency.setValueAtTime(def.freq, t);
    if (def.freqEnd !== def.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, def.freqEnd), t + def.duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(def.volume, t);
    // Exponential decay to silence — clickless endings without an envelope lib.
    gain.gain.exponentialRampToValueAtTime(0.001, t + def.duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + def.duration);
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.detachDom();
    void this.ctx?.close();
  }
}
```

**Step 2: Expose the bus**

In `src/game.ts` (~line 49), change:

```ts
  private bus = new EventBus<GameEvents>();
```

to:

```ts
  /** Readonly so platform subscribers (audio, haptics) can listen from main.ts. */
  readonly bus = new EventBus<GameEvents>();
```

(Every internal `this.bus` use compiles unchanged.)

**Step 3: Wire `src/main.ts`**

Add the import:

```ts
import { AudioEngine } from './platform/audio.ts';
```

After the lifecycle wiring from Task 8:

```ts
  const audio = new AudioEngine(game.bus);
```

and in the HMR `dispose` callback:

```ts
      audio.dispose();
```

**Step 4: Verify types and suite**

Run: `npm run typecheck` — clean.
Run: `npm test` — full suite green; the leaf-layer gate confirms audio.ts imports only core types + platform siblings.

**Step 5: Manual dev-server check**

Run: `npm run dev`:
- [ ] Before any click/tap: total silence, zero console errors
- [ ] After the first click, kills thud, coins chirp, XP ticks softly — no sound is machine-gunned in a horde (voice cap + throttle audibly working)
- [ ] Level-up, Feast, Frenzy and ability casts each have a distinct blip
- [ ] Hide the tab mid-run: audio stops with the auto-pause; return + resume: audio back
- [ ] Edit a `freq` in `src/content/audio.json` — hot-reload changes the sound, no restart

**Step 6: Commit**

```bash
git add src/platform/audio.ts src/game.ts src/main.ts
git commit -m "feat: bus-driven webaudio engine with synth placeholder sfx"
```

---

### Task 10: Haptics — `src/platform/haptics.ts`

Device-bound (real feedback needs an iPhone; the web shim is a no-op). Gates: `tsc`, suite green, web no-op verified now, device feel in Task 12.

**Files:**
- Create: `src/platform/haptics.ts`
- Modify: `src/main.ts` (construct; HMR dispose)

**Step 1: Write `src/platform/haptics.ts`**

```ts
import type { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';

import { RateGate } from './voices.ts';

type Impact = 'LIGHT' | 'MEDIUM' | 'HEAVY';

/**
 * Bus-driven Capacitor haptics. Big moments only — player hits, Frenzy,
 * ability casts, level-ups, unlocks. Enemy hits are deliberately excluded
 * (hundreds per second would numb the actuator and the player). One global
 * 100ms RateGate on top, so overlapping events never stack buzzes.
 *
 * The plugin loads via guarded dynamic import: off-iOS (or headless) init
 * fails quietly and every handler stays a no-op forever.
 */
export class HapticsDriver {
  private readonly gate = new RateGate(100);
  private impact: ((style: Impact) => void) | null = null;
  private notify: (() => void) | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(bus: EventBus<GameEvents>) {
    void this.init();
    this.unsubs.push(
      bus.on('player:damaged', () => this.buzz('MEDIUM')),
      bus.on('blood:frenzy', () => this.buzz('HEAVY')),
      bus.on('ability:used', () => this.buzz('HEAVY')),
      bus.on('blood:ready', () => this.buzz('LIGHT')),
      bus.on('player:levelup', () => this.ding()),
      bus.on('character:unlocked', () => this.ding()),
    );
  }

  private async init(): Promise<void> {
    try {
      const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
      const styles = {
        LIGHT: ImpactStyle.Light,
        MEDIUM: ImpactStyle.Medium,
        HEAVY: ImpactStyle.Heavy,
      } as const;
      this.impact = (style) => void Haptics.impact({ style: styles[style] }).catch(() => {});
      this.notify = () =>
        void Haptics.notification({ type: NotificationType.Success }).catch(() => {});
    } catch {
      // Web build / plugin unavailable: remain a silent no-op.
    }
  }

  private buzz(style: Impact): void {
    if (!this.impact || !this.gate.try(performance.now())) return;
    this.impact(style);
  }

  private ding(): void {
    if (!this.notify || !this.gate.try(performance.now())) return;
    this.notify();
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
  }
}
```

**Step 2: Wire `src/main.ts`**

Import, construct next to the AudioEngine, dispose in HMR:

```ts
import { HapticsDriver } from './platform/haptics.ts';
```

```ts
  const haptics = new HapticsDriver(game.bus);
```

```ts
      haptics.dispose();
```

**Step 3: Verify types, suite and the web no-op**

Run: `npm run typecheck` — clean.
Run: `npm test` — full suite green.
Run: `npm run dev` — play a minute:
- [ ] Zero console errors/warnings from haptics on desktop (init failure is silent, handlers no-op)

**Step 4: Commit**

```bash
git add src/platform/haptics.ts src/main.ts
git commit -m "feat: bus-driven capacitor haptics with a global rate gate"
```

---

### Task 11: Safe areas — `viewport-fit=cover` + inset-composed anchors

Browser-bound (pure CSS/HTML; verified with DevTools notch emulation now, real notch in Task 12). Gates: `tsc`, suite green, manual checklist.

The geometry rule: `#ui` is already translated by the letterbox offset (`--offset-x/--offset-y` from `syncUiMetrics()` — that function needs **no change**), so for a child of `#ui` the composed form is `max(designInset, safeInset − letterboxOffset)`: if the letterbox bar is already wider than the notch, the safe inset dissolves to the original design value.

**Files:**
- Modify: `index.html` (viewport meta)
- Modify: `src/ui/style.css` (`:root` vars; `#app`; five anchor edits; the Task-7 `.touch-pause` anchors)

**Step 1: Viewport meta**

In `index.html` line 5, replace the viewport meta with:

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
```

**Step 2: CSS variables and gesture hardening**

In `src/ui/style.css`, append inside the `:root` block (after `--u`):

```css
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
```

In the `#app` rule, add:

```css
  /* Kills double-tap zoom and rubber-banding inside the game surface. */
  touch-action: none;
```

**Step 3: Compose the anchors**

Five edits, same pattern each time (existing value wrapped in `max()` against `safe − offset`):

- `.hud-row` (~line 116): `top: calc(var(--u) * 8);` →
  `top: max(calc(var(--u) * 8), calc(var(--safe-t) - var(--offset-y, 0px)));`
- `.hud-left` (~line 126): `left: calc(var(--u) * 5);` →
  `left: max(calc(var(--u) * 5), calc(var(--safe-l) - var(--offset-x, 0px)));`
- `.hud-right` (~line 141): `right: calc(var(--u) * 5);` →
  `right: max(calc(var(--u) * 5), calc(var(--safe-r) - var(--offset-x, 0px)));`
- `.loadout` (~line 204): both anchors →
  `left: max(calc(var(--u) * 5), calc(var(--safe-l) - var(--offset-x, 0px)));`
  `bottom: max(calc(var(--u) * 5), calc(var(--safe-b) - var(--offset-y, 0px)));`
- `.blood-cluster` (~line 516): `bottom: calc(var(--u) * 5);` →
  `bottom: max(calc(var(--u) * 5), calc(var(--safe-b) - var(--offset-y, 0px)));`

And in the Task-7 touch block, `.touch-pause`:

```css
    top: max(calc(var(--u) * 4), calc(var(--safe-t) - var(--offset-y, 0px)));
    right: max(calc(var(--u) * 4), calc(var(--safe-r) - var(--offset-x, 0px)));
```

**Step 4: Verify types and suite**

Run: `npm run typecheck` — clean (nothing typed changed).
Run: `npm test` — full suite green (CSS/HTML are invisible to it).

**Step 5: Manual dev-server check**

Run: `npm run dev`, DevTools device toolbar, iPhone 15 Pro, **landscape**:
- [ ] HP bar, timer, gold and loadout all clear the notch side and the home indicator
- [ ] Rotate to the other landscape orientation — still clear (both `--safe-l` and `--safe-r` compose)
- [ ] Desktop window (no emulation): pixel-identical to before this task (`env()` falls back to 0 and `max()` picks the design inset)
- [ ] Wide window where the letterbox bars exceed the notch: anchors sit at the design inset, not pushed further

**Step 6: Commit**

```bash
git add index.html src/ui/style.css
git commit -m "feat: safe-area insets composed with the letterbox ui vars"
```

---

### Task 12: On-device iOS pass (fully manual — Mac toolchain)

No agent steps beyond the two commands below; everything else is hands-on-device. Nothing merges until this checklist is green (roadmap exit criteria).

**Step 1: Fresh sync**

```bash
npm run build
npx cap sync ios
```
Expected: `Sync finished` (this time including `pod install` if CocoaPods is present).

**Step 2: Keep-awake (documented native line — the locked no-new-deps decision)**

In `ios/App/App/AppDelegate.swift`, inside `application(_:didFinishLaunchingWithOptions:)`, add:

```swift
        // Survivors runs are minutes of no-touch joystick holding; never dim.
        application.isIdleTimerDisabled = true
```

`ios/` is committed, so this edit persists across `cap sync` (sync never rewrites AppDelegate). Commit it with this task.

**Step 3: Device checklist**

`npx cap open ios`, sign, run on the oldest target device (iPhone SE class) and a notch device:

- [ ] `cd ios/App && pod install` succeeded; Xcode build clean (Task 1 carry-over if it was deferred)
- [ ] App launches to the title in landscape; cannot rotate to portrait; both landscape orientations work
- [ ] No white/system bars: WKWebView edge-to-edge (`contentInset: 'never'`), background `#05060a` everywhere
- [ ] **3-finger test:** joystick held + ability tapped + FEAST/FRENZY tapped simultaneously — all respond, no stolen touches, joystick never recenters
- [ ] **60fps** during a minute-10 horde with the F3 overlay on the SE-class device (Low Power Mode note: 30Hz rAF → 2 ticks/frame is correct by design, not a bug)
- [ ] Audio: silent until the first touch; SFX after; **ringer switch on mute** — check whether game audio mutes (known WKWebView/AVAudioSession risk from the design; if muted and that's unwanted, the fix is a native AVAudioSession category tweak — note it, don't improvise one mid-checklist)
- [ ] Haptics: player hit / Frenzy / ability / level-up buzz distinctly; horde combat does NOT buzz continuously
- [ ] Home-swipe to background mid-run → reopen: pause screen is up, timer unchanged, no tick burst, audio resumed only after tapping resume
- [ ] Notch device: HUD clears notch + home indicator in both landscape orientations
- [ ] Screen never dims during a hands-still joystick run (keep-awake line working)
- [ ] Full run start→death→results→sanctum→next run entirely by touch, no keyboard ever

**Step 4: Commit (device-pass fixes + AppDelegate)**

```bash
git add ios/
git commit -m "chore: ios device pass - keep-awake and on-device fixes"
```

(If device testing surfaced code fixes, commit them separately with their own messages before this.)

---

### Task 13: Full verification + squash merge

**Files:** none (verification only)

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean, zero errors.

**Step 2: Full suite**

Run: `npm test`
Expected: ALL tests pass — the runner's count is authoritative; the expected shape is **129**: the 106 from Phase 4 close plus **23 new** (18 + 4 + 1):
- `src/platform/platform.test.ts` (18): joystick math (5) · voice allocation (5) · audio map (4) · lifecycle (4)
- `src/core/input.test.ts` (4): inject consumed once · endFrame clears · axis source normalized · detach stops
- `src/services/isolation.test.ts` (3, was 2): coverage incl. platform · engine imports neither services nor platform · platform stays a leaf
- `src/gameplay/simulation.test.ts`: **byte-identical to main** — verify with `git diff main...HEAD -- src/gameplay/simulation.test.ts` printing nothing

**Step 3: Isolation double-check (belt and braces over the vitest gate)**

Run: `grep -rn "platform/" src/core src/ecs src/gameplay src/render`
Expected: no matches.
Run: `grep -rn "gameplay/\|ecs/\|render/\|services/" src/platform`
Expected: no matches.

**Step 4: Capacitor build from clean**

Run: `npm run build && npx cap sync ios`
Expected: build clean, `Sync finished` — the roadmap's "from a clean checkout" criterion.

**Step 5: Self-review the diff**

Run: `git diff main...HEAD --stat` then `git diff main...HEAD`
Check against the invariants:
- `Game.tick()` and the harness tick untouched — `git diff main...HEAD -- src/gameplay/` shows nothing at all
- `src/core/input.ts` diff is exactly: `AxisSource` interface, `axisSources` field + loop, `attachAxisSource`, the `win?` guard — `wasPressed` consumption semantics, `injectPress`, `readGamepad` untouched
- every platform module is constructed in `main.ts`/`game.ts` only; every one subscribes to the bus or feeds Input seams; none is called from a gameplay system
- no `Math.random` in `src/platform/` (`grep -rn "Math.random" src/platform` — empty); `performance.now()` appears only in `audio.ts`/`haptics.ts` (frame-side, never sim-side)
- all audio tuning lives in `src/content/audio.json`; no synth numbers hardcoded outside defaults/clamps in `audio-map.ts`
- new npm deps are exactly the five `@capacitor/*` packages (`git diff main...HEAD -- package.json`)

**Step 6: Squash merge (ask the user before each git command)**

```bash
git checkout main
git merge --squash feat/phase-5-mobile-platform
git commit -m "feat: mobile platform layer - capacitor ios shell, touch controls, audio and haptics (mobile v1 phase 5)"
```
Keep the phase branch until the user confirms deletion. Then reassess (per the
roadmap's just-in-time rule) before writing the Phase 6 plan.

---

## Notes for the executor

- **The sim is untouched this phase.** No `Game.tick()` edits, no `simulation.test.ts`
  edits, no gameplay-system edits of any kind. The only engine file that changes is
  `src/core/input.ts`, and only additively. If a task seems to need more, stop.
- **Task 1 must precede Tasks 8 and 10.** `lifecycle.ts` and `haptics.ts` dynamically
  import `@capacitor/app` / `@capacitor/haptics`; before the install, `tsc` and the
  vite build fail on unresolvable modules.
- **Silence before the first gesture is correct, not a bug** — iOS autoplay policy.
  Don't "fix" it by creating the AudioContext at boot; it would start suspended and
  waste the first unlock.
- **Auto-resume is deliberately absent.** Hide → pause screen; the *player* resumes.
  `loop.ts`'s frameDt clamp + `MAX_TICKS_PER_FRAME` already prevent resume tick
  bursts — no new code should touch that.
- **Two RNG streams rule:** the platform layer uses neither. Synth parameters are
  fixed per event; if a later polish pass wants pitch jitter, it must use `fxRng`,
  never `Math.random`, never `ctx.rng`.
- `performance.now()` and DOM timing live exclusively in browser-bound platform
  files; the pure modules (`joystick.ts`, `voices.ts`, `audio-map.ts`,
  `lifecycle.ts`'s exported functions) take timestamps and hosts as parameters —
  keep it that way or the headless tests rot.
- All audio tuning hot-reloads from `src/content/audio.json` in the dev server —
  sound-balance passes need no code changes.
- If any test fails twice with the same error: stop, re-read the relevant source
  file in full, do not blind-retry (execution discipline rules).
- Deliberately out of scope (locked decisions): AdMob/IAP/ATT/App-Store metadata
  (Phase 6); music tracks + recorded SFX assets (follow-up asset swap);
  `@capacitor-community/keep-awake` (native one-liner in Task 12 instead); icon and
  splash generation via `@capacitor/assets` (art-track deliverable, needs the 1024px
  icon that doesn't exist yet); Capacitor Preferences storage adapter (revisit with
  Phase 6's save-hardening if needed — localStorage persists fine inside WKWebView
  for v1).
- Known v1 warts (accepted): DevTools multi-touch emulation can't fully prove the
  3-finger case — that proof lives on-device in Task 12; the joystick zone is a
  fixed left half rather than "anywhere not on a button"; pause is the only
  touch-reachable menu shortcut during play.



