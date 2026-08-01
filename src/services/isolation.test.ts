import { describe, expect, it } from 'vitest';

// Vite inlines every source as a raw string at transform time — no node:fs,
// so the gate runs in the same environment as every other test.
const engineSources = import.meta.glob(
  ['../core/**/*.ts', '../ecs/**/*.ts', '../gameplay/**/*.ts', '../render/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const platformSources = import.meta.glob(['../platform/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Every module-specifier position the language has: `from '…'` (static import and
// re-export), bare side-effect `import '…'`, dynamic `import('…')`, `require('…')`.
// Matching the specifier itself rather than only `from`-clauses is what keeps
// `import '../platform/audio.ts';` and `await import('../game.ts')` from slipping
// past the gates below. `import.meta.glob(...)` is not a specifier position — the
// character after `import` is `.`, so the pattern never engages there.
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function moduleSpecifiers(source: string): string[] {
  return Array.from(source.matchAll(SPECIFIER_RE), (match) => match[1]);
}

// npm packages ('vitest', '@capacitor/app') are not src modules; these gates
// govern intra-src edges only, so only relative specifiers are judged.
const isIntraSrc = (spec: string): boolean => spec.startsWith('.');

// src/services and src/platform, with or without a trailing slash — `'../platform'`
// is a directory import and must be caught just like `'../platform/audio.ts'`.
const ENGINE_FORBIDDEN_RE = /(^|\/)(services|platform)(\/|$)/;

// platform must stay a leaf that only sees src/core types and src/content JSON.
// This is an allowlist, not a denylist: reaching back for `../game.ts`, `../main.ts`,
// `../ui/hud.ts` or any dir invented later is a violation by default rather than by
// omission — which is what stops a platform module from closing a cycle with game.ts.
// Assumes src/platform stays flat; a subdirectory would need './' widened to cover
// its own parent hop.
const PLATFORM_ALLOWED_RE = /^(\.\/|\.\.\/core\/|\.\.\/content\/)/;

const engineViolations = (source: string): string[] =>
  moduleSpecifiers(source).filter((spec) => isIntraSrc(spec) && ENGINE_FORBIDDEN_RE.test(spec));

const platformViolations = (source: string): string[] =>
  moduleSpecifiers(source).filter((spec) => isIntraSrc(spec) && !PLATFORM_ALLOWED_RE.test(spec));

const offenders = (
  sources: Record<string, string>,
  check: (source: string) => string[],
): string[] =>
  Object.entries(sources)
    .map(([file, source]) => [file, check(source)] as const)
    .filter(([, bad]) => bad.length > 0)
    .map(([file, bad]) => `${file}: ${bad.join(', ')}`);

describe('import-gate matcher', () => {
  it('reads specifiers out of every import form, not just from-clauses', () => {
    expect(moduleSpecifiers("import { a } from '../core/events.ts';")).toEqual([
      '../core/events.ts',
    ]);
    expect(moduleSpecifiers("import type { A } from '../core/events.ts';")).toEqual([
      '../core/events.ts',
    ]);
    expect(moduleSpecifiers("export { a } from './joystick.ts';")).toEqual(['./joystick.ts']);
    expect(moduleSpecifiers("import '../platform/audio.ts';")).toEqual(['../platform/audio.ts']);
    expect(moduleSpecifiers("const m = await import('../platform/audio.ts');")).toEqual([
      '../platform/audio.ts',
    ]);
    expect(moduleSpecifiers("const m = require('../services/save.ts');")).toEqual([
      '../services/save.ts',
    ]);
  });

  it('does not mistake import.meta.glob patterns for specifiers', () => {
    expect(
      moduleSpecifiers("const s = import.meta.glob(['../core/**/*.ts'], { eager: true });"),
    ).toEqual([]);
  });
});

describe('engine isolation', () => {
  it('actually covers the four engine directories and the platform layer', () => {
    const files = Object.keys(engineSources);
    for (const dir of ['/core/', '/ecs/', '/gameplay/', '/render/']) {
      expect(files.some((f) => f.includes(dir)), `no files globbed under ${dir}`).toBe(true);
    }
    expect(Object.keys(platformSources).length, 'no files globbed under /platform/').toBeGreaterThan(0);
  });

  it('never lets engine code import src/services or src/platform', () => {
    expect(offenders(engineSources, engineViolations)).toEqual([]);
  });

  it('catches services/platform reached by side-effect, dynamic or directory import', () => {
    expect(engineViolations("import '../platform/audio.ts';")).toEqual(['../platform/audio.ts']);
    expect(engineViolations("await import('../platform/audio.ts');")).toEqual([
      '../platform/audio.ts',
    ]);
    expect(engineViolations("import { save } from '../services';")).toEqual(['../services']);
    expect(engineViolations("export { save } from '../../services/save.ts';")).toEqual([
      '../../services/save.ts',
    ]);
    expect(engineViolations("import { Ctx } from './context.ts';")).toEqual([]);
    expect(engineViolations("import { App } from '@capacitor/app';")).toEqual([]);
  });
});

describe('platform leaf', () => {
  it('keeps the platform layer a leaf: only src/core, src/content and its own siblings', () => {
    expect(offenders(platformSources, platformViolations)).toEqual([]);
  });

  it('rejects any reach outside core/content, including game.ts, main.ts and ui/', () => {
    expect(platformViolations("import type { Game } from '../game.ts';")).toEqual(['../game.ts']);
    expect(platformViolations("import { boot } from '../main.ts';")).toEqual(['../main.ts']);
    expect(platformViolations("import { Hud } from '../ui/hud.ts';")).toEqual(['../ui/hud.ts']);
    expect(platformViolations("import { Ctx } from '../gameplay/context.ts';")).toEqual([
      '../gameplay/context.ts',
    ]);
    expect(platformViolations("import '../ui/hud.ts';")).toEqual(['../ui/hud.ts']);
    expect(platformViolations("const g = await import('../game.ts');")).toEqual(['../game.ts']);
    expect(platformViolations("import { save } from '../services';")).toEqual(['../services']);
  });

  it('allows core types, content JSON, siblings and npm packages', () => {
    expect(platformViolations("import type { GameEvents } from '../core/events.ts';")).toEqual([]);
    expect(platformViolations("import audioJson from '../content/audio.json';")).toEqual([]);
    expect(platformViolations("import { joystickVector } from './joystick.ts';")).toEqual([]);
    expect(platformViolations("import { App } from '@capacitor/app';")).toEqual([]);
    expect(platformViolations("import { describe } from 'vitest';")).toEqual([]);
  });
});
