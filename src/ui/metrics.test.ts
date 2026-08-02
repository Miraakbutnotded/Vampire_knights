import { describe, expect, it } from 'vitest';

import { VIEW_H, VIEW_W, viewportScale } from '../render/renderer.ts';

import { UI_SCALE_MAX, UI_SCALE_MIN_COARSE, UI_SCALE_MIN_FINE, uiScale } from './metrics.ts';

// Vite inlines the stylesheet as a raw string at transform time, the same trick
// `services/isolation.test.ts` uses on the source tree — so the allowlist gate
// below runs headless, in the same environment as every other test.
const styleSheet = import.meta.glob('./style.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const css = styleSheet['./style.css'] ?? '';

/**
 * The stylesheet with its comments removed. Every gate below reads this rather
 * than the raw text: the file explains the art/chrome split in prose, quoting
 * both `var(--u)` and `@media (pointer: coarse)` while doing so, and a gate that
 * cannot tell an explanation from a declaration is not a gate.
 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('chrome scale', () => {
  it('is the art scale wherever the art scale is a sane size for a control', () => {
    // This is the invariant the whole migration rests on: in the band, chrome
    // and art are the same number, so sizing the interface in chrome units
    // changed nothing about how an ordinary desktop window renders.
    expect(uiScale(1440, 900, false)).toBeCloseTo(3, 10);
    expect(uiScale(1920, 1080, false)).toBeCloseTo(4, 10);
    expect(uiScale(1600, 1000, false)).toBeCloseTo(3.333, 3);
    for (const [w, h] of [
      [1440, 900],
      [1920, 1080],
      [1600, 1000],
      [1024, 768],
      [2160, 1215],
    ] as const) {
      expect(uiScale(w, h, false), `${w}x${h}`).toBeCloseTo(viewportScale(w, h), 10);
    }
  });

  it('holds every shipping phone at one physical size', () => {
    // Landscape viewports across the iPhone range. The art scale varies by 14%
    // between the widest and the narrowest of them; the chrome does not vary at
    // all, which is the point — a button is a thumb-width on all of them.
    const phones = [
      [874, 402], // 15 Pro Max
      [852, 393], // 15 Pro
      [932, 430], // 16 Pro Max
      [844, 390], // 13/14
      [667, 375], // SE
    ] as const;
    for (const [w, h] of phones) {
      expect(uiScale(w, h, true), `${w}x${h}`).toBe(UI_SCALE_MIN_COARSE);
      // And it is genuinely a departure, not a coincidence: the art scale on
      // every one of these is roughly half the chrome scale.
      expect(viewportScale(w, h)).toBeLessThan(1.7);
    }
  });

  it('holds tablets on the touch floor too', () => {
    // iPads clear the fine-pointer floor on their own but still take the touch
    // floor, because the finger is the same size on a tablet.
    expect(uiScale(1180, 820, true)).toBe(UI_SCALE_MIN_COARSE);
    expect(uiScale(1366, 1024, true)).toBe(UI_SCALE_MIN_COARSE);
    // The same viewport driven by a mouse is inside the band and takes the art
    // scale — the floor is about the pointer, not about the pixels.
    expect(uiScale(1366, 1024, false)).toBeCloseTo(viewportScale(1366, 1024), 10);
  });

  it('stops growing on very large displays', () => {
    expect(uiScale(2560, 1440, false)).toBe(UI_SCALE_MAX);
    expect(uiScale(3840, 2160, false)).toBe(UI_SCALE_MAX);
    // The art is still free to grow: 4K draws the world at 8x while the
    // interface stays at 4.5x.
    expect(viewportScale(3840, 2160)).toBeCloseTo(8, 10);
    // Just inside the ceiling, nothing is clamped.
    expect(uiScale(2159, 1214, false)).toBeLessThan(UI_SCALE_MAX);
  });

  it('keeps chrome legible in a window too small to deserve it', () => {
    expect(uiScale(800, 600, false)).toBe(UI_SCALE_MIN_FINE);
    expect(uiScale(VIEW_W, VIEW_H, false)).toBe(UI_SCALE_MIN_FINE);
    // Either axis can bind: a wide, short window is still a small window.
    expect(uiScale(4000, 400, false)).toBe(UI_SCALE_MIN_FINE);
    expect(uiScale(400, 4000, false)).toBe(UI_SCALE_MIN_FINE);
  });

  it('never publishes a scale that would collapse the interface', () => {
    // A hidden iframe or a window mid-restore reports zero; NaN can arrive from
    // a jsdom-ish host that leaves innerWidth undefined. Neither may reach CSS,
    // because `--ui-scale: NaN` invalidates every length that depends on it.
    for (const [w, h] of [
      [0, 0],
      [-100, -100],
      [Number.NaN, 900],
      [1440, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(uiScale(w, h, false), `${w}x${h} fine`).toBeGreaterThanOrEqual(UI_SCALE_MIN_FINE);
      expect(uiScale(w, h, false), `${w}x${h} fine`).toBeLessThanOrEqual(UI_SCALE_MAX);
      expect(uiScale(w, h, true), `${w}x${h} coarse`).toBeGreaterThanOrEqual(UI_SCALE_MIN_COARSE);
      expect(uiScale(w, h, true), `${w}x${h} coarse`).toBeLessThanOrEqual(UI_SCALE_MAX);
    }
  });

  it('is monotonic in the viewport, so a resize never jumps the wrong way', () => {
    let previous = 0;
    for (let w = 480; w <= 4000; w += 40) {
      const value = uiScale(w, w * (VIEW_H / VIEW_W), false);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('art-bound allowlist', () => {
  // The classification rule, restated so a reviewer can apply it: a length is
  // art-bound if changing it would put the element out of agreement with a
  // sprite or a world position. Exactly one rule in the stylesheet answers yes.
  const ART_BOUND_SELECTORS = ['.xp-track'];

  /** Every rule in the sheet as [selector text, declaration block]. */
  function rules(sheet: string): Array<[string, string]> {
    return Array.from(sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => [
      match[1].trim().replace(/\s+/g, ' '),
      match[2],
    ]);
  }

  const artUnit = /var\(--u\)/;

  it('parses the stylesheet it is meant to be gating', () => {
    expect(css.length).toBeGreaterThan(1000);
    const selectors = rules(declarations).map(([selector]) => selector);
    expect(selectors).toContain('.xp-track');
    expect(selectors).toContain('.blood-orb');
    expect(selectors.length).toBeGreaterThan(80);
  });

  it('spends the art unit only where the interface has to agree with the art', () => {
    const offenders = rules(declarations)
      .filter(([selector, body]) => artUnit.test(body) && !ART_BOUND_SELECTORS.includes(selector))
      // `:root` defines `--u` itself, which is not a use of it.
      .filter(([selector]) => selector !== ':root')
      .map(([selector]) => selector);
    expect(offenders).toEqual([]);
  });

  it('still has the art-bound rule it claims to protect', () => {
    // The other half of the gate: deleting the allowlisted rule, or quietly
    // migrating it to chrome units, must fail here rather than pass silently.
    const xpTrack = rules(declarations).find(([selector]) => selector === '.xp-track');
    expect(xpTrack).toBeDefined();
    expect(xpTrack![1]).toMatch(artUnit);
  });

  it('sizes everything else in the chrome unit', () => {
    // The complement of the gate above: no rule may be left in raw `--scale`,
    // and the chrome unit has to actually be in use.
    const rawArtScale = rules(declarations)
      .filter(([selector]) => selector !== ':root')
      .filter(([, body]) => /var\(--scale\)/.test(body))
      .map(([selector]) => selector);
    expect(rawArtScale).toEqual([]);
    expect(declarations.match(/var\(--ui\)/g)?.length ?? 0).toBeGreaterThan(100);
  });

  it('keys touch rules off the class Game writes, not a media query', () => {
    // Two sources of truth for "is this a touch device" is how a hybrid laptop
    // ends up with a pause button that is in the DOM but invisible.
    expect(declarations).not.toMatch(/@media[^{]*pointer:\s*coarse/);
    expect(declarations).toMatch(/\.coarse \.touch-layer/);
    expect(declarations).toMatch(/\.coarse \.touch-pause/);
  });
});
