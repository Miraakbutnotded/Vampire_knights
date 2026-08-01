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
