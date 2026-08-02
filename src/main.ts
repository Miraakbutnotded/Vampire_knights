import { Loop } from './core/loop.ts';

/** How long the native storage arm may take before boot gives up on it. */
const NATIVE_TIMEOUT_MS = 2500;
import { Game } from './game.ts';
import { AudioEngine } from './platform/audio.ts';
import { HapticsDriver } from './platform/haptics.ts';
import { wireCapacitorLifecycle, wireLifecycle } from './platform/lifecycle.ts';
import { SpriteTable } from './render/sprites.ts';
import { MetaService } from './services/meta.ts';
import { liftStorage } from './services/migration.ts';
import { LocalStorageAdapter, PreferencesStorageAdapter } from './services/storage.ts';
import type { StorageAdapter } from './services/storage.ts';
import { TelemetryService } from './services/telemetry.ts';

/**
 * Dev-only console handle: `copy(vkTelemetry.dump())` gives you the log as a
 * file. Declared rather than cast so the service itself never has to know a
 * global exists — that is what keeps it headless-testable.
 */
declare global {
  interface Window {
    vkTelemetry?: TelemetryService;
  }
}

/**
 * Picks the store the whole app persists through, and it is the only place in
 * the codebase allowed to make that choice — services take an adapter, they
 * never construct one.
 *
 * Detection is `Capacitor.isNativePlatform()`, which is true only when the
 * native bridge injected itself into the WebView; the import is dynamic and
 * caught so a plain `vite build` served over http behaves identically whether
 * or not the package resolves. Both ways of being wrong are survivable:
 *
 * - **Native misread as web** → we keep writing localStorage, which is exactly
 *   today's behaviour. The eviction risk returns, but nothing is lost, and no
 *   marker is written, so the first correct boot still lifts the save.
 * - **Web misread as native** → Preferences' own web implementation is
 *   localStorage under a `CapacitorStorage.` key prefix, so the save is lifted
 *   into the prefixed keys and the game reads it back from there. Different
 *   keys, same bytes, same behaviour.
 *
 * Choosing Preferences is what triggers the one-time lift, and the boot waits
 * for it: MetaService.load() must not read an empty store while the wallet is
 * still in flight. A lift that fails is logged and boot continues — the game
 * starts fine on an empty store, and the next launch retries.
 */
async function selectStorage(): Promise<StorageAdapter> {
  const web = new LocalStorageAdapter();

  // Every await below talks to a bridge that may simply never answer. A
  // rejection we can catch; silence we cannot, and silence is what a plugin
  // that failed to register actually produces — boot then waits forever behind
  // a black screen with no error to report. So the native arm races a deadline
  // and loses by default: the store that already works is one line away, and a
  // wallet restored a launch later is worth incomparably more than a game that
  // never starts.
  const deadline = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([
      work,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);

  let native = false;
  try {
    const core = await deadline(import('@capacitor/core'), NATIVE_TIMEOUT_MS);
    if (!core) {
      return web;
    }
    native = core.Capacitor.isNativePlatform();
  } catch (error) {
    console.warn('[storage] Capacitor unavailable; using localStorage:', error);
    return web;
  }
  if (!native) return web;

  try {
    const prefs = new PreferencesStorageAdapter();
    const report = await deadline(liftStorage(web, prefs), NATIVE_TIMEOUT_MS);
    if (!report) {
      return web;
    }
    if (report.outcome !== 'already-done') console.info('[storage] lift:', report);
    return prefs;
  } catch (error) {
    console.error('[storage] Preferences unavailable; staying on localStorage:', error);
    return web;
  }
}

/**
 * Boots the game: load art, pick the save store, build the game, start the loop.
 *
 * Two asynchronous steps, run together because neither needs the other: art,
 * after which every sprite resolves to something drawable — a real PNG where one
 * exists, procedural placeholder art where it doesn't — and storage selection,
 * which on device also carries out the one-time lift off localStorage.
 */
async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game');
  const uiRoot = document.querySelector<HTMLElement>('#ui');
  const touchRoot = document.querySelector<HTMLElement>('#touch');
  const menuRoot = document.querySelector<HTMLElement>('#menu');
  if (!canvas || !uiRoot || !touchRoot || !menuRoot) {
    throw new Error('index.html is missing #game, #touch, #ui or #menu');
  }

  const sprites = await SpriteTable.load();
  const storage = await selectStorage();
  // Last async boot step: the wallet and sanctum ranks must exist before the
  // title screen renders and before the first Run is constructed.
  const meta = new MetaService(storage);
  const telemetry = new TelemetryService(storage);
  // Both read the same backing store and neither depends on the other, so they
  // load together rather than adding a third serial step to boot.
  await Promise.all([meta.load(), telemetry.load()]);
  // First of the three rollover points, and it must precede the Game: the
  // constructor opens the title screen, which renders today's oaths.
  meta.rollDaily(Date.now());
  const game = new Game(canvas, { ui: uiRoot, touch: touchRoot, menu: menuRoot }, sprites, meta, telemetry);

  if (import.meta.env.DEV) window.vkTelemetry = telemetry;

  const loop = new Loop({
    beforeFrame: () => game.beforeFrame(),
    update: (dt) => game.update(dt),
    render: (alpha, frameDt) => {
      game.fps = loop.fps;
      game.render(alpha, frameDt);
    },
    afterFrame: () => game.afterFrame(),
  });

  loop.start();

  const detachLifecycle = wireLifecycle(game, document);
  let detachCapacitorLifecycle: () => void = () => {};
  // The native pause is the last moment before iOS may terminate a suspended
  // app, so completed records get pushed down here. A run still in flight is
  // lost, which is fine — it had no outcome to record anyway.
  void wireCapacitorLifecycle({
    autoPause: () => {
      game.autoPause();
      void telemetry.flush();
    },
  })
    .then(({ detach }) => {
      detachCapacitorLifecycle = detach;
    })
    // A plugin bridge that is not there is a missing convenience, not a reason
    // to take the game down: the web `visibilitychange` path is already wired
    // and covers everything except a cold native suspend. Unhandled, this
    // rejection reaches window.onunhandledrejection and any diagnostic overlay
    // listening there paints over a game that is running perfectly well.
    .catch((error: unknown) => {
      console.warn('[lifecycle] native pause unavailable:', error);
    });

  const audio = new AudioEngine(game.bus);
  const haptics = new HapticsDriver(game.bus);

  // Vite replaces this module on save; without tearing the old loop down, each
  // edit would leave another one running and inputs would be handled twice.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      loop.stop();
      game.dispose();
      detachLifecycle();
      detachCapacitorLifecycle();
      audio.dispose();
      haptics.dispose();
      delete window.vkTelemetry;
    });
  }
}

boot()
  .catch((error: unknown) => {
  console.error(error);
  const message =
    error instanceof Error
      ? [error.name, error.message].filter(Boolean).join(': ')
      : String(error);
  document.body.innerHTML =
    `<pre style="color:#ff6b8a;font:14px ui-monospace,monospace;padding:24px;white-space:pre-wrap">` +
    `Failed to start.\n\n${escapeHtml(message)}</pre>`;
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
