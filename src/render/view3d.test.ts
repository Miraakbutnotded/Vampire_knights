import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { isoX, isoY } from './iso.ts';
import { VIEW_H, VIEW_W } from './renderer.ts';
import {
  createIsoCamera,
  GROUND_UNITS_PER_PX,
  GROUND_UP,
  placeIsoCamera,
  PX,
  SCREEN_RIGHT,
  UPRIGHT_UNITS_PER_PX,
} from './view3d.ts';

/**
 * The 3D view is only a drop-in for the flat one if the two agree on where
 * every point of the ground lands. Gameplay asks iso.ts what is on screen —
 * `withinEngagement` decides what the player may hit from it — so a camera that
 * drifted from the projection would let the picture and the rules disagree.
 */

function toPixels(camera: ReturnType<typeof createIsoCamera>, p: Vector3): [number, number] {
  const v = p.clone().project(camera);
  return [((v.x + 1) / 2) * VIEW_W, ((1 - v.y) / 2) * VIEW_H];
}

describe('3D camera against iso.ts', () => {
  const centres: [number, number][] = [
    [0, 0],
    [412, -97],
    [-640, 480],
  ];

  it('lands every ground point on the pixel the flat projection does', () => {
    const camera = createIsoCamera(VIEW_W, VIEW_H);
    for (const [cx, cy] of centres) {
      placeIsoCamera(camera, cx, cy);
      for (const [dx, dy] of [
        [0, 0],
        [100, 0],
        [0, 100],
        [-73, 41],
        [150, 150],
      ]) {
        const wx = cx + dx!;
        const wy = cy + dy!;
        const [px, py] = toPixels(camera, new Vector3(wx, 0, wy));
        expect(px).toBeCloseTo(isoX(wx, wy) - isoX(cx, cy) + VIEW_W / 2, 3);
        expect(py).toBeCloseTo(isoY(wx, wy) - isoY(cx, cy) + VIEW_H / 2, 3);
      }
    }
  });

  it('draws upright art at one texel per screen pixel', () => {
    // The flat renderer never zooms sprites, only positions; a billboard that
    // came out bigger or smaller than its pixels would change every silhouette.
    const camera = createIsoCamera(VIEW_W, VIEW_H);
    placeIsoCamera(camera, 50, 50);
    const base = new Vector3(50, 0, 50);
    const [bx, by] = toPixels(camera, base);

    const [tx, ty] = toPixels(camera, base.clone().add(new Vector3(0, 24 * UPRIGHT_UNITS_PER_PX, 0)));
    expect(tx).toBeCloseTo(bx, 3);
    expect(by - ty).toBeCloseTo(24, 3);

    const [rx, ry] = toPixels(camera, base.clone().addScaledVector(SCREEN_RIGHT, 24 / PX));
    expect(rx - bx).toBeCloseTo(24, 3);
    expect(ry).toBeCloseTo(by, 3);
  });

  it('lays screen-shaped art flat on the floor without changing its pixels', () => {
    const camera = createIsoCamera(VIEW_W, VIEW_H);
    placeIsoCamera(camera, -20, 300);
    const base = new Vector3(-20, 0, 300);
    const [bx, by] = toPixels(camera, base);
    const [ux, uy] = toPixels(camera, base.clone().addScaledVector(GROUND_UP, 16 * GROUND_UNITS_PER_PX));
    expect(ux).toBeCloseTo(bx, 3);
    expect(by - uy).toBeCloseTo(16, 3);
  });
});
