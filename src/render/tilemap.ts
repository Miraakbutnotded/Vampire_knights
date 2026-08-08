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
  /** One line for the arena picker: what this place asks of you. */
  blurb?: string;
  /**
   * Sort key for the arena picker, ascending. Optional by design — a map that
   * omits it still appears (after every ordered map, alphabetically among its
   * peers), so dropping a JSON in `content/maps/` remains the whole ritual.
   */
  order?: number;
  tileSize?: number;
  bounds?: { left: number; top: number; right: number; bottom: number } | null;
  spawnPoint?: [number, number];
  ground?: {
    mode?: 'scatter' | 'grid';
    /**
     * Scatter mode only. Side of one material patch, in tiles. Zero — the
     * default — picks every tile independently, which reads as noise once the
     * tileset spans more than one material. Above zero the tileset is drawn in
     * contiguous areas instead: grass here, bare earth there.
     */
    patchScale?: number;
  };
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

/**
 * A static circular obstacle. Hand-placed props always; scattered decor too,
 * but only on a bounded map — see `buildSolids`, which has to materialise the
 * whole field up front and so cannot serve an infinite one.
 */
export interface Solid {
  x: number;
  y: number;
  r: number;
}

const mapModules = import.meta.glob<{ default: MapJson }>('../content/maps/*.json', {
  eager: true,
});

/** What the arena picker needs to describe a map without loading its tileset. */
export interface MapChoice {
  /** Filename without extension. The id every other system passes around. */
  id: string;
  /** Display name from the map file; falls back to the id so it is never blank. */
  name: string;
  /** One line of pitch. Empty when the map file does not offer one. */
  blurb: string;
  /**
   * True when the map ships structures, i.e. this is a defence night rather
   * than a survival one. **Derived, never authored** — a map cannot advertise
   * walls it does not stand up, and adding walls to a map advertises them.
   */
  defends: boolean;
}

/** Maps without an `order` sort after every ordered one, alphabetically. */
const UNORDERED = 1000;

/**
 * Turns raw map files into picker order. Pure and exported so the defaulting
 * and the sort are testable without a glob or a browser.
 *
 * The order lives in the map files rather than in a list here: registration in
 * two places is how a map ends up discovered but invisible, or listed but
 * missing. Every field degrades — an id for a missing name, an empty blurb, the
 * back of the queue for a missing order — so an undecorated map file still
 * shows up and still starts, which is the warn-don't-throw contract the content
 * pipeline keeps everywhere else. Ties break alphabetically, so the sort is
 * total and the picker cannot shuffle between boots.
 */
export function orderMaps(entries: { id: string; json: MapJson }[]): MapChoice[] {
  return entries
    .map(({ id, json }) => ({
      id,
      name: json.name ?? id,
      blurb: json.blurb ?? '',
      defends: (json.structures?.length ?? 0) > 0,
      order: typeof json.order === 'number' && Number.isFinite(json.order) ? json.order : UNORDERED,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(({ id, name, blurb, defends }) => ({ id, name, blurb, defends }));
}

/** Every shipped map, in the order the title screen offers them. */
export function mapChoices(): MapChoice[] {
  return orderMaps(
    Object.entries(mapModules).map(([path, mod]) => ({
      id: path.split('/').pop()!.replace(/\.json$/, ''),
      json: mod.default,
    })),
  );
}

/** Map ids are the filename without extension: `content/maps/meadow.json` -> "meadow". */
export function availableMaps(): string[] {
  return mapChoices().map((choice) => choice.id);
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
  private patchScale = 0;
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
    this.patchScale = Math.max(0, def.ground?.patchScale ?? 0);
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
    this.buildDecorSolids();
    // Everything below this index is hand-authored and permanent; everything
    // above is a runtime structure solid and lives run-to-run.
    this.propSolidCount = this.solids.length;
  }

  /**
   * Turns scattered decor that asked for a collision radius into real solids.
   *
   * Scatter decor is generated on demand from a hash as the camera moves, but
   * `resolveSolids` scans a flat array, so a collider has to exist before
   * anything can walk into it. That is affordable exactly once: over a bounded
   * map, where the cell range is finite and can be swept at load. An unbounded
   * map would need a solid for every cell out to infinity, so `solid` on decor
   * is ignored there — warned about rather than silently dropped, because the
   * failure otherwise looks like collision that mysteriously does not work.
   */
  private buildDecorSolids(): void {
    if (!this.decor.some((d) => (d.solid ?? 0) > 0)) return;

    if (!this.bounds) {
      console.warn(
        `[map ${this.name}] decor asks for "solid" but the map is unbounded, so no collider can be built for it. ` +
          `Give the map "bounds", or hand-place it in "props" instead.`,
      );
      return;
    }

    const b = this.bounds;
    const gx0 = Math.floor(b.left / DECOR_CELL);
    const gx1 = Math.floor(b.right / DECOR_CELL);
    const gy0 = Math.floor(b.top / DECOR_CELL);
    const gy1 = Math.floor(b.bottom / DECOR_CELL);

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const placed = this.decorAt(gx, gy);
        const r = placed?.decor.solid ?? 0;
        if (placed && r > 0) this.solids.push({ x: placed.x, y: placed.y, r });
      }
    }
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
    if (this.patchScale <= 0) return this.weightedTile(hash2(tx, ty) / 4294967296);
    return this.patchTile(tx, ty);
  }

  /** Indexes the cumulative weights with a uniform sample in [0,1). */
  private weightedTile(u: number): TileTexture | null {
    const roll = u * this.totalWeight;
    for (let i = 0; i < this.cumulativeWeights.length; i++) {
      if (roll < this.cumulativeWeights[i]!) return this.textures[i]!;
    }
    return this.textures[this.textures.length - 1] ?? null;
  }

  /**
   * Draws the tileset in contiguous areas rather than per-tile static.
   *
   * Each corner of the patch lattice makes its own weighted draw; a tile then
   * picks *which corner it belongs to*, using the bilinear share of the four
   * around it as the probabilities. Near a corner that corner nearly always
   * wins, which is what makes an area of one material; halfway between two, the
   * draw is close to a coin flip, which dithers the border into an organic edge
   * instead of a straight contour.
   *
   * Choosing among four independent weighted draws leaves the marginal
   * distribution exactly the weighted one, so `weight` still means the same
   * share of ground it meant before — patches change where a tile lands, never
   * how much of it there is. That is the reason for this shape rather than the
   * obvious one of smoothing a noise field and thresholding it: interpolated
   * noise is bell-shaped, so it would quietly starve the first and last entries
   * of the tileset and over-serve the middle.
   */
  private patchTile(tx: number, ty: number): TileTexture | null {
    const fx = tx / this.patchScale;
    const fy = ty / this.patchScale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const dx = fx - x0;
    const dy = fy - y0;
    // Smoothstep, so patch interiors stay pure and only the seams mix.
    const sx = dx * dx * (3 - 2 * dx);
    const sy = dy * dy * (3 - 2 * dy);

    const w00 = (1 - sx) * (1 - sy);
    const w10 = sx * (1 - sy);
    const w01 = (1 - sx) * sy;

    const pick = hash2(tx + 0x9e37, ty + 0x85eb) / 4294967296;
    let cx = x0 + 1;
    let cy = y0 + 1;
    if (pick < w00) {
      cx = x0;
      cy = y0;
    } else if (pick < w00 + w10) {
      cx = x0 + 1;
      cy = y0;
    } else if (pick < w00 + w10 + w01) {
      cx = x0;
      cy = y0 + 1;
    }

    return this.weightedTile(hash2(cx * 0x51ed, cy * 0x27d4) / 4294967296);
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
        const placed = this.decorAt(gx, gy);
        if (!placed) continue;
        renderer.queue(sprites.id(placed.decor.sprite), 0, 0, placed.x, placed.y, {
          // `flat` decor sits under everything; -1e6 keeps it below any entity y.
          depth: placed.decor.flat ? -1e6 : placed.y,
        });
      }
    }
  }

  /**
   * What decor, if any, occupies one scatter cell, and exactly where.
   *
   * One deterministic hash per cell drives choice, placement and rejection, so
   * decor never flickers as the camera moves. Both the renderer and
   * `buildSolids` read placement through here, because a collider that computed
   * its own jitter would drift off the sprite it is supposed to be.
   */
  private decorAt(gx: number, gy: number): { decor: DecorJson; x: number; y: number } | null {
    const roll = hash2(gx * 73856093, gy * 19349663) / 4294967296;

    let acc = 0;
    for (const decor of this.decor) {
      const density = decor.density ?? 0.05;
      if (roll >= acc && roll < acc + density) {
        const jx = (hash2(gx, gy + 1013) / 4294967296 - 0.5) * DECOR_CELL * 0.8;
        const jy = (hash2(gx + 7919, gy) / 4294967296 - 0.5) * DECOR_CELL * 0.8;
        const x = gx * DECOR_CELL + DECOR_CELL / 2 + jx;
        const y = gy * DECOR_CELL + DECOR_CELL / 2 + jy;
        if (this.bounds) {
          const b = this.bounds;
          if (x < b.left || x > b.right || y < b.top || y > b.bottom) return null;
        }
        return { decor, x, y };
      }
      acc += density;
    }
    return null;
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
