import { describe, expect, it } from 'vitest';

import { FlashSheetCache, MAX_FLASH_PIXELS, MAX_FLASH_SHEETS } from './flash-sheet.ts';

/** Stands in for an animation strip; only its identity matters to the cache. */
const strip = (name: string): CanvasImageSource => ({ name }) as unknown as CanvasImageSource;

interface Baked {
  source: CanvasImageSource;
  w: number;
  h: number;
}

function tracked(): {
  cache: FlashSheetCache<Baked>;
  calls: Baked[];
} {
  const calls: Baked[] = [];
  const cache = new FlashSheetCache<Baked>((source, w, h) => {
    const baked = { source, w, h };
    calls.push(baked);
    return baked;
  });
  return { cache, calls };
}

describe('flash sheet cache', () => {
  it('bakes a strip once and keys purely on its identity', () => {
    const { cache, calls } = tracked();
    const idle = strip('idle');

    const first = cache.get(idle, 64, 16);
    expect(first).not.toBeNull();
    // Same strip, different reported extent: identity wins, nothing is re-baked.
    expect(cache.get(idle, 64, 16)).toBe(first);
    expect(cache.get(idle, 999, 999)).toBe(first);
    expect(calls.length).toBe(1);
    expect(cache.count).toBe(1);
    expect(cache.pixels).toBe(64 * 16);
  });

  it('costs one bake for a whole crowd flashing for a whole second', () => {
    // The per-frame claim, measured: before the cache every flashing sprite
    // paid a clear, a blit, two composite switches and a fill on every frame.
    const { cache, calls } = tracked();
    const idle = strip('idle');
    let hits = 0;
    for (let frame = 0; frame < 60; frame++) {
      for (let sprite = 0; sprite < 8; sprite++) {
        if (cache.get(idle, 64, 16) !== null) hits++;
      }
    }
    expect(hits).toBe(60 * 8);
    expect(calls.length).toBe(1);
  });

  it('keeps distinct strips distinct', () => {
    const { cache, calls } = tracked();
    const idle = cache.get(strip('idle'), 64, 16);
    const walk = cache.get(strip('walk'), 96, 16);
    expect(idle).not.toBe(walk);
    expect(calls.length).toBe(2);
    expect(cache.count).toBe(2);
    expect(cache.pixels).toBe(64 * 16 + 96 * 16);
  });

  it('refuses past the sheet cap rather than evicting, and stops asking', () => {
    const { cache, calls } = tracked();
    const kept = strip('kept');
    expect(cache.get(kept, 8, 8)).not.toBeNull();
    for (let i = 1; i < MAX_FLASH_SHEETS; i++) {
      expect(cache.get(strip(`s${i}`), 8, 8)).not.toBeNull();
    }
    expect(cache.count).toBe(MAX_FLASH_SHEETS);

    const overflow = strip('overflow');
    expect(cache.get(overflow, 8, 8)).toBeNull();
    expect(cache.get(overflow, 8, 8)).toBeNull();
    expect(calls.length).toBe(MAX_FLASH_SHEETS);
    expect(cache.count).toBe(MAX_FLASH_SHEETS);
    // Nothing already baked was thrown away to make room.
    expect(cache.get(kept, 8, 8)).not.toBeNull();
  });

  it('refuses a strip that would blow the pixel budget, but not the ones that fit', () => {
    const { cache, calls } = tracked();
    const big = Math.floor(MAX_FLASH_PIXELS * 0.9);
    expect(cache.get(strip('big'), big, 1)).not.toBeNull();

    expect(cache.get(strip('too-big'), MAX_FLASH_PIXELS, 1)).toBeNull();
    expect(cache.count).toBe(1);
    expect(cache.pixels).toBe(big);

    // A small strip still fits in the remaining tenth.
    expect(cache.get(strip('small'), 64, 16)).not.toBeNull();
    expect(cache.count).toBe(2);
    expect(calls.length).toBe(2);
  });

  it('never bakes an empty strip', () => {
    const { cache, calls } = tracked();
    expect(cache.get(strip('zero'), 0, 16)).toBeNull();
    expect(cache.get(strip('negative'), 64, -1)).toBeNull();
    expect(cache.get(strip('nan'), Number.NaN, 16)).toBeNull();
    expect(calls.length).toBe(0);
    expect(cache.count).toBe(0);
    expect(cache.pixels).toBe(0);
  });

  it('remembers a baker that could not produce a sheet, without charging for it', () => {
    let calls = 0;
    const cache = new FlashSheetCache<object>(() => {
      calls++;
      return null;
    });
    const source = strip('unbakeable');
    expect(cache.get(source, 64, 16)).toBeNull();
    expect(cache.get(source, 64, 16)).toBeNull();
    expect(calls).toBe(1);
    expect(cache.count).toBe(0);
    expect(cache.pixels).toBe(0);
  });
});
