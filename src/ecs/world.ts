import { Kind } from './components.ts';

export const MAX_ENTITIES = 16384;

const KIND_COUNT = 6;

/**
 * Entity store. Every array below is indexed by entity id; see components.ts
 * for the rationale.
 *
 * Ids are recycled through a freelist. Because a recycled id would otherwise
 * make a stale reference silently point at a brand new entity, each id carries
 * a generation counter — hold an entity across ticks as a *handle*
 * (`world.handleOf(id)`) and resolve it with `world.resolve(handle)`, which
 * returns -1 if the original entity is gone.
 */
export class World {
  readonly capacity = MAX_ENTITIES;

  // --- identity -----------------------------------------------------------
  readonly gen = new Uint32Array(MAX_ENTITIES);
  readonly kind = new Uint8Array(MAX_ENTITIES);
  readonly flags = new Uint32Array(MAX_ENTITIES);
  readonly alive = new Uint8Array(MAX_ENTITIES);

  // --- transform ----------------------------------------------------------
  readonly x = new Float32Array(MAX_ENTITIES);
  readonly y = new Float32Array(MAX_ENTITIES);
  /** Position at the start of the current tick, so the renderer can interpolate. */
  readonly prevX = new Float32Array(MAX_ENTITIES);
  readonly prevY = new Float32Array(MAX_ENTITIES);
  readonly rot = new Float32Array(MAX_ENTITIES);
  readonly scale = new Float32Array(MAX_ENTITIES);

  // --- velocity -----------------------------------------------------------
  readonly vx = new Float32Array(MAX_ENTITIES);
  readonly vy = new Float32Array(MAX_ENTITIES);
  /** Desired movement speed for AI-driven entities, in world units/sec. */
  readonly speed = new Float32Array(MAX_ENTITIES);
  /**
   * Knockback impulse, decaying each tick. Kept apart from vx/vy because AI
   * overwrites its desired velocity every tick and would otherwise erase it.
   */
  readonly kbx = new Float32Array(MAX_ENTITIES);
  readonly kby = new Float32Array(MAX_ENTITIES);

  // --- collider -----------------------------------------------------------
  readonly radius = new Float32Array(MAX_ENTITIES);

  // --- health -------------------------------------------------------------
  readonly hp = new Float32Array(MAX_ENTITIES);
  readonly maxHp = new Float32Array(MAX_ENTITIES);
  /** Seconds of damage immunity remaining. */
  readonly iframe = new Float32Array(MAX_ENTITIES);
  /** Seconds of white-flash remaining, for hit feedback. */
  readonly hitFlash = new Float32Array(MAX_ENTITIES);

  // --- damage dealing -----------------------------------------------------
  readonly damage = new Float32Array(MAX_ENTITIES);
  readonly knockback = new Float32Array(MAX_ENTITIES);
  /** Remaining enemies this projectile can pass through. Negative = unlimited. */
  readonly pierce = new Int16Array(MAX_ENTITIES);
  /** Seconds until this damage source may hit again (auras, contact damage). */
  readonly hitCooldown = new Float32Array(MAX_ENTITIES);
  /** Seconds between repeat hits from this source. 0 = single hit only. */
  readonly hitInterval = new Float32Array(MAX_ENTITIES);

  // --- lifetime -----------------------------------------------------------
  readonly lifetime = new Float32Array(MAX_ENTITIES);
  readonly maxLifetime = new Float32Array(MAX_ENTITIES);

  // --- sprite -------------------------------------------------------------
  /** Index into the renderer's sprite table. */
  readonly spriteId = new Uint16Array(MAX_ENTITIES);
  readonly animState = new Uint8Array(MAX_ENTITIES);
  readonly animTime = new Float32Array(MAX_ENTITIES);
  /** -1 draws the sprite mirrored horizontally, +1 normal. */
  readonly facing = new Int8Array(MAX_ENTITIES);
  /** Added to y when depth sorting, to force something above/below its row. */
  readonly drawBias = new Float32Array(MAX_ENTITIES);

  // --- ai -----------------------------------------------------------------
  readonly behavior = new Uint8Array(MAX_ENTITIES);
  readonly aiTimer = new Float32Array(MAX_ENTITIES);
  readonly aiPhase = new Float32Array(MAX_ENTITIES);

  // --- orbit (weapons that circle the player) -----------------------------
  readonly orbitAngle = new Float32Array(MAX_ENTITIES);
  readonly orbitRadius = new Float32Array(MAX_ENTITIES);
  readonly orbitSpeed = new Float32Array(MAX_ENTITIES);
  /** Owning entity id, or -1. Not a handle: owners outlive their attachments here. */
  readonly owner = new Int32Array(MAX_ENTITIES);

  // --- content linkage ----------------------------------------------------
  /** Index into the relevant def table (enemy type, pickup type, weapon). */
  readonly defIndex = new Uint16Array(MAX_ENTITIES);
  readonly team = new Uint8Array(MAX_ENTITIES);
  /** Generic payload: xp for gems, heal amount for food, gold for coins. */
  readonly value = new Float32Array(MAX_ENTITIES);

  /**
   * Which enemies a piercing projectile has already damaged. Cold data, so it
   * lives outside the typed arrays. Cleared when the entity is freed.
   */
  private readonly hitRegistry = new Map<number, Set<number>>();

  /** Live entity ids bucketed by Kind, for iteration without scanning capacity. */
  private readonly lists: number[][] = Array.from({ length: KIND_COUNT }, () => []);

  private readonly freeList: number[] = [];
  private nextFresh = 0;
  private pendingFree: number[] = [];
  private needsCompact = false;

  entityCount = 0;

  constructor() {
    // Start with a full freelist in ascending order so early ids stay low and
    // debugging output is readable.
    for (let i = 0; i < 64; i++) this.freeList.push(i);
    this.nextFresh = 64;
  }

  /** Ids of every live entity of a kind. Do not mutate; do not retain across ticks. */
  list(kind: Kind): readonly number[] {
    return this.lists[kind]!;
  }

  /**
   * Allocates an entity and resets every field to a sane default.
   * Returns -1 when at capacity — callers should treat that as "skip this spawn".
   */
  create(kind: Kind): number {
    let id: number;
    if (this.freeList.length > 0) {
      id = this.freeList.pop()!;
    } else if (this.nextFresh < MAX_ENTITIES) {
      id = this.nextFresh++;
    } else {
      return -1;
    }

    this.alive[id] = 1;
    this.kind[id] = kind;
    this.flags[id] = 0;

    this.x[id] = 0;
    this.y[id] = 0;
    this.prevX[id] = 0;
    this.prevY[id] = 0;
    this.rot[id] = 0;
    this.scale[id] = 1;

    this.vx[id] = 0;
    this.vy[id] = 0;
    this.speed[id] = 0;
    this.kbx[id] = 0;
    this.kby[id] = 0;

    this.radius[id] = 0;

    this.hp[id] = 1;
    this.maxHp[id] = 1;
    this.iframe[id] = 0;
    this.hitFlash[id] = 0;

    this.damage[id] = 0;
    this.knockback[id] = 0;
    this.pierce[id] = 0;
    this.hitCooldown[id] = 0;
    this.hitInterval[id] = 0;

    this.lifetime[id] = 0;
    this.maxLifetime[id] = 0;

    this.spriteId[id] = 0;
    this.animState[id] = 0;
    this.animTime[id] = 0;
    this.facing[id] = 1;
    this.drawBias[id] = 0;

    this.behavior[id] = 0;
    this.aiTimer[id] = 0;
    this.aiPhase[id] = 0;

    this.orbitAngle[id] = 0;
    this.orbitRadius[id] = 0;
    this.orbitSpeed[id] = 0;
    this.owner[id] = -1;

    this.defIndex[id] = 0;
    this.team[id] = 0;
    this.value[id] = 0;

    this.lists[kind]!.push(id);
    this.entityCount++;
    return id;
  }

  /** Sets position and prev-position together, so a fresh spawn doesn't streak. */
  place(id: number, x: number, y: number): void {
    this.x[id] = x;
    this.y[id] = y;
    this.prevX[id] = x;
    this.prevY[id] = y;
  }

  add(id: number, comps: number): void {
    this.flags[id] |= comps;
  }

  remove(id: number, comps: number): void {
    this.flags[id] &= ~comps;
  }

  has(id: number, comps: number): boolean {
    return (this.flags[id]! & comps) === comps;
  }

  hasAny(id: number, comps: number): boolean {
    return (this.flags[id]! & comps) !== 0;
  }

  isAlive(id: number): boolean {
    return id >= 0 && this.alive[id] === 1;
  }

  /**
   * Marks an entity for removal. The id stays readable until the next
   * `flush()`, so it is safe to call this while iterating a kind list.
   */
  destroy(id: number): void {
    if (id < 0 || this.alive[id] !== 1) return;
    this.alive[id] = 0;
    this.pendingFree.push(id);
    this.needsCompact = true;
  }

  /** Recycles everything destroyed this tick. Call once, at the end of the tick. */
  flush(): void {
    if (!this.needsCompact) return;

    for (const list of this.lists) {
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        const id = list[read]!;
        if (this.alive[id] === 1) list[write++] = id;
      }
      list.length = write;
    }

    for (const id of this.pendingFree) {
      // Bumping the generation invalidates any handle still pointing here.
      this.gen[id] = (this.gen[id]! + 1) >>> 0;
      this.kind[id] = Kind.None;
      this.flags[id] = 0;
      this.hitRegistry.delete(id);
      this.freeList.push(id);
      this.entityCount--;
    }
    this.pendingFree.length = 0;
    this.needsCompact = false;
  }

  /** Copies current position into prev position. Call at the top of every tick. */
  snapshotPositions(): void {
    for (const list of this.lists) {
      for (let i = 0; i < list.length; i++) {
        const id = list[i]!;
        this.prevX[id] = this.x[id]!;
        this.prevY[id] = this.y[id]!;
      }
    }
  }

  // --- stable handles -----------------------------------------------------

  /** Packs id + generation into one number that is safe to hold across ticks. */
  handleOf(id: number): number {
    if (id < 0) return -1;
    return id | (this.gen[id]! * MAX_ENTITIES);
  }

  /** Unpacks a handle, returning -1 if that entity has since died or been recycled. */
  resolve(handle: number): number {
    if (handle < 0) return -1;
    const id = handle % MAX_ENTITIES;
    const gen = Math.floor(handle / MAX_ENTITIES);
    if (this.alive[id] !== 1 || this.gen[id] !== gen) return -1;
    return id;
  }

  // --- pierce bookkeeping -------------------------------------------------

  /**
   * Records that `source` hit `target`. Returns false if it already had —
   * this is what stops a piercing knife from shredding one enemy per frame.
   */
  registerHit(source: number, target: number): boolean {
    let set = this.hitRegistry.get(source);
    if (!set) {
      set = new Set();
      this.hitRegistry.set(source, set);
    }
    if (set.has(target)) return false;
    set.add(target);
    return true;
  }

  /** Lets a repeating source (an aura) hit the same targets again next interval. */
  clearHits(source: number): void {
    this.hitRegistry.get(source)?.clear();
  }

  /** Wipes every entity. Used when starting a fresh run. */
  reset(): void {
    for (const list of this.lists) {
      for (const id of list) this.alive[id] = 0;
      list.length = 0;
    }
    this.hitRegistry.clear();
    this.pendingFree.length = 0;
    this.needsCompact = false;
    this.freeList.length = 0;
    this.nextFresh = 0;
    this.entityCount = 0;
    for (let i = 0; i < 64; i++) this.freeList.push(i);
    this.nextFresh = 64;
    this.gen.fill(0);
    this.alive.fill(0);
    this.kind.fill(Kind.None);
    this.flags.fill(0);
  }
}
