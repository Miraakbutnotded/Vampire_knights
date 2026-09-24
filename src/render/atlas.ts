import type { Anim, SpriteTable } from './sprites.ts';

/** A rectangle in atlas pixels, origin top-left. */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Transparent gutter between strips, so nearest sampling never bleeds a neighbour in. */
const GUTTER = 1;

/**
 * Shelf-packs rectangles into a `size` x `size` square, tallest first.
 *
 * Returns the placements in input order, or null when they do not fit. Shelf
 * packing wastes some space above short strips, but every strip in this game
 * is a single row of frames and the whole set is well under a quarter of the
 * smallest atlas it lands in, so the simple packer is the honest one.
 */
export function packShelves(sizes: readonly { w: number; h: number }[], size: number): AtlasRect[] | null {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b]!.h - sizes[a]!.h || sizes[b]!.w - sizes[a]!.w);
  const out: AtlasRect[] = new Array(sizes.length);

  let shelfY = GUTTER;
  let shelfH = 0;
  let cursorX = GUTTER;
  for (const i of order) {
    const { w, h } = sizes[i]!;
    if (w + GUTTER * 2 > size || h + GUTTER * 2 > size) return null;
    if (cursorX + w + GUTTER > size) {
      shelfY += shelfH + GUTTER;
      shelfH = 0;
      cursorX = GUTTER;
    }
    if (shelfY + h + GUTTER > size) return null;
    out[i] = { x: cursorX, y: shelfY, w, h };
    cursorX += w + GUTTER;
    shelfH = Math.max(shelfH, h);
  }
  return out;
}

/** Every animation strip in one canvas, so the whole sprite pass is one draw call. */
export interface SpriteAtlas {
  canvas: HTMLCanvasElement;
  size: number;
  /** Where a strip landed. Strips are keyed by their source image, shared or not. */
  rectOf(anim: Anim): AtlasRect | undefined;
}

/** The largest texture every WebGL device this ships to is guaranteed to accept. */
const MAX_ATLAS = 4096;

/**
 * Copies every strip the sprite table holds into one power-of-two canvas.
 *
 * Keyed by source rather than by (sprite, state): a sprite with no art for a
 * state borrows its Idle strip as the *same object*, and several sprites share
 * one PNG, so keying by source packs each image once however many names
 * point at it.
 */
export function buildSpriteAtlas(sprites: SpriteTable): SpriteAtlas {
  const sources: Anim[] = [];
  const seen = new Set<CanvasImageSource>();
  for (let id = 0; id < sprites.count; id++) {
    for (const anim of sprites.get(id).anims) {
      if (!anim || seen.has(anim.source)) continue;
      seen.add(anim.source);
      sources.push(anim);
    }
  }

  const sizes = sources.map((a) => ({ w: a.frameW * a.frames, h: a.frameH }));
  let size = 512;
  let rects = packShelves(sizes, size);
  while (!rects && size < MAX_ATLAS) {
    size *= 2;
    rects = packShelves(sizes, size);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const bySource = new Map<CanvasImageSource, AtlasRect>();
  if (!rects) {
    // Fail-soft, like a missing PNG: past the texture limit the sprites draw as
    // nothing rather than the game refusing to start.
    console.warn(`[atlas] sprites do not fit a ${MAX_ATLAS}px atlas; the 3D view will draw none of them`);
  } else {
    sources.forEach((anim, i) => {
      const r = rects[i]!;
      ctx.drawImage(anim.source, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      bySource.set(anim.source, r);
    });
  }

  return { canvas, size, rectOf: (anim) => bySource.get(anim.source) };
}
