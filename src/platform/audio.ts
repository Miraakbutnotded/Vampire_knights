import type { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';

import { AUDIO_MAP } from './audio-map.ts';
import type { SoundDef } from './audio-map.ts';
import { VoiceAllocator } from './voices.ts';

/**
 * Swallow a rejected AudioContext state promise. These calls are fire-and-forget
 * by design (nothing downstream waits on them) but WebKit really does reject
 * them, and an unhandled rejection surfaces as a global error under Capacitor.
 */
const ignore = (): void => {};

/**
 * Bus-driven WebAudio synth. Gameplay never imports this (isolation gate);
 * it subscribes to GameEvents and turns them into oscillator blips — zero
 * asset files, so the game is audible before real SFX land.
 *
 * iOS rules shape the whole design: an AudioContext may only start from a
 * user gesture, so the context is created/resumed on the first pointerdown/
 * touchend/keydown and every play() before that is silently dropped. keydown
 * is load-bearing, not a nicety: the game is fully playable from the keyboard
 * (menus on Enter, movement on WASD) and gamepad buttons are injected as
 * synthetic key presses that never reach the DOM, so without it a keyboard or
 * pad player would be silent for the entire session. Hidden tab → suspend
 * (ducking); visible → resume. resume()/suspend()/close() are deliberately not
 * awaited but always carry a .catch: WebKit rejects resume() outside a gesture
 * task (every foregrounding would raise an unhandledrejection) and close()
 * rejects if dispose() runs twice. performance.now() timing lives here on the
 * frame side only — the sim never sees it (determinism untouched).
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
      const ctx = this.ctx;
      if (!ctx) return;
      if (document.visibilityState === 'hidden') ctx.suspend().catch(ignore);
      else ctx.resume().catch(ignore);
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    this.detachDom = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchend', unlock);
      window.removeEventListener('keydown', unlock);
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
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(ignore);
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
    this.ctx?.close().catch(ignore);
  }
}
