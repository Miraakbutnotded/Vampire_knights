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
