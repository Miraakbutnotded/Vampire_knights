import { AnimState, Behavior, ChargePhase, Comp, FusePhase, Kind, Team } from '../ecs/components.ts';

import type { EnemyDef } from './content.ts';
import type { Ctx } from './context.ts';

/**
 * Getting an enemy into the world.
 *
 * This is a deliberate leaf: it imports content and the ECS and nothing else in
 * `gameplay/`. `enemies.ts` cannot host it, because `enemies.ts` imports
 * `damage.ts` (for contact damage) while `damage.ts` needs to spawn enemies
 * (a splitter breaking apart on death) — and putting both in one module would
 * make `gameplay/` cyclic for the first time. Splitting the spawn path out
 * keeps the import graph a DAG, so the pair reads as
 * `enemies -> damage -> spawn` rather than a knot.
 *
 * `enemies.ts` re-exports `spawnEnemy`, so existing call sites are unaffected.
 */
export function spawnEnemy(ctx: Ctx, def: EnemyDef, x: number, y: number): number {
  const { world } = ctx;
  const id = world.create(Kind.Enemy);
  if (id < 0) return -1;

  let comps =
    Comp.Transform |
    Comp.Velocity |
    Comp.Sprite |
    Comp.Health |
    Comp.Collider |
    Comp.Damaging |
    Comp.Pushable;
  if (def.behavior === Behavior.Ranged) comps |= Comp.Shooter;
  // Bosses and elites are expensive to earn, so they never get culled for
  // wandering off screen.
  if (def.boss || def.elite) comps |= Comp.Persistent;
  world.add(id, comps);

  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(def.sprite);
  world.radius[id] = def.radius;
  world.defIndex[id] = def.index;
  world.team[id] = Team.Enemy;
  world.behavior[id] = def.behavior;
  world.animState[id] = AnimState.Walk;
  world.animTime[id] = ctx.rng.range(0, 1);

  const hp = Math.max(1, Math.round(def.hp * ctx.hpScale));
  world.maxHp[id] = hp;
  world.hp[id] = hp;
  world.damage[id] = def.damage * ctx.damageScale;
  world.speed[id] = def.speed * ctx.speedScale;

  switch (def.behavior) {
    case Behavior.Orbiter:
      // Randomised spin direction so wraiths don't all circle in formation.
      world.orbitSpeed[id] = def.orbitSpeed * ctx.rng.sign();
      world.orbitRadius[id] = def.orbitRadius;
      break;
    case Behavior.Drifter: {
      // Locked-in heading, aimed roughly at the player so it crosses their path.
      const player = ctx.player;
      const tx = player >= 0 ? world.x[player]! : 0;
      const ty = player >= 0 ? world.y[player]! : 0;
      const angle = Math.atan2(ty - y, tx - x) + ctx.rng.range(-0.5, 0.5);
      world.vx[id] = Math.cos(angle) * world.speed[id]!;
      world.vy[id] = Math.sin(angle) * world.speed[id]!;
      break;
    }
    case Behavior.Hopper:
      world.aiPhase[id] = 0;
      world.aiTimer[id] = ctx.rng.range(0, def.hopTime);
      break;
    case Behavior.Charger:
      world.aiPhase[id] = ChargePhase.Approach;
      world.aiTimer[id] = ctx.rng.range(0.5, 1.4);
      break;
    case Behavior.Exploder:
      // Unlit. The fuse is armed by proximity, never by the clock, so a fusebearer
      // that never reaches anything never becomes dangerous.
      world.aiPhase[id] = FusePhase.Approach;
      world.aiTimer[id] = 0;
      break;
    case Behavior.Ranged:
      world.hitCooldown[id] = ctx.rng.range(0.5, def.shootInterval);
      break;
    default:
      break;
  }

  if (def.boss) {
    ctx.bus.emit('boss:spawned', { name: def.name });
    ctx.camera.shake(4, 0.5);
    ctx.fx.shockwave(x, y, '#ff9ec4', 0.8, 16);
  }

  return id;
}

/** How far under a living entity at the same y a body lies. */
const CORPSE_DEPTH_BIAS = -2;

/**
 * Leaves `from`'s body behind to play out its death animation.
 *
 * Called from killEnemy while the dying entity is still readable — destruction
 * is deferred to flush(), so its position, sprite and facing are all still
 * there to copy. The corpse itself carries no collider, no health and no team:
 * it exists only to be drawn, and it is destroyed when the animation ends.
 *
 * Returns -1 when the sprite has no death art of its own. `sprites.anim` falls
 * back to Idle in that case, and a frozen *standing* sprite lying on the ground
 * reads as a bug rather than as a body, so it is better to keep the old
 * behaviour of vanishing outright.
 */
export function spawnCorpse(ctx: Ctx, from: number): number {
  const { world } = ctx;
  const spriteId = world.spriteId[from]!;
  const death = ctx.sprites.anim(spriteId, AnimState.Death);
  if (death === ctx.sprites.anim(spriteId, AnimState.Idle)) return -1;

  const id = world.create(Kind.Corpse);
  if (id < 0) return -1;

  world.add(id, Comp.Transform | Comp.Sprite | Comp.Lifetime);
  world.place(id, world.x[from]!, world.y[from]!);
  world.spriteId[id] = spriteId;
  world.animState[id] = AnimState.Death;
  world.animTime[id] = 0;
  world.facing[id] = world.facing[from]!;
  world.scale[id] = world.scale[from]!;
  // Bodies lie under whatever is still standing on the same row.
  world.drawBias[id] = CORPSE_DEPTH_BIAS;
  world.lifetime[id] = death.duration;
  world.maxLifetime[id] = death.duration;
  return id;
}
