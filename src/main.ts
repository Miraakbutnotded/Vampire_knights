import { Loop } from './core/loop.ts';
import { Game } from './game.ts';
import { AudioEngine } from './platform/audio.ts';
import { HapticsDriver } from './platform/haptics.ts';
import { wireCapacitorLifecycle, wireLifecycle } from './platform/lifecycle.ts';
import { SpriteTable } from './render/sprites.ts';
import { MetaService } from './services/meta.ts';
import { LocalStorageAdapter } from './services/storage.ts';
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
 * Boots the game: load art, build the game, start the loop.
 *
 * Sprite loading is the only asynchronous step. Everything downstream can then
 * assume every sprite resolves to something drawable — a real PNG where one
 * exists, procedural placeholder art where it doesn't.
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
  // Second async boot step: the wallet and sanctum ranks must exist before the
  // title screen renders and before the first Run is constructed.
  const storage = new LocalStorageAdapter();
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
  }).then(({ detach }) => {
    detachCapacitorLifecycle = detach;
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

boot().catch((error: unknown) => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
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
