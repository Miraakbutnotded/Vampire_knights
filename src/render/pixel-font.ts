/**
 * A 3x5 pixel font, and the baked atlas that draws it cheaply.
 *
 * Canvas `fillText` at 480x270 renders anti-aliased glyphs that look blurry
 * next to nearest-neighbour sprites, and a webfont would be an external
 * dependency. Five rows of three bits per glyph avoids both.
 *
 * Drawing those bits as `fillRect` calls costs up to fifteen fills per glyph,
 * and damage numbers are drawn twice each (shadow, then fill). At the numbers
 * this game throws that is a five-figure fill count per second. So each colour
 * gets its glyph row baked into a one-row atlas canvas once, and a glyph
 * becomes a single `drawImage`. The atlas is drawn at whole-number scales onto
 * a context with smoothing off, so the result is pixel-identical to the fills
 * it replaces.
 */

/** Bit rows per glyph, most significant bit leftmost. */
const GLYPH_TABLE: Record<string, readonly number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b001],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
  '-': [0b000, 0b000, 0b111, 0b000, 0b000],
  '!': [0b010, 0b010, 0b010, 0b000, 0b010],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101],
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const GLYPH_GAP = 1;

/** Atlas column order. A glyph's index here is its column in every baked atlas. */
export const GLYPH_CHARS: readonly string[] = Object.keys(GLYPH_TABLE);

/** Bit rows indexed by atlas column, so drawing never has to hash a string. */
export const GLYPH_ROWS: readonly (readonly number[])[] = GLYPH_CHARS.map(
  (char) => GLYPH_TABLE[char]!,
);

export const ATLAS_W = GLYPH_CHARS.length * GLYPH_W;
export const ATLAS_H = GLYPH_H;

/**
 * Char code -> atlas column, -1 for anything the font can't draw.
 *
 * A flat table rather than a Map lookup because the draw loop indexes it per
 * character per glyph per frame. Every glyph in the font is ASCII, so a
 * 128-entry table covers it; higher code units miss and are skipped, exactly as
 * an unknown ASCII char is.
 */
const COLUMN_BY_CODE = new Int8Array(128).fill(-1);
for (let i = 0; i < GLYPH_CHARS.length; i++) {
  COLUMN_BY_CODE[GLYPH_CHARS[i]!.charCodeAt(0)] = i;
}

/** Atlas column for a UTF-16 code unit, or -1 when the font has no such glyph. */
export function glyphColumn(code: number): number {
  return code >= 0 && code < 128 ? COLUMN_BY_CODE[code]! : -1;
}

/** Horizontal distance from one glyph's left edge to the next one's. */
export function glyphAdvance(scale: number): number {
  return (GLYPH_W + GLYPH_GAP) * scale;
}

/** Width of `text` in pixels — advances minus the trailing gap. */
export function pixelTextWidth(text: string, scale = 1): number {
  return text.length * glyphAdvance(scale) - GLYPH_GAP * scale;
}

/**
 * The atlas only reproduces the fill grid exactly at whole-number scales: a
 * fractional scale would resample a 3x5 source and soften edges the fills would
 * have left hard. Fractional callers fall back to the fills.
 */
export function atlasUsable(scale: number): boolean {
  return Number.isInteger(scale) && scale >= 1;
}

/**
 * Distinct colours that may hold a baked atlas. The call sites use seven
 * literals between them, so this is headroom rather than a limit anyone reaches
 * — and past it the fill path still draws, exactly as it did before atlases
 * existed. Same policy as the Fx pools: refuse, never grow.
 */
export const MAX_ATLASES = 16;

/** What a baked atlas has to be to get drawn. Widened for headless tests. */
export type Atlas = CanvasImageSource;

export type AtlasBaker = (color: string) => Atlas | null;

/** Paints one row of glyphs in `color`; the source of truth for atlas layout. */
export function bakeAtlasCanvas(color: string): Atlas | null {
  // No DOM (a headless test) or no context (memory pressure) both mean "no
  // atlas", and PixelFont answers that by drawing the fills instead. Same
  // fail-soft rule as a missing PNG becoming placeholder art.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = color;
  for (let col = 0; col < GLYPH_ROWS.length; col++) {
    const rows = GLYPH_ROWS[col]!;
    const originX = col * GLYPH_W;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = rows[row]!;
      for (let bit = 0; bit < GLYPH_W; bit++) {
        if (bits & (1 << (GLYPH_W - 1 - bit))) ctx.fillRect(originX + bit, row, 1, 1);
      }
    }
  }
  return canvas;
}

/**
 * Draws pixel text, from a baked atlas where it can and from fills where it
 * can't.
 *
 * Owned by whoever draws — no module-level canvas — so a headless test can
 * construct one with a fake baker and never touch the DOM. Baking is lazy for
 * the same reason: `new PixelFont()` allocates nothing.
 */
export class PixelFont {
  private readonly atlases = new Map<string, Atlas>();
  /** Colours that asked for an atlas and were refused; never asked again. */
  private readonly refused = new Set<string>();

  constructor(private readonly bake: AtlasBaker = bakeAtlasCanvas) {}

  /** How many colours currently hold a baked atlas. */
  get atlasCount(): number {
    return this.atlases.size;
  }

  /** The atlas for `color`, baking it on first use. null ⇒ use the fill path. */
  atlasFor(color: string): Atlas | null {
    const cached = this.atlases.get(color);
    if (cached !== undefined) return cached;
    if (this.refused.has(color)) return null;
    if (this.atlases.size >= MAX_ATLASES) {
      this.refused.add(color);
      return null;
    }
    const baked = this.bake(color);
    if (!baked) {
      this.refused.add(color);
      return null;
    }
    this.atlases.set(color, baked);
    return baked;
  }

  /**
   * Draws `text` left-aligned at (x, y). Unknown chars are skipped but still
   * advance the cursor, so a string's width never depends on which glyphs the
   * font happens to have.
   *
   * Indexes by code unit rather than iterating the string: `for (const c of s)`
   * allocates an iterator and a one-char string per character, and this runs
   * per glyph per number per frame.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    scale = 1,
  ): void {
    const atlas = atlasUsable(scale) ? this.atlasFor(color) : null;
    const advance = glyphAdvance(scale);
    let cursor = x;

    if (atlas) {
      const dw = GLYPH_W * scale;
      const dh = GLYPH_H * scale;
      for (let i = 0; i < text.length; i++) {
        const col = glyphColumn(text.charCodeAt(i));
        if (col >= 0) {
          ctx.drawImage(atlas, col * GLYPH_W, 0, GLYPH_W, GLYPH_H, cursor, y, dw, dh);
        }
        cursor += advance;
      }
      return;
    }

    ctx.fillStyle = color;
    for (let i = 0; i < text.length; i++) {
      const col = glyphColumn(text.charCodeAt(i));
      if (col >= 0) {
        const rows = GLYPH_ROWS[col]!;
        for (let row = 0; row < GLYPH_H; row++) {
          const bits = rows[row]!;
          for (let bit = 0; bit < GLYPH_W; bit++) {
            if (bits & (1 << (GLYPH_W - 1 - bit))) {
              ctx.fillRect(cursor + bit * scale, y + row * scale, scale, scale);
            }
          }
        }
      }
      cursor += advance;
    }
  }
}
