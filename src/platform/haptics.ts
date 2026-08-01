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
