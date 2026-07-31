import { generateTileTexture } from '../core/placeholders.ts';
import type { TilePlaceholderSpec } from '../core/placeholders.ts';
import { clamp } from '../core/math.ts';
import type { Renderer } from './renderer.ts';
import type { SpriteTable } from './sprites.ts';
import type { CameraBounds } from './camera.ts';

const ASSET_ROOT = 'assets/';
/** Ground is rendered in square blocks of this many tiles and cached. */
const CHUNK_TILES = 8;
/** Cached ground chunks retained before the oldest are dropped. */
const CHUNK_CACHE_LIMIT = 96;
/** World-space cell size used to scatter decor deterministically. */
const DECOR_CELL = 48;

// --- authoring format -----------------------------------------------------

interface TileJson {
  src?: string;
  /** Relative likelihood in scatter mode. Ignored in grid mode. */
  weight?: number;
  /** Blocks movement. Mostly useful in grid mode, for walls. */
  solid?: boolean;
  placeholder?: TilePlaceholderSpec;
}

interface DecorJson {
  sprite: string;
  /** Chance per DECOR_CELL cell, 0..1. */
  density?: number;
  /** Collision radius. Omit or 0 for purely decorative. */
  solid?: number;
  /** Drawn behind entities regardless of y when true (puddles, cracks). */
  flat?: boolean;
}

interface PropJson {
  sprite: string;
  x: number;
  y: number;
  solid?: number;
}

export interface MapJson {
  name?: string;
  tileSize?: number;
  bounds?: { left: number; top: number; right: number; bottom: number } | null;
  spawnPoint?: [number, number];
  ground?: { mode?: 'scatter' | 'grid' };
  tileset?: TileJson[];
  /** Grid mode only: row-major tile indices, 1-based into `tileset`; 0 = void. */
  gridWidth?: number;
  gridHeight?: number;
  tiles?: number[];
  decor?: DecorJson[];
  props?: PropJson[];
  /** Which wave table from content/waves.json this map uses. */
  waves?: string;
  /** Defendable structures spawned at run start. Optional; most maps have none. */
  structures?: { type: string; x: number; y: number }[];
  /** Background colour shown where there is no tile. */
  voidColor?: string;
}

/** A static circular obstacle. Hand-placed props only; scattered decor is passable. */
export interface Solid {
  x: number;
  y: number;
  r: number;
}

const mapModules = import.meta.glob<{ default: MapJson }>('../content/maps/*.json', {
  eager: true,
});

/** Map ids are the filename without extension: `content/maps/meadow.json` -> "meadow". */
export function availableMaps(): string[] {
  return Object.keys(mapModules)
    .map((path) => path.split('/').pop()!.replace(/\.json$/, ''))
    .sort();
}

function mapJson(id: string): MapJson {
  for (const [path, mod] of Object.entries(mapModules)) {
    if (path.endsWith(`/${id}.json`)) return mod.default;
  }
  throw new Error(
    `Map "${id}" not found. Available: ${availableMaps().join(', ') || '(none in content/maps/)'}`,
  );
}

// --- runtime --------------------------------------------------------------

interface TileTexture {
  source: CanvasImageSource;
  weight: number;
  solid: boolean;
}

export class TileMap {
  readonly name: string;
  readonly tileSize: number;
  readonly bounds: CameraBounds | null;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly wavesTable: string;
  readonly solids: Solid[] = [];
  readonly structures: { type: string; x: number; y: number }[];

  private mode: 'scatter' | 'grid';
  private propSolidCount = 0;
  private hasSolidTiles = false;
  private textures: TileTexture[] = [];
  private cumulativeWeights: number[] = [];
  private totalWeight = 0;
  private voidColor: string;

  private gridWidth = 0;
  private gridHeight = 0;
  private tiles: number[] = [];

  private decor: DecorJson[];
  private props: PropJson[];

  private chunkCache = new Map<string, HTMLCanvasElement>();
  private chunkOrder: string[] = [];

  private constructor(private def: MapJson, id: string) {
    this.name = def.name ?? id;
    this.tileSize = def.tileSize ?? 16;
    this.mode = def.ground?.mode ?? 'scatter';
    this.spawnX = def.spawnPoint?.[0] ?? 0;
    this.spawnY = def.spawnPoint?.[1] ?? 0;
    this.wavesTable = def.waves ?? 'default';
    this.voidColor = def.voidColor ?? '#0b0d14';
    this.decor = def.decor ?? [];
    this.props = def.props ?? [];
    this.structures = def.structures ?? [];

    if (this.mode === 'grid') {
      this.gridWidth = def.gridWidth ?? 0;
      this.gridHeight = def.gridHeight ?? 0;
      this.tiles = def.tiles ?? [];
      const expected = this.gridWidth * this.gridHeight;
      if (this.tiles.length !== expected) {
        console.warn(
          `[map ${this.name}] grid mode expects gridWidth*gridHeight = ${expected} tile entries, got ${this.tiles.length}. ` +
            `Missing entries render as void.`,
        );
      }
    }

    // A grid map is implicitly bounded by its own extent unless it says otherwise.
    if (def.bounds) {
      this.bounds = { ...def.bounds };
    } else if (this.mode === 'grid' && this.gridWidth > 0 && this.gridHeight > 0) {
      this.bounds = {
        left: 0,
        top: 0,
        right: this.gridWidth * this.tileSize,
        bottom: this.gridHeight * this.tileSize,
      };
    } else {
      this.bounds = null;
    }
  }

  static async load(id: string): Promise<TileMap> {
    const def = mapJson(id);
    const map = new TileMap(def, id);
    await map.loadTextures();
    map.buildSolids();
    return map;
  }

  private async loadTextures(): Promise<void> {
    const tileset = this.def.tileset ?? [];
    if (tileset.length === 0) {
      console.warn(`[map ${this.name}] no tileset defined; ground will be flat void colour`);
    }

    this.textures = await Promise.all(
      tileset.map(async (tile, index): Promise<TileTexture> => {
        const weight = Math.max(0, tile.weight ?? 1);
        const solid = tile.solid === true;
        if (tile.src) {
          const img = await loadImage(ASSET_ROOT + tile.src);
          if (img) return { source: img, weight, solid };
        }
        const spec: TilePlaceholderSpec = {
          color: tile.placeholder?.color ?? '#26301f',
          size: this.tileSize,
          seed: index + 1,
        };
        if (tile.placeholder?.accent !== undefined) spec.accent = tile.placeholder.accent;
        if (tile.placeholder?.detail !== undefined) spec.detail = tile.placeholder.detail;
        return { source: generateTileTexture(spec), weight, solid };
      }),
    );

    this.cumulativeWeights = [];
    this.totalWeight = 0;
    for (const tex of this.textures) {
      this.totalWeight += tex.weight;
      this.cumulativeWeights.push(this.totalWeight);
    }
    this.hasSolidTiles = this.textures.some((tex) => tex.solid);
  }

  /** True when a solid tile covers this tile coordinate. */
  isSolidTile(tx: number, ty: number): boolean {
    if (this.mode !== 'grid') {
      // Scatter mode could technically mark a tile solid, but randomly strewn
      // walls make for an unplayable arena, so treat scatter ground as open.
      return false;
    }
    if (tx < 0 || ty < 0 || tx >= this.gridWidth || ty >= this.gridHeight) {
      // Outside an authored grid is void — treat it as wall so nothing walks off.
      return true;
    }
    const raw = this.tiles[ty * this.gridWidth + tx] ?? 0;
    if (raw <= 0) return true;
    return this.textures[raw - 1]?.solid ?? false;
  }

  /**
   * Pushes a circle out of any solid tiles it overlaps.
   *
   * Uses closest-point-on-rect per overlapping tile rather than a swept test.
   * That is approximate, but movement per tick is far smaller than a tile, so
   * nothing tunnels through, and it costs only a handful of lookups per entity.
   */
  resolveTiles(x: number, y: number, r: number): [number, number] {
    if (!this.hasSolidTiles) return [x, y];

    let px = x;
    let py = y;
    const ts = this.tileSize;

    // Two relaxation passes so a circle wedged into a corner settles instead of
    // oscillating between the two walls.
    for (let pass = 0; pass < 2; pass++) {
      const tx0 = Math.floor((px - r) / ts);
      const tx1 = Math.floor((px + r) / ts);
      const ty0 = Math.floor((py - r) / ts);
      const ty1 = Math.floor((py + r) / ts);
      let moved = false;

      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (!this.isSolidTile(tx, ty)) continue;

          const left = tx * ts;
          const top = ty * ts;
          const closestX = clamp(px, left, left + ts);
          const closestY = clamp(py, top, top + ts);
          const dx = px - closestX;
          const dy = py - closestY;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;

          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            px += (dx / d) * (r - d);
            py += (dy / d) * (r - d);
          } else {
            // Centre is inside the tile: eject along the shallowest face.
            const toLeft = px - left;
            const toRight = left + ts - px;
            const toTop = py - top;
            const toBottom = top + ts - py;
            const min = Math.min(toLeft, toRight, toTop, toBottom);
            if (min === toLeft) px = left - r;
            else if (min === toRight) px = left + ts + r;
            else if (min === toTop) py = top - r;
            else py = top + ts + r;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }

    return [px, py];
  }

  /** True when the map has any collision geometry at all, so callers can skip work. */
  get hasCollision(): boolean {
    return this.hasSolidTiles || this.solids.length > 0;
  }

  private buildSolids(): void {
    for (const prop of this.props) {
      if (prop.solid && prop.solid > 0) {
        this.solids.push({ x: prop.x, y: prop.y, r: prop.solid });
      }
    }
    // Everything below this index is hand-authored and permanent; everything
    // above is a runtime structure solid and lives run-to-run.
    this.propSolidCount = this.solids.length;
  }

  /** Keeps a circle of radius `r` inside the map bounds. Returns the clamped position. */
  clampToBounds(x: number, y: number, r: number): [number, number] {
    const b = this.bounds;
    if (!b) return [x, y];
    return [clamp(x, b.left + r, b.right - r), clamp(y, b.top + r, b.bottom - r)];
  }

  /** Resolves overlap with static props by pushing the circle out. */
  resolveSolids(x: number, y: number, r: number): [number, number] {
    let px = x;
    let py = y;
    for (const solid of this.solids) {
      if (solid.r <= 0) continue;
      const dx = px - solid.x;
      const dy = py - solid.y;
      const minDist = r + solid.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = minDist - d;
      px += (dx / d) * push;
      py += (dy / d) * push;
    }
    return [px, py];
  }

  // --- runtime solids (castle structures) ---------------------------------

  /**
   * Registers a circular obstacle at runtime (a solid structure). Returns its
   * index into `solids`, valid for the structure's whole life: removal
   * tombstones the entry (r = 0) rather than splicing, so the indices other
   * structures hold in `world.value` never shift.
   */
  addRuntimeSolid(x: number, y: number, r: number): number {
    this.solids.push({ x, y, r });
    return this.solids.length - 1;
  }

  /** Disables one runtime solid (a gate breach opens the wall). Prop solids are untouchable. */
  removeRuntimeSolid(index: number): void {
    if (index < this.propSolidCount) return;
    const solid = this.solids[index];
    if (solid) solid.r = 0;
  }

  /**
   * Drops every runtime solid, keeping the hand-authored prop solids. Maps are
   * cached across runs in Game.mapCache, so startRun() must call this or a
   * restarted run would collide with the previous run's structures.
   */
  clearRuntimeSolids(): void {
    this.solids.length = this.propSolidCount;
  }

  /** Draws the ground layer. Call before queuing sprites. */
  drawGround(renderer: Renderer): void {
    const view = renderer.visibleBounds();
    const ctx = renderer.ctx;

    if (this.textures.length === 0) {
      ctx.fillStyle = this.voidColor;
      ctx.fillRect(view.left, view.top, view.right - view.left, view.bottom - view.top);
      return;
    }

    const chunkSize = this.tileSize * CHUNK_TILES;
    const cx0 = Math.floor(view.left / chunkSize);
    const cx1 = Math.floor(view.right / chunkSize);
    const cy0 = Math.floor(view.top / chunkSize);
    const cy1 = Math.floor(view.bottom / chunkSize);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = this.chunk(cx, cy);
        ctx.drawImage(chunk, cx * chunkSize, cy * chunkSize);
      }
    }
  }

  /**
   * Renders (or reuses) one CHUNK_TILES-square block of ground. Caching these
   * turns ~550 per-tile draws per frame into ~24 blits.
   */
  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = `${cx},${cy}`;
    const cached = this.chunkCache.get(key);
    if (cached) return cached;

    const size = this.tileSize * CHUNK_TILES;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.voidColor;
    ctx.fillRect(0, 0, size, size);

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const worldTx = cx * CHUNK_TILES + tx;
        const worldTy = cy * CHUNK_TILES + ty;
        const tex = this.tileAt(worldTx, worldTy);
        if (!tex) continue;
        ctx.drawImage(tex.source, tx * this.tileSize, ty * this.tileSize);
      }
    }

    this.chunkCache.set(key, canvas);
    this.chunkOrder.push(key);
    // Simple FIFO eviction: the view moves smoothly, so the oldest chunk is
    // reliably the furthest behind us.
    while (this.chunkOrder.length > CHUNK_CACHE_LIMIT) {
      const oldest = this.chunkOrder.shift()!;
      this.chunkCache.delete(oldest);
    }
    return canvas;
  }

  private tileAt(tx: number, ty: number): TileTexture | null {
    if (this.mode === 'grid') {
      if (tx < 0 || ty < 0 || tx >= this.gridWidth || ty >= this.gridHeight) return null;
      const raw = this.tiles[ty * this.gridWidth + tx] ?? 0;
      if (raw <= 0) return null;
      return this.textures[raw - 1] ?? null;
    }

    // Scatter mode: pick deterministically from the weighted tileset so the
    // ground is stable across chunk cache evictions and infinite in extent.
    if (this.totalWeight <= 0) return this.textures[0] ?? null;
    const roll = (hash2(tx, ty) / 4294967296) * this.totalWeight;
    for (let i = 0; i < this.cumulativeWeights.length; i++) {
      if (roll < this.cumulativeWeights[i]!) return this.textures[i]!;
    }
    return this.textures[this.textures.length - 1] ?? null;
  }

  /**
   * Queues decor and props into the renderer's depth-sorted list so trees
   * correctly draw over or under the player depending on position.
   */
  queueScenery(renderer: Renderer, sprites: SpriteTable): void {
    const view = renderer.visibleBounds();

    for (const prop of this.props) {
      if (
        prop.x < view.left ||
        prop.x > view.right ||
        prop.y < view.top ||
        prop.y > view.bottom
      ) {
        continue;
      }
      renderer.queue(sprites.id(prop.sprite), 0, 0, prop.x, prop.y);
    }

    if (this.decor.length === 0) return;

    const gx0 = Math.floor(view.left / DECOR_CELL);
    const gx1 = Math.floor(view.right / DECOR_CELL);
    const gy0 = Math.floor(view.top / DECOR_CELL);
    const gy1 = Math.floor(view.bottom / DECOR_CELL);

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        // One deterministic hash per cell drives choice, placement and rejection,
        // so decor never flickers as the camera moves.
        const h = hash2(gx * 73856093, gy * 19349663);
        const roll = h / 4294967296;

        let acc = 0;
        for (const decor of this.decor) {
          const density = decor.density ?? 0.05;
          if (roll >= acc && roll < acc + density) {
            const jx = ((hash2(gx, gy + 1013) / 4294967296) - 0.5) * DECOR_CELL * 0.8;
            const jy = ((hash2(gx + 7919, gy) / 4294967296) - 0.5) * DECOR_CELL * 0.8;
            const wx = gx * DECOR_CELL + DECOR_CELL / 2 + jx;
            const wy = gy * DECOR_CELL + DECOR_CELL / 2 + jy;
            if (this.bounds) {
              const b = this.bounds;
              if (wx < b.left || wx > b.right || wy < b.top || wy > b.bottom) break;
            }
            renderer.queue(sprites.id(decor.sprite), 0, 0, wx, wy, {
              // `flat` decor sits under everything; -1e6 keeps it below any entity y.
              depth: decor.flat ? -1e6 : wy,
            });
            break;
          }
          acc += density;
        }
      }
    }
  }
}

/** 32-bit integer hash of a coordinate pair. Stable, cheap, good enough for scatter. */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
