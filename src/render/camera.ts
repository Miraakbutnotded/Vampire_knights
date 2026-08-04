import { clamp, damp } from '../core/math.ts';
import { fxRng } from '../core/rng.ts';
import { VIEW_H, VIEW_W } from './renderer.ts';

/** How hard the camera pulls toward the target, in 1/sec. Higher = tighter. */
const FOLLOW_RATE = 9;
/** The target can move this far from centre before the camera reacts at all. */
const DEADZONE_X = 12;
const DEADZONE_Y = 8;

export interface CameraBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Follows the player with a small deadzone, so tiny movements don't slosh the
 * whole screen, plus decaying shake for impacts.
 */
export class Camera {
  /** View centre, in world units. */
  x = 0;
  y = 0;

  private shakeAmount = 0;
  private shakeDecay = 1;
  private shakeX = 0;
  private shakeY = 0;

  /** When set, the view is clamped to stay inside these world bounds. */
  bounds: CameraBounds | null = null;

  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.shakeAmount = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.applyBounds();
  }

  follow(targetX: number, targetY: number, dt: number): void {
    // Only chase the component of the offset that exceeds the deadzone.
    const dx = targetX - this.x;
    const dy = targetY - this.y;

    let goalX = this.x;
    let goalY = this.y;
    if (Math.abs(dx) > DEADZONE_X) goalX = targetX - Math.sign(dx) * DEADZONE_X;
    if (Math.abs(dy) > DEADZONE_Y) goalY = targetY - Math.sign(dy) * DEADZONE_Y;

    this.x = damp(this.x, goalX, FOLLOW_RATE, dt);
    this.y = damp(this.y, goalY, FOLLOW_RATE, dt);

    this.decayShake(dt);
    this.applyBounds();
  }

  /**
   * Rings the shake out without moving the view.
   *
   * Folded out of `follow` because `follow` stops being called the moment the
   * player dies, and the killing blow's own shake is still ringing: left alone
   * the offset freezes wherever the last tick put it, so the death animation
   * plays on a world held a few pixels off centre and then snaps back. The
   * shake belongs to the impact, not to the simulation, so it finishes either
   * way.
   */
  decayShake(dt: number): void {
    if (this.shakeAmount > 0.01) {
      this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeDecay * dt);
      this.shakeX = fxRng.range(-1, 1) * this.shakeAmount;
      this.shakeY = fxRng.range(-1, 1) * this.shakeAmount;
    } else {
      this.shakeAmount = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /**
   * Adds screen shake. Calls don't stack past the strongest active shake, so a
   * hundred simultaneous hits can't shake the screen into orbit.
   */
  shake(amount: number, duration = 0.25): void {
    if (amount <= this.shakeAmount) return;
    this.shakeAmount = amount;
    this.shakeDecay = amount / Math.max(0.05, duration);
  }

  /** Position to render from, shake included. */
  get renderX(): number {
    return this.x + this.shakeX;
  }

  get renderY(): number {
    return this.y + this.shakeY;
  }

  private applyBounds(): void {
    const b = this.bounds;
    if (!b) return;
    const halfW = VIEW_W / 2;
    const halfH = VIEW_H / 2;
    // If the map is narrower than the view, centre on it rather than clamping
    // to a nonsensical inverted range.
    if (b.right - b.left <= VIEW_W) this.x = (b.left + b.right) / 2;
    else this.x = clamp(this.x, b.left + halfW, b.right - halfW);
    if (b.bottom - b.top <= VIEW_H) this.y = (b.top + b.bottom) / 2;
    else this.y = clamp(this.y, b.top + halfH, b.bottom - halfH);
  }
}
