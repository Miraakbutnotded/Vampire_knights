import { describe, expect, it } from 'vitest';

// Vite inlines every engine source as a raw string at transform time — no
// node:fs, so the gate runs in the same environment as every other test.
const engineSources = import.meta.glob(
  ['../core/**/*.ts', '../ecs/**/*.ts', '../gameplay/**/*.ts', '../render/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('engine isolation', () => {
  it('actually covers the four engine directories', () => {
    const files = Object.keys(engineSources);
    for (const dir of ['/core/', '/ecs/', '/gameplay/', '/render/']) {
      expect(files.some((f) => f.includes(dir)), `no files globbed under ${dir}`).toBe(true);
    }
  });

  it('never lets engine code import src/services', () => {
    const offenders = Object.entries(engineSources)
      .filter(([, source]) => /from\s+['"][^'"]*\/services\//.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
