import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';
import { Rng } from '../core/rng.ts';
import { FIXED_DT } from '../core/loop.ts';
import { Kind } from '../ecs/components.ts';
import { World } from '../ecs/world.ts';
import { Camera } from '../render/camera.ts';
import { Fx } from '../render/fx.ts';
import type { SpriteTable } from '../render/sprites.ts';
import type { TileMap } from '../render/tilemap.ts';
import type { Input } from '../core/input.ts';

import { MAX_QUERY_RESULTS, SpatialHash } from './collision.ts';
import { CHARACTER_LIST, WEAPON_LIST, enemyDef, waveTable, weaponStatsAtLevel } from './content.ts';
import { updateEnemies, updateEnemyProjectiles, spawnEnemy } from './enemies.ts';
import { spawnPlayer, updatePlayer } from './player.ts';
import { updatePickups } from './pickups.ts';
import { Run, xpForLevel } from './run.ts';
import { Spawner, difficultyAt } from './spawner.ts';
import { applyOffer, rollOffers } from './upgrades.ts';
import { updateHazards, updatePlayerProjectiles, updateWeapons } from './weapons.ts';
import type { Ctx } from './context.ts';

/**
 * Headless integration tests.
 *
 * These drive the real gameplay systems in the real tick order — the same order
 * `Game.tick` uses — with only the two genuinely browser-bound dependencies
 * stubbed: the sprite table (needs canvas) and the tile map (needs decoded
 * images). Everything being exercised is the shipping code path, so a crash,
 * a runaway entity count or a progression stall shows up here rather than
 * fifteen minutes into a play session.
 */

/** Sprite table stand-in: fixed 16x16 metrics, no image decoding. */
function stubSprites(): SpriteTable {
  const sprite = {
    name: 'stub',
    anims: [],
    width: 16,
    height: 16,
    originX: 0.5,
    originY: 0.5,
    generated: true,
  };
  return {
    missing: [],
    id: () => 0,
    has: () => true,
    get: () => sprite,
    anim: () => ({
      source: null as unknown as CanvasImageSource,
      frameW: 16,
      frameH: 16,
      frames: 1,
      fps: 8,
      loop: true,
      duration: 1,
    }),
    iconCanvas: () => null as unknown as HTMLCanvasElement,
  } as unknown as SpriteTable;
}

/** Open, unbounded map with no collision — the meadow case. */
function stubMap(): TileMap {
  return {
    name: 'test',
    tileSize: 16,
    bounds: null,
    spawnX: 0,
    spawnY: 0,
    wavesTable: 'default',
    solids: [],
    hasCollision: false,
    clampToBounds: (x: number, y: number) => [x, y] as [number, number],
    resolveSolids: (x: number, y: number) => [x, y] as [number, number],
    resolveTiles: (x: number, y: number) => [x, y] as [number, number],
    isSolidTile: () => false,
  } as unknown as TileMap;
}

function stubInput(axisX = 0, axisY = 0): Input {
  return { axisX, axisY } as unknown as Input;
}

interface Harness {
  ctx: Ctx;
  spawner: Spawner;
  /** Advances the simulation by `seconds`, resolving level-ups automatically. */
  run(seconds: number, input?: Input): void;
  levelUpsTaken: number;
}

function makeHarness(characterId = CHARACTER_LIST[0]!.id, seed = 12345): Harness {
  const world = new World();
  const run = new Run(characterId);
  const ctx: Ctx = {
    world,
    run,
    sprites: stubSprites(),
    fx: new Fx(),
    camera: new Camera(),
    map: stubMap(),
    rng: new Rng(seed),
    bus: new EventBus<GameEvents>(),
    wave: waveTable('default'),
    player: -1,
    aimX: 1,
    aimY: 0,
    enemyHash: new SpatialHash(),
    pickupHash: new SpatialHash(),
    scratch: new Int32Array(MAX_QUERY_RESULTS),
    scratchInner: new Int32Array(MAX_QUERY_RESULTS),
    hpScale: 1,
    damageScale: 1,
    speedScale: 1,
  };
  ctx.player = spawnPlayer(ctx, 0, 0);

  const spawner = new Spawner();
  const harness: Harness = {
    ctx,
    spawner,
    levelUpsTaken: 0,
    run(seconds: number, input: Input = stubInput()) {
      const ticks = Math.round(seconds / FIXED_DT);
      for (let i = 0; i < ticks; i++) {
        run.time += FIXED_DT;

        const difficulty = difficultyAt(ctx, run.time);
        ctx.hpScale = difficulty.hp;
        ctx.damageScale = difficulty.damage;
        ctx.speedScale = difficulty.speed;

        world.snapshotPositions();
        ctx.enemyHash.build(world, world.list(Kind.Enemy));

        updatePlayer(ctx, FIXED_DT, input);
        spawner.update(ctx, FIXED_DT);
        updateEnemies(ctx, FIXED_DT);

        ctx.enemyHash.build(world, world.list(Kind.Enemy));

        updateEnemyProjectiles(ctx, FIXED_DT);
        updateWeapons(ctx, FIXED_DT);
        updatePlayerProjectiles(ctx, FIXED_DT);
        updateHazards(ctx, FIXED_DT);

        ctx.pickupHash.build(world, world.list(Kind.Pickup));
        updatePickups(ctx, FIXED_DT);

        ctx.fx.update(FIXED_DT);
        world.flush();

        // Stand in for the level-up screen: always take the first offer.
        let guard = 0;
        while (run.pendingLevelUps > 0 && guard++ < 50) {
          const offers = rollOffers(ctx);
          expect(offers.length).toBeGreaterThan(0);
          applyOffer(ctx, offers[0]!);
          harness.levelUpsTaken++;
        }
      }
    },
  };
  return harness;
}

describe('content', () => {
  it('loads every content file into usable defs', () => {
    expect(CHARACTER_LIST.length).toBeGreaterThan(0);
    expect(WEAPON_LIST.length).toBeGreaterThan(0);
    expect(enemyDef('bat')).not.toBeNull();
    expect(waveTable('default').stages.length).toBeGreaterThan(0);
  });

  it('accumulates weapon level deltas and clamps past max level', () => {
    const whip = WEAPON_LIST.find((w) => w.id === 'whip')!;
    const level1 = weaponStatsAtLevel(whip, 1);
    const level2 = weaponStatsAtLevel(whip, 2);
    const max = weaponStatsAtLevel(whip, whip.maxLevel);
    const beyond = weaponStatsAtLevel(whip, whip.maxLevel + 20);

    expect(level2.damage).toBeGreaterThan(level1.damage);
    expect(max.damage).toBeGreaterThan(level2.damage);
    // Asking for a level above the ceiling must not keep stacking deltas.
    expect(beyond.damage).toBe(max.damage);
  });

  it('gives every wave stage at least one spawnable enemy', () => {
    for (const stage of waveTable('default').stages) {
      expect(stage.enemies.length).toBeGreaterThan(0);
    }
  });
});

describe('progression', () => {
  it('requires strictly more xp at each level', () => {
    for (let level = 1; level < 40; level++) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
  });

  it('banks multiple level-ups from one oversized xp grant', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    const gained = run.gainXp(500);
    expect(gained).toBeGreaterThan(1);
    expect(run.pendingLevelUps).toBe(gained);
  });

  it('recomputes derived stats from passive levels', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    const baseMight = run.stats.might;
    const baseHp = run.stats.maxHp;

    run.addPassive('whetstone');
    expect(run.stats.might).toBeGreaterThan(baseMight);

    run.addPassive('vitalember');
    expect(run.stats.maxHp).toBeGreaterThan(baseHp);
    // The health delta is reported so the caller can grant it as current hp.
    expect(run.maxHpDelta).toBeGreaterThan(0);
  });

  it('never exceeds the slot caps, however many offers are taken', () => {
    const harness = makeHarness();
    const { run, ctx } = { run: harness.ctx.run, ctx: harness.ctx };
    for (let i = 0; i < 200; i++) {
      run.pendingLevelUps = 1;
      const offers = rollOffers(ctx);
      applyOffer(ctx, offers[0]!);
    }
    expect(run.weapons.length).toBeLessThanOrEqual(6);
    expect(run.passives.length).toBeLessThanOrEqual(6);
    for (const weapon of run.weapons) {
      expect(weapon.level).toBeLessThanOrEqual(weapon.def.maxLevel);
    }
    for (const passive of run.passives) {
      expect(passive.level).toBeLessThanOrEqual(passive.def.maxLevel);
    }
  });

  it('always offers something, even with a fully maxed loadout', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    // Force every weapon and passive to its ceiling.
    for (let i = 0; i < 400; i++) {
      const offers = rollOffers(ctx);
      applyOffer(ctx, offers[0]!);
    }
    const offers = rollOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });
});

describe('simulation', () => {
  it('spawns enemies, kills them, and awards experience', () => {
    const harness = makeHarness();
    harness.run(30);

    const { world, run } = harness.ctx;
    expect(world.list(Kind.Enemy).length).toBeGreaterThan(0);
    expect(run.kills).toBeGreaterThan(0);
    expect(run.level).toBeGreaterThan(1);
    expect(harness.levelUpsTaken).toBeGreaterThan(0);
  });

  // Simulating the whole run is 54,000 ticks with hundreds of live entities, so
  // it needs far more than the default per-test budget.
  it('survives a full fifteen-minute run without stalling or leaking entities', { timeout: 120_000 }, () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;

    // Immortal player: this test is about the systems, not about balance.
    const originalHp = () => {
      world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
    };

    let maxEntities = 0;
    const victory = ctx.wave.victorySeconds;
    const chunk = 15;
    for (let elapsed = 0; elapsed < victory; elapsed += chunk) {
      originalHp();
      // Stationary: the player is standing in the horde, which is the highest
      // contact and highest entity-count case. Running in a straight line
      // instead would outpace most enemies and understate the load.
      harness.run(chunk);
      maxEntities = Math.max(maxEntities, world.entityCount);
      // The pool is 16384; anything approaching that is a leak, not load.
      expect(world.entityCount).toBeLessThan(4000);
    }

    // Summing 1/60 fifty-four thousand times drifts by a fraction of a tick,
    // so compare with a tolerance rather than exactly.
    expect(ctx.run.time).toBeGreaterThan(victory - FIXED_DT);
    expect(ctx.run.kills).toBeGreaterThan(500);
    expect(ctx.run.level).toBeGreaterThan(20);
    expect(world.list(Kind.Enemy).length).toBeLessThanOrEqual(ctx.wave.maxAlive);
    expect(maxEntities).toBeGreaterThan(0);
  });

  it('respects the concurrent enemy cap', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    // Skip to the densest stage and let it run.
    ctx.run.time = 860;
    ctx.world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;
    harness.run(20);
    expect(ctx.world.list(Kind.Enemy).length).toBeLessThanOrEqual(ctx.wave.maxAlive);
  });

  it('damages the player on contact and can kill them', () => {
    const harness = makeHarness();
    const { ctx, world } = { ctx: harness.ctx, world: harness.ctx.world };

    let died = false;
    ctx.bus.on('player:died', () => {
      died = true;
    });

    // Park a wall of brutes on top of a player with no revives left.
    ctx.run.revivesLeft = 0;
    const brute = enemyDef('brute')!;
    for (let i = 0; i < 12; i++) {
      spawnEnemy(ctx, brute, 0, 0);
    }
    harness.run(12);

    expect(died || world.hp[ctx.player]! < ctx.run.stats.maxHp).toBe(true);
  });

  it('fires every weapon behaviour without error', () => {
    for (const def of WEAPON_LIST) {
      const harness = makeHarness();
      const { ctx } = harness;
      // Replace the starting loadout with just this weapon, at max level.
      ctx.run.weapons.length = 0;
      ctx.run.addWeapon(def.id);
      const owned = ctx.run.weapons[0]!;
      owned.level = def.maxLevel;

      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;

      const before = ctx.run.kills;
      harness.run(20);
      // Every weapon should be able to kill something in 20 seconds of spawns.
      expect(ctx.run.kills, `${def.id} scored no kills`).toBeGreaterThan(before);
    }
  });

  it('collects gems and converts them to experience', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const bat = enemyDef('bat')!;
    for (let i = 0; i < 20; i++) spawnEnemy(ctx, bat, 12, 0);

    const xpBefore = ctx.run.level * 1000 + ctx.run.xp;
    harness.run(6);
    const xpAfter = ctx.run.level * 1000 + ctx.run.xp;
    expect(xpAfter).toBeGreaterThan(xpBefore);
  });

  it('recycles entity ids and invalidates stale handles', () => {
    const world = new World();
    const a = world.create(Kind.Enemy);
    const handle = world.handleOf(a);
    expect(world.resolve(handle)).toBe(a);

    world.destroy(a);
    world.flush();
    expect(world.resolve(handle)).toBe(-1);

    const b = world.create(Kind.Enemy);
    // The id is reused, but the old handle must not resolve to the new entity.
    expect(b).toBe(a);
    expect(world.resolve(handle)).toBe(-1);
    expect(world.resolve(world.handleOf(b))).toBe(b);
  });
});

describe('difficulty scaling', () => {
  it('increases monotonically over a run', () => {
    const harness = makeHarness();
    let previous = difficultyAt(harness.ctx, 0);
    for (let t = 30; t <= 900; t += 30) {
      const current = difficultyAt(harness.ctx, t);
      expect(current.hp).toBeGreaterThan(previous.hp);
      expect(current.damage).toBeGreaterThan(previous.damage);
      previous = current;
    }
  });
});
