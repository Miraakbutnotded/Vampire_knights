import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // keep sprite PNGs as real files so they stay swappable
  },
  test: {
    // Vitest replaces every CSS import with an empty string by default, `?raw`
    // included — which would silently hand the art-unit gate in
    // `src/ui/metrics.test.ts` an empty stylesheet to find no violations in.
    // Scoped to the one file that gate reads rather than switched on globally.
    css: { include: [/style\.css/] },
  },
});
