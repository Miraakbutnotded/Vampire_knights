import { describe, expect, it } from 'vitest';

import {
  ATLAS_H,
  ATLAS_W,
  GLYPH_CHARS,
  GLYPH_GAP,
  GLYPH_H,
  GLYPH_ROWS,
  GLYPH_W,
  MAX_ATLASES,
  PixelFont,
  atlasUsable,
  glyphAdvance,
  glyphColumn,
  pixelTextWidth,
} from './pixel-font.ts';
import type { Atlas } from './pixel-font.ts';

/** A rect the font asked to be painted, as [x, y, w, h]. */
type Rect = [number, number, number, number];

const sortRects = (rects: Rect[]): Rect[] =>
  [...rects].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

/** Records fillRect calls; stands in for the buffer context. */
function fillRecorder(): { rects: Rect[]; ctx: CanvasRenderingContext2D } {
  const rects: Rect[] = [];
  const ctx = {
    fillRect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]),
    set fillStyle(_value: string) {},
    drawImage: () => {
      throw new Error('unexpected drawImage on the fill path');
    },
  };
  return { rects, ctx: ctx as unknown as CanvasRenderingContext2D };
}

/**
 * Records drawImage calls and expands each into the pixels the atlas would put
 * on screen — which is what has to match the fill path rect for rect.
 */
function atlasRecorder(): { rects: Rect[]; ctx: CanvasRenderingContext2D } {
  const rects: Rect[] = [];
  const ctx = {
    fillRect: () => {
      throw new Error('unexpected fillRect on the atlas path');
    },
    set fillStyle(_value: string) {},
    drawImage: (
      _atlas: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      expect(sy).toBe(0);
      expect(sw).toBe(GLYPH_W);
      expect(sh).toBe(GLYPH_H);
      expect(sx % GLYPH_W).toBe(0);
      const scale = dw / GLYPH_W;
      expect(dh / GLYPH_H).toBe(scale);
      const bits = GLYPH_ROWS[sx / GLYPH_W]!;
      for (let row = 0; row < GLYPH_H; row++) {
        for (let bit = 0; bit < GLYPH_W; bit++) {
          if (bits[row]! & (1 << (GLYPH_W - 1 - bit))) {
            rects.push([dx + bit * scale, dy + row * scale, scale, scale]);
          }
        }
      }
    },
  };
  return { rects, ctx: ctx as unknown as CanvasRenderingContext2D };
}

const FAKE_ATLAS = { atlas: true } as unknown as Atlas;

describe('glyph metrics', () => {
  it('lays the atlas out one glyph column per character, in table order', () => {
    expect(ATLAS_W).toBe(GLYPH_CHARS.length * GLYPH_W);
    expect(ATLAS_H).toBe(GLYPH_H);
    expect(GLYPH_ROWS.length).toBe(GLYPH_CHARS.length);
    GLYPH_CHARS.forEach((char, index) => {
      expect(glyphColumn(char.charCodeAt(0))).toBe(index);
    });
  });

  it('keeps every glyph inside the 3x5 cell the atlas reserves for it', () => {
    // A glyph row with a bit above 0b111 would paint into its neighbour's column
    // once the font is baked into a shared strip, which the fills tolerated.
    for (let i = 0; i < GLYPH_ROWS.length; i++) {
      const rows = GLYPH_ROWS[i]!;
      expect(rows.length, `glyph "${GLYPH_CHARS[i]}" row count`).toBe(GLYPH_H);
      for (const bits of rows) {
        expect(bits, `glyph "${GLYPH_CHARS[i]}" row bits`).toBeLessThan(1 << GLYPH_W);
        expect(bits).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reports no glyph for characters the font does not define', () => {
    expect(glyphColumn('Z'.charCodeAt(0))).toBe(-1);
    expect(glyphColumn(' '.charCodeAt(0))).toBe(-1);
    expect(glyphColumn('é'.charCodeAt(0))).toBe(-1);
    expect(glyphColumn(0)).toBe(-1);
    expect(glyphColumn(-1)).toBe(-1);
    expect(glyphColumn(1_000_000)).toBe(-1);
  });

  it('measures text as advances minus the trailing gap', () => {
    expect(glyphAdvance(1)).toBe(GLYPH_W + GLYPH_GAP);
    expect(pixelTextWidth('1')).toBe(GLYPH_W);
    expect(pixelTextWidth('123')).toBe(3 * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP);
    expect(pixelTextWidth('123', 2)).toBe(2 * pixelTextWidth('123'));
    // Width is a function of length alone, so an undrawable char still occupies
    // its cell and centring never shifts.
    expect(pixelTextWidth('1Z3')).toBe(pixelTextWidth('123'));
  });

  it('only claims the atlas is exact at whole scales of at least one', () => {
    expect(atlasUsable(1)).toBe(true);
    expect(atlasUsable(3)).toBe(true);
    expect(atlasUsable(1.5)).toBe(false);
    expect(atlasUsable(0.5)).toBe(false);
    expect(atlasUsable(0)).toBe(false);
    expect(atlasUsable(Number.NaN)).toBe(false);
  });
});

describe('atlas and fill paths agree', () => {
  for (const scale of [1, 2, 3]) {
    it(`paints the same pixels at scale ${scale}`, () => {
      const text = '+1234567890-!%';
      const fills = fillRecorder();
      const atlas = atlasRecorder();

      new PixelFont(() => null).draw(fills.ctx, text, 17, 9, '#fff4e0', scale);
      new PixelFont(() => FAKE_ATLAS).draw(atlas.ctx, text, 17, 9, '#fff4e0', scale);

      expect(atlas.rects.length).toBeGreaterThan(0);
      expect(sortRects(atlas.rects)).toEqual(sortRects(fills.rects));
    });
  }

  it('falls back to fills at a fractional scale rather than resampling', () => {
    const fills = fillRecorder();
    // The recorder throws on drawImage, so reaching the atlas here would fail.
    new PixelFont(() => FAKE_ATLAS).draw(fills.ctx, '42', 0, 0, '#fff4e0', 1.5);
    expect(fills.rects.length).toBeGreaterThan(0);
  });

  it('skips undrawable characters but still advances past them', () => {
    const withGap = fillRecorder();
    const withDigit = fillRecorder();
    new PixelFont(() => null).draw(withGap.ctx, '1Z1', 0, 0, '#fff', 1);
    new PixelFont(() => null).draw(withDigit.ctx, '111', 0, 0, '#fff', 1);
    // Same first and last glyph positions; only the middle cell differs.
    const rightmost = (rects: Rect[]): number => Math.max(...rects.map((r) => r[0]));
    expect(rightmost(withGap.rects)).toBe(rightmost(withDigit.rects));
    expect(withGap.rects.length).toBeLessThan(withDigit.rects.length);
  });
});

describe('atlas cache', () => {
  it('bakes a colour once and reuses it', () => {
    let bakes = 0;
    const font = new PixelFont((color) => {
      bakes++;
      return { color } as unknown as Atlas;
    });

    const first = font.atlasFor('#ffd23f');
    expect(font.atlasFor('#ffd23f')).toBe(first);
    expect(font.atlasFor('#ffd23f')).toBe(first);
    expect(bakes).toBe(1);
    expect(font.atlasCount).toBe(1);

    expect(font.atlasFor('#fff4e0')).not.toBe(first);
    expect(bakes).toBe(2);
    expect(font.atlasCount).toBe(2);
  });

  it('refuses past the cap instead of growing, and does not keep re-asking', () => {
    let bakes = 0;
    const font = new PixelFont(() => {
      bakes++;
      return {} as unknown as Atlas;
    });

    for (let i = 0; i < MAX_ATLASES; i++) expect(font.atlasFor(`c${i}`)).not.toBeNull();
    expect(font.atlasCount).toBe(MAX_ATLASES);
    expect(bakes).toBe(MAX_ATLASES);

    expect(font.atlasFor('one-too-many')).toBeNull();
    expect(font.atlasFor('one-too-many')).toBeNull();
    expect(bakes).toBe(MAX_ATLASES);
    expect(font.atlasCount).toBe(MAX_ATLASES);

    // Colours that did get an atlas keep it.
    expect(font.atlasFor('c0')).not.toBeNull();
  });

  it('remembers a baker that could not produce an atlas', () => {
    let bakes = 0;
    const font = new PixelFont(() => {
      bakes++;
      return null;
    });
    expect(font.atlasFor('#fff')).toBeNull();
    expect(font.atlasFor('#fff')).toBeNull();
    expect(bakes).toBe(1);
    expect(font.atlasCount).toBe(0);
  });

  it('never bakes until something is actually drawn', () => {
    let bakes = 0;
    const font = new PixelFont(() => {
      bakes++;
      return {} as unknown as Atlas;
    });
    expect(bakes).toBe(0);
    expect(font.atlasCount).toBe(0);
    void font;
  });
});
