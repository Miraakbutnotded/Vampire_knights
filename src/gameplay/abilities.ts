import { TAU } from '../core/math.ts';
import { AbilityKind, BLOOD_CONFIG, WEAPON_STAT_DEFAULTS } from './content.ts';
import type { AbilityDef, WeaponStats } from './content.ts';
import { nearestEnemy, spawnHazard, spawnProjectile } from './weapons.ts';
import { healPlayer } from './pickups.ts';
import type { Ctx } from './context.ts';
import type { AbilityState, Run } from './run.ts';

/**
 * Builds the WeaponStats an ability's spawned entities carry, so abilities can
 * ride spawnProjectile/spawnHazard and every downstream updater unchanged.
 *
 * Scaling is deliberately narrow (design guardrail): damage x might, sizes x
 * area, lifetime x duration — and nothing else. amount, cooldown and
 * projectileSpeed do not apply, and the ability cooldown itself never appears
 * here at all (it lives raw on AbilityDef, immune to cooldown scaling).
 *
 * Frenzy folds in read-side exactly as effectiveStats does — keyed off
 * run.frenzyT, never written to run.stats — so a buffed, frenzied cast is
 * (base x might-incl-buff x mightMult) with zero recompute involvement.
 */
export function abilityStats(run: Run, def: AbilityDef): WeaponStats {
  const p = def.params;
  const s = run.stats;
  const frenzyDamage = run.frenzyT > 0 ? BLOOD_CONFIG.frenzy.mightMult : 1;

  return {
    ...WEAPON_STAT_DEFAULTS,
    damage: p.damage * s.might * frenzyDamage,
    count: p.count,
    pierce: p.pierce,
    area: s.area,
    duration: p.lifetime * s.duration,
    knockback: p.knockback,
    speed: p.speed,
    lifetime: p.lifetime * s.duration,
    interval: p.interval,
    radius: p.radius * s.area,
    turnRate: p.turnRate,
  };
}

/**
 * The active-ability system: ticks the cooldown, expires buff windows, pumps
 * volley bursts, and consumes the player's latched cast intent.
 *
 * Runs immediately after the post-movement enemy-hash rebuild (rebuild #2) and
 * before updateWeapons in the tick, mirrored verbatim in the test harness.
 * Casting before updateEnemyProjectiles means dash iframes granted this tick
 * already cover this tick's enemy fire, and entities spawned here are moved,
 * resolved and rendered by the ordinary updaters later in the same tick.
 * Every timer advances on sim dt only — wall clock would break determinism.
 */
export function updateAbility(ctx: Ctx, dt: number): void {
  const { run, world, bus } = ctx;
  const state = run.ability;
  if (!state) {
    ctx.abilityQueued = false;
    return;
  }

  if (state.cooldownLeft > 0) {
    state.cooldownLeft = Math.max(0, state.cooldownLeft - dt);
    if (state.cooldownLeft === 0) bus.emit('ability:ready', undefined);
  }

  if (state.activeLeft > 0) {
    state.activeLeft = Math.max(0, state.activeLeft - dt);
    if (state.activeLeft === 0 && state.def.kind === AbilityKind.Buff) {
      // Expiry is a state change — one of exactly two recompute sites the
      // buff owns (the other is activation). Never per tick.
      run.abilityMods = null;
      run.recomputeStats();
      // A buff that raised maxHp (e.g. an armor/maxHp mix) must not leave hp
      // above the restored cap once the mod is gone.
      if (ctx.player >= 0 && world.isAlive(ctx.player)) {
        world.hp[ctx.player] = Math.min(world.hp[ctx.player]!, run.stats.maxHp);
      }
    }
  }

  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) {
    ctx.abilityQueued = false;
    return;
  }

  if (state.def.kind === AbilityKind.Volley && state.burstLeft > 0) {
    pumpVolley(ctx, state, dt);
  }

  if (ctx.abilityQueued) {
    // Consumed either way: a press during cooldown is dropped, not banked —
    // a queued cast firing seconds later would land where nobody aimed it.
    ctx.abilityQueued = false;
    if (state.cooldownLeft === 0) activate(ctx, state);
  }
}

function activate(ctx: Ctx, state: AbilityState): void {
  const def = state.def;
  // The one place the cooldown is written. run.stats.cooldown and Frenzy's
  // cooldownMult are deliberately absent (design guardrail).
  state.cooldownLeft = def.cooldown;

  switch (def.kind) {
    case AbilityKind.Nova:
      castNova(ctx, def);
      break;
    case AbilityKind.Volley:
      state.activeLeft = def.duration; // the burst window
      state.burstLeft = def.params.count;
      state.burstTimer = 0;
      pumpVolley(ctx, state, 0); // first shot leaves on the cast tick
      break;
    case AbilityKind.Zone:
      castZone(ctx, def);
      break;
    case AbilityKind.Buff:
      castBuff(ctx, def, state);
      break;
    case AbilityKind.Dash:
      castDash(ctx, def);
      break;
    default:
      break;
  }

  ctx.bus.emit('ability:used', { name: def.name, kind: def.kind, cooldown: def.cooldown });
}

/** Radial burst around the player, riding the ordinary projectile pipeline. */
function castNova(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const px = world.x[ctx.player]!;
  const py = world.y[ctx.player]!;
  const stats = abilityStats(run, def);
  // Random phase (gameplay rng — determinism) so repeat casts vary their lanes.
  const phase = ctx.rng.angle();

  for (let i = 0; i < stats.count; i++) {
    const a = phase + (i / stats.count) * TAU;
    spawnProjectile(ctx, def.sprite, px, py, Math.cos(a) * stats.speed, Math.sin(a) * stats.speed, stats, false);
  }

  ctx.fx.shockwave(px, py, '#d94a5e', 0.4, 6);
  ctx.camera.shake(2, 0.2);
}

/**
 * One large lingering hazard at the caster's feet. Interval re-hits, pierce
 * dedup and expiry are all updateHazards' existing behavior — zero new damage
 * code, exactly like the weapon Drop behavior but bigger and on demand.
 */
function castZone(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const px = world.x[ctx.player]!;
  const py = world.y[ctx.player]!;
  const stats = abilityStats(run, def);

  spawnHazard(ctx, def.sprite, px, py, stats.radius, stats.lifetime, stats, stats.interval);
  ctx.fx.shockwave(px, py, '#7a3fa0', 0.45, 7);
}

/**
 * Temporary stat mods through the recompute pipeline plus an instant heal.
 * Activation is state change #1 (mods in, one recompute); expiry in
 * updateAbility is #2 (mods out, one recompute). The heal runs AFTER the
 * recompute so a future maxHp-buffing kit heals against the raised cap;
 * healPlayer clamps at run.stats.maxHp, so overheal is discarded.
 */
function castBuff(ctx: Ctx, def: AbilityDef, state: AbilityState): void {
  const { world, run } = ctx;
  state.activeLeft = def.duration;

  // Copy, never alias: def.mods is shared normalized content — content must
  // never be mutated through this reference.
  run.abilityMods = { ...def.mods };
  run.recomputeStats();
  if (def.params.heal > 0) healPlayer(ctx, def.params.heal);

  ctx.fx.shockwave(world.x[ctx.player]!, world.y[ctx.player]!, '#d4a15a', 0.4, 6);
}

/**
 * Instant reposition along the persistent aim direction, resolved against the
 * map in substeps so the dash cannot tunnel through tiles or runtime solids —
 * the same resolveTiles/resolveSolids/clampToBounds contract updatePlayer
 * honours every tick, applied 8 units at a time. Tunnel-safety invariant: the
 * substep must stay below 2×min player radius (10 for the smallest, radius-5
 * characters) so consecutive swept circles overlap, and below tileSize (16) so
 * no step can skip a whole tile.
 *
 * Position is written to x/y directly, deliberately NOT world.place(): prev
 * keeps the dash origin from this tick's snapshot, so the renderer lerps the
 * whole dash across one frame — a fast, readable smear. place() would set
 * prev == current and hard-snap instead.
 *
 * Takes no AbilityState on purpose: the dash's only timer is the iframe window
 * on world.iframe (activeLeft stays 0), and tsconfig's noUnusedParameters
 * would reject an unused state parameter.
 */
function castDash(ctx: Ctx, def: AbilityDef): void {
  const { world, map, run } = ctx;
  const id = ctx.player;
  const p = def.params;

  // ctx.aimX/aimY is a persistent unit vector (never zero after init).
  const dirX = ctx.aimX;
  const dirY = ctx.aimY;
  const radius = world.radius[id]!;
  const startX = world.x[id]!;
  const startY = world.y[id]!;

  const steps = Math.max(1, Math.ceil(p.distance / 8));
  const step = p.distance / steps;
  let nx = startX;
  let ny = startY;
  for (let i = 0; i < steps; i++) {
    nx += dirX * step;
    ny += dirY * step;
    if (map.hasCollision) {
      [nx, ny] = map.resolveTiles(nx, ny, radius);
      [nx, ny] = map.resolveSolids(nx, ny, radius);
    }
    [nx, ny] = map.clampToBounds(nx, ny, radius);
  }

  world.x[id] = nx;
  world.y[id] = ny;
  // Extend-or-keep, never truncate: a longer window may already be running
  // (revive grants 2.5s) and a panic dash must not shorten it. Post-hit
  // iframes (0.45) are shorter than any dash duration, so the normal case
  // still lands exactly def.duration (≤ 0.8s by guardrail; updatePlayer
  // ticks it down).
  world.iframe[id] = Math.max(world.iframe[id]!, def.duration);

  // Mist trail: evenly spaced along the segment actually travelled, so a
  // wall-shortened dash shortens its trail with it.
  const stats = abilityStats(run, def);
  for (let i = 1; i <= p.trailCount; i++) {
    const t = i / (p.trailCount + 1);
    spawnHazard(
      ctx,
      def.sprite,
      startX + (nx - startX) * t,
      startY + (ny - startY) * t,
      stats.radius,
      stats.lifetime,
      stats,
      stats.interval,
    );
  }

  ctx.fx.burst(startX, startY, 8, 70, '#b8c8d8', 0.3, 1);
  ctx.fx.burst(nx, ny, 8, 70, '#b8c8d8', 0.3, 1);
}

/**
 * Releases queued volley shots on a fixed cadence: one every
 * duration/count seconds. Runs from updateAbility while burstLeft > 0, so a
 * burst continues (and finishes) even while the cooldown is already counting.
 */
function pumpVolley(ctx: Ctx, state: AbilityState, dt: number): void {
  state.burstTimer -= dt;
  const interval = state.def.duration / Math.max(1, state.def.params.count);
  while (state.burstTimer <= 0 && state.burstLeft > 0) {
    fireVolleyShot(ctx, state.def);
    state.burstLeft--;
    state.burstTimer += interval;
  }
}

/** One homing bat: aimed near the closest enemy, or a random lane when alone. */
function fireVolleyShot(ctx: Ctx, def: AbilityDef): void {
  const { world, run } = ctx;
  const player = ctx.player;
  const px = world.x[player]!;
  const py = world.y[player]!;
  // Recomputed per shot, like weapons re-reading stats per fire, so a passive
  // picked mid-burst applies to the tail of the swarm.
  const stats = abilityStats(run, def);

  const target = nearestEnemy(ctx, px, py);
  const angle =
    target >= 0
      ? Math.atan2(world.y[target]! - py, world.x[target]! - px) + ctx.rng.range(-0.35, 0.35)
      : ctx.rng.angle();

  spawnProjectile(ctx, def.sprite, px, py, Math.cos(angle) * stats.speed, Math.sin(angle) * stats.speed, stats, true);
}
