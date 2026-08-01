import { Kind } from '../ecs/components.ts';
import { enemyDef, isSiegeMelee, structureDefByIndex } from './content.ts';
import { offscreenSpawnPoint, spawnEnemy } from './enemies.ts';
import { spawnChest, spawnCoin } from './pickups.ts';
import type { Ctx } from './context.ts';
import type { WaveStage } from './content.ts';

/** Bosses arrive closer than trash so the player registers them immediately. */
const BOSS_RING = 210;
const ELITE_RING = 290;
/** Siege attackers arrive between elites and trash: visible, not instant. */
const SIEGE_RING = 300;
/** Extra damage/speed multiplier per wall lost — "the hunters grow bolder". */
const BOLDER_PER_WALL = 0.08;

/**
 * Drives all enemy population: the timed wave stages, periodic elites, and
 * scripted boss appearances.
 *
 * Kept separate from enemy AI so pacing can be retuned entirely in
 * content/waves.json without touching behaviour code.
 */
export class Spawner {
  private stageIndex = -1;
  private spawnTimer = 0;
  private eliteTimer = 0;
  private nextBoss = 0;
  private nextSiege = 0;
  /** Sim time the open siege window closes, or -1 when no siege is active. */
  private siegeEndsAt = -1;

  /** Cached weights for the active stage, so the weighted pick allocates nothing. */
  private stageWeights: number[] = [];

  reset(): void {
    this.stageIndex = -1;
    this.spawnTimer = 0;
    this.eliteTimer = 0;
    this.nextBoss = 0;
    this.nextSiege = 0;
    this.siegeEndsAt = -1;
    this.stageWeights = [];
  }

  update(ctx: Ctx, dt: number): void {
    const table = ctx.wave;
    const time = ctx.run.time;

    this.syncStage(table.stages, time);
    this.updateBosses(ctx, time);
    this.updateSieges(ctx, time);
    this.updateElites(ctx, dt, time);

    const stage = table.stages[this.stageIndex];
    if (!stage || stage.enemies.length === 0) return;

    const alive = ctx.world.list(Kind.Enemy).length;
    if (alive >= table.maxAlive) {
      // At the cap, hold the timer at zero so spawning resumes the moment
      // room frees up instead of waiting out a fresh interval.
      this.spawnTimer = 0;
      return;
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = stage.spawnInterval;

    const room = table.maxAlive - alive;
    const toSpawn = Math.min(stage.perSpawn, room);

    // One position per burst, with a small scatter around it, so groups arrive
    // together from one direction rather than surrounding the player evenly.
    const [baseX, baseY] = offscreenSpawnPoint(ctx);

    for (let i = 0; i < toSpawn; i++) {
      const pick = ctx.rng.weightedIndex(this.stageWeights);
      if (pick < 0) return;
      const def = enemyDef(stage.enemies[pick]!.type);
      if (!def) continue;
      spawnEnemy(
        ctx,
        def,
        baseX + ctx.rng.range(-34, 34),
        baseY + ctx.rng.range(-34, 34),
      );
    }
  }

  /** Advances to the latest stage whose start time has passed. */
  private syncStage(stages: readonly WaveStage[], time: number): void {
    let next = this.stageIndex;
    while (next + 1 < stages.length && stages[next + 1]!.at <= time) next++;
    if (next === this.stageIndex) return;

    this.stageIndex = next;
    const stage = stages[next];
    this.stageWeights = stage ? stage.enemies.map((e) => e.weight) : [];
    // Fire the new stage's first burst promptly so pacing changes are felt.
    this.spawnTimer = Math.min(this.spawnTimer, 0.2);
  }

  private updateBosses(ctx: Ctx, time: number): void {
    const bosses = ctx.wave.bosses;
    while (this.nextBoss < bosses.length && bosses[this.nextBoss]!.at <= time) {
      const entry = bosses[this.nextBoss]!;
      this.nextBoss++;
      const def = enemyDef(entry.type);
      if (!def) continue;
      for (let i = 0; i < entry.count; i++) {
        const [x, y] = offscreenSpawnPoint(ctx, BOSS_RING);
        spawnEnemy(ctx, def, x, y);
      }
    }
  }

  /**
   * Mirrors updateBosses: a forward-only cursor over wave.sieges. Each due
   * entry spawns its attackers off screen and hands each one a handle to the
   * nearest living structure. With no living structure the handle stays -1 and
   * the attacker hunts the player — sieges degrade gracefully on
   * structure-less maps, never crash, never stall.
   */
  private updateSieges(ctx: Ctx, time: number): void {
    const sieges = ctx.wave.sieges;
    while (this.nextSiege < sieges.length && sieges[this.nextSiege]!.at <= time) {
      const entry = sieges[this.nextSiege]!;
      this.nextSiege++;
      const def = enemyDef(entry.type);
      if (!def) continue;

      const structures = ctx.world.list(Kind.Structure);
      for (let i = 0; i < entry.count; i++) {
        const [x, y] = offscreenSpawnPoint(ctx, SIEGE_RING);
        const id = spawnEnemy(ctx, def, x, y);
        if (id < 0) continue;
        // Non-melee types were warned at content load; they chase the player.
        if (!isSiegeMelee(def.behavior)) continue;

        // Nearest living structure — ≤4 per map, a linear scan beats a hash.
        let best = -1;
        let bestD2 = Infinity;
        for (let s = 0; s < structures.length; s++) {
          const sid = structures[s]!;
          if (!ctx.world.isAlive(sid)) continue;
          const dx = ctx.world.x[sid]! - x;
          const dy = ctx.world.y[sid]! - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = sid;
          }
        }
        if (best >= 0) ctx.world.targetHandle[id] = ctx.world.handleOf(best);
      }

      // Overlapping sieges extend one shared window; the reward resolves once.
      this.siegeEndsAt = Math.max(this.siegeEndsAt, time + entry.duration);
      ctx.bus.emit('siege:started', { duration: entry.duration });
    }

    if (this.siegeEndsAt >= 0 && time >= this.siegeEndsAt) {
      this.siegeEndsAt = -1;
      this.resolveSiege(ctx);
    }
  }

  /**
   * The window closed. Defended = at least one structure still stands: the
   * reward (chest + gold) lands at the first survivor, so walking back to the
   * wall you held is the loop. Every structure down = no reward and nothing
   * else — the difficulty penalty is already banked in run.wallsLost, and
   * player death stays the only fail state.
   */
  private resolveSiege(ctx: Ctx): void {
    const structures = ctx.world.list(Kind.Structure);
    for (let i = 0; i < structures.length; i++) {
      const sid = structures[i]!;
      if (!ctx.world.isAlive(sid)) continue;
      const def = structureDefByIndex(ctx.world.defIndex[sid]!);
      const x = ctx.world.x[sid]!;
      const y = ctx.world.y[sid]!;
      spawnChest(ctx, x, y + 6);
      spawnCoin(ctx, x + 10, y + 2, def.gold);
      ctx.bus.emit('siege:defended', { gold: def.gold });
      return;
    }
  }

  private updateElites(ctx: Ctx, dt: number, time: number): void {
    const elites = ctx.wave.elites;
    if (!elites || time < elites.startAt) return;

    this.eliteTimer -= dt;
    if (this.eliteTimer > 0) return;
    this.eliteTimer = elites.interval;

    const def = enemyDef(elites.type);
    if (!def) return;

    const minutes = time / 60;
    const count = Math.max(1, Math.round(elites.count + elites.countGrowthPerMinute * minutes));
    for (let i = 0; i < count; i++) {
      const [x, y] = offscreenSpawnPoint(ctx, ELITE_RING);
      spawnEnemy(ctx, def, x, y);
    }
  }
}

/** Difficulty multipliers for the current run time. */
export function difficultyAt(ctx: Ctx, seconds: number): {
  hp: number;
  damage: number;
  speed: number;
} {
  const table = ctx.wave;
  const minutes = seconds / 60;
  // Losing a wall is not a fail state; the world just leans harder on you.
  // Consumed at spawn time only, like the rest of these multipliers — enemies
  // already on the field never rescale. Counted off run.wallsLost, not
  // structuresLost, so the ceiling is set by how many walls a map defends and
  // not by how many guns it happens to mount.
  const bolder = 1 + BOLDER_PER_WALL * ctx.run.wallsLost;
  return {
    // The exponent lets late-game health outpace linear weapon growth, which is
    // what forces build decisions rather than letting one weapon carry forever.
    hp: Math.pow(1 + table.hpPerMinute * minutes, table.hpExponent),
    damage: (1 + table.damagePerMinute * minutes) * bolder,
    speed: (1 + table.speedPerMinute * minutes) * bolder,
  };
}
