import { MAX_ENTITIES } from '../ecs/world.ts';
import { frameIndex } from './sprites.ts';
import type { SpriteTable } from './sprites.ts';
import type { Camera } from './camera.ts';

/**
 * The world is drawn at exactly this resolution into an offscreen buffer, then
 * nearest-neighbour upscaled to fill the window. Two things fall out of that:
 * pixel art stays crisp at any window size, and every player sees the same
 * amount of the arena regardless of monitor — which matters, because how much
 * you can see is a difficulty knob in this genre.
 *
 * 480x270 is exactly 1/4 of 1080p, so the common case is a clean 4x upscale.
 */
export const VIEW_W = 480;
export const VIEW_H = 270;

/** Entities this far outside the view are not drawn. */
const CULL_MARGIN = 48;

/**
 * Depth-sorted draw queue. Sprites are collected during the frame and flushed
 * in y order so things lower on screen overlap things above them.
 *
 * Stored as parallel arrays with a separately sorted index list: sorting 32-bit
 * indices avoids allocating a command object per sprite per frame, which at
 * 2000+ entities would be real GC pressure.
 */
class DrawList {
  private readonly spriteId = new Uint16Array(MAX_ENTITIES);
  private readonly state = new Uint8Array(MAX_ENTITIES);
  private readonly animTime = new Float32Array(MAX_ENTITIES);
  private readonly x = new Float32Array(MAX_ENTITIES);
  private readonly y = new Float32Array(MAX_ENTITIES);
  private readonly facing = new Int8Array(MAX_ENTITIES);
  private readonly scale = new Float32Array(MAX_ENTITIES);
  private readonly rot = new Float32Array(MAX_ENTITIES);
  private readonly flash = new Float32Array(MAX_ENTITIES);
  private readonly alpha = new Float32Array(MAX_ENTITIES);
  private readonly depth = new Float32Array(MAX_ENTITIES);

  private readonly order = new Uint32Array(MAX_ENTITIES);
  private count = 0;

  private readonly compare = (a: number, b: number): number => this.depth[a]! - this.depth[b]!;

  clear(): void {
    this.count = 0;
  }

  push(
    spriteId: number,
    state: number,
    animTime: number,
    x: number,
    y: number,
    facing: number,
    scale: number,
    rot: number,
    flash: number,
    alpha: number,
    depth: number,
  ): void {
    const i = this.count;
    if (i >= MAX_ENTITIES) return;
    this.spriteId[i] = spriteId;
    this.state[i] = state;
    this.animTime[i] = animTime;
    this.x[i] = x;
    this.y[i] = y;
    this.facing[i] = facing;
    this.scale[i] = scale;
    this.rot[i] = rot;
    this.flash[i] = flash;
    this.alpha[i] = alpha;
    this.depth[i] = depth;
    this.count++;
  }

  flush(ctx: CanvasRenderingContext2D, sprites: SpriteTable, flashCanvas: FlashCache): void {
    const n = this.count;
    if (n === 0) return;

    const order = this.order.subarray(0, n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort(this.compare);

    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      const id = this.spriteId[i]!;
      const sprite = sprites.get(id);
      const anim = sprites.anim(id, this.state[i]!);
      const frame = frameIndex(anim, this.animTime[i]!);

      const sx = frame * anim.frameW;
      const w = anim.frameW;
      const h = anim.frameH;
      const s = this.scale[i]!;
      const dw = w * s;
      const dh = h * s;

      // Anchor the sprite by its origin so feet land on the world position.
      const ox = -sprite.originX * dw;
      const oy = -sprite.originY * dh;

      const alpha = this.alpha[i]!;
      const rot = this.rot[i]!;
      const flip = this.facing[i]! < 0;
      const flash = this.flash[i]!;

      const needsTransform = rot !== 0 || flip;

      if (alpha < 1) ctx.globalAlpha = alpha;

      if (needsTransform) {
        ctx.save();
        ctx.translate(this.x[i]!, this.y[i]!);
        if (rot !== 0) ctx.rotate(rot);
        if (flip) ctx.scale(-1, 1);
        ctx.drawImage(anim.source, sx, 0, w, h, ox, oy, dw, dh);
        if (flash > 0) {
          const silhouette = flashCanvas.get(anim.source, sx, w, h, flash);
          if (silhouette) ctx.drawImage(silhouette, ox, oy, dw, dh);
        }
        ctx.restore();
      } else {
        const dx = this.x[i]! + ox;
        const dy = this.y[i]! + oy;
        ctx.drawImage(anim.source, sx, 0, w, h, dx, dy, dw, dh);
        if (flash > 0) {
          const silhouette = flashCanvas.get(anim.source, sx, w, h, flash);
          if (silhouette) ctx.drawImage(silhouette, dx, dy, dw, dh);
        }
      }

      if (alpha < 1) ctx.globalAlpha = 1;
    }
  }
}

/**
 * Hit flashes are drawn by compositing a white copy of the sprite frame over
 * itself. Building that copy costs a scratch canvas, so keep one and reuse it
 * — there is at most one flash draw in flight at a time.
 */
class FlashCache {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas.width = 64;
    this.canvas.height = 64;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  get(
    source: CanvasImageSource,
    sx: number,
    w: number,
    h: number,
    strength: number,
  ): HTMLCanvasElement | null {
    if (w <= 0 || h <= 0) return null;
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
      this.ctx.imageSmoothingEnabled = false;
    }
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(source, sx, 0, w, h, 0, 0, w, h);
    // 'source-atop' paints white only where the sprite is opaque, preserving its shape.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = Math.min(1, strength);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return this.canvas;
  }
}

export class Renderer {
  /** Offscreen buffer that the world is drawn into, at VIEW_W x VIEW_H. */
  private buffer: HTMLCanvasElement;
  /** Draw into this for anything in world space. */
  readonly ctx: CanvasRenderingContext2D;

  private display: HTMLCanvasElement;
  private displayCtx: CanvasRenderingContext2D;

  private drawList = new DrawList();
  private flashCache = new FlashCache();

  /** Upscale factor and letterbox offsets, recomputed on resize. */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  /** Camera translation applied for the current frame, in buffer pixels. */
  private camX = 0;
  private camY = 0;

  constructor(canvas: HTMLCanvasElement, private sprites: SpriteTable) {
    this.display = canvas;
    const displayCtx = canvas.getContext('2d', { alpha: false });
    if (!displayCtx) throw new Error('2D canvas context unavailable');
    this.displayCtx = displayCtx;

    this.buffer = document.createElement('canvas');
    this.buffer.width = VIEW_W;
    this.buffer.height = VIEW_H;
    const bufferCtx = this.buffer.getContext('2d', { alpha: false });
    if (!bufferCtx) throw new Error('2D canvas context unavailable');
    this.ctx = bufferCtx;
    this.ctx.imageSmoothingEnabled = false;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    this.display.style.width = `${cssW}px`;
    this.display.style.height = `${cssH}px`;
    this.display.width = Math.max(1, Math.round(cssW * dpr));
    this.display.height = Math.max(1, Math.round(cssH * dpr));

    const raw = Math.min(this.display.width / VIEW_W, this.display.height / VIEW_H);
    // Prefer integer upscales: a 3.4x nearest-neighbour scale gives visibly
    // uneven pixel widths, which looks worse than a slightly smaller 3x.
    this.scale = raw >= 1 ? Math.floor(raw) : raw;
    this.offsetX = Math.floor((this.display.width - VIEW_W * this.scale) / 2);
    this.offsetY = Math.floor((this.display.height - VIEW_H * this.scale) / 2);

    this.displayCtx.imageSmoothingEnabled = false;
  }

  /** Clears the buffer and applies the camera transform. */
  begin(camera: Camera): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Round the camera to whole pixels or the whole scene shimmers as it scrolls.
    this.camX = Math.round(camera.renderX - VIEW_W / 2);
    this.camY = Math.round(camera.renderY - VIEW_H / 2);
    ctx.setTransform(1, 0, 0, 1, -this.camX, -this.camY);

    this.drawList.clear();
  }

  /** World-space rect currently visible, expanded by the cull margin. */
  visibleBounds(): { left: number; top: number; right: number; bottom: number } {
    return {
      left: this.camX - CULL_MARGIN,
      top: this.camY - CULL_MARGIN,
      right: this.camX + VIEW_W + CULL_MARGIN,
      bottom: this.camY + VIEW_H + CULL_MARGIN,
    };
  }

  /**
   * Queues a sprite for depth-sorted drawing. `depth` defaults to y, which is
   * what you want for anything standing on the ground.
   */
  queue(
    spriteId: number,
    state: number,
    animTime: number,
    x: number,
    y: number,
    opts?: {
      facing?: number;
      scale?: number;
      rot?: number;
      flash?: number;
      alpha?: number;
      depth?: number;
    },
  ): void {
    this.drawList.push(
      spriteId,
      state,
      animTime,
      Math.round(x),
      Math.round(y),
      opts?.facing ?? 1,
      opts?.scale ?? 1,
      opts?.rot ?? 0,
      opts?.flash ?? 0,
      opts?.alpha ?? 1,
      opts?.depth ?? y,
    );
  }

  /** Draws every queued sprite in depth order. Call once, after all queue() calls. */
  flushSprites(): void {
    this.drawList.flush(this.ctx, this.sprites, this.flashCache);
  }

  /** Blits the buffer to the visible canvas. Call last. */
  present(): void {
    const ctx = this.displayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Letterbox bars.
    if (this.offsetX > 0 || this.offsetY > 0) {
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, this.display.width, this.display.height);
    }

    ctx.drawImage(
      this.buffer,
      0,
      0,
      VIEW_W,
      VIEW_H,
      this.offsetX,
      this.offsetY,
      VIEW_W * this.scale,
      VIEW_H * this.scale,
    );
  }

  /**
   * Reports how the buffer maps onto the page, so the DOM UI layer can size
   * itself to the letterboxed play area instead of the whole window.
   */
  viewportMetrics(): { scale: number; offsetX: number; offsetY: number; dpr: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return { scale: this.scale / dpr, offsetX: this.offsetX / dpr, offsetY: this.offsetY / dpr, dpr };
  }
}
