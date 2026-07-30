/** Simulation runs at a fixed rate so gameplay is deterministic and framerate-independent. */
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;

/** Never simulate more than this many ticks in one frame — prevents a death spiral after a stall. */
const MAX_TICKS_PER_FRAME = 5;

export interface LoopHooks {
  /**
   * Called exactly once per frame, before any update. Edge-triggered input —
   * menu navigation, pause, debug toggles — belongs here: `update` may run zero
   * or several times per frame, so a key press handled there would be missed or
   * processed twice.
   */
  beforeFrame?(frameDt: number): void;
  /** Called 0..MAX_TICKS_PER_FRAME times per frame with a constant dt. */
  update(dt: number): void;
  /**
   * Called once per frame. `alpha` is 0..1 progress toward the next tick, for
   * interpolating rendered positions so high-refresh displays look smooth.
   */
  render(alpha: number, frameDt: number): void;
  /** Called exactly once per frame, after render. Clears per-frame input state. */
  afterFrame?(): void;
}

export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Rolling average frames-per-second, for the debug overlay. */
  fps = 0;
  /** Ticks simulated on the most recent frame. */
  ticksLastFrame = 0;

  constructor(private hooks: LoopHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const frame = (now: number) => {
      if (!this.running) return;
      this.step(now);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private step(now: number): void {
    // Clamp the frame delta so a background tab or a breakpoint doesn't
    // teleport everything on the next frame.
    const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    this.fps = this.fps === 0 ? 1 / Math.max(frameDt, 1e-6) : this.fps * 0.92 + (1 / Math.max(frameDt, 1e-6)) * 0.08;

    this.accumulator += frameDt;

    this.hooks.beforeFrame?.(frameDt);

    let ticks = 0;
    while (this.accumulator >= FIXED_DT && ticks < MAX_TICKS_PER_FRAME) {
      this.hooks.update(FIXED_DT);
      this.accumulator -= FIXED_DT;
      ticks++;
    }
    // If we hit the tick ceiling we're running behind; drop the backlog rather
    // than carrying it forward and staying behind forever.
    if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    this.ticksLastFrame = ticks;

    this.hooks.render(this.accumulator / FIXED_DT, frameDt);
    this.hooks.afterFrame?.();
  }
}
