import { defineConfig } from 'vite';

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
});
