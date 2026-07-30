import { TAU } from './math.ts';

/**
 * Seeded PRNG (mulberry32). Deterministic given a seed, so runs are reproducible
 * for debugging and so a future "daily run" mode can share a seed.
 */
export class Rng {
  private state: number;

  constructor(seed: number = Date.now() >>> 0) {
    this.state = seed >>> 0;
  }

  /** Reseed in place, so a run can restart deterministically. */
  reseed(seed: number): void {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p` (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  angle(): number {
    return this.next() * TAU;
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * Weighted pick. Returns the chosen index, or -1 if every weight is <= 0.
   * Used by the level-up draft so rarer upgrades show up less often.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) if (w > 0) total += w;
    if (total <= 0) return -1;

    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]!;
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return i;
    }
    // Floating point slop: fall back to the last positive weight.
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i]! > 0) return i;
    return -1;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  /** A random point on a circle of `radius` around the origin. */
  onCircle(radius: number): [number, number] {
    const a = this.angle();
    return [Math.cos(a) * radius, Math.sin(a) * radius];
  }
}

/** Shared instance for cosmetic randomness (particles, damage-number jitter). */
export const fxRng = new Rng(0xc0ffee);
