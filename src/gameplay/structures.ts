import { Comp, Kind, Team } from '../ecs/components.ts';
import { fxRng } from '../core/rng.ts';
import { WEAPON_STAT_DEFAULTS, structureDefByIndex } from './content.ts';
import { nearestEnemy, spawnProjectile } from './weapons.ts';
import type { StructureDef, WeaponStats } from './content.ts';
import type { Ctx } from './context.ts';

/** Seconds a structure flashes white after taking a hit (damageEnemy parity). */
const HIT_FLASH = 0.12;
/** Below this hp fraction a structure smoulders. */
const SMOKE_THRESHOLD = 0.3;
/** Expected smoke puffs per second while smouldering. Cosmetic — fxRng, never ctx.rng. */
const SMOKE_RATE = 3;
/** Height above the entity origin that a tower's bolts leave from. */
const MUZZLE_HEIGHT = 10;

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

/**
 * One bolt at the nearest enemy in range, or nothing if the field is clear.
 *
 * Spawned like an enemy shot — every number read straight off the def — but
 * flagged Team.Player, because only player-team projectiles are resolved
 * against ctx.enemyHash by updatePlayerProjectiles. That single flag buys the
 * tower the whole downstream pipeline: movement, despawn, the pierce/hit
 * registry, damageEnemy, drops, blood and kill events.
 *
 * Accepted coupling: resolveDamageArea always allows crits, so tower bolts do
 * crit off the player's crit chance. Threading a canCrit flag through the
 * player's own damage path for this was not worth it — note it when balancing.
 */
function fireTower(ctx: Ctx, id: number, def: StructureDef): void {
  const { world } = ctx;
  const x = world.x[id]!;
  // Bolts leave from the crenellations, and the shot is aimed from there too,
  // so the muzzle offset never becomes an aiming error.
  const y = world.y[id]! - MUZZLE_HEIGHT;

  const target = nearestEnemy(ctx, x, y, def.range);
  if (target < 0) return;

  const angle = Math.atan2(world.y[target]! - y, world.x[target]! - x);
  TOWER_STATS.damage = def.projectileDamage;
  TOWER_STATS.lifetime = def.projectileLifetime;
  const bolt = spawnProjectile(
    ctx,
    def.projectileSprite,
    x,
    y,
    Math.cos(angle) * def.projectileSpeed,
    Math.sin(angle) * def.projectileSpeed,
    TOWER_STATS,
    false,
  );
  // Marks the shot as the tower's rather than the player's, which is what
  // exempts it from the on-screen restraint the player's own weapons obey.
  if (bolt >= 0) world.owner[bolt] = id;

  world.hitCooldown[id] = def.shootInterval;
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
