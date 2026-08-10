/**
 * The one place that knows the world is drawn on the diagonal.
 *
 * Gameplay stays flat. Every system in `gameplay/` reasons about a 2D plane —
 * distances, radii, the spatial hash, knockback — and none of it changes here,
 * because an isometric view is a *projection*, not a different simulation. The
 * whole conversion lives in this file so that stays true: the renderer projects
 * on the way in, the tile map and anything asking "is this on screen?" projects
 * or unprojects through these functions, and nothing else has to care.
 *
 * The projection is a 45-degree rotation followed by a vertical squash, which
 * is what makes a world-axis-aligned square land as a 2:1 diamond:
 *
 *     screenX = (wx - wy) * COS45
 *     screenY = (wx + wy) * COS45 * SQUASH
 *
 * `COS45` rather than 1 keeps a world unit close to a screen pixel; dropping it
 * would silently stretch the whole arena by 1.41 along the diagonal.
 *
 * Depth is `wx + wy`, the distance along the screen's vertical axis. That is
 * the isometric equivalent of "further down the screen draws later", and it is
 * why the existing feet-on-ground sort survives unchanged — `renderer.queue`
 * already takes an explicit depth, it just used to default to `y`.
 */

/** Half of the 2:1 diamond: a world square is twice as wide as it is tall. */
const SQUASH = 0.5;
const COS45 = Math.SQRT1_2;

/**
 * Uniform zoom applied after the projection.
 *
 * The squash halves how much vertical screen space a given world distance takes,
 * so an unscaled projection shows roughly twice the world area — and how much of
 * the arena you can see is a difficulty knob in this genre, not a free choice.
 * This pulls the view back toward the flat game's footprint.
 */
export const ISO_ZOOM = 1.35;

/**
 * The projection as a pair of scales, for callers that need the matrix rather
 * than a point — the tile map skews square ground textures into diamonds with
 * `setTransform(ISO_SX, ISO_SY, -ISO_SX, ISO_SY, ...)`.
 */
export const ISO_SX = COS45 * ISO_ZOOM;
export const ISO_SY = COS45 * SQUASH * ISO_ZOOM;

const SX = ISO_SX;
const SY = ISO_SY;

/** World position to screen x. */
export function isoX(wx: number, wy: number): number {
  return (wx - wy) * SX;
}

/** World position to screen y. */
export function isoY(wx: number, wy: number): number {
  return (wx + wy) * SY;
}

/**
 * Sort key for a world position: how far down the screen it sits.
 *
 * Deliberately `wx + wy` rather than `isoY`, so the ordering is independent of
 * zoom — a depth stored under one zoom stays valid under another.
 */
export function isoDepth(wx: number, wy: number): number {
  return wx + wy;
}

/** Screen position back to world x. */
export function worldX(sx: number, sy: number): number {
  return (sy / SY + sx / SX) / 2;
}

/** Screen position back to world y. */
export function worldY(sx: number, sy: number): number {
  return (sy / SY - sx / SX) / 2;
}

/**
 * The world-space bounding box of a screen-space rect.
 *
 * A screen rectangle unprojects to a diamond, and a diamond's bounding box is
 * what callers that iterate world cells actually need. It is deliberately
 * generous: culling and tile iteration must never miss something at a corner,
 * and drawing a few extra off-screen tiles is cheaper than a hole in the floor.
 */
export function worldBounds(
  left: number,
  top: number,
  right: number,
  bottom: number,
): { left: number; top: number; right: number; bottom: number } {
  const xs = [
    worldX(left, top), worldX(right, top),
    worldX(left, bottom), worldX(right, bottom),
  ];
  const ys = [
    worldY(left, top), worldY(right, top),
    worldY(left, bottom), worldY(right, bottom),
  ];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}
