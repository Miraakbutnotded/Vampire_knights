import { describe, expect, it } from 'vitest';
import { packShelves } from './atlas.ts';

/**
 * The 3D view draws every sprite out of one atlas, so a packer that overlapped
 * two strips would put one character's frames inside another's — silently, and
 * only in the 3D view.
 */
describe('packShelves', () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('places every strip inside the square without overlap, in input order', () => {
    const sizes = [
      { w: 256, h: 32 },
      { w: 30, h: 30 },
      { w: 128, h: 16 },
      { w: 64, h: 48 },
      { w: 22, h: 22 },
      { w: 300, h: 8 },
    ];
    const rects = packShelves(sizes, 512)!;
    expect(rects).not.toBeNull();
    rects.forEach((r, i) => {
      expect(r.w).toBe(sizes[i]!.w);
      expect(r.h).toBe(sizes[i]!.h);
      expect(r.x).toBeGreaterThanOrEqual(1);
      expect(r.y).toBeGreaterThanOrEqual(1);
      expect(r.x + r.w).toBeLessThanOrEqual(511);
      expect(r.y + r.h).toBeLessThanOrEqual(511);
      for (let j = 0; j < i; j++) expect(overlaps(r, rects[j]!)).toBe(false);
    });
  });

  it('keeps a gutter between neighbours so nearest sampling cannot bleed', () => {
    const rects = packShelves([{ w: 10, h: 10 }, { w: 10, h: 10 }], 64)!;
    const [a, b] = rects;
    expect(Math.abs(a!.x - b!.x)).toBeGreaterThanOrEqual(11);
  });

  it('reports a set that does not fit rather than clipping it', () => {
    expect(packShelves([{ w: 600, h: 10 }], 512)).toBeNull();
    expect(packShelves(Array.from({ length: 40 }, () => ({ w: 100, h: 100 })), 512)).toBeNull();
  });
});
