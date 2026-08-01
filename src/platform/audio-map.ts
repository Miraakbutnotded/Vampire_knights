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
