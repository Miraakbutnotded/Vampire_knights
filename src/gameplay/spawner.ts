import { Kind } from '../ecs/components.ts';
import { enemyDef } from './content.ts';
import { offscreenSpawnPoint, spawnEnemy } from './enemies.ts';
import type { Ctx } from './context.ts';
import type { WaveStage } from './content.ts';

/** Bosses arrive closer than trash so the player registers them immediately. */
const BOSS_RING = 210;
const ELITE_RING = 290;

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

  /** Cached weights for the active stage, so the weighted pick allocates nothing. */
  private stageWeights: number[] = [];

  reset(): void {
    this.stageIndex = -1;
    this.spawnTimer = 0;
    this.eliteTimer = 0;
    this.nextBoss = 0;
    this.stageWeights = [];
  }

  update(ctx: Ctx, dt: number): void {
    const table = ctx.wave;
    const time = ctx.run.time;

    this.syncStage(table.stages, time);
    this.updateBosses(ctx, time);
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
  return {
    // The exponent lets late-game health outpace linear weapon growth, which is
    // what forces build decisions rather than letting one weapon carry forever.
    hp: Math.pow(1 + table.hpPerMinute * minutes, table.hpExponent),
    damage: 1 + table.damagePerMinute * minutes,
    speed: 1 + table.speedPerMinute * minutes,
  };
}
