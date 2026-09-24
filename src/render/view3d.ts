import { OrthographicCamera, Vector3 } from 'three';
import { ISO_ZOOM } from './iso.ts';

/**
 * The 3D camera that sees exactly what `iso.ts` draws.
 *
 * The flat renderer's projection — rotate 45 degrees, squash the vertical by
 * half — is not an approximation of a 3D view, it *is* one: an orthographic
 * camera turned 45 degrees about the vertical and tilted down 30 degrees lands
 * every point of the ground plane on the same pixel the 2D projection does. A
 * ground displacement toward the camera shortens by sin(30) = 0.5, which is the
 * squash, and one across the view keeps its full length, which is the COS45
 * scale. That identity is what lets the 3D view replace the 2D one without
 * gameplay noticing: `onScreen`, `withinEngagement`, the camera's clamp to the
 * map and the direction WASD walks all keep asking `iso.ts`, and the answers
 * stay true of the picture on screen. `view3d.test.ts` pins it.
 *
 * World axes map as flat x → three X, flat y → three Z, and three Y is up.
 */

/** Elevation of the view above the ground plane. sin(30) is the 2:1 squash. */
export const ELEVATION = Math.PI / 6;
const SIN_EL = Math.sin(ELEVATION);
const COS_EL = Math.cos(ELEVATION);

/** Screen pixels per world unit, for anything measured across the view. */
export const PX = ISO_ZOOM;

/**
 * How far the camera sits from the point it looks at. Orthographic, so this
 * changes nothing about the picture — it only has to clear the tallest thing in
 * the scene, and keep near and far close enough for depth precision.
 */
const DISTANCE = 1200;

/** Unit vector along the screen's x axis, in world space. */
export const SCREEN_RIGHT = new Vector3(Math.SQRT1_2, 0, -Math.SQRT1_2);
/** Unit vector pointing up the screen, laid on the ground plane. */
export const GROUND_UP = new Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2);

/**
 * World units of height per screen pixel for an upright billboard.
 *
 * A vertical segment is foreshortened by cos(30) on its way to the screen, so a
 * sprite standing up has to be that much taller in the world for its pixels to
 * come out 1:1 — which they must, because the flat renderer never zooms art,
 * only positions.
 */
export const UPRIGHT_UNITS_PER_PX = 1 / (PX * COS_EL);
/** World units along the ground per screen pixel measured up the screen. */
export const GROUND_UNITS_PER_PX = 1 / (PX * SIN_EL);

/**
 * Builds the orthographic camera for a view of `viewW` x `viewH` screen pixels.
 *
 * Taken as arguments rather than imported from renderer.ts, which constructs
 * the 3D scene and would otherwise close an import cycle through this file.
 */
export function createIsoCamera(viewW: number, viewH: number): OrthographicCamera {
  const halfW = viewW / 2 / PX;
  const halfH = viewH / 2 / PX;
  const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, DISTANCE * 3);
  camera.up.set(0, 1, 0);
  placeIsoCamera(camera, 0, 0);
  return camera;
}

/**
 * Points the camera at a ground position, given in flat world coordinates.
 *
 * The camera sits back along the direction the screen's bottom edge faces —
 * toward +x and +y, because further down the screen is `wx + wy` getting bigger
 * — and up by the elevation.
 */
export function placeIsoCamera(camera: OrthographicCamera, wx: number, wy: number): void {
  const back = DISTANCE * COS_EL * Math.SQRT1_2;
  camera.position.set(wx + back, DISTANCE * SIN_EL, wy + back);
  camera.lookAt(wx, 0, wy);
  camera.updateMatrixWorld(true);
}
