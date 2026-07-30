import { fxRng } from '../core/rng.ts';
import { TAU } from '../core/math.ts';
import type { Renderer } from './renderer.ts';

const MAX_PARTICLES = 768;
const MAX_NUMBERS = 160;

/**
 * A 3x5 pixel font, drawn as filled rects.
 *
 * Canvas `fillText` at this resolution renders anti-aliased glyphs that look
 * blurry next to nearest-neighbour sprites, and a webfont would be an external
 * dependency. Five rows of three bits per glyph avoids both.
 */
const GLYPHS: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b001],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
  '-': [0b000, 0b000, 0b111, 0b000, 0b000],
  '!': [0b010, 0b010, 0b010, 0b000, 0b010],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101],
};

const GLYPH_W = 3;
const GLYPH_H = 5;
const GLYPH_GAP = 1;

/** Draws `text` with the pixel font, left-aligned at (x, y). Unknown chars are skipped. */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale = 1,
): void {
  ctx.fillStyle = color;
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (glyph) {
      for (let row = 0; row < GLYPH_H; row++) {
        const bits = glyph[row]!;
        for (let col = 0; col < GLYPH_W; col++) {
          // Bit 2 is the leftmost column.
          if (bits & (1 << (GLYPH_W - 1 - col))) {
            ctx.fillRect(cursor + col * scale, y + row * scale, scale, scale);
          }
        }
      }
    }
    cursor += (GLYPH_W + GLYPH_GAP) * scale;
  }
}

export function pixelTextWidth(text: string, scale = 1): number {
  return text.length * (GLYPH_W + GLYPH_GAP) * scale - GLYPH_GAP * scale;
}

export const ParticleShape = {
  Square: 0,
  Spark: 1,
  Ring: 2,
} as const;
export type ParticleShape = (typeof ParticleShape)[keyof typeof ParticleShape];

/**
 * Fixed-capacity particle and damage-number pools.
 *
 * Both use a swap-with-last free strategy: the arrays stay densely packed, so
 * update and draw are straight linear scans with no allocation during play.
 * When a pool is full the new effect is dropped — cosmetic loss under extreme
 * load is much better than an unbounded array.
 */
export class Fx {
  // --- particles ---
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES);
  private pvy = new Float32Array(MAX_PARTICLES);
  private pLife = new Float32Array(MAX_PARTICLES);
  private pMaxLife = new Float32Array(MAX_PARTICLES);
  private pSize = new Float32Array(MAX_PARTICLES);
  private pDrag = new Float32Array(MAX_PARTICLES);
  private pShape = new Uint8Array(MAX_PARTICLES);
  private pColor: string[] = new Array(MAX_PARTICLES).fill('#ffffff');
  private particleCount = 0;

  // --- damage numbers ---
  private nx = new Float32Array(MAX_NUMBERS);
  private ny = new Float32Array(MAX_NUMBERS);
  private nvy = new Float32Array(MAX_NUMBERS);
  private nvx = new Float32Array(MAX_NUMBERS);
  private nLife = new Float32Array(MAX_NUMBERS);
  private nMaxLife = new Float32Array(MAX_NUMBERS);
  private nScale = new Float32Array(MAX_NUMBERS);
  private nText: string[] = new Array(MAX_NUMBERS).fill('');
  private nColor: string[] = new Array(MAX_NUMBERS).fill('#ffffff');
  private numberCount = 0;

  particle(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    color: string,
    shape: ParticleShape = ParticleShape.Square,
    drag = 3,
  ): void {
    const i = this.particleCount;
    if (i >= MAX_PARTICLES) return;
    this.px[i] = x;
    this.py[i] = y;
    this.pvx[i] = vx;
    this.pvy[i] = vy;
    this.pLife[i] = life;
    this.pMaxLife[i] = life;
    this.pSize[i] = size;
    this.pDrag[i] = drag;
    this.pShape[i] = shape;
    this.pColor[i] = color;
    this.particleCount++;
  }

  /** Radial spray, for hits and deaths. */
  burst(
    x: number,
    y: number,
    count: number,
    speed: number,
    color: string,
    life = 0.35,
    size = 1,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = fxRng.angle();
      const s = speed * fxRng.range(0.45, 1);
      this.particle(x, y, Math.cos(a) * s, Math.sin(a) * s, life * fxRng.range(0.7, 1.2), size, color);
    }
  }

  /** Expanding ring, for level-ups and boss spawns. */
  shockwave(x: number, y: number, color: string, life = 0.4, size = 6): void {
    this.particle(x, y, 0, 0, life, size, color, ParticleShape.Ring, 0);
  }

  damageNumber(x: number, y: number, amount: number, crit: boolean): void {
    const i = this.numberCount;
    if (i >= MAX_NUMBERS) return;
    this.nx[i] = x + fxRng.range(-3, 3);
    this.ny[i] = y;
    this.nvx[i] = fxRng.range(-6, 6);
    this.nvy[i] = crit ? -46 : -34;
    this.nLife[i] = crit ? 0.75 : 0.55;
    this.nMaxLife[i] = this.nLife[i]!;
    this.nScale[i] = crit ? 2 : 1;
    // Round for display; sub-1 damage still reads as 1 so hits never look free.
    this.nText[i] = String(Math.max(1, Math.round(amount)));
    this.nColor[i] = crit ? '#ffd23f' : '#fff4e0';
    this.numberCount++;
  }

  /** Free-form floating label — "LEVEL UP", "+5". */
  floatingText(x: number, y: number, text: string, color: string, scale = 1): void {
    const i = this.numberCount;
    if (i >= MAX_NUMBERS) return;
    this.nx[i] = x;
    this.ny[i] = y;
    this.nvx[i] = 0;
    this.nvy[i] = -22;
    this.nLife[i] = 1.1;
    this.nMaxLife[i] = 1.1;
    this.nScale[i] = scale;
    this.nText[i] = text;
    this.nColor[i] = color;
    this.numberCount++;
  }

  update(dt: number): void {
    for (let i = this.particleCount - 1; i >= 0; i--) {
      const life = this.pLife[i]! - dt;
      if (life <= 0) {
        this.swapRemoveParticle(i);
        continue;
      }
      this.pLife[i] = life;
      const drag = Math.exp(-this.pDrag[i]! * dt);
      const vx = this.pvx[i]! * drag;
      const vy = this.pvy[i]! * drag;
      this.pvx[i] = vx;
      this.pvy[i] = vy;
      this.px[i] = this.px[i]! + vx * dt;
      this.py[i] = this.py[i]! + vy * dt;
    }

    for (let i = this.numberCount - 1; i >= 0; i--) {
      const life = this.nLife[i]! - dt;
      if (life <= 0) {
        this.swapRemoveNumber(i);
        continue;
      }
      this.nLife[i] = life;
      this.nx[i] = this.nx[i]! + this.nvx[i]! * dt;
      this.ny[i] = this.ny[i]! + this.nvy[i]! * dt;
      // Decelerate the rise so numbers settle instead of flying off.
      this.nvy[i] = this.nvy[i]! + 52 * dt;
      this.nvx[i] = this.nvx[i]! * Math.exp(-4 * dt);
    }
  }

  private swapRemoveParticle(i: number): void {
    const last = this.particleCount - 1;
    if (i !== last) {
      this.px[i] = this.px[last]!;
      this.py[i] = this.py[last]!;
      this.pvx[i] = this.pvx[last]!;
      this.pvy[i] = this.pvy[last]!;
      this.pLife[i] = this.pLife[last]!;
      this.pMaxLife[i] = this.pMaxLife[last]!;
      this.pSize[i] = this.pSize[last]!;
      this.pDrag[i] = this.pDrag[last]!;
      this.pShape[i] = this.pShape[last]!;
      this.pColor[i] = this.pColor[last]!;
    }
    this.particleCount--;
  }

  private swapRemoveNumber(i: number): void {
    const last = this.numberCount - 1;
    if (i !== last) {
      this.nx[i] = this.nx[last]!;
      this.ny[i] = this.ny[last]!;
      this.nvx[i] = this.nvx[last]!;
      this.nvy[i] = this.nvy[last]!;
      this.nLife[i] = this.nLife[last]!;
      this.nMaxLife[i] = this.nMaxLife[last]!;
      this.nScale[i] = this.nScale[last]!;
      this.nText[i] = this.nText[last]!;
      this.nColor[i] = this.nColor[last]!;
    }
    this.numberCount--;
  }

  /** Particles draw under sprites. */
  drawParticles(renderer: Renderer): void {
    const ctx = renderer.ctx;
    for (let i = 0; i < this.particleCount; i++) {
      const t = this.pLife[i]! / this.pMaxLife[i]!;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillStyle = this.pColor[i]!;

      const x = this.px[i]!;
      const y = this.py[i]!;

      switch (this.pShape[i]) {
        case ParticleShape.Ring: {
          // Grows as it fades.
          const r = this.pSize[i]! + (1 - t) * this.pSize[i]! * 3.5;
          ctx.strokeStyle = this.pColor[i]!;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(Math.round(x), Math.round(y), r, 0, TAU);
          ctx.stroke();
          break;
        }
        case ParticleShape.Spark: {
          // Streak along the direction of travel.
          const len = Math.min(6, Math.hypot(this.pvx[i]!, this.pvy[i]!) * 0.04);
          const [dx, dy] = [this.pvx[i]!, this.pvy[i]!];
          const inv = 1 / Math.max(1e-4, Math.hypot(dx, dy));
          ctx.strokeStyle = this.pColor[i]!;
          ctx.lineWidth = this.pSize[i]!;
          ctx.beginPath();
          ctx.moveTo(Math.round(x), Math.round(y));
          ctx.lineTo(Math.round(x - dx * inv * len), Math.round(y - dy * inv * len));
          ctx.stroke();
          break;
        }
        default: {
          const s = Math.max(1, Math.round(this.pSize[i]! * (0.4 + t * 0.6)));
          ctx.fillRect(Math.round(x), Math.round(y), s, s);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Damage numbers draw over everything. */
  drawNumbers(renderer: Renderer): void {
    const ctx = renderer.ctx;
    for (let i = 0; i < this.numberCount; i++) {
      const t = this.nLife[i]! / this.nMaxLife[i]!;
      ctx.globalAlpha = Math.min(1, t * 2.2);
      const text = this.nText[i]!;
      const scale = this.nScale[i]!;
      const x = Math.round(this.nx[i]! - pixelTextWidth(text, scale) / 2);
      const y = Math.round(this.ny[i]!);
      // Cheap 1px drop shadow keeps numbers readable over bright sprites.
      drawPixelText(ctx, text, x + 1, y + 1, 'rgba(0,0,0,0.65)', scale);
      drawPixelText(ctx, text, x, y, this.nColor[i]!, scale);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.particleCount = 0;
    this.numberCount = 0;
  }

  get activeParticles(): number {
    return this.particleCount;
  }
}
