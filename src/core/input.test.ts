import { describe, expect, it } from 'vitest';

import { Input } from './input.ts';

// A plain EventTarget instead of window: keyboard events never fire in these
// tests — they cover the injection and axis seams, which is exactly what the
// touch layer uses. Browser behavior stays covered by `npm run dev`.
function makeInput(): Input {
  return new Input(new EventTarget());
}

describe('input seams', () => {
  it('injectPress is consumed by exactly one wasPressed caller, like a real key', () => {
    const input = makeInput();
    input.injectPress('Escape');
    input.beginFrame();
    expect(input.wasPressed('Escape')).toBe(true); // first caller wins…
    expect(input.wasPressed('Escape')).toBe(false); // …later callers see nothing
  });

  it('endFrame clears injected presses like real keydowns', () => {
    const input = makeInput();
    input.injectPress('Space');
    input.beginFrame();
    input.endFrame();
    input.beginFrame();
    expect(input.wasPressed('Space')).toBe(false);
  });

  it('an attached axis source drives normalized axes', () => {
    const input = makeInput();
    const stick = { axisX: 1, axisY: 1 };
    input.attachAxisSource(stick);
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(Math.SQRT1_2, 5);
    expect(input.axisY).toBeCloseTo(Math.SQRT1_2, 5);
    stick.axisX = -1;
    stick.axisY = 0;
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(-1, 5);
    expect(input.axisY).toBeCloseTo(0, 5);
  });

  it('a detached axis source stops contributing', () => {
    const input = makeInput();
    const stick = { axisX: 1, axisY: 0 };
    const detach = input.attachAxisSource(stick);
    input.beginFrame();
    expect(input.axisX).toBeCloseTo(1, 5);
    detach();
    input.beginFrame();
    expect(input.axisX).toBe(0);
    expect(input.axisY).toBe(0);
  });
});
