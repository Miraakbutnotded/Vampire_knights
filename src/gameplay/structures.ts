import { Comp, Kind, Team } from '../ecs/components.ts';
import { fxRng } from '../core/rng.ts';
import { WEAPON_STAT_DEFAULTS, structureDefByIndex, structureStatsAtTier, upgradeCost } from './content.ts';
import { nearestEnemy, spawnProjectile } from './weapons.ts';
import type { StructureDef, WeaponStats } from './content.ts';
import type { Ctx } from './context.ts';
import type { BuildSite } from './run.ts';

/** Seconds a structure flashes white after taking a hit (damageEnemy parity). */
const HIT_FLASH = 0.12;
/** Below this hp fraction a structure smoulders. */
const SMOKE_THRESHOLD = 0.3;
/** Expected smoke puffs per second while smouldering. Cosmetic — fxRng, never ctx.rng. */
const SMOKE_RATE = 3;
/** Height above the entity origin that a tower's bolts leave from. */
const MUZZLE_HEIGHT = 10;
/**
 * Seconds an armed structure waits before sweeping for targets again after a
 * miss. A loaded tower with an empty field would otherwise re-enter the
 * `ready <= 0` branch every tick and run a full spatial-hash query 60 times a
 * second for the whole run — sieges are five bounded windows, so idle is the
 * common case. At 100ms a tower is still all but instant on anything that walks
 * into range, and idle time still never banks into owed shots.
 */
const IDLE_RESCAN = 0.1;

/**
 * Scratch stats for tower shots, overwritten in place per shot — one shared
 * object, no per-shot allocation, same idiom as ctx.scratch and safe for the
 * same reason: it is consumed synchronously inside spawnProjectile.
 *
 * Built from WEAPON_STAT_DEFAULTS and the StructureDef, never from
 * effectiveStats(). No passive, weapon level or Frenzy multiplier may ever
 * reach a tower, or the tower stops being terrain and becomes part of the
 * player's build — at which point it carries the run.
 */
const TOWER_STATS: WeaponStats = {
  ...WEAPON_STAT_DEFAULTS,
  // One enemy per bolt; walls don't stagger the horde.
  pierce: 1,
  knockback: 0,
  area: 1,
  turnRate: 0,
};

/**
 * Places a defendable structure: static (no Velocity — snapshotPositions makes
 * prev == current, so interpolation is free), player-team so weapons — which
 * only query enemyHash — can never friendly-fire it.
 */
export function spawnStructure(ctx: Ctx, def: StructureDef, x: number, y: number): number {
  const { world } = ctx;
  const id = world.create(Kind.Structure);
  if (id < 0) return -1;

  // A positive range arms the structure. Comp.Shooter lets the per-tick loop
  // skip passive walls with one AND instead of a def lookup each.
  let comps = Comp.Transform | Comp.Sprite | Comp.Health | Comp.Collider;
  if (def.range > 0) comps |= Comp.Shooter;
  world.add(id, comps);
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(def.sprite);
  world.radius[id] = def.radius;
  world.defIndex[id] = def.index;
  world.team[id] = Team.Player;
  world.hp[id] = def.hp;
  world.maxHp[id] = def.hp;
  // HUD pip slot, in spawn order. aiPhase is polymorphic by Kind, and
  // Structure is a new Kind, so claiming it here is sanctioned (CLAUDE.md).
  world.aiPhase[id] = ctx.run.structuresSpawned++;
  // Runtime-solid index for gates, -1 for walk-through structures. The index
  // stays valid for life: removal tombstones in place, never splices.
  world.value[id] = def.solid ? ctx.map.addRuntimeSolid(x, y, def.radius) : -1;
  // hitCooldown is the fire timer, zeroed by World.create(): a fresh tower is
  // loaded and shoots the first thing that walks into range.
  return id;
}

/** How close the player must stand to work on a structure, in world units. */
export const REACH = 34;

/**
 * The structure the player is standing at, or -1.
 *
 * Nearest wins, so two towers built shoulder to shoulder are still individually
 * selectable by stepping toward one. The player's own position is the cursor —
 * this game has no mouse on any of its platforms, and asking a thumb to aim a
 * pointer at a 10px tower would be worse than walking to it.
 */
export function structureAtPlayer(ctx: Ctx): number {
  const { world } = ctx;
  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) return -1;
  const px = world.x[player]!;
  const py = world.y[player]!;

  let best = -1;
  let bestD2 = Infinity;
  const ids = world.list(Kind.Structure);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (!world.isAlive(id)) continue;
    const reach = REACH + world.radius[id]!;
    const dx = world.x[id]! - px;
    const dy = world.y[id]! - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach * reach || d2 >= bestD2) continue;
    bestD2 = d2;
    best = id;
  }
  return best;
}

/**
 * Buys the next tier for a structure. Returns true when gold actually changed
 * hands.
 *
 * Spends from `run.gold` — the same purse the run banks at the end — so
 * fortifying is paid for out of the meta-progression the player was saving up.
 * That tension is the point: a tower now, or a Sanctum rank later.
 *
 * Health is topped up by exactly what the tier added rather than refilled, so
 * upgrading is never a repair. A wall on its last legs stays on its last legs;
 * it just has a higher ceiling.
 */
export function upgradeStructure(ctx: Ctx, id: number): boolean {
  const { world, run, bus } = ctx;
  if (!world.isAlive(id) || world.kind[id] !== Kind.Structure) return false;

  const def = structureDefByIndex(world.defIndex[id]!);
  const tier = world.tier[id]!;
  const cost = upgradeCost(def, tier);
  if (cost < 0 || run.gold < cost) return false;

  const before = structureStatsAtTier(def, tier);
  const after = structureStatsAtTier(def, tier + 1);

  run.gold -= cost;
  world.tier[id] = tier + 1;
  const gained = after.hp - before.hp;
  world.maxHp[id] = after.hp;
  if (gained > 0) world.hp[id] = world.hp[id]! + gained;

  ctx.fx.shockwave(world.x[id]!, world.y[id]! - 6, '#d4a15a', 0.5, 10);
  ctx.fx.floatingText(world.x[id]!, world.y[id]! - world.radius[id]! - 10, `T${tier + 1}`, '#d4a15a', 1);
  bus.emit('structure:upgraded', {
    name: def.name,
    tier: tier + 1,
    maxTier: def.maxTier,
    cost,
    index: world.aiPhase[id]!,
  });
  return true;
}

/**
 * Below this fraction of its ceiling, a structure asks to be patched up rather
 * than improved.
 *
 * A threshold rather than "any damage at all": a wall a single bat chipped
 * would otherwise keep offering a one-gold repair in front of the upgrade the
 * player actually walked over for. Below it, the offer flips — you cannot
 * improve a wall that is about to come down, and being made to triage is the
 * point.
 */
const REPAIR_BELOW = 0.75;
/** Gold per point of health put back. Cheaper than buying that health as a tier. */
const REPAIR_PER_HP = 0.35;

/** Whether this structure is hurt enough to be offered a repair. */
export function needsRepair(ctx: Ctx, id: number): boolean {
  const { world } = ctx;
  const max = world.maxHp[id]!;
  return max > 0 && world.hp[id]! < max * REPAIR_BELOW;
}

/** Gold to put a structure back to full, or -1 when it does not need it. */
export function repairCost(ctx: Ctx, id: number): number {
  if (!needsRepair(ctx, id)) return -1;
  const missing = ctx.world.maxHp[id]! - ctx.world.hp[id]!;
  return Math.max(1, Math.ceil(missing * REPAIR_PER_HP));
}

/**
 * Buys a structure back to full health. Returns true on a sale.
 *
 * Priced per point restored rather than as a flat fee, so patching a scratch is
 * cheap and saving a wall at death's door is not — and always cheaper per point
 * than buying the same health as a tier, because a repair buys nothing but the
 * status quo while a tier is permanent.
 */
export function repairStructure(ctx: Ctx, id: number): boolean {
  const { world, run, bus } = ctx;
  if (!world.isAlive(id) || world.kind[id] !== Kind.Structure) return false;
  const cost = repairCost(ctx, id);
  if (cost < 0 || run.gold < cost) return false;

  run.gold -= cost;
  world.hp[id] = world.maxHp[id]!;
  const def = structureDefByIndex(world.defIndex[id]!);
  ctx.fx.shockwave(world.x[id]!, world.y[id]! - 4, '#aab7c9', 0.5, 9);
  ctx.fx.floatingText(world.x[id]!, world.y[id]! - world.radius[id]! - 10, 'MENDED', '#aab7c9', 1);
  bus.emit('structure:repaired', { name: def.name, cost, index: world.aiPhase[id]! });
  return true;
}

/** Whether a pad currently has something standing on it. */
export function padOccupied(ctx: Ctx, site: BuildSite): boolean {
  return site.handle >= 0 && ctx.world.resolve(site.handle) >= 0;
}

/**
 * The index of the empty pad the player is standing on, or -1.
 *
 * Only empty pads answer: once a pad is filled, the thing standing on it is
 * what the player is interacting with, and `structureAtPlayer` finds that.
 */
export function padAtPlayer(ctx: Ctx): number {
  const { world, run } = ctx;
  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) return -1;
  const px = world.x[player]!;
  const py = world.y[player]!;

  let best = -1;
  let bestD2 = REACH * REACH;
  for (let i = 0; i < run.buildSites.length; i++) {
    const site = run.buildSites[i]!;
    if (padOccupied(ctx, site)) continue;
    const dx = site.x - px;
    const dy = site.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    best = i;
  }
  return best;
}

/**
 * Raises the pad's structure, if the run can afford it. Returns true on a sale.
 *
 * The pad remembers the structure by handle rather than id, so nothing has to
 * clean up when the thing falls: a destroyed tower's handle simply stops
 * resolving and the pad is free again, which is exactly the rebuild-between-
 * sieges loop this is for.
 */
export function buildAtPad(ctx: Ctx, index: number): boolean {
  const { run, world } = ctx;
  const site = run.buildSites[index];
  if (!site || padOccupied(ctx, site)) return false;

  const def = structureDefByIndex(site.defIndex);
  // Zero means "map-placed only" — a gate is architecture, not kit for sale.
  if (def.buildCost <= 0 || run.gold < def.buildCost) return false;

  const id = spawnStructure(ctx, def, site.x, site.y);
  if (id < 0) return false;

  run.gold -= def.buildCost;
  site.handle = world.handleOf(id);
  ctx.fx.shockwave(site.x, site.y, '#d4a15a', 0.6, 12);
  ctx.bus.emit('structure:built', {
    name: def.name,
    cost: def.buildCost,
    index: world.aiPhase[id]!,
  });
  return true;
}

/**
 * Consumes the player's latched build press: raise something on an empty pad,
 * or pay to improve whatever is already standing here.
 *
 * Latched rather than read live for the same reason as Feast and the ability: a
 * frame can run zero sim ticks, and a press written straight into a system on
 * the frame side would be dropped.
 *
 * A standing structure outranks a pad, because once a pad is filled its own
 * radius covers the pad's position and the player cannot step off one without
 * stepping off both.
 */
export function updateBuilding(ctx: Ctx): void {
  if (!ctx.buildIntent) return;
  ctx.buildIntent = false;

  const standing = structureAtPlayer(ctx);
  if (standing >= 0) {
    // Mending outranks improving on a wall that is far enough gone. Which one
    // the key does is therefore chosen by *when* the player walks over, not by
    // a second control — and a wall about to fall cannot be upgraded past the
    // problem.
    if (needsRepair(ctx, standing)) repairStructure(ctx, standing);
    else upgradeStructure(ctx, standing);
    return;
  }
  const pad = padAtPlayer(ctx);
  if (pad >= 0) buildAtPad(ctx, pad);
}

/**
 * One bolt at the nearest enemy in range, or nothing if the field is clear.
 *
 * Spawned like an enemy shot — every number read straight off the def — but
 * flagged Team.Player, because only player-team projectiles are resolved
 * against ctx.enemyHash by updatePlayerProjectiles. That single flag buys the
 * tower the whole downstream pipeline: movement, despawn, the pierce/hit
 * registry, damageEnemy, drops, blood and kill events.
 *
 * The bolt claims its owner, and resolveDamageArea reads that claim twice: to
 * exempt the shot from the on-screen engagement rule, and to deny it crits.
 * Crit chance and crit multiplier are player upgrade stats, and a tower that
 * scaled with them would stop being terrain.
 */
function fireTower(ctx: Ctx, id: number, def: StructureDef): void {
  const { world } = ctx;
  // Per entity, not per def: two towers of the same type diverge the moment one
  // of them is paid for, and reading the def here would silently make every
  // upgrade cosmetic.
  const stats = structureStatsAtTier(def, world.tier[id]!);
  const x = world.x[id]!;
  // Bolts leave from the crenellations, and the shot is aimed from there too,
  // so the muzzle offset never becomes an aiming error.
  const y = world.y[id]! - MUZZLE_HEIGHT;

  const target = nearestEnemy(ctx, x, y, stats.range);
  if (target < 0) {
    // Nothing in range: sleep off the rescan interval instead of querying the
    // hash again next tick. Capped by shootInterval so a fast emplacement is
    // never slowed down by its own idle throttle.
    world.hitCooldown[id] = Math.min(stats.shootInterval, IDLE_RESCAN);
    return;
  }

  const angle = Math.atan2(world.y[target]! - y, world.x[target]! - x);
  TOWER_STATS.damage = stats.projectileDamage;
  TOWER_STATS.lifetime = def.projectileLifetime;
  const bolt = spawnProjectile(
    ctx,
    def.projectileSprite,
    x,
    y,
    Math.cos(angle) * stats.projectileSpeed,
    Math.sin(angle) * stats.projectileSpeed,
    TOWER_STATS,
    false,
  );
  // Marks the shot as the tower's rather than the player's, which is what
  // exempts it from the on-screen restraint the player's own weapons obey.
  if (bolt >= 0) world.owner[bolt] = id;

  world.hitCooldown[id] = stats.shootInterval;
  ctx.fx.burst(x, y, 3, 40, '#ffd9a0', 0.18, 1);
}

/**
 * Applies damage to a structure — the damageEnemy of castle defense, minus
 * crits and knockback (walls don't dodge). At zero hp the structure falls.
 * Returns the damage dealt, or 0 if the target was already gone.
 */
export function damageStructure(ctx: Ctx, id: number, amount: number): number {
  const { world, fx, bus } = ctx;
  if (!world.isAlive(id) || world.kind[id] !== Kind.Structure) return 0;

  world.hp[id] = world.hp[id]! - amount;
  world.hitFlash[id] = HIT_FLASH;
  fx.damageNumber(world.x[id]!, world.y[id]! - world.radius[id]! - 4, amount, false);
  bus.emit('structure:damaged', {
    hp: Math.max(0, world.hp[id]!),
    maxHp: world.maxHp[id]!,
    index: world.aiPhase[id]!,
  });

  if (world.hp[id]! <= 0) destroyStructure(ctx, id);
  return amount;
}

/**
 * The fall of a structure: its solid is removed (a gate breach opens the
 * wall), the difficulty penalty is banked, and the entity is destroyed.
 * resolve() returns -1 from this same tick, before flush() (resolve checks
 * alive, not just generation), so attackers processed later in this same
 * updateEnemies pass already retarget within the death tick.
 */
function destroyStructure(ctx: Ctx, id: number): void {
  const { world, run, fx, bus } = ctx;
  const def = structureDefByIndex(world.defIndex[id]!);
  const x = world.x[id]!;
  const y = world.y[id]!;

  const solidIndex = world.value[id]!;
  if (solidIndex >= 0) ctx.map.removeRuntimeSolid(solidIndex);

  run.structuresLost++;
  // Only walls are scored. An emplacement is hardware you spend defending them,
  // so losing one costs its guns and nothing more — otherwise arming a map
  // would raise its difficulty ceiling as a side effect of the placement.
  if (def.range === 0) run.wallsLost++;
  fx.shockwave(x, y, '#c9a86a', 0.7, 14);
  fx.burst(x, y, 24, 110, '#8a7a66', 0.7, 2);
  ctx.camera.shake(4, 0.4);

  world.destroy(id);
  // destroy() only marks dead, so count survivors by aliveness, never by
  // list length — the list still holds this id until flush().
  let remaining = 0;
  for (const sid of world.list(Kind.Structure)) {
    if (world.isAlive(sid)) remaining++;
  }
  bus.emit('structure:destroyed', { name: def.name, remaining, index: world.aiPhase[id]! });
}

/**
 * Per-tick upkeep: hit-flash decay, idle animation, smoulder fx below 30% hp,
 * and tower fire.
 *
 * Its existing slot in the tick (after updateHazards, before the pickup-index
 * rebuild) is already downstream of enemy-hash rebuild #2, and nothing between
 * that rebuild and here writes an enemy's x/y — only kbx/kby, which are not
 * integrated until the next tick. So a tower aims at exact current positions,
 * and enemies killed earlier this tick are already excluded by nearestEnemy's
 * isAlive filter. Firing needs no new call in Game.tick(), and therefore no
 * change to the test harness that mirrors it.
 */
export function updateStructures(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const ids = world.list(Kind.Structure);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    world.animTime[id] = world.animTime[id]! + dt;
    if (world.hitFlash[id]! > 0) world.hitFlash[id] = Math.max(0, world.hitFlash[id]! - dt);

    if (world.has(id, Comp.Shooter) && world.isAlive(id)) {
      const ready = world.hitCooldown[id]! - dt;
      // Clamped at zero: idle time never banks into owed shots.
      world.hitCooldown[id] = ready > 0 ? ready : 0;
      if (ready <= 0) fireTower(ctx, id, structureDefByIndex(world.defIndex[id]!));
    }

    if (world.hp[id]! / world.maxHp[id]! < SMOKE_THRESHOLD && fxRng.chance(SMOKE_RATE * dt)) {
      ctx.fx.particle(
        world.x[id]! + fxRng.range(-4, 4),
        world.y[id]! - world.radius[id]! * 0.6,
        fxRng.range(-4, 4),
        -18,
        0.8,
        1,
        '#5a5462',
      );
    }
  }
}
