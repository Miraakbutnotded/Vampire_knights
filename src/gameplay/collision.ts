import { MAX_ENTITIES } from '../ecs/world.ts';
import type { World } from '../ecs/world.ts';

/**
 * Broadphase cell size, in world units. Should be a little larger than the
 * biggest common collider so a query touches ~4 cells rather than dozens.
 */
const CELL = 40;
/** Bucket grid is GRID x GRID. Coordinates wrap into it (see `bucketOf`). */
const GRID = 128;
const BUCKETS = GRID * GRID;

/** Upper bound on candidates a single query can report. */
export const MAX_QUERY_RESULTS = 512;

/**
 * Uniform spatial hash over entity positions, rebuilt every tick.
 *
 * Cells wrap modulo GRID rather than covering a fixed rectangle, so the map can
 * be unbounded with no "outside the grid" blind spot. Wrapping means two
 * entities thousands of units apart can share a bucket; the narrowphase
 * distance check rejects them, and at this cell size that is far cheaper than
 * the bookkeeping to avoid it.
 *
 * Population uses a counting sort into one flat array — no per-cell arrays, and
 * zero allocation after construction.
 */
export class SpatialHash {
  private counts = new Int32Array(BUCKETS);
  private starts = new Int32Array(BUCKETS + 1);
  private cursor = new Int32Array(BUCKETS);
  private items = new Int32Array(MAX_ENTITIES);
  private itemCount = 0;

  /** Rebuilds the index over `ids`. Positions are read from `world`. */
  build(world: World, ids: readonly number[]): void {
    this.counts.fill(0);
    const n = Math.min(ids.length, MAX_ENTITIES);
    this.itemCount = n;

    for (let i = 0; i < n; i++) {
      const id = ids[i]!;
      const b = bucketOf(world.x[id]!, world.y[id]!);
      this.counts[b] = this.counts[b]! + 1;
    }

    let running = 0;
    for (let b = 0; b < BUCKETS; b++) {
      this.starts[b] = running;
      this.cursor[b] = running;
      running += this.counts[b]!;
    }
    this.starts[BUCKETS] = running;

    for (let i = 0; i < n; i++) {
      const id = ids[i]!;
      const b = bucketOf(world.x[id]!, world.y[id]!);
      const slot = this.cursor[b]!;
      this.items[slot] = id;
      this.cursor[b] = slot + 1;
    }
  }

  /**
   * Writes candidate ids overlapping the circle (x, y, r) into `out`, returning
   * how many were written. Results are candidates only — the caller must still
   * do an exact distance test.
   *
   * `out` is caller-owned so queries never allocate. Don't share one buffer
   * between an outer and inner loop.
   */
  query(x: number, y: number, r: number, out: Int32Array): number {
    if (this.itemCount === 0) return 0;

    const minCx = Math.floor((x - r) / CELL);
    const maxCx = Math.floor((x + r) / CELL);
    const minCy = Math.floor((y - r) / CELL);
    const maxCy = Math.floor((y + r) / CELL);

    let count = 0;
    const limit = Math.min(out.length, MAX_QUERY_RESULTS);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const b = bucketIndex(cx, cy);
        const end = this.starts[b + 1]!;
        for (let i = this.starts[b]!; i < end; i++) {
          if (count >= limit) return count;
          out[count++] = this.items[i]!;
        }
      }
    }
    return count;
  }
}

function bucketOf(x: number, y: number): number {
  return bucketIndex(Math.floor(x / CELL), Math.floor(y / CELL));
}

function bucketIndex(cx: number, cy: number): number {
  // `& (GRID - 1)` after adding GRID handles negative coordinates without a modulo.
  const wx = (cx + GRID * 4096) & (GRID - 1);
  const wy = (cy + GRID * 4096) & (GRID - 1);
  return wy * GRID + wx;
}

/**
 * Pushes overlapping enemies apart so a horde reads as a crowd rather than a
 * single stack of sprites sharing one pixel.
 *
 * Deliberately soft and approximate: it runs one relaxation pass per tick with
 * a partial strength, which converges over a few ticks and costs far less than
 * solving the whole contact graph. `maxNeighbors` bounds the worst case when
 * hundreds of enemies pile into one cell.
 */
export function separateCrowd(
  world: World,
  ids: readonly number[],
  hash: SpatialHash,
  scratch: Int32Array,
  strength: number,
  maxNeighbors = 8,
): void {
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i]!;
    // Tracked in locals and written back once, but kept up to date across
    // neighbours so multiple simultaneous contacts accumulate correctly.
    let ax = world.x[a]!;
    let ay = world.y[a]!;
    const ar = world.radius[a]!;

    const found = hash.query(ax, ay, ar * 2, scratch);
    let handled = 0;

    for (let k = 0; k < found && handled < maxNeighbors; k++) {
      const b = scratch[k]!;
      // Compare ids so each pair is resolved once, and skip self.
      if (b <= a) continue;

      const bx = world.x[b]!;
      const by = world.y[b]!;
      const dx = bx - ax;
      const dy = by - ay;
      const minDist = ar + world.radius[b]!;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;

      handled++;

      let nx: number;
      let ny: number;
      let overlap: number;
      if (d2 < 1e-6) {
        // Exactly coincident: nudge along a deterministic axis derived from the
        // id, so the pair doesn't stay stuck and doesn't need RNG.
        const angle = (a % 8) * 0.7854;
        nx = Math.cos(angle);
        ny = Math.sin(angle);
        overlap = minDist;
      } else {
        const d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
        overlap = minDist - d;
      }

      const push = overlap * 0.5 * strength;
      ax -= nx * push;
      ay -= ny * push;
      world.x[b] = bx + nx * push;
      world.y[b] = by + ny * push;
    }

    world.x[a] = ax;
    world.y[a] = ay;
  }
}
