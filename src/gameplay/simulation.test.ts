import { describe, expect, it, vi } from 'vitest';

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
import {
  BLOOD_CONFIG,
  CHARACTER_LIST,
  WEAPON_LIST,
  enemyDef,
  normalizeBlood,
  waveTable,
  weaponStatsAtLevel,
} from './content.ts';
import { updateEnemies, updateEnemyProjectiles, spawnEnemy } from './enemies.ts';
import { damageEnemy } from './damage.ts';
import { spawnPlayer, updatePlayer } from './player.ts';
import { PickupKind, spawnBloodVial, updatePickups } from './pickups.ts';
import { Run, xpForLevel } from './run.ts';
import { Spawner, difficultyAt } from './spawner.ts';
import { applyOffer, rollOffers } from './upgrades.ts';
import { effectiveStats, updateHazards, updatePlayerProjectiles, updateWeapons } from './weapons.ts';
import { updateBlood } from './blood.ts';
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
    bloodIntent: null,
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
        updateBlood(ctx, FIXED_DT);

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

describe('blood economy', () => {
  it('normalizes blood.json into a typed config with the design defaults', () => {
    expect(BLOOD_CONFIG.barMax).toBe(100);
    expect(BLOOD_CONFIG.threshold).toBe(50);
    expect(BLOOD_CONFIG.intakePerSec).toBe(12);
    expect(BLOOD_CONFIG.decayPerSec).toBeCloseTo(1.5);
    expect(BLOOD_CONFIG.decayGrace).toBe(4);
    expect(BLOOD_CONFIG.healPerBlood).toBeCloseTo(0.005);
    expect(BLOOD_CONFIG.vialValue).toBe(25);
    expect(BLOOD_CONFIG.frenzy.baseDuration).toBe(3);
    expect(BLOOD_CONFIG.frenzy.durationPerBlood).toBeCloseTo(0.06);
    expect(BLOOD_CONFIG.frenzy.mightMult).toBeCloseTo(1.4);
    expect(BLOOD_CONFIG.frenzy.cooldownMult).toBeCloseTo(0.75);
    expect(BLOOD_CONFIG.frenzy.moveSpeedMult).toBeCloseTo(1.15);
    expect(BLOOD_CONFIG.frenzy.novaDamage).toBe(30);
    expect(BLOOD_CONFIG.frenzy.novaRadius).toBe(80);
  });

  it('clamps out-of-range blood.json values and warns instead of throwing', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      const cfg = normalizeBlood({
        barMax: 0,
        threshold: 999,
        intakePerSec: -5,
        decayPerSec: -1,
        decayGrace: -2,
        healPerBlood: -0.1,
        vialValue: -25,
        frenzy: 'not an object',
      });

      expect(cfg.barMax).toBe(1); // a zero-width bar would divide by zero in the HUD
      expect(cfg.threshold).toBe(1); // squeezed into [1, barMax]
      expect(cfg.intakePerSec).toBe(0);
      expect(cfg.decayPerSec).toBe(0);
      expect(cfg.decayGrace).toBe(0);
      expect(cfg.healPerBlood).toBe(0);
      expect(cfg.vialValue).toBe(0);
      // A malformed frenzy block falls back wholesale, and says so.
      expect(cfg.frenzy.baseDuration).toBe(3);
      expect(cfg.frenzy.novaRadius).toBe(80);
      expect(warnings.some((w) => w.includes('frenzy'))).toBe(true);
      for (const key of [
        'barMax',
        'threshold',
        'intakePerSec',
        'decayPerSec',
        'decayGrace',
        'healPerBlood',
        'vialValue',
      ]) {
        expect(warnings.some((w) => w.includes(`"${key}"`))).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults per-enemy blood by tier and honours explicit values', () => {
    expect(enemyDef('bat')!.blood).toBe(1);          // normal default
    expect(enemyDef('swarmling')!.blood).toBe(0.5);  // explicit in enemies.json
    expect(enemyDef('brute')!.blood).toBe(8);        // elite default
    expect(enemyDef('warden')!.blood).toBe(8);       // boss default
  });

  it('folds bloodGain from character defaults and the Bloodthirst passive', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    expect(run.stats.bloodGain).toBe(1);
    run.addPassive('bloodthirst');
    expect(run.stats.bloodGain).toBeCloseTo(1.1);
  });

  it('caps blood intake inside one window and clamps at the bar max', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    expect(run.gainBlood(5)).toBe(5);
    expect(run.blood).toBe(5);
    expect(run.graceT).toBe(BLOOD_CONFIG.decayGrace);

    // 5 already absorbed this window; only 7 more fit under the 12/sec cap.
    expect(run.gainBlood(100)).toBe(BLOOD_CONFIG.intakePerSec - 5);
    expect(run.blood).toBe(BLOOD_CONFIG.intakePerSec);
    expect(run.gainBlood(1)).toBe(0);

    // A fresh window still clamps at the bar max.
    run.bloodIntakeWindow = 0;
    run.blood = run.bloodMax - 2;
    expect(run.gainBlood(10)).toBe(2);
    expect(run.blood).toBe(run.bloodMax);
  });

  it('lets an uncapped gain bypass the intake window but still clamp to the bar', () => {
    const run = new Run(CHARACTER_LIST[0]!.id);
    run.bloodIntakeWindow = BLOOD_CONFIG.intakePerSec; // window already exhausted
    run.graceT = 0;

    // The window neither limits the uncapped grant nor absorbs any of it, so a
    // capped gain later in the same second still has its full allowance spent.
    expect(run.gainBlood(25, true)).toBe(25);
    expect(run.blood).toBe(25);
    expect(run.bloodIntakeWindow).toBe(BLOOD_CONFIG.intakePerSec);
    expect(run.graceT).toBe(BLOOD_CONFIG.decayGrace); // uncapped still refreshes grace

    // The bar maximum is the one limit an uncapped gain still respects.
    run.blood = run.bloodMax - 3;
    expect(run.gainBlood(25, true)).toBe(3);
    expect(run.blood).toBe(run.bloodMax);
    expect(run.gainBlood(25, true)).toBe(0);
  });

  it('grants blood per enemy def on kill and signals readiness at the threshold', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    let readyFired = false;
    let gainedEvents = 0;
    ctx.bus.on('blood:ready', () => {
      readyFired = true;
    });
    ctx.bus.on('blood:gained', () => {
      gainedEvents++;
    });

    const bat = enemyDef('bat')!;
    const swarmling = enemyDef('swarmling')!;
    const ids = [
      spawnEnemy(ctx, bat, 60, 0),
      spawnEnemy(ctx, bat, 70, 0),
      spawnEnemy(ctx, bat, 80, 0),
      spawnEnemy(ctx, swarmling, 90, 0),
      spawnEnemy(ctx, swarmling, 100, 0),
    ];
    for (const id of ids) damageEnemy(ctx, id, 1e9, 0, 0, 0, false);

    // 3 x 1 + 2 x 0.5 with bloodGain 1, all inside the intake window.
    expect(ctx.run.blood).toBeCloseTo(4);
    expect(gainedEvents).toBe(5);
    expect(readyFired).toBe(false);

    // Crossing the threshold announces readiness exactly once.
    ctx.run.blood = BLOOD_CONFIG.threshold - 1;
    const last = spawnEnemy(ctx, bat, 110, 0);
    damageEnemy(ctx, last, 1e9, 0, 0, 0, false);
    expect(ctx.run.blood).toBeCloseTo(BLOOD_CONFIG.threshold);
    expect(readyFired).toBe(true);
  });

  it('discards blood above the per-second intake cap', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const bat = enemyDef('bat')!;
    for (let i = 0; i < 100; i++) {
      const id = spawnEnemy(ctx, bat, 300 + (i % 10) * 8, 300 + Math.floor(i / 10) * 8);
      damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    }
    // 100 blood offered inside one window; everything past the cap is gone.
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);
  });

  it('drops a Blood Vial from elites that collects past the intake cap', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // weapon kills would add blood of their own

    // Collection: the vial is a burst reward, so it skips the anti-farm window
    // entirely — the whole value lands even with the window already spent.
    ctx.run.bloodIntakeWindow = BLOOD_CONFIG.intakePerSec;
    spawnBloodVial(ctx, 0, 0);
    harness.run(FIXED_DT * 2);
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.vialValue);
    expect(ctx.run.graceT).toBe(BLOOD_CONFIG.decayGrace);

    // Drop: an elite kill leaves a vial pickup behind, worth the configured value.
    const brute = enemyDef('brute')!;
    const id = spawnEnemy(ctx, brute, 300, 0);
    damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    const vial = world
      .list(Kind.Pickup)
      .find((p) => world.defIndex[p] === PickupKind.BloodVial && world.x[p]! > 200);
    expect(vial).toBeDefined();
    expect(world.value[vial!]).toBe(BLOOD_CONFIG.vialValue);
  });

  it('feast consumes all banked blood and heals per blood spent', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    const feasts: Array<{ spent: number; healed: number }> = [];
    ctx.bus.on('blood:feast', (p) => {
      feasts.push(p);
    });

    world.hp[ctx.player] = 10;
    ctx.run.blood = 100;
    ctx.bloodIntent = 'heal';
    harness.run(FIXED_DT);

    // 100 blood x 0.005 x 100 maxHp = 50 hp healed.
    expect(world.hp[ctx.player]).toBeCloseTo(60);
    expect(ctx.run.blood).toBe(0);
    expect(ctx.bloodIntent).toBeNull();
    expect(feasts).toHaveLength(1);
    expect(feasts[0]!.spent).toBe(100);
    expect(feasts[0]!.healed).toBeCloseTo(50);
  });

  it('reports the healing a feast actually applied, not the amount requested', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    const feasts: Array<{ spent: number; healed: number }> = [];
    ctx.bus.on('blood:feast', (p) => {
      feasts.push(p);
    });

    const maxHp = ctx.run.stats.maxHp;
    world.hp[ctx.player] = maxHp - 5; // room for 5 of the 50 hp a full bar buys
    ctx.run.blood = 100;
    ctx.bloodIntent = 'heal';
    harness.run(FIXED_DT);

    const requested = 100 * BLOOD_CONFIG.healPerBlood * maxHp;
    expect(world.hp[ctx.player]).toBeCloseTo(maxHp);
    expect(feasts).toHaveLength(1);
    expect(feasts[0]!.spent).toBe(100);
    // The payload is the delta that reached the player, so overheal never
    // inflates the number the HUD shows.
    expect(feasts[0]!.healed).toBeCloseTo(5);
    expect(feasts[0]!.healed).toBeLessThan(requested);
  });

  it('ignores and clears blood intent below the spend threshold', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 40;
    ctx.run.blood = 30;
    ctx.bloodIntent = 'heal';
    harness.run(FIXED_DT);
    expect(world.hp[ctx.player]).toBeCloseTo(40);
    expect(ctx.run.blood).toBe(30);
    expect(ctx.bloodIntent).toBeNull();
  });

  it('decays banked blood to just below the threshold after the grace period', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills, so nothing refreshes the grace timer
    world.hp[ctx.player] = 1e9; // stray contact damage must not end the test
    ctx.run.stats.maxHp = 1e9;
    ctx.run.blood = 60; // set directly: graceT stays 0, decay starts immediately
    harness.run(8);
    // 8s x 1.5/s = 12 wanted; the floor stops it at threshold - 1.
    expect(ctx.run.blood).toBeCloseTo(BLOOD_CONFIG.threshold - 1);
  });

  it('holds banked blood through the decay grace after a real gain, then bleeds it down', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // only the scripted kills may feed the bar
    world.hp[ctx.player] = 1e9; // stray contact damage must not end the test
    ctx.run.stats.maxHp = 1e9;

    // Sit one point under the decay floor, then bank the rest through the real
    // kill path so gainBlood — not the test — is what arms the grace timer.
    ctx.run.blood = BLOOD_CONFIG.threshold - 1;
    const brute = enemyDef('brute')!; // 8 blood each, so two fill the 12/sec window
    for (const at of [300, 320]) {
      const id = spawnEnemy(ctx, brute, at, 300);
      damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    }
    const banked = ctx.run.blood;
    expect(banked).toBeCloseTo(BLOOD_CONFIG.threshold - 1 + BLOOD_CONFIG.intakePerSec);
    expect(ctx.run.graceT).toBe(BLOOD_CONFIG.decayGrace);

    // Inside the 4-second grace, blood is untouched even with no further kills.
    harness.run(3);
    expect(ctx.run.blood).toBeCloseTo(banked);
    expect(ctx.run.graceT).toBeCloseTo(BLOOD_CONFIG.decayGrace - 3, 3);

    // Past the grace it starts bleeding, but not instantly.
    harness.run(2);
    expect(ctx.run.graceT).toBe(0);
    expect(ctx.run.blood).toBeLessThan(banked);
    expect(ctx.run.blood).toBeGreaterThan(BLOOD_CONFIG.threshold - 1);

    // And it settles on the ready-minus-one floor rather than draining away.
    harness.run(20);
    expect(ctx.run.blood).toBeCloseTo(BLOOD_CONFIG.threshold - 1);
  });

  it('reopens the intake window on the next sim-second', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    ctx.run.weapons.length = 0; // weapon kills would muddy the exact count
    const bat = enemyDef('bat')!;
    for (let i = 0; i < 30; i++) {
      const id = spawnEnemy(ctx, bat, 300 + i * 6, 300);
      damageEnemy(ctx, id, 1e9, 0, 0, 0, false);
    }
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);

    harness.run(1.1); // run.time crosses a whole second → window resets
    const straggler = spawnEnemy(ctx, bat, 300, 300);
    damageEnemy(ctx, straggler, 1e9, 0, 0, 0, false);
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec + 1);
  });

  it('casts a blood nova on frenzy that clears a ring around the player', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    const bat = enemyDef('bat')!;

    // A ring inside the nova radius (80) but outside whip reach, plus one
    // enemy well outside the nova that must survive.
    const ring: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 60, Math.sin(a) * 60);
      world.hp[id] = 1;
      ring.push(id);
    }
    const outside = spawnEnemy(ctx, bat, 200, 0);
    world.hp[outside] = 1;

    const frenzies: Array<{ spent: number; duration: number }> = [];
    ctx.bus.on('blood:frenzy', (p) => {
      frenzies.push(p);
    });

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT);

    // 3s base + 0.06 x 100 = 9s. updateBlood runs the countdown BEFORE it
    // consumes the intent, so the value is exact right after the cast tick.
    expect(ctx.run.frenzyT).toBeCloseTo(9, 5);
    expect(frenzies).toHaveLength(1);
    expect(frenzies[0]!.spent).toBe(100);
    expect(frenzies[0]!.duration).toBeCloseTo(9, 5);
    for (const id of ring) expect(world.isAlive(id)).toBe(false);
    expect(world.isAlive(outside)).toBe(true);
  });

  it('frenzy multiplies weapon stats read-side and reverts on expiry without touching run.stats', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills → no level-ups → run.stats must stay put
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    // A detached OwnedWeapon: effectiveStats is pure, so this probes the
    // multiplier without letting a real weapon kill anything.
    const whip = WEAPON_LIST.find((w) => w.id === 'whip')!;
    const owned = { def: whip, level: 1, cooldown: 0, activeIds: [], activeTimer: 0, active: false };
    const calm = effectiveStats(ctx.run, owned);
    const statsBefore = JSON.stringify(ctx.run.stats);

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT);

    expect(ctx.run.frenzyT).toBeGreaterThan(0);
    const frenzied = effectiveStats(ctx.run, owned);
    expect(frenzied.damage).toBeCloseTo(calm.damage * BLOOD_CONFIG.frenzy.mightMult);
    expect(frenzied.cooldown).toBeCloseTo(calm.cooldown * BLOOD_CONFIG.frenzy.cooldownMult);
    // The invariant: the buff never wrote through to run.stats.
    expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);

    harness.run(9.5); // outlive the 9-second frenzy
    expect(ctx.run.frenzyT).toBe(0);
    const after = effectiveStats(ctx.run, owned);
    expect(after.damage).toBeCloseTo(calm.damage);
    expect(after.cooldown).toBeCloseTo(calm.cooldown);
    expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);
  });

  it('frenzy speeds the player up read-side', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    ctx.run.blood = 100;
    ctx.bloodIntent = 'burst';
    harness.run(FIXED_DT); // consume the intent; frenzy is now active

    const x0 = world.x[ctx.player]!;
    harness.run(FIXED_DT, stubInput(1, 0));
    const dx = world.x[ctx.player]! - x0;
    expect(dx).toBeCloseTo(
      ctx.run.stats.moveSpeed * BLOOD_CONFIG.frenzy.moveSpeedMult * FIXED_DT,
      5,
    );
  });
});
