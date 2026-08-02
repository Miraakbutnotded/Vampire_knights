/**
 * Pre-baked hit-flash silhouettes.
 *
 * A flashing sprite is drawn normally and then overpainted with a white copy of
 * itself. Building that copy per draw means, per flashing sprite per frame:
 * clear a scratch canvas, blit the frame into it, switch the composite mode to
 * 'source-atop', fill it white, switch back — and then immediately use that
 * same canvas as a `drawImage` source. Writing a canvas and reading it in the
 * same frame is the one access pattern a GPU-backed 2D context cannot pipeline;
 * it forces a flush every time.
 *
 * Baking instead makes the silhouette write-once, read-many. The whole strip is
 * baked in one go rather than a frame at a time: the frames of a strip are
 * contiguous, so one sheet per source lets the draw sample it with the same
 * `sx` it already uses on the real strip, and the cache key collapses to source
 * identity — no per-draw key string, no per-source frame table.
 *
 * White at the sprite's own alpha, with the flash strength applied as
 * `globalAlpha` at draw time, rather than a pre-mixed tint baked per strength:
 * for an opaque pixel the two composite identically, and pixel art is opaque
 * where it is drawn at all.
 */

/** Strips that may hold a baked sheet. Roughly one per animation state in the game. */
export const MAX_FLASH_SHEETS = 192;

/**
 * Total baked area, in pixels. Four bytes each, so this caps the cache near
 * 8 MB — a budget a phone can hold alongside the decoded strips it mirrors.
 */
export const MAX_FLASH_PIXELS = 2 * 1024 * 1024;

export type FlashBaker<T> = (source: CanvasImageSource, w: number, h: number) => T | null;

/**
 * One baked sheet per strip, keyed by the strip's own identity.
 *
 * A WeakMap because a sheet must not outlive the strip it mirrors, and because
 * `get` on an object key costs no allocation — which a template-literal key
 * would, once per flashing sprite per frame.
 *
 * Both caps refuse rather than evict: a refusal falls back to the scratch-canvas
 * path, which is what this replaced, so the flash never disappears. Refusals are
 * remembered so a refused strip is not re-measured every frame.
 */
export class FlashSheetCache<T = CanvasImageSource> {
  private readonly sheets = new WeakMap<object, T | null>();
  private sheetCount = 0;
  private bakedPixels = 0;

  constructor(private readonly bake: FlashBaker<T> = bakeFlashSheet as unknown as FlashBaker<T>) {}

  /** Baked strips currently held. */
  get count(): number {
    return this.sheetCount;
  }

  /** Total baked area in pixels. */
  get pixels(): number {
    return this.bakedPixels;
  }

  /**
   * The white sheet for `source`, baking it on first use. `w`/`h` are the strip's
   * used extent — `frameW * frames` by `frameH`, which is what the draw samples.
   * null means the caller must fall back.
   */
  get(source: CanvasImageSource, w: number, h: number): T | null {
    const key = source as object;
    const cached = this.sheets.get(key);
    if (cached !== undefined) return cached;

    if (!(w > 0) || !(h > 0)) return null;
    if (this.sheetCount >= MAX_FLASH_SHEETS || this.bakedPixels + w * h > MAX_FLASH_PIXELS) {
      this.sheets.set(key, null);
      return null;
    }

    const sheet = this.bake(source, w, h);
    this.sheets.set(key, sheet);
    if (sheet !== null) {
      this.sheetCount++;
      this.bakedPixels += w * h;
    }
    return sheet;
  }
}

/** Paints a strip's opaque pixels white, preserving its alpha. */
export function bakeFlashSheet(
  source: CanvasImageSource,
  w: number,
  h: number,
): HTMLCanvasElement | null {
  // No DOM or no context both mean "no sheet", and the caller falls back to the
  // scratch path rather than losing the flash.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, w, h, 0, 0, w, h);
  // 'source-atop' paints white only where the strip is opaque, keeping its shape.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}
