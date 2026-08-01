import { Kind } from '../ecs/components.ts';
import { VIEW_H, VIEW_W } from '../render/renderer.ts';
import { enemyDefByIndex } from './content.ts';
import { grantBlood, spawnBloodVial, spawnCoin, spawnChest, spawnGem, spawnMagnet, spawnMeat } from './pickups.ts';
import type { Ctx } from './context.ts';

/**
 * Half-extents of the ground an attack can reach, plus a sprite's worth of
 * slack so an enemy leaning into frame is already fair game.
 *
 * Enemies arrive on a ring wider than the view, so without this a stray knife
 * kills things you cannot see and drops their gems out there with them — the
 * arena quietly asks you to walk into the dark after loot you never earned
 * sight of. Anything that can hurt you closes well inside this box (the
 * furthest is the acolyte's censer at 110 units), so nothing can shoot from a
 * place you are unable to answer.
 */
const ENGAGE_HALF_W = VIEW_W / 2 + 24;
const ENGAGE_HALF_H = VIEW_H / 2 + 24;

/**
 * Whether an enemy is on screen, and so a fair target for the player's own
 * weapons. Emplacements are exempt: a watchtower's whole job is to hold a wall
 * you have walked away from, so it answers to its own range instead.
 *
 * Deliberately measured from the camera rather than the player: on a bounded
 * map the camera stops at the wall while the player keeps walking, and what
 * the player can see is what the camera frames.
 */
export function withinEngagement(ctx: Ctx, id: number): boolean {
  const { world, camera } = ctx;
  return (
    Math.abs(world.x[id]! - camera.x) <= ENGAGE_HALF_W &&
    Math.abs(world.y[id]! - camera.y) <= ENGAGE_HALF_H
  );
}

/** Seconds of invulnerability granted after the player is hit. */
export const PLAYER_IFRAME = 0.45;
/** Seconds an enemy sprite flashes white after taking damage. */
const HIT_FLASH = 0.12;

/** Base drop chances, before the player's luck multiplier. */
/** Halved when the blood economy landed: Feast is the reliable sustain now. */
const MEAT_CHANCE = 0.004;
const MAGNET_CHANCE = 0.003;

/**
 * Applies damage to an enemy, including crit roll, feedback and knockback.
 * Returns the damage actually dealt, or 0 if the target was already gone.
 *
 * Callers pass the damage source position so knockback pushes away from it
 * rather than in an arbitrary direction.
 */
export function damageEnemy(
  ctx: Ctx,
  id: number,
  amount: number,
  knockback: number,
  srcX: number,
  srcY: number,
  canCrit = true,
): number {
  const { world, run, fx } = ctx;
  if (!world.isAlive(id) || world.kind[id] !== Kind.Enemy) return 0;

  let dealt = amount;
  let crit = false;
  if (canCrit && run.stats.critChance > 0 && ctx.rng.chance(run.stats.critChance)) {
    crit = true;
    dealt *= run.stats.critMult;
  }

  world.hp[id] = world.hp[id]! - dealt;
  world.hitFlash[id] = HIT_FLASH;

  const ex = world.x[id]!;
  const ey = world.y[id]!;
  fx.damageNumber(ex, ey - world.radius[id]! - 4, dealt, crit);

  if (knockback > 0) {
    const def = enemyDefByIndex(world.defIndex[id]!);
    const resist = 1 - def.knockbackResist;
    if (resist > 0) {
      const dx = ex - srcX;
      const dy = ey - srcY;
      const d = Math.hypot(dx, dy) || 1;
      const impulse = knockback * resist;
      world.kbx[id] = world.kbx[id]! + (dx / d) * impulse;
      world.kby[id] = world.kby[id]! + (dy / d) * impulse;
    }
  }

  if (world.hp[id]! <= 0) {
    killEnemy(ctx, id);
  } else {
    fx.burst(ex, ey, crit ? 5 : 2, crit ? 70 : 40, crit ? '#ffd23f' : '#ffdcc0', 0.22, 1);
  }

  return dealt;
}

/** Removes an enemy, spawning its drops and firing the kill event. */
export function killEnemy(ctx: Ctx, id: number): void {
  const { world, run, fx, bus } = ctx;
  if (!world.isAlive(id)) return;

  const def = enemyDefByIndex(world.defIndex[id]!);
  const x = world.x[id]!;
  const y = world.y[id]!;

  run.kills++;
  grantBlood(ctx, def.blood * run.stats.bloodGain);
  bus.emit('enemy:killed', { x, y, kills: run.kills });

  if (def.boss) {
    fx.shockwave(x, y, '#ff9ec4', 0.7, 14);
    fx.burst(x, y, 46, 150, '#ff9ec4', 0.8, 2);
    ctx.camera.shake(5, 0.5);
  } else if (def.elite) {
    fx.shockwave(x, y, '#ffb08a', 0.5, 9);
    fx.burst(x, y, 22, 110, '#ffb08a', 0.6, 2);
    ctx.camera.shake(2.5, 0.3);
  } else {
    fx.burst(x, y, 6, 65, '#e8c0b0', 0.35, 1);
  }

  // Elites and bosses additionally leave a Blood Vial behind.
  if (def.elite || def.boss) spawnBloodVial(ctx, x, y - 2);

  spawnGem(ctx, x, y, def.xp);

  if (def.coinChance > 0 && ctx.rng.chance(def.coinChance)) {
    spawnCoin(ctx, x + ctx.rng.range(-5, 5), y + ctx.rng.range(-5, 5), def.coin);
  }

  const luck = run.stats.luck;
  if (ctx.rng.chance(MEAT_CHANCE * luck)) {
    spawnMeat(ctx, x, y, Math.round(run.stats.maxHp * 0.2));
  } else if (ctx.rng.chance(MAGNET_CHANCE * luck)) {
    spawnMagnet(ctx, x, y);
  }

  if (def.dropsChest) {
    spawnChest(ctx, x, y + 4);
  }

  world.destroy(id);
}

/**
 * Damages the player, respecting armour and invulnerability frames.
 * Returns true if the hit landed.
 *
 * Armour is flat reduction with a floor of 1, so stacking it stays valuable
 * against weak enemies without ever making the player literally untouchable.
 */
export function damagePlayer(ctx: Ctx, amount: number): boolean {
  const { world, run, fx, bus } = ctx;
  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) return false;
  if (world.iframe[player]! > 0) return false;

  const reduced = Math.max(1, amount - run.stats.armor);
  world.hp[player] = world.hp[player]! - reduced;
  world.iframe[player] = PLAYER_IFRAME;
  world.hitFlash[player] = 0.2;

  const px = world.x[player]!;
  const py = world.y[player]!;
  fx.damageNumber(px, py - 18, reduced, false);
  fx.burst(px, py, 8, 80, '#ff6b8a', 0.3, 1);
  ctx.camera.shake(3, 0.25);

  bus.emit('player:damaged', {
    amount: reduced,
    hp: Math.max(0, world.hp[player]!),
    maxHp: run.stats.maxHp,
  });

  if (world.hp[player]! <= 0) {
    if (run.revivesLeft > 0) {
      run.revivesLeft--;
      world.hp[player] = run.stats.maxHp;
      world.iframe[player] = 2.5;
      fx.shockwave(px, py, '#ffffff', 0.9, 20);
      fx.floatingText(px, py - 26, '+', '#ffffff', 3);
      ctx.camera.shake(7, 0.6);
      // Clear the immediate threat so the revive isn't spent instantly.
      clearNearbyEnemies(ctx, px, py, 90);
    } else {
      world.hp[player] = 0;
      bus.emit('player:died', { survivedSeconds: run.time, kills: run.kills });
    }
  }

  return true;
}

/** Kills every enemy within `radius`. Used by revives and could back a bomb item. */
export function clearNearbyEnemies(ctx: Ctx, x: number, y: number, radius: number): void {
  const found = ctx.enemyHash.query(x, y, radius, ctx.scratch);
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!ctx.world.isAlive(id)) continue;
    const def = enemyDefByIndex(ctx.world.defIndex[id]!);
    // Bosses shrug this off; wiping one with a revive would be anticlimactic.
    if (def.boss) continue;
    const dx = ctx.world.x[id]! - x;
    const dy = ctx.world.y[id]! - y;
    if (dx * dx + dy * dy > radius * radius) continue;
    killEnemy(ctx, id);
  }
}
