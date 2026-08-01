import { describe, expect, it } from 'vitest';

import { VIEW_H, VIEW_W, viewportScale } from './renderer.ts';

describe('viewport scale', () => {
  it('fits the buffer exactly on the binding axis', () => {
    // 1080p: the view is exactly a quarter of it, so this lands on a clean 4x.
    expect(viewportScale(1920, 1080)).toBeCloseTo(4, 5);
    // Height binds: a tall window can only show the view as wide as it is high.
    expect(viewportScale(4000, 540)).toBeCloseTo(2, 5);
    // Width binds.
    expect(viewportScale(480, 4000)).toBeCloseTo(1, 5);
  });

  it('fills the short axis on phone aspect ratios instead of flooring away a third of it', () => {
    // iPhone-class landscape viewport at the dpr-2 cap: 874x402 CSS px.
    const scale = viewportScale(1748, 804);
    // The old integer-floored rule collapsed 2.98 to 2 and left the game
    // occupying two thirds of the height on a screen with room for all of it.
    expect(scale).toBeGreaterThan(2.9);
    expect(VIEW_H * scale).toBeCloseTo(804, 5);
    expect(VIEW_W * scale).toBeLessThanOrEqual(1748);
  });

  it('scales down below 1 when the window is smaller than the view', () => {
    expect(viewportScale(240, 135)).toBeCloseTo(0.5, 5);
  });

  it('never returns a scale that overflows either axis', () => {
    for (const [w, h] of [
      [1748, 804],
      [2556, 1179],
      [1334, 750],
      [800, 600],
      [3024, 1964],
    ] as const) {
      const scale = viewportScale(w, h);
      expect(VIEW_W * scale).toBeLessThanOrEqual(w + 1e-9);
      expect(VIEW_H * scale).toBeLessThanOrEqual(h + 1e-9);
    }
  });
});
