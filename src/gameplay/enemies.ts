import { AnimState, Behavior, Comp, Kind, Team } from '../ecs/components.ts';
import { TAU } from '../core/math.ts';
import { enemyDefByIndex } from './content.ts';
import { damagePlayer } from './damage.ts';
import { damageStructure } from './structures.ts';
import { separateCrowd } from './collision.ts';
import type { EnemyDef } from './content.ts';
import type { Ctx } from './context.ts';

/** Enemies further than this from the player are removed, drops and all. */
const CULL_DISTANCE = 620;
/** How fast knockback bleeds off, in 1/sec. */
const KNOCKBACK_DECAY = 9;
/** Strength of the crowd separation pass; 1 would fully resolve overlaps in one tick. */
const CROWD_STRENGTH = 0.45;
/** Siege enemies whose target's player gets this close switch back to the player. */
const PEEL_DISTANCE = 56;
/** Seconds between structure hits while parked at the wall. */
const SIEGE_HIT_INTERVAL = 0.8;

/** Charger phases, stored in `aiPhase`. */
const ChargePhase = {
  Approach: 0,
  Windup: 1,
  Dash: 2,
  Rest: 3,
} as const;

/**
 * Spawns an enemy at a world position, scaling its stats by elapsed-time
 * difficulty. Returns the entity id, or -1 if the pool is full.
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

/** Fires a projectile from a ranged enemy toward the player. */
function shootAtPlayer(ctx: Ctx, shooter: number, def: EnemyDef): void {
  const { world } = ctx;
  const player = ctx.player;
  if (player < 0) return;

  const id = world.create(Kind.Projectile);
  if (id < 0) return;

  const sx = world.x[shooter]!;
  const sy = world.y[shooter]!;
  const angle = Math.atan2(world.y[player]! - sy, world.x[player]! - sx);

  world.add(
    id,
    Comp.Transform | Comp.Velocity | Comp.Sprite | Comp.Collider | Comp.Damaging | Comp.Lifetime,
  );
  world.place(id, sx, sy);
  world.spriteId[id] = ctx.sprites.id(def.projectileSprite);
  // The bolt carries its shooter's content id, not a handle: the wisp may be
  // dead by the time this lands, and a death still has to be able to name it.
  world.defIndex[id] = def.index;
  world.radius[id] = def.projectileRadius;
  world.team[id] = Team.Enemy;
  world.damage[id] = def.projectileDamage * ctx.damageScale;
  world.vx[id] = Math.cos(angle) * def.projectileSpeed;
  world.vy[id] = Math.sin(angle) * def.projectileSpeed;
  world.lifetime[id] = def.projectileLifetime;
  world.maxLifetime[id] = def.projectileLifetime;
  world.rot[id] = angle;
}

/**
 * Runs enemy AI, movement, map collision, contact damage and culling.
 *
 * One pass over the enemy list handles all of it: at several hundred enemies the
 * cost is dominated by memory access, so touching each entity once and doing
 * everything while its data is warm beats separate systems per concern.
 */
export function updateEnemies(ctx: Ctx, dt: number): void {
  const { world, map } = ctx;
  const player = ctx.player;
  const hasPlayer = player >= 0 && world.isAlive(player);
  const px = hasPlayer ? world.x[player]! : 0;
  const py = hasPlayer ? world.y[player]! : 0;
  const playerRadius = hasPlayer ? world.radius[player]! : 0;

  const ids = world.list(Kind.Enemy);
  const cullDist2 = CULL_DISTANCE * CULL_DISTANCE;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const def = enemyDefByIndex(world.defIndex[id]!);

    const ex = world.x[id]!;
    const ey = world.y[id]!;

    // Siege targeting: a live target handle substitutes the structure's
    // position for the player's in everything below, so the existing melee
    // movement code marches at the wall unchanged. Handles, not ids: a
    // recycled id resolves to -1, never to the squatter.
    let tx = px;
    let ty = py;
    let structTarget = -1;
    if (world.targetHandle[id]! >= 0) {
      const sid = world.resolve(world.targetHandle[id]!);
      if (sid < 0) {
        // Structure destroyed (or its id recycled): resume the player hunt.
        world.targetHandle[id] = -1;
      } else if (
        hasPlayer &&
        (px - ex) * (px - ex) + (py - ey) * (py - ey) <= PEEL_DISTANCE * PEEL_DISTANCE
      ) {
        // The player closing in outranks the siege order — peeling enemies
        // off the gate is the intended counterplay. Cleared for good; the
        // next siege wave brings fresh attackers.
        world.targetHandle[id] = -1;
      } else {
        structTarget = sid;
        tx = world.x[sid]!;
        ty = world.y[sid]!;
      }
    }

    const dx = tx - ex;
    const dy = ty - ey;
    const d2 = dx * dx + dy * dy;

    // Culling is exempt while a live target holds this enemy on the field —
    // otherwise attackers evaporate the moment the player kites away.
    if (structTarget < 0 && !world.has(id, Comp.Persistent) && d2 > cullDist2) {
      // Silent removal — no drops, no kill credit. The spawner will replace it.
      world.destroy(id);
      continue;
    }

    const speed = world.speed[id]!;
    const dist = Math.sqrt(d2) || 1;
    const towardX = dx / dist;
    const towardY = dy / dist;

    if (world.aiTimer[id]! > 0) world.aiTimer[id] = world.aiTimer[id]! - dt;

    switch (world.behavior[id]) {
      case Behavior.Chase: {
        world.vx[id] = towardX * speed;
        world.vy[id] = towardY * speed;
        break;
      }

      case Behavior.Hopper: {
        // Alternates a fast lunge with a pause, which reads as hopping.
        if (world.aiTimer[id]! <= 0) {
          const resting = world.aiPhase[id] === 1;
          world.aiPhase[id] = resting ? 0 : 1;
          world.aiTimer[id] = resting ? def.hopTime : def.restTime;
        }
        if (world.aiPhase[id] === 0) {
          world.vx[id] = towardX * speed * 1.35;
          world.vy[id] = towardY * speed * 1.35;
        } else {
          world.vx[id] = 0;
          world.vy[id] = 0;
        }
        break;
      }

      case Behavior.Charger: {
        if (world.aiTimer[id]! <= 0) {
          switch (world.aiPhase[id]) {
            case ChargePhase.Approach:
              world.aiPhase[id] = ChargePhase.Windup;
              world.aiTimer[id] = def.windupTime;
              // Lock the dash heading at the end of the windup, giving the
              // player a readable window to step out of the line.
              world.orbitAngle[id] = Math.atan2(towardY, towardX);
              break;
            case ChargePhase.Windup:
              world.aiPhase[id] = ChargePhase.Dash;
              world.aiTimer[id] = def.dashTime;
              world.orbitAngle[id] = Math.atan2(towardY, towardX);
              break;
            case ChargePhase.Dash:
              world.aiPhase[id] = ChargePhase.Rest;
              world.aiTimer[id] = def.restTime;
              break;
            default:
              world.aiPhase[id] = ChargePhase.Approach;
              world.aiTimer[id] = 1.2;
              break;
          }
        }

        if (world.aiPhase[id] === ChargePhase.Dash) {
          const a = world.orbitAngle[id]!;
          world.vx[id] = Math.cos(a) * def.dashSpeed;
          world.vy[id] = Math.sin(a) * def.dashSpeed;
        } else if (world.aiPhase[id] === ChargePhase.Approach) {
          world.vx[id] = towardX * speed;
          world.vy[id] = towardY * speed;
        } else {
          // Windup and rest hold position, telegraphing the charge.
          world.vx[id] = 0;
          world.vy[id] = 0;
        }
        break;
      }

      case Behavior.Orbiter: {
        // Radial correction toward the preferred ring, plus a tangential term.
        const target = world.orbitRadius[id]!;
        const radialError = dist - target;
        const radial = Math.max(-1, Math.min(1, radialError / 40));
        const tangentX = -towardY * Math.sign(world.orbitSpeed[id]!);
        const tangentY = towardX * Math.sign(world.orbitSpeed[id]!);
        world.vx[id] = (towardX * radial + tangentX * 0.9) * speed;
        world.vy[id] = (towardY * radial + tangentY * 0.9) * speed;
        break;
      }

      case Behavior.Ranged: {
        const range = def.preferredRange;
        // Back off when too close, close in when too far, strafe in the band.
        if (dist < range * 0.75) {
          world.vx[id] = -towardX * speed;
          world.vy[id] = -towardY * speed;
        } else if (dist > range * 1.25) {
          world.vx[id] = towardX * speed;
          world.vy[id] = towardY * speed;
        } else {
          world.vx[id] = -towardY * speed * 0.5;
          world.vy[id] = towardX * speed * 0.5;
        }

        world.hitCooldown[id] = world.hitCooldown[id]! - dt;
        if (world.hitCooldown[id]! <= 0 && hasPlayer) {
          world.hitCooldown[id] = def.shootInterval;
          shootAtPlayer(ctx, id, def);
        }
        break;
      }

      case Behavior.Drifter:
        // Heading was fixed at spawn; nothing to steer.
        break;

      default:
        world.vx[id] = towardX * speed;
        world.vy[id] = towardY * speed;
        break;
    }

    // Parked at the wall: stop and swing on the hitCooldown cadence. Only
    // melee behaviors ever carry a target handle (updateSieges enforces it),
    // so this reuse of hitCooldown never collides with Ranged shooting. The
    // +0.5 slack keeps resolveSolids' exact-touch parking from starving the
    // attack at the float boundary.
    if (structTarget >= 0) {
      const touch = world.radius[id]! + world.radius[structTarget]! + 0.5;
      if (d2 <= touch * touch) {
        world.vx[id] = 0;
        world.vy[id] = 0;
        world.hitCooldown[id] = world.hitCooldown[id]! - dt;
        if (world.hitCooldown[id]! <= 0) {
          world.hitCooldown[id] = SIEGE_HIT_INTERVAL;
          damageStructure(ctx, structTarget, world.damage[id]!);
        }
      }
    }

    // Knockback decays independently of AI velocity, then both are integrated.
    const decay = Math.exp(-KNOCKBACK_DECAY * dt);
    world.kbx[id] = world.kbx[id]! * decay;
    world.kby[id] = world.kby[id]! * decay;

    let nx = ex + (world.vx[id]! + world.kbx[id]!) * dt;
    let ny = ey + (world.vy[id]! + world.kby[id]!) * dt;

    if (map.hasCollision) {
      [nx, ny] = map.resolveTiles(nx, ny, world.radius[id]!);
      [nx, ny] = map.resolveSolids(nx, ny, world.radius[id]!);
    }

    world.x[id] = nx;
    world.y[id] = ny;

    if (world.vx[id]! !== 0) world.facing[id] = world.vx[id]! < 0 ? -1 : 1;
    world.animTime[id] = world.animTime[id]! + dt;
    if (world.hitFlash[id]! > 0) world.hitFlash[id] = Math.max(0, world.hitFlash[id]! - dt);

    // Contact damage. The player's i-frames stop this from firing every tick,
    // so no per-enemy cooldown is needed.
    if (hasPlayer) {
      const touch = playerRadius + world.radius[id]!;
      const cdx = px - nx;
      const cdy = py - ny;
      if (cdx * cdx + cdy * cdy <= touch * touch) {
        damagePlayer(ctx, world.damage[id]!, id);
      }
    }
  }

  // Crowd separation runs after movement so it corrects the final positions.
  separateCrowd(ctx.world, ids, ctx.enemyHash, ctx.scratch, CROWD_STRENGTH);
}

/**
 * Picks a spawn position on a ring outside the visible area, so enemies always
 * walk in from off screen rather than materialising in view.
 */
export function offscreenSpawnPoint(ctx: Ctx, ringRadius = 330): [number, number] {
  const { world, map } = ctx;
  const player = ctx.player;
  const px = player >= 0 ? world.x[player]! : map.spawnX;
  const py = player >= 0 ? world.y[player]! : map.spawnY;

  const angle = ctx.rng.next() * TAU;
  const r = ringRadius * ctx.rng.range(1, 1.12);
  let x = px + Math.cos(angle) * r;
  let y = py + Math.sin(angle) * r;

  const b = map.bounds;
  if (b) {
    // On a bounded map the ring may fall outside the arena; fold it back in.
    const margin = 16;
    x = Math.max(b.left + margin, Math.min(b.right - margin, x));
    y = Math.max(b.top + margin, Math.min(b.bottom - margin, y));
  }

  return [x, y];
}

/** Updates enemy projectiles: movement, lifetime, and hitting the player. */
export function updateEnemyProjectiles(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const player = ctx.player;
  const hasPlayer = player >= 0 && world.isAlive(player);
  const px = hasPlayer ? world.x[player]! : 0;
  const py = hasPlayer ? world.y[player]! : 0;
  const playerRadius = hasPlayer ? world.radius[player]! : 0;

  const ids = world.list(Kind.Projectile);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (world.team[id] !== Team.Enemy) continue;

    world.lifetime[id] = world.lifetime[id]! - dt;
    if (world.lifetime[id]! <= 0) {
      world.destroy(id);
      continue;
    }

    const nx = world.x[id]! + world.vx[id]! * dt;
    const ny = world.y[id]! + world.vy[id]! * dt;
    world.x[id] = nx;
    world.y[id] = ny;
    world.animTime[id] = world.animTime[id]! + dt;

    if (!hasPlayer) continue;
    const touch = playerRadius + world.radius[id]!;
    const dx = px - nx;
    const dy = py - ny;
    if (dx * dx + dy * dy <= touch * touch) {
      if (damagePlayer(ctx, world.damage[id]!, id)) {
        ctx.fx.burst(nx, ny, 6, 70, '#ff6b8a', 0.25, 1);
        world.destroy(id);
      }
    }
  }
}
