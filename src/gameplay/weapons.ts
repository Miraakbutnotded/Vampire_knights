import { Comp, Kind, Team } from '../ecs/components.ts';
import { TAU } from '../core/math.ts';
import { BLOOD_CONFIG, WeaponBehavior, weaponStatsAtLevel } from './content.ts';
import { damageEnemy, withinEngagement } from './damage.ts';
import type { WeaponStats } from './content.ts';
import type { Ctx } from './context.ts';
import type { OwnedWeapon, Run } from './run.ts';

/** Radius searched when a weapon needs a target. Roughly the visible area. */
const TARGET_RANGE = 300;
/** Hazards and projectiles further than this from the player are dropped. */
const DESPAWN_DISTANCE = 700;

/**
 * Folds the player's global stats into a weapon's own numbers.
 *
 * Weapon JSON stores raw values; the player's passives scale them here, once per
 * shot, so content stays readable and there is a single place where "+10% might"
 * is defined to mean "multiply weapon damage".
 */
export function effectiveStats(run: Run, weapon: OwnedWeapon): WeaponStats {
  const base = weaponStatsAtLevel(weapon.def, weapon.level);
  const s = run.stats;
  const isAura = weapon.def.behavior === WeaponBehavior.Aura;
  // Frenzy is a read-side buff keyed off run.frenzyT. run.stats itself is
  // never touched, preserving the recompute-only-on-loadout-change invariant.
  const frenzied = run.frenzyT > 0;
  const frenzyDamage = frenzied ? BLOOD_CONFIG.frenzy.mightMult : 1;
  const frenzyCooldown = frenzied ? BLOOD_CONFIG.frenzy.cooldownMult : 1;

  return {
    damage: base.damage * s.might * frenzyDamage,
    cooldown: Math.max(0.08, base.cooldown * s.cooldown * frenzyCooldown),
    // The +projectile stat is meaningless for a single persistent ring.
    count: Math.max(1, Math.round(base.count + (isAura ? 0 : s.amount))),
    // -1 is a sentinel for "unlimited", not a number to add to: a weapon that
    // already passes through everything gains nothing from more pierce.
    pierce: base.pierce < 0 ? -1 : base.pierce + s.pierce,
    area: base.area * s.area,
    duration: base.duration * s.duration,
    knockback: base.knockback,
    speed: base.speed * s.projectileSpeed,
    lifetime: base.lifetime * s.duration,
    // Faster ticking is a buff, so cooldown reduction shortens it too —
    // including the Frenzy factor, so aura weapons (interval-driven,
    // cooldown-exempt in updateWeapons) get the same ×0.75 cadence buff.
    interval: Math.max(0.06, base.interval * s.cooldown * frenzyCooldown),
    radius: base.radius * base.area * s.area,
    orbitSpeed: base.orbitSpeed,
    spawnRadius: base.spawnRadius,
    reach: base.reach * base.area * s.area,
    spread: base.spread,
    turnRate: base.turnRate,
  };
}

/** Ticks every owned weapon and fires the ones that are ready. */
export function updateWeapons(ctx: Ctx, dt: number): void {
  const player = ctx.player;
  if (player < 0 || !ctx.world.isAlive(player)) return;

  for (const weapon of ctx.run.weapons) {
    const stats = effectiveStats(ctx.run, weapon);

    // The warding circle is always on: it maintains one persistent entity
    // rather than firing on a cooldown.
    if (weapon.def.behavior === WeaponBehavior.Aura) {
      maintainAura(ctx, weapon, stats);
      continue;
    }

    weapon.cooldown -= dt;
    if (weapon.cooldown > 0) continue;
    weapon.cooldown = stats.cooldown;
    fire(ctx, weapon, stats);
  }
}

function fire(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  switch (weapon.def.behavior) {
    case WeaponBehavior.Arc:
      fireArc(ctx, weapon, stats);
      break;
    case WeaponBehavior.Homing:
      fireHoming(ctx, weapon, stats);
      break;
    case WeaponBehavior.Straight:
      fireStraight(ctx, weapon, stats);
      break;
    case WeaponBehavior.Orbit:
      fireOrbit(ctx, weapon, stats);
      break;
    case WeaponBehavior.Drop:
      fireDrop(ctx, weapon, stats);
      break;
    case WeaponBehavior.Nova:
      fireNova(ctx, weapon, stats);
      break;
    case WeaponBehavior.Lightning:
      fireLightning(ctx, weapon, stats);
      break;
    case WeaponBehavior.Tether:
      fireTether(ctx, weapon, stats);
      break;
    case WeaponBehavior.Chain:
      fireChain(ctx, weapon, stats);
      break;
    case WeaponBehavior.Trail:
      fireTrail(ctx, weapon, stats);
      break;
    case WeaponBehavior.Slam:
      fireSlam(ctx, weapon, stats);
      break;
    case WeaponBehavior.Spiral:
      fireSpiral(ctx, weapon, stats);
      break;
    default:
      break;
  }
}

// --- shared spawn helpers -------------------------------------------------

export function spawnProjectile(
  ctx: Ctx,
  spriteName: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  stats: WeaponStats,
  homing: boolean,
): number {
  const { world } = ctx;
  const id = world.create(Kind.Projectile);
  if (id < 0) return -1;

  world.add(
    id,
    Comp.Transform | Comp.Velocity | Comp.Sprite | Comp.Collider | Comp.Damaging | Comp.Lifetime,
  );
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(spriteName);
  world.team[id] = Team.Player;
  world.vx[id] = vx;
  world.vy[id] = vy;
  world.damage[id] = stats.damage;
  world.knockback[id] = stats.knockback;
  world.pierce[id] = stats.pierce;
  world.lifetime[id] = stats.lifetime;
  world.maxLifetime[id] = stats.lifetime;
  world.scale[id] = stats.area;
  world.rot[id] = Math.atan2(vy, vx);
  world.radius[id] = Math.max(3, ctx.sprites.get(world.spriteId[id]!).width * 0.32 * stats.area);
  // turnRate doubles as the "is homing" marker for the projectile updater.
  world.aiPhase[id] = homing ? stats.turnRate : 0;
  return id;
}

/**
 * Creates a damaging area. `interval` of 0 means each enemy is hit once ever;
 * above 0 it re-hits everything inside on that cadence.
 */
export function spawnHazard(
  ctx: Ctx,
  spriteName: string,
  x: number,
  y: number,
  radius: number,
  lifetime: number,
  stats: WeaponStats,
  interval: number,
): number {
  const { world } = ctx;
  const id = world.create(Kind.Hazard);
  if (id < 0) return -1;

  world.add(id, Comp.Transform | Comp.Sprite | Comp.Collider | Comp.Damaging | Comp.Lifetime);
  world.place(id, x, y);
  world.spriteId[id] = ctx.sprites.id(spriteName);
  world.team[id] = Team.Player;
  world.radius[id] = radius;
  world.damage[id] = stats.damage;
  world.knockback[id] = stats.knockback;
  world.hitInterval[id] = interval;
  world.hitCooldown[id] = 0;
  world.lifetime[id] = lifetime;
  world.maxLifetime[id] = lifetime;
  // Match the drawn size to the collision radius so the telegraph is honest.
  world.scale[id] = spriteScaleForRadius(ctx, world.spriteId[id]!, radius);
  return id;
}

/** Scale that makes a sprite's drawn width equal a collision diameter. */
function spriteScaleForRadius(ctx: Ctx, spriteId: number, radius: number): number {
  const width = ctx.sprites.get(spriteId).width;
  if (width <= 0) return 1;
  return (radius * 2) / width;
}

/** Nearest living enemy to a point, or -1. */
export function nearestEnemy(ctx: Ctx, x: number, y: number, range = TARGET_RANGE): number {
  const found = ctx.enemyHash.query(x, y, range, ctx.scratch);
  let best = -1;
  let bestD2 = range * range;
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!ctx.world.isAlive(id)) continue;
    const dx = ctx.world.x[id]! - x;
    const dy = ctx.world.y[id]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = id;
    }
  }
  return best;
}

/**
 * The nearest living enemies to a point, closest first, written into `out`.
 * Returns how many were found, which may be fewer than `max`.
 *
 * Only enemies the camera frames are eligible, so a weapon that picks its own
 * targets can never spend one on something the player cannot see — the same
 * rule `resolveDamageArea` applies when the damage actually lands.
 *
 * Insertion into a list this short beats sorting the query: `max` is a weapon's
 * count, so single digits, while the query behind it can return hundreds.
 */
function nearestEnemies(
  ctx: Ctx,
  x: number,
  y: number,
  range: number,
  max: number,
  out: number[],
  distances: number[],
): number {
  out.length = 0;
  distances.length = 0;
  if (max <= 0) return 0;

  const found = ctx.enemyHash.query(x, y, range, ctx.scratch);
  const limit = range * range;
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!ctx.world.isAlive(id)) continue;
    if (!withinEngagement(ctx, id)) continue;
    const dx = ctx.world.x[id]! - x;
    const dy = ctx.world.y[id]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > limit) continue;
    // Already full and further away than the worst kept: nothing to do.
    if (out.length === max && d2 >= distances[max - 1]!) continue;

    let slot = out.length < max ? out.length : max - 1;
    while (slot > 0 && distances[slot - 1]! > d2) {
      out[slot] = out[slot - 1]!;
      distances[slot] = distances[slot - 1]!;
      slot--;
    }
    out[slot] = id;
    distances[slot] = d2;
  }
  return out.length;
}

// --- behaviours -----------------------------------------------------------

/**
 * Sweeping melee hit in the aim direction. Extra instances alternate to the
 * opposite side first, then fan vertically, so upgrades widen coverage instead
 * of stacking in one spot.
 */
function fireArc(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const baseAngle = Math.atan2(ctx.aimY, ctx.aimX);
  const radius = Math.max(10, stats.reach * 0.62);

  for (let i = 0; i < stats.count; i++) {
    let angle = baseAngle;
    if (i === 1) angle = baseAngle + Math.PI;
    else if (i > 1) angle = baseAngle + (i % 2 === 0 ? 1 : -1) * (Math.PI / 2) * Math.ceil(i / 2) * 0.5;

    const ox = px + Math.cos(angle) * stats.reach * 0.55;
    const oy = py + Math.sin(angle) * stats.reach * 0.55;
    const id = spawnHazard(ctx, weapon.def.sprite, ox, oy, radius, stats.duration, stats, 0);
    if (id >= 0) {
      world.rot[id] = angle;
      // Mirror rather than rotate when swinging leftward, so the art reads right.
      world.facing[id] = Math.cos(angle) < 0 ? -1 : 1;
    }
  }

  ctx.fx.burst(px + Math.cos(baseAngle) * 12, py + Math.sin(baseAngle) * 12, 4, 60, '#fff4e0', 0.18, 1);
}

/** Bolts that curve toward whatever is nearest. */
function fireHoming(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;

  for (let i = 0; i < stats.count; i++) {
    const target = nearestEnemy(ctx, px, py);
    let angle: number;
    if (target >= 0) {
      angle = Math.atan2(world.y[target]! - py, world.x[target]! - px);
      // Fan multiple bolts so they don't all fly the identical path.
      angle += (i - (stats.count - 1) / 2) * 0.28;
    } else {
      angle = Math.atan2(ctx.aimY, ctx.aimX) + (i - (stats.count - 1) / 2) * 0.28;
    }
    spawnProjectile(
      ctx,
      weapon.def.sprite,
      px,
      py,
      Math.cos(angle) * stats.speed,
      Math.sin(angle) * stats.speed,
      stats,
      true,
    );
  }
}

/** A fan of straight-flying projectiles along the aim direction. */
function fireStraight(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const baseAngle = Math.atan2(ctx.aimY, ctx.aimX);

  for (let i = 0; i < stats.count; i++) {
    const offset = (i - (stats.count - 1) / 2) * stats.spread;
    const angle = baseAngle + offset;
    // Stagger perpendicular to the shot so knives leave as a rank, not a stack.
    const lateral = (i - (stats.count - 1) / 2) * 4;
    spawnProjectile(
      ctx,
      weapon.def.sprite,
      px - Math.sin(baseAngle) * lateral,
      py + Math.cos(baseAngle) * lateral,
      Math.cos(angle) * stats.speed,
      Math.sin(angle) * stats.speed,
      stats,
      false,
    );
  }
}

/** Satellites that circle the player for a limited window. */
function fireOrbit(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;

  // Drop any leftovers from the previous volley before starting a new one.
  for (const id of weapon.activeIds) world.destroy(id);
  weapon.activeIds.length = 0;

  const radius = Math.max(6, ctx.sprites.get(ctx.sprites.id(weapon.def.sprite)).width * 0.4 * stats.area);

  for (let i = 0; i < stats.count; i++) {
    const id = spawnHazard(
      ctx,
      weapon.def.sprite,
      world.x[player]!,
      world.y[player]!,
      radius,
      stats.duration,
      stats,
      stats.interval,
    );
    if (id < 0) break;
    world.add(id, Comp.Orbit);
    world.owner[id] = player;
    world.orbitAngle[id] = (i / stats.count) * TAU;
    world.orbitRadius[id] = stats.radius;
    world.orbitSpeed[id] = stats.orbitSpeed;
    // Orbit sprites keep their natural size; only the collider tracks area.
    world.scale[id] = stats.area;
    weapon.activeIds.push(id);
  }
}

/** Lobs lingering ground hazards around the player. */
function fireDrop(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;

  for (let i = 0; i < stats.count; i++) {
    // Bias toward enemies when there are any, so flasks aren't wasted on empty ground.
    const target = nearestEnemy(ctx, px, py, stats.spawnRadius * 1.4);
    let tx: number;
    let ty: number;
    if (target >= 0 && i === 0) {
      tx = world.x[target]!;
      ty = world.y[target]!;
    } else {
      const angle = ctx.rng.angle();
      const r = ctx.rng.range(stats.spawnRadius * 0.25, stats.spawnRadius);
      tx = px + Math.cos(angle) * r;
      ty = py + Math.sin(angle) * r;
    }
    const id = spawnHazard(ctx, weapon.def.sprite, tx, ty, stats.radius, stats.duration, stats, stats.interval);
    if (id >= 0) ctx.fx.burst(tx, ty, 7, 55, '#ffb066', 0.3, 1);
  }
}

/** Radial burst in every direction. */
function fireNova(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  // Random phase so consecutive bursts don't overlay the same lanes.
  const phase = ctx.rng.angle();

  for (let i = 0; i < stats.count; i++) {
    const angle = phase + (i / stats.count) * TAU;
    spawnProjectile(
      ctx,
      weapon.def.sprite,
      px,
      py,
      Math.cos(angle) * stats.speed,
      Math.sin(angle) * stats.speed,
      stats,
      false,
    );
  }
  ctx.fx.shockwave(px, py, '#fff0b0', 0.35, 5);
}

/** Instant strikes on random enemies in view. Ignores line of sight entirely. */
function fireLightning(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;

  const found = ctx.enemyHash.query(px, py, TARGET_RANGE, ctx.scratch);
  if (found === 0) return;

  // Collect valid targets first, then sample without replacement so several
  // strikes in one volley don't all land on the same enemy.
  const candidates: number[] = [];
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!world.isAlive(id)) continue;
    const dx = world.x[id]! - px;
    const dy = world.y[id]! - py;
    if (dx * dx + dy * dy > TARGET_RANGE * TARGET_RANGE) continue;
    candidates.push(id);
  }
  if (candidates.length === 0) return;
  ctx.rng.shuffle(candidates);

  const strikes = Math.min(stats.count, candidates.length);
  for (let i = 0; i < strikes; i++) {
    const target = candidates[i]!;
    const tx = world.x[target]!;
    const ty = world.y[target]!;
    spawnHazard(ctx, weapon.def.sprite, tx, ty, stats.radius, stats.duration, stats, 0);
    ctx.fx.burst(tx, ty, 10, 100, '#cfe8ff', 0.3, 1);
    ctx.fx.shockwave(tx, ty, '#cfe8ff', 0.25, 4);
  }
  ctx.camera.shake(1.5, 0.15);
}

/** Beads a tether can be built from, so a long cord cannot flood the world. */
const MAX_TETHER_BEADS = 22;

/**
 * Cords strung from the player to the nearest enemies, cutting everything along
 * their length.
 *
 * A cord is a line of small single-hit beads rather than one long collider,
 * because a hazard is a circle: beads are how a line becomes hittable at all,
 * and they are spaced a diameter apart so a body standing on the cord is caught
 * by one of them rather than shredded by several.
 *
 * `count` is cords, not beads — an upgrade opens another throat, which is what
 * makes it the answer to an elite escort rather than to a crowd.
 */
function fireTether(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const bead = Math.max(2, stats.radius);

  const targets: number[] = [];
  const distances: number[] = [];
  const anchors = nearestEnemies(ctx, px, py, stats.reach, stats.count, targets, distances);
  if (anchors === 0) return;

  for (let t = 0; t < anchors; t++) {
    const target = targets[t]!;
    const dx = world.x[target]! - px;
    const dy = world.y[target]! - py;
    const length = Math.hypot(dx, dy);
    const beads = Math.max(1, Math.min(MAX_TETHER_BEADS, Math.round(length / (bead * 2))));

    // From one step out to the anchor itself: a bead centred on the player is
    // hidden under their own sprite and covers ground nothing stands on.
    for (let i = 1; i <= beads; i++) {
      const f = i / beads;
      spawnHazard(ctx, weapon.def.sprite, px + dx * f, py + dy * f, bead, stats.duration, stats, 0);
    }
    ctx.fx.burst(world.x[target]!, world.y[target]!, 4, 55, '#d94a5e', 0.22, 1);
  }
}

/**
 * A strike that leaps from body to body: the first jump starts at the player,
 * every one after it starts where the last landed.
 *
 * Distinct from `lightning`, which samples the whole screen at once — a chain
 * follows the crowd's own shape, so it is worth most exactly where the bodies
 * are packed and worth nothing against a single straggler.
 */
function fireChain(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  let x = world.x[player]!;
  let y = world.y[player]!;

  const struck: number[] = [];
  const jumps = Math.max(1, stats.count);
  // The first link reaches as far as the screen; every later one only as far as
  // the next body, so the chain has to walk the crowd instead of teleporting.
  let range = TARGET_RANGE;

  for (let i = 0; i < jumps; i++) {
    const node = nearestUnstruck(ctx, x, y, range, struck);
    if (node < 0) break;

    x = world.x[node]!;
    y = world.y[node]!;
    struck.push(node);
    spawnHazard(ctx, weapon.def.sprite, x, y, stats.radius, stats.duration, stats, 0);
    ctx.fx.burst(x, y, 6, 70, '#aab7c9', 0.25, 1);
    range = Math.max(1, stats.spawnRadius);
  }
}

/** Nearest on-screen enemy this chain has not already hit, or -1. */
function nearestUnstruck(ctx: Ctx, x: number, y: number, range: number, struck: readonly number[]): number {
  const found = ctx.enemyHash.query(x, y, range, ctx.scratch);
  let best = -1;
  let bestD2 = range * range;
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!ctx.world.isAlive(id)) continue;
    if (struck.includes(id)) continue;
    if (!withinEngagement(ctx, id)) continue;
    const dx = ctx.world.x[id]! - x;
    const dy = ctx.world.y[id]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = id;
    }
  }
  return best;
}

/**
 * Lays lingering ground in the player's wake.
 *
 * Placed behind the aim direction rather than underfoot, so walking draws a
 * line and standing still stacks one spot: the weapon pays out for kiting,
 * which is the one thing the arena always wants you doing anyway.
 */
function fireTrail(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const behind = Math.atan2(ctx.aimY, ctx.aimX) + Math.PI;
  const bx = px + Math.cos(behind) * stats.spawnRadius;
  const by = py + Math.sin(behind) * stats.spawnRadius;

  for (let i = 0; i < stats.count; i++) {
    // Extra drops widen the wake across the path rather than lengthening it,
    // so upgrades make the trail harder to walk around, not merely longer.
    const lateral = (i - (stats.count - 1) / 2) * stats.radius * 1.5;
    const id = spawnHazard(
      ctx,
      weapon.def.sprite,
      bx - Math.sin(behind) * lateral,
      by + Math.cos(behind) * lateral,
      stats.radius,
      stats.duration,
      stats,
      stats.interval,
    );
    // Ground-level, under everything that walks over it.
    if (id >= 0) world.drawBias[id] = -1e5;
  }
}

/**
 * Shockwave rings that expand outward from the player.
 *
 * Each ring hits a body once, as it passes — the sweep is the weapon, so its
 * damage lands in the order the crowd is standing rather than all at once, and
 * the knockback opens a hole around the player instead of scattering them
 * evenly. Extra `count` starts further out and finishes with the first, so the
 * volley reads as one wave with echoes.
 */
function fireSlam(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;

  const start = Math.max(2, stats.radius);
  const finish = Math.max(start + 8, stats.spawnRadius * stats.area);
  const seconds = Math.max(0.05, stats.duration);
  const speed = (finish - start) / seconds;
  const gap = (finish - start) / (stats.count + 1);

  for (let i = 0; i < stats.count; i++) {
    const from = start + gap * i;
    const id = spawnHazard(ctx, weapon.def.sprite, px, py, from, (finish - from) / speed, stats, 0);
    if (id < 0) break;
    world.growRate[id] = speed;
    world.drawBias[id] = -1e5;
  }

  ctx.fx.shockwave(px, py, '#d1d8e2', 0.4, 7);
  ctx.camera.shake(2, 0.18);
}

/**
 * Projectiles launched radially that keep turning as they fly, so each one
 * sweeps a spiral outward instead of leaving a gap between lanes the way a
 * `nova` does. Slow and patient: the coverage is the point, not the velocity.
 */
function fireSpiral(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const phase = ctx.rng.angle();

  for (let i = 0; i < stats.count; i++) {
    const angle = phase + (i / stats.count) * TAU;
    const id = spawnProjectile(
      ctx,
      weapon.def.sprite,
      px,
      py,
      Math.cos(angle) * stats.speed,
      Math.sin(angle) * stats.speed,
      stats,
      false,
    );
    if (id >= 0) world.spin[id] = stats.turnRate;
  }
}

/**
 * Keeps the persistent aura alive, centred, and matched to current stats.
 *
 * Rebuilt lazily rather than on level-up so it recovers automatically if the
 * entity is ever lost, and picks up passive changes with no explicit signal.
 */
function maintainAura(ctx: Ctx, weapon: OwnedWeapon, stats: WeaponStats): void {
  const { world } = ctx;
  const player = ctx.player;

  let id = weapon.activeIds[0] ?? -1;
  if (id < 0 || !world.isAlive(id)) {
    id = spawnHazard(ctx, weapon.def.sprite, world.x[player]!, world.y[player]!, stats.radius, 0, stats, stats.interval);
    if (id < 0) return;
    // Persistent: no lifetime component, so it is never expired by the updater.
    world.remove(id, Comp.Lifetime);
    weapon.activeIds[0] = id;
  }

  world.x[id] = world.x[player]!;
  world.y[id] = world.y[player]!;
  world.radius[id] = stats.radius;
  world.damage[id] = stats.damage;
  world.knockback[id] = stats.knockback;
  world.hitInterval[id] = stats.interval;
  world.scale[id] = spriteScaleForRadius(ctx, world.spriteId[id]!, stats.radius);
  // Drawn under everything, since it is ground-level consecration.
  world.drawBias[id] = -1e5;
}

// --- per-tick updates -----------------------------------------------------

/** Moves player projectiles, applies homing, and resolves hits. */
export function updatePlayerProjectiles(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const player = ctx.player;
  const px = player >= 0 ? world.x[player]! : 0;
  const py = player >= 0 ? world.y[player]! : 0;

  const ids = world.list(Kind.Projectile);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (world.team[id] !== Team.Player) continue;

    world.lifetime[id] = world.lifetime[id]! - dt;
    if (world.lifetime[id]! <= 0) {
      world.destroy(id);
      continue;
    }

    const turnRate = world.aiPhase[id]!;
    if (turnRate > 0) {
      const target = nearestEnemy(ctx, world.x[id]!, world.y[id]!, 220);
      if (target >= 0) {
        const desired = Math.atan2(world.y[target]! - world.y[id]!, world.x[target]! - world.x[id]!);
        const current = Math.atan2(world.vy[id]!, world.vx[id]!);
        let delta = desired - current;
        // Normalize into (-PI, PI] so it always turns the short way round.
        while (delta > Math.PI) delta -= TAU;
        while (delta < -Math.PI) delta += TAU;
        const step = Math.max(-turnRate * dt, Math.min(turnRate * dt, delta));
        const speed = Math.hypot(world.vx[id]!, world.vy[id]!);
        const next = current + step;
        world.vx[id] = Math.cos(next) * speed;
        world.vy[id] = Math.sin(next) * speed;
        world.rot[id] = next;
      }
    }

    const spin = world.spin[id]!;
    if (spin !== 0) {
      const speed = Math.hypot(world.vx[id]!, world.vy[id]!);
      const next = Math.atan2(world.vy[id]!, world.vx[id]!) + spin * dt;
      world.vx[id] = Math.cos(next) * speed;
      world.vy[id] = Math.sin(next) * speed;
      world.rot[id] = next;
    }

    const nx = world.x[id]! + world.vx[id]! * dt;
    const ny = world.y[id]! + world.vy[id]! * dt;
    world.x[id] = nx;
    world.y[id] = ny;
    world.animTime[id] = world.animTime[id]! + dt;

    if (player >= 0) {
      const dx = nx - px;
      const dy = ny - py;
      if (dx * dx + dy * dy > DESPAWN_DISTANCE * DESPAWN_DISTANCE) {
        world.destroy(id);
        continue;
      }
    }

    resolveDamageArea(ctx, id, nx, ny, world.radius[id]!, true);
  }
}

/** Ticks hazards: orbit motion, lifetime, and interval damage. */
export function updateHazards(ctx: Ctx, dt: number): void {
  const { world } = ctx;
  const player = ctx.player;

  const ids = world.list(Kind.Hazard);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;

    if (world.has(id, Comp.Lifetime)) {
      world.lifetime[id] = world.lifetime[id]! - dt;
      if (world.lifetime[id]! <= 0) {
        world.destroy(id);
        continue;
      }
    }

    // Expanding rings: the collider grows and the art is re-fitted to it every
    // tick, so what the ring looks like is what it hits at any moment of the
    // sweep. The hit registry does the rest — a body the ring has already
    // passed is never caught a second time.
    const grow = world.growRate[id]!;
    if (grow !== 0) {
      world.radius[id] = Math.max(0, world.radius[id]! + grow * dt);
      world.scale[id] = spriteScaleForRadius(ctx, world.spriteId[id]!, world.radius[id]!);
    }

    if (world.has(id, Comp.Orbit)) {
      const owner = world.owner[id]!;
      if (owner < 0 || !world.isAlive(owner)) {
        world.destroy(id);
        continue;
      }
      world.orbitAngle[id] = world.orbitAngle[id]! + world.orbitSpeed[id]! * dt;
      const a = world.orbitAngle[id]!;
      world.x[id] = world.x[owner]! + Math.cos(a) * world.orbitRadius[id]!;
      world.y[id] = world.y[owner]! + Math.sin(a) * world.orbitRadius[id]!;
      world.rot[id] = a;
    }

    world.animTime[id] = world.animTime[id]! + dt;

    // Interval 0 means "hit each target once", enforced by the hit registry, so
    // it can safely run every tick as the area moves or grows.
    let shouldDamage = true;
    if (world.hitInterval[id]! > 0) {
      world.hitCooldown[id] = world.hitCooldown[id]! - dt;
      if (world.hitCooldown[id]! <= 0) {
        world.hitCooldown[id] = world.hitInterval[id]!;
        world.clearHits(id);
      } else {
        shouldDamage = false;
      }
    }

    if (shouldDamage) {
      resolveDamageArea(ctx, id, world.x[id]!, world.y[id]!, world.radius[id]!, false);
    }

    if (player >= 0 && !world.has(id, Comp.Orbit)) {
      const dx = world.x[id]! - world.x[player]!;
      const dy = world.y[id]! - world.y[player]!;
      if (dx * dx + dy * dy > DESPAWN_DISTANCE * DESPAWN_DISTANCE) world.destroy(id);
    }
  }
}

/**
 * Damages enemies overlapping a circle, honouring pierce and the per-source hit
 * registry so nothing is hit twice by the same instance.
 *
 * `consumePierce` is true for projectiles, which die once their pierce budget
 * runs out, and false for hazards, which persist regardless.
 */
function resolveDamageArea(
  ctx: Ctx,
  source: number,
  x: number,
  y: number,
  radius: number,
  consumePierce: boolean,
): void {
  const { world } = ctx;
  const found = ctx.enemyHash.query(x, y, radius + 24, ctx.scratch);
  if (found === 0) return;

  const damage = world.damage[source]!;
  const knockback = world.knockback[source]!;
  // The player only gets to fight what the screen shows. Emplacements are the
  // exception — a watchtower defends a wall you have walked away from — and
  // they are the ones that claim their shots, so anything unclaimed is the
  // player's and answers to the camera. The same flag decides crits: an
  // emplacement fires the number in structures.json and nothing else, or the
  // player's crit stats start scaling terrain.
  const emplaced = world.owner[source] >= 0 && world.kind[world.owner[source]!] === Kind.Structure;

  for (let i = 0; i < found; i++) {
    const enemy = ctx.scratch[i]!;
    if (!world.isAlive(enemy)) continue;
    if (!emplaced && !withinEngagement(ctx, enemy)) continue;

    const dx = world.x[enemy]! - x;
    const dy = world.y[enemy]! - y;
    const reach = radius + world.radius[enemy]!;
    if (dx * dx + dy * dy > reach * reach) continue;

    if (!world.registerHit(source, enemy)) continue;

    damageEnemy(ctx, enemy, damage, knockback, x, y, !emplaced);

    if (consumePierce) {
      const left = world.pierce[source]!;
      if (left >= 0) {
        const remaining = left - 1;
        world.pierce[source] = remaining;
        if (remaining <= 0) {
          ctx.fx.burst(x, y, 4, 50, '#ffdcc0', 0.2, 1);
          world.destroy(source);
          return;
        }
      }
    }
  }
}
