import { Loop } from './core/loop.ts';
import { Game } from './game.ts';
import { SpriteTable } from './render/sprites.ts';
import { MetaService } from './services/meta.ts';
import { LocalStorageAdapter } from './services/storage.ts';

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
  if (!canvas || !uiRoot) throw new Error('index.html is missing #game or #ui');

  const sprites = await SpriteTable.load();
  // Second async boot step: the wallet and sanctum ranks must exist before the
  // title screen renders and before the first Run is constructed.
  const meta = new MetaService(new LocalStorageAdapter());
  await meta.load();
  const game = new Game(canvas, uiRoot, sprites, meta);

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

  // Vite replaces this module on save; without tearing the old loop down, each
  // edit would leave another one running and inputs would be handled twice.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      loop.stop();
      game.dispose();
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
