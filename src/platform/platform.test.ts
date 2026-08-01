import { describe, expect, it, vi } from 'vitest';

import audioJson from '../content/audio.json';
import { AUDIO_MAP, normalizeAudioMap } from './audio-map.ts';
import { joystickVector, nubOffset } from './joystick.ts';
import { shouldAutoPause, wireCapacitorLifecycle, wireLifecycle } from './lifecycle.ts';
import type { VisibilityHost } from './lifecycle.ts';
import { MAX_VOICES, RateGate, VoiceAllocator } from './voices.ts';

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
