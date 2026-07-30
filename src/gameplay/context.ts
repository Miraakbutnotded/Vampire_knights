import type { EventBus, GameEvents } from '../core/events.ts';
import type { Rng } from '../core/rng.ts';
import type { World } from '../ecs/world.ts';
import type { Camera } from '../render/camera.ts';
import type { Fx } from '../render/fx.ts';
import type { SpriteTable } from '../render/sprites.ts';
import type { TileMap } from '../render/tilemap.ts';
import type { SpatialHash } from './collision.ts';
import type { Run } from './run.ts';
import type { WaveTable } from './content.ts';

/**
 * Everything a gameplay system needs, passed explicitly rather than reached for
 * through globals. Systems are plain functions taking a Ctx, which keeps them
 * independently testable and makes their dependencies obvious.
 */
export interface Ctx {
  world: World;
  run: Run;
  sprites: SpriteTable;
  fx: Fx;
  camera: Camera;
  map: TileMap;
  /** Gameplay RNG. Seeded per run, so a run is reproducible from its seed. */
  rng: Rng;
  bus: EventBus<GameEvents>;
  wave: WaveTable;

  /** The player's entity id, or -1 once dead. */
  player: number;

  /**
   * Unit vector of the player's last non-zero movement input. Directional
   * weapons fire along it, so it persists while standing still rather than
   * resetting — otherwise letting go of the keys would swing your aim.
   */
  aimX: number;
  aimY: number;

  /** Broadphase over living enemies, rebuilt at the top of each tick. */
  enemyHash: SpatialHash;
  /** Broadphase over pickups. */
  pickupHash: SpatialHash;

  /**
   * Shared query buffers. `scratch` is for outer loops and `scratchInner` for a
   * query made while iterating the results of another — never share one buffer
   * between nested queries.
   */
  scratch: Int32Array;
  scratchInner: Int32Array;

  /** Difficulty multipliers derived from elapsed time; refreshed each tick. */
  hpScale: number;
  damageScale: number;
  speedScale: number;
}
