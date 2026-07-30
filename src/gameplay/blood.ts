import { BLOOD_CONFIG } from './content.ts';
import { damageEnemy } from './damage.ts';
import { healPlayer } from './pickups.ts';
import type { Ctx } from './context.ts';

/**
 * The blood economy system: resets the anti-farm intake window each
 * sim-second, counts down Frenzy, consumes the player's latched spend intent,
 * then decays banked blood above the threshold after a grace period.
 *
 * Runs after updatePickups in the tick (all damage and collection for the tick
 * has resolved) and is mirrored verbatim in the test harness. Every timer here
 * advances on sim dt only — wall-clock time would break seed reproducibility.
 */
export function updateBlood(ctx: Ctx, dt: number): void {
  const { run, bus } = ctx;
  const cfg = BLOOD_CONFIG;

  // The intake window is keyed to run.time: it reopens on each whole-second
  // boundary of sim time, never on wall clock.
  if (Math.floor(run.time) !== Math.floor(run.time - dt)) run.bloodIntakeWindow = 0;

  if (run.frenzyT > 0) run.frenzyT = Math.max(0, run.frenzyT - dt);

  // Consume the latched intent BEFORE the decay step below: a press landing on
  // the same tick as a decay step must spend the full banked amount, and a bar
  // the HUD shows as ready must never be dipped under the threshold by this
  // tick's decay before the press is honoured.
  const intent = ctx.bloodIntent;
  if (intent !== null) {
    ctx.bloodIntent = null;
    // Below the threshold the press is swallowed: no partial spends.
    if (run.blood >= cfg.threshold) {
      const spent = run.blood;
      run.blood = 0;

      if (intent === 'heal') {
        // Report what actually landed, not what was asked for: at high health
        // most of a full bar is overheal, and the HUD must not claim otherwise.
        const healed = healPlayer(ctx, spent * cfg.healPerBlood * run.stats.maxHp);
        bus.emit('blood:feast', { spent, healed });
      } else {
        run.frenzyT = cfg.frenzy.baseDuration + cfg.frenzy.durationPerBlood * spent;
        castBloodNova(ctx);
        bus.emit('blood:frenzy', { spent, duration: run.frenzyT });
      }
    }
  }

  // Use-it-or-lose-it: at or above the threshold, blood holds through a short
  // grace after the last gain, then bleeds down — but never below ready-minus-one.
  // (After a spend, blood is 0, so this block is a no-op on the cast tick.)
  if (run.blood > cfg.threshold - 1) {
    if (run.graceT > 0) run.graceT = Math.max(0, run.graceT - dt);
    else run.blood = Math.max(cfg.threshold - 1, run.blood - cfg.decayPerSec * dt);
  }
}

/**
 * Single-tick burst around the player when Frenzy begins.
 *
 * One damage call per enemy in one tick, so no registerHit bookkeeping is
 * needed. The enemyHash from this tick's post-movement rebuild is still
 * current (pickups don't move enemies), and candidates land in ctx.scratch —
 * zero allocations. Query results are candidates only: exact distance test
 * plus isAlive, as the spatial hash contract demands.
 */
function castBloodNova(ctx: Ctx): void {
  const { world, run } = ctx;
  const player = ctx.player;
  if (player < 0 || !world.isAlive(player)) return;

  const cfg = BLOOD_CONFIG.frenzy;
  const px = world.x[player]!;
  const py = world.y[player]!;
  const damage = cfg.novaDamage * run.stats.might;

  const found = ctx.enemyHash.query(px, py, cfg.novaRadius, ctx.scratch);
  for (let i = 0; i < found; i++) {
    const id = ctx.scratch[i]!;
    if (!world.isAlive(id)) continue;
    const dx = world.x[id]! - px;
    const dy = world.y[id]! - py;
    if (dx * dx + dy * dy > cfg.novaRadius * cfg.novaRadius) continue;
    damageEnemy(ctx, id, damage, 0, px, py);
  }

  ctx.fx.shockwave(px, py, '#d94a5e', 0.5, 10);
  ctx.camera.shake(3, 0.3);
}
