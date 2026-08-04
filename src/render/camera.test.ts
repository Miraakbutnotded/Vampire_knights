import { describe, expect, it } from 'vitest';

import { Camera } from './camera.ts';

const DT = 1 / 60;

/** Runs `decayShake` alone for `seconds`, the way the death animation does. */
function ringOut(camera: Camera, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) camera.decayShake(DT);
}

/** Runs a full follow on a stationary target, the way a live tick does. */
function followInPlace(camera: Camera, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) camera.follow(camera.x, camera.y, DT);
}

describe('camera shake', () => {
  it('rings out with no follow calls at all', () => {
    // The regression this guards: shake used to decay only inside follow(),
    // and follow() stops being called the moment the player dies. The killing
    // blow's own shake then froze wherever the last tick left it, so the death
    // animation played on a world held a few pixels off centre and snapped
    // back at the results screen.
    const camera = new Camera();
    camera.snapTo(100, 100);
    camera.shake(3, 0.25);
    ringOut(camera, 0.3);

    expect(camera.renderX).toBe(camera.x);
    expect(camera.renderY).toBe(camera.y);
  });

  it('never offsets the view further than the shake it was given', () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.shake(4, 0.5);
    for (let t = 0; t < 0.5; t += DT) {
      camera.decayShake(DT);
      expect(Math.abs(camera.renderX - camera.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(camera.renderY - camera.y)).toBeLessThanOrEqual(4);
    }
  });

  it('still decays through follow, which owns the decay on a live tick', () => {
    const camera = new Camera();
    camera.snapTo(100, 100);
    camera.shake(3, 0.25);
    followInPlace(camera, 0.3);

    expect(camera.renderX).toBe(camera.x);
    expect(camera.renderY).toBe(camera.y);
  });

  it('is actually shaking partway through, so the ring-out is not a no-op', () => {
    // Without this the three tests above would pass on a camera that never
    // shook in the first place.
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.shake(5, 0.5);

    let moved = false;
    for (let t = 0; t < 0.25; t += DT) {
      camera.decayShake(DT);
      if (camera.renderX !== camera.x || camera.renderY !== camera.y) moved = true;
    }
    expect(moved).toBe(true);
  });

  it('lets a weaker shake neither extend nor weaken the one already running', () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.shake(3, 0.25);
    // A long, weak shake arriving mid-impact must not stretch the decay out to
    // its own five seconds — a hundred simultaneous hits would otherwise leave
    // the screen trembling long after the moment that earned it.
    camera.shake(1, 5);
    ringOut(camera, 0.3);

    expect(camera.renderX).toBe(camera.x);
  });

  it('drops any shake in flight when the view is snapped to a new position', () => {
    const camera = new Camera();
    camera.shake(6, 1);
    camera.decayShake(DT);
    // startRun snaps to the spawn point; a shake carried across would be the
    // previous run's.
    camera.snapTo(50, 50);

    expect(camera.renderX).toBe(50);
    expect(camera.renderY).toBe(50);
  });
});
