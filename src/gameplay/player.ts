import { AnimState, Comp, Kind } from '../ecs/components.ts';
import type { Input } from '../core/input.ts';
import { screenDirToWorld } from '../render/iso.ts';
import { BLOOD_CONFIG } from './content.ts';
import type { Ctx } from './context.ts';

export function spawnPlayer(ctx: Ctx, x: number, y: number): number {
  const { world, run } = ctx;
  const id = world.create(Kind.Player);
  if (id < 0) throw new Error('failed to spawn player: entity pool exhausted');

  world.add(id, Comp.Transform | Comp.Velocity | Comp.Sprite | Comp.Health | Comp.Collider);
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(run.character.sprite);
  world.radius[id] = run.character.radius;
  world.maxHp[id] = run.stats.maxHp;
  world.hp[id] = run.stats.maxHp;
  world.team[id] = 0;
  return id;
}

/**
 * Moves the player, resolves the map, and ticks health regeneration.
 *
 * Movement is applied before collision resolution rather than being predicted,
 * because at 60Hz the per-tick step is a fraction of a tile and the resolve pass
 * cannot tunnel.
 */
export function updatePlayer(ctx: Ctx, dt: number, input: Input): void {
  const { world, run, map } = ctx;
  const id = ctx.player;
  if (id < 0 || !world.isAlive(id)) return;

  // Frenzy movement bonus is read-side, same rule as effectiveStats.
  const frenzySpeed = run.frenzyT > 0 ? BLOOD_CONFIG.frenzy.moveSpeedMult : 1;
  const speed = run.stats.moveSpeed * frenzySpeed;
  // The keys and the joystick are read in the frame the player can see, so they
  // are rotated onto the plane before they become velocity. Feeding the raw
  // axes straight in is what made every direction come out diagonal.
  const [dirX, dirY] = screenDirToWorld(input.axisX, input.axisY);
  const vx = dirX * speed;
  const vy = dirY * speed;
  world.vx[id] = vx;
  world.vy[id] = vy;

  const moving = vx !== 0 || vy !== 0;
  if (moving) {
    // Aim is a world direction — directional weapons fire along it, and they
    // live on the plane, not on the screen.
    ctx.aimX = dirX;
    ctx.aimY = dirY;
    // Only flip on horizontal input, so walking straight up or down keeps
    // whichever way the sprite was already facing.
    if (input.axisX !== 0) world.facing[id] = input.axisX < 0 ? -1 : 1;
  }

  let nx = world.x[id]! + vx * dt;
  let ny = world.y[id]! + vy * dt;

  const radius = world.radius[id]!;
  if (map.hasCollision) {
    [nx, ny] = map.resolveTiles(nx, ny, radius);
    [nx, ny] = map.resolveSolids(nx, ny, radius);
  }
  [nx, ny] = map.clampToBounds(nx, ny, radius);

  world.x[id] = nx;
  world.y[id] = ny;

  // Animation. A hit outranks movement for as long as the white flash lasts, so
  // the flinch and the flash are one event rather than two that can disagree.
  // Gated on the character owning a flinch: without one, Hurt resolves to the
  // standing pose and being hit mid-run would stop the legs dead.
  const flinching = world.hitFlash[id]! > 0 && ctx.sprites.hasOwn(world.spriteId[id]!, AnimState.Hurt);
  const nextState = flinching ? AnimState.Hurt : moving ? AnimState.Walk : AnimState.Idle;
  if (world.animState[id] !== nextState) {
    world.animState[id] = nextState;
    world.animTime[id] = 0;
  } else {
    world.animTime[id] = world.animTime[id]! + dt;
  }

  if (world.iframe[id]! > 0) world.iframe[id] = Math.max(0, world.iframe[id]! - dt);
  if (world.hitFlash[id]! > 0) world.hitFlash[id] = Math.max(0, world.hitFlash[id]! - dt);

  // Regeneration. Applied continuously rather than in ticks so a fractional
  // recovery stat still does something.
  if (run.stats.recovery > 0 && world.hp[id]! < run.stats.maxHp) {
    world.hp[id] = Math.min(run.stats.maxHp, world.hp[id]! + run.stats.recovery * dt);
  }

  // Keep the health cap in sync when a passive raises it mid-run.
  world.maxHp[id] = run.stats.maxHp;
}

/**
 * Renders the player. Kept out of the generic sprite pass because the
 * invulnerability blink needs per-frame alpha the draw list doesn't model.
 */
export function playerAlpha(ctx: Ctx): number {
  const id = ctx.player;
  if (id < 0) return 1;
  const iframe = ctx.world.iframe[id]!;
  if (iframe <= 0) return 1;
  // ~10Hz blink while invulnerable.
  return Math.floor(iframe * 20) % 2 === 0 ? 0.4 : 1;
}
