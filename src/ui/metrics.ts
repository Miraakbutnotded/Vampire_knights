import { VIEW_H, VIEW_W } from '../render/renderer.ts';

/**
 * The interface's own scale, deliberately written next to `viewportScale()` in
 * `src/render/renderer.ts` so the two sit side by side in review.
 *
 * The art scale answers "how many CSS pixels is one game pixel?", and until now
 * the whole DOM interface was sized in that same unit. That is the right answer
 * for the world and the wrong one for the chrome, because the two have
 * different masters: a sprite must agree with the buffer it was drawn for, and
 * a button must agree with a finger. On an 874x402 phone the art scale resolves
 * to 1.489, which makes every control exactly half the size it was authored at
 * — a 44pt tap target designed on a desktop lands at 22pt on the device where
 * it is the only way to play.
 *
 * So the chrome gets its own unit, computed from the same basis and then
 * clamped:
 *
 *   uiScale = clamp(floor, min(cssW / VIEW_W, cssH / VIEW_H), CEILING)
 *
 * Taking the art scale as the basis is the whole trick. Inside the band the two
 * numbers are identical, so every desktop window renders exactly as it did
 * before and this unit is not a redesign; the chrome only departs from the art
 * at the clamps, which is precisely where the art scale is wrong — too small
 * for fingers on a phone, too large for eyes on a 4K monitor.
 *
 * Both bounds are stated in CSS pixels per chrome unit, and on iOS one CSS
 * pixel is one point, so these are directly comparable to Apple's 44pt minimum.
 */

/**
 * Mouse and trackpad. Two is the smallest unit at which the 4u-tall text in
 * this interface (the card cost, the blood button labels) stays readable; it
 * binds only below 960x540, where the HUD covering more of an already
 * degenerate window is the correct trade against illegible chrome.
 */
export const UI_SCALE_MIN_FINE = 2;

/**
 * Touch. Every shipping phone lands on this floor — 667x375 through 932x430
 * all compute an art scale between 1.39 and 1.59, and iPads between 2.4 and
 * 2.9 — so chrome becomes physically constant across the whole touch
 * population instead of varying with aspect ratio. The very wide phone and the
 * narrow one get the same size button, which is the point of the exercise.
 */
export const UI_SCALE_MIN_COARSE = 3;

/**
 * Above 2160x1215 the art keeps growing and the interface stops. A 4K monitor
 * draws the world at 8x and the chrome at 4.5x: the game gets big, the
 * furniture does not. This is the one intentional desktop change in the unit,
 * and nothing below 2160x1215 reaches it.
 */
export const UI_SCALE_MAX = 4.5;

/**
 * Chrome units per CSS pixel for a viewport of `cssW` x `cssH` CSS pixels.
 *
 * `coarse` selects the floor and is the device's pointer class — resolved once,
 * in Game's constructor, from the same `navigator.maxTouchPoints` test that
 * decides whether the joystick exists at all. One source of truth: the
 * stylesheet keys its touch rules off a `.coarse` class written from that same
 * answer rather than asking the browser a second, subtly different question.
 *
 * Dimensions are CSS pixels, never device pixels — device pixel ratio must not
 * enter here or the unit would shrink on exactly the dense displays where
 * physical size matters most.
 */
export function uiScale(cssW: number, cssH: number, coarse: boolean): number {
  const floor = coarse ? UI_SCALE_MIN_COARSE : UI_SCALE_MIN_FINE;
  const art = Math.min(cssW / VIEW_W, cssH / VIEW_H);
  // A zero or negative viewport (a hidden iframe, a window mid-restore) falls
  // out of the clamp as the floor on its own; NaN would not, and publishing
  // NaN would collapse every length in the interface to nothing.
  if (!Number.isFinite(art)) return floor;
  return Math.min(Math.max(art, floor), UI_SCALE_MAX);
}
