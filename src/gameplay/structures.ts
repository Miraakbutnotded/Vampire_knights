import { Comp, Kind, Team } from '../ecs/components.ts';
import { fxRng } from '../core/rng.ts';
import { structureDefByIndex } from './content.ts';
import type { StructureDef } from './content.ts';
import type { Ctx } from './context.ts';

/** Seconds a structure flashes white after taking a hit (damageEnemy parity). */
const HIT_FLASH = 0.12;
/** Below this hp fraction a structure smoulders. */
const SMOKE_THRESHOLD = 0.3;
/** Expected smoke puffs per second while smouldering. Cosmetic — fxRng, never ctx.rng. */
const SMOKE_RATE = 3;

/**
 * Places a defendable structure: static (no Velocity — snapshotPositions makes
 * prev == current, so interpolation is free), player-team so weapons — which
 * only query enemyHash — can never friendly-fire it.
 */
export function spawnStructure(ctx: Ctx, def: StructureDef, x: number, y: number): number {
  const { world } = ctx;
  const id = world.create(Kind.Structure);
  if (id < 0) return -1;

  world.add(id, Comp.Transform | Comp.Sprite | Comp.Health | Comp.Collider);
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
  return id;
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
 * Per-tick upkeep: hit-flash decay, idle animation, smoulder fx below 30% hp.
 * Deals no damage, so its slot in the tick (after updateHazards, before the
 * pickup-index rebuild) has no enemyHash dependency — but it is mirrored
 * verbatim in the test harness all the same.
 */
export function updateStructures(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const ids = world.list(Kind.Structure);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    world.animTime[id] = world.animTime[id]! + dt;
    if (world.hitFlash[id]! > 0) world.hitFlash[id] = Math.max(0, world.hitFlash[id]! - dt);
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
