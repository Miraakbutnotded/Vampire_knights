/**
 * Background/foreground handling. Two triggers converge on Game.autoPause():
 * the web visibilitychange event (covers WKWebView too) and, on device, the
 * Capacitor App 'pause' event. autoPause is idempotent (guarded by
 * shouldAutoPause), so double-firing on native is harmless.
 *
 * Resume never unpauses the run: the game returns to the pause screen and the
 * *player* resumes. Loop's frameDt clamp already prevents a catch-up tick burst
 * after a long background. It does, however, notify the game via onResumed,
 * which is what lets a suspended app notice the calendar moved — an iOS player
 * who never kills the app would otherwise never see a new day, because boot and
 * the title screen are the only other places rollover is evaluated.
 */

export interface AutoPausable {
  autoPause(): void;
}

export interface Resumable {
  /** The app came back to the foreground. Must not resume gameplay itself. */
  onResumed(): void;
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

/** visibilitychange → autoPause / onResumed. Returns a detach (HMR dispose). */
export function wireLifecycle(
  game: AutoPausable & Resumable,
  doc: VisibilityHost,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') game.autoPause();
    else game.onResumed();
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
