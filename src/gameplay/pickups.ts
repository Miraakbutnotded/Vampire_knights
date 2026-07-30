import { Comp, Kind } from '../ecs/components.ts';
import { damp } from '../core/math.ts';
import { BLOOD_CONFIG } from './content.ts';
import type { Ctx } from './context.ts';

export const PickupKind = {
  Gem: 0,
  Coin: 1,
  Meat: 2,
  Magnet: 3,
  Chest: 4,
  BloodVial: 5,
} as const;
export type PickupKind = (typeof PickupKind)[keyof typeof PickupKind];

/** Above this many pickups on the ground, new gems merge into nearby ones. */
const GEM_MERGE_THRESHOLD = 120;
/** How close an existing gem must be to absorb a new one. */
const GEM_MERGE_RADIUS = 26;

/** Speed a magnetised pickup homes in at, and how sharply it accelerates. */
const MAGNET_SPEED = 210;
const MAGNET_ACCEL = 9;

/** Chests always grant at least this many upgrades, sometimes more. */
const CHEST_MIN_UPGRADES = 1;
const CHEST_MAX_UPGRADES = 3;

function gemSprite(value: number): string {
  if (value >= 15) return 'gem_large';
  if (value >= 5) return 'gem_med';
  return 'gem_small';
}

function spawnPickup(
  ctx: Ctx,
  kind: PickupKind,
  spriteName: string,
  x: number,
  y: number,
  value: number,
  radius: number,
): number {
  const { world } = ctx;
  const id = world.create(Kind.Pickup);
  if (id < 0) return -1;

  world.add(id, Comp.Transform | Comp.Sprite | Comp.Collider | Comp.Magnetic);
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(spriteName);
  world.radius[id] = radius;
  world.defIndex[id] = kind;
  world.value[id] = value;
  // Spread the animation phase so a pile of gems doesn't pulse in lockstep.
  world.animTime[id] = ctx.rng.range(0, 1);
  return id;
}

/**
 * Drops an experience gem.
 *
 * Once the ground is crowded, a new gem is folded into a nearby one instead of
 * adding an entity. The player loses nothing — the value carries over, and the
 * sprite upgrades to the higher tier — but entity count and draw calls stay flat
 * during the late-game swarms where they would otherwise balloon.
 */
export function spawnGem(ctx: Ctx, x: number, y: number, value: number): number {
  const { world } = ctx;

  if (world.list(Kind.Pickup).length > GEM_MERGE_THRESHOLD) {
    const found = ctx.pickupHash.query(x, y, GEM_MERGE_RADIUS, ctx.scratchInner);
    for (let i = 0; i < found; i++) {
      const other = ctx.scratchInner[i]!;
      if (!world.isAlive(other) || world.defIndex[other] !== PickupKind.Gem) continue;
      // The pickup index was built earlier in the tick, so an id here may have
      // been recycled into a different gem elsewhere. Re-check the distance
      // against live positions, or experience could teleport across the map.
      const dx = world.x[other]! - x;
      const dy = world.y[other]! - y;
      if (dx * dx + dy * dy > GEM_MERGE_RADIUS * GEM_MERGE_RADIUS) continue;

      const merged = world.value[other]! + value;
      world.value[other] = merged;
      world.spriteId[other] = ctx.sprites.id(gemSprite(merged));
      return other;
    }
  }

  return spawnPickup(ctx, PickupKind.Gem, gemSprite(value), x, y, value, 6);
}

export function spawnCoin(ctx: Ctx, x: number, y: number, value: number): number {
  return spawnPickup(ctx, PickupKind.Coin, 'coin', x, y, value, 6);
}

export function spawnMeat(ctx: Ctx, x: number, y: number, healAmount: number): number {
  return spawnPickup(ctx, PickupKind.Meat, 'meat', x, y, healAmount, 7);
}

export function spawnMagnet(ctx: Ctx, x: number, y: number): number {
  return spawnPickup(ctx, PickupKind.Magnet, 'magnet', x, y, 0, 8);
}

export function spawnChest(ctx: Ctx, x: number, y: number): number {
  // Chests are worth walking to, so they ignore the magnet and sit still.
  const id = spawnPickup(ctx, PickupKind.Chest, 'chest', x, y, 0, 10);
  if (id >= 0) ctx.world.remove(id, Comp.Magnetic);
  return id;
}

/** Elite/boss Blood Vial, worth `blood.json` vialValue. Magnet-attracted like gems. */
export function spawnBloodVial(ctx: Ctx, x: number, y: number): number {
  return spawnPickup(ctx, PickupKind.BloodVial, 'blood_vial', x, y, BLOOD_CONFIG.vialValue, 7);
}

/**
 * Moves pickups toward the player when in magnet range and collects the ones
 * that touch. Also handles the "collect everything" magnet item.
 */
export function updatePickups(ctx: Ctx, dt: number): void {
  const { world, run } = ctx;
  const player = ctx.player;
  if (player < 0) return;

  const px = world.x[player]!;
  const py = world.y[player]!;
  const playerRadius = world.radius[player]!;
  const magnetRange = run.stats.magnet;

  const ids = world.list(Kind.Pickup);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    world.animTime[id] = world.animTime[id]! + dt;

    const dx = px - world.x[id]!;
    const dy = py - world.y[id]!;
    const d2 = dx * dx + dy * dy;

    const pickRange = playerRadius + world.radius[id]!;
    if (d2 <= pickRange * pickRange) {
      collect(ctx, id);
      continue;
    }

    if (!world.has(id, Comp.Magnetic)) continue;

    const attracted = world.aiPhase[id]! > 0 || d2 <= magnetRange * magnetRange;
    if (!attracted) {
      // Idle drift decay, so a gem knocked loose by a death settles.
      world.vx[id] = damp(world.vx[id]!, 0, 6, dt);
      world.vy[id] = damp(world.vy[id]!, 0, 6, dt);
    } else {
      // Latch on once attracted, so a gem doesn't stall at the edge of range
      // when the player turns away mid-flight.
      world.aiPhase[id] = 1;
      const d = Math.sqrt(d2) || 1;
      const targetVx = (dx / d) * MAGNET_SPEED;
      const targetVy = (dy / d) * MAGNET_SPEED;
      world.vx[id] = damp(world.vx[id]!, targetVx, MAGNET_ACCEL, dt);
      world.vy[id] = damp(world.vy[id]!, targetVy, MAGNET_ACCEL, dt);
    }

    world.x[id] = world.x[id]! + world.vx[id]! * dt;
    world.y[id] = world.y[id]! + world.vy[id]! * dt;
  }
}

function collect(ctx: Ctx, id: number): void {
  const { world, run, fx, bus } = ctx;
  const x = world.x[id]!;
  const y = world.y[id]!;
  const value = world.value[id]!;

  switch (world.defIndex[id]) {
    case PickupKind.Gem: {
      const before = run.level;
      run.gainXp(value);
      bus.emit('xp:gained', {
        amount: value,
        xp: run.xp,
        needed: run.xpNeeded,
        level: run.level,
      });
      if (run.level > before) {
        bus.emit('player:levelup', { level: run.level });
        fx.shockwave(x, y, '#ffe9a8', 0.45, 8);
      }
      fx.particle(x, y, 0, -40, 0.25, 1, '#9fe8ff');
      break;
    }
    case PickupKind.Coin: {
      const gained = run.gainGold(value);
      bus.emit('gold:gained', { amount: gained, total: run.gold });
      fx.floatingText(x, y - 6, `+${gained}`, '#ffd23f');
      break;
    }
    case PickupKind.Meat: {
      healPlayer(ctx, value);
      break;
    }
    case PickupKind.BloodVial: {
      // Uncapped: a vial is a one-off elite reward, so the per-second intake
      // window must not shave it down to a fraction of its advertised value.
      const granted = grantBlood(ctx, value, true);
      if (granted > 0) fx.floatingText(x, y - 6, `+${Math.round(granted)}`, '#d94a5e');
      fx.burst(x, y, 8, 60, '#d94a5e', 0.3, 1);
      break;
    }
    case PickupKind.Magnet: {
      // Pull in every gem on the field by latching them all at once.
      const gems = world.list(Kind.Pickup);
      for (const gem of gems) {
        if (world.defIndex[gem] === PickupKind.Gem) world.aiPhase[gem] = 1;
      }
      fx.shockwave(x, y, '#7dd3fc', 0.5, 10);
      fx.floatingText(x, y - 10, '+', '#7dd3fc', 2);
      break;
    }
    case PickupKind.Chest: {
      const rolls = ctx.rng.int(CHEST_MIN_UPGRADES, CHEST_MAX_UPGRADES);
      run.pendingLevelUps += rolls;
      const gold = run.gainGold(ctx.rng.int(10, 30));
      bus.emit('gold:gained', { amount: gold, total: run.gold });
      bus.emit('player:levelup', { level: run.level });
      fx.shockwave(x, y, '#ffd23f', 0.6, 12);
      fx.burst(x, y, 18, 90, '#ffe9a8', 0.6, 2);
      break;
    }
    default:
      break;
  }

  world.destroy(id);
}

/**
 * Heals the player, clamped to max health, with feedback. Shared with
 * weapons/events. Returns the health actually restored — overheal is dropped,
 * so callers that report the heal (the Feast payload) show the real number
 * rather than what they asked for. Callers that don't care may ignore it.
 */
export function healPlayer(ctx: Ctx, amount: number): number {
  const { world, run, fx, bus } = ctx;
  const player = ctx.player;
  if (player < 0 || amount <= 0) return 0;

  const before = world.hp[player]!;
  const healed = Math.min(run.stats.maxHp, before + amount);
  world.hp[player] = healed;
  const delta = healed - before;
  if (delta <= 0) return 0;

  fx.floatingText(world.x[player]!, world.y[player]! - 14, `+${Math.round(delta)}`, '#7ef0a0');
  bus.emit('player:healed', { amount: delta, hp: healed, maxHp: run.stats.maxHp });
  return delta;
}

/**
 * Grants blood through the Run's intake and reports it on the bus.
 * Lives here beside healPlayer so kills and Blood Vial pickups share one path.
 * `uncapped` forwards to Run.gainBlood: burst rewards skip the per-second
 * window, everything else pays into it.
 */
export function grantBlood(ctx: Ctx, amount: number, uncapped = false): number {
  const { run, bus } = ctx;
  const wasReady = run.blood >= BLOOD_CONFIG.threshold;
  const granted = run.gainBlood(amount, uncapped);
  if (granted <= 0) return 0;
  bus.emit('blood:gained', { amount: granted, blood: run.blood, max: run.bloodMax });
  if (!wasReady && run.blood >= BLOOD_CONFIG.threshold) bus.emit('blood:ready', undefined);
  return granted;
}
