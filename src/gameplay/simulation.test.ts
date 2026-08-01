import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../core/events.ts';
import type { GameEvents } from '../core/events.ts';
import { Rng } from '../core/rng.ts';
import { FIXED_DT } from '../core/loop.ts';
import { Comp, Kind, Team } from '../ecs/components.ts';
import { World } from '../ecs/world.ts';
import bastionMap from '../content/maps/bastion.json';
import { Camera } from '../render/camera.ts';
import { Fx } from '../render/fx.ts';
import type { SpriteTable } from '../render/sprites.ts';
import type { Solid, TileMap } from '../render/tilemap.ts';
import type { Input } from '../core/input.ts';

import { MAX_QUERY_RESULTS, SpatialHash } from './collision.ts';
import {
  BLOOD_CONFIG,
  CHARACTER_LIST,
  META_LIST,
  STRUCTURE_LIST,
  WEAPON_LIST,
  characterDef,
  enemyDef,
  metaNodeDef,
  normalizeAbility,
  normalizeBlood,
  normalizeMeta,
  structureDef,
  structureDefByIndex,
  waveTable,
  weaponStatsAtLevel,
} from './content.ts';
import type { MetaMods, StructureDef } from './content.ts';
import { updateEnemies, updateEnemyProjectiles, spawnEnemy } from './enemies.ts';
import { damageEnemy } from './damage.ts';
import { spawnPlayer, updatePlayer } from './player.ts';
import { PickupKind, spawnBloodVial, spawnCoin, spawnGem, updatePickups } from './pickups.ts';
import { withinEngagement } from './damage.ts';
import { Run, xpForLevel } from './run.ts';
import { Spawner, difficultyAt } from './spawner.ts';
import { damageStructure, spawnStructure, updateStructures } from './structures.ts';
import { applyOffer, rollOffers } from './upgrades.ts';
import { effectiveStats, spawnHazard, updateHazards, updatePlayerProjectiles, updateWeapons } from './weapons.ts';
import { updateBlood } from './blood.ts';
import { abilityStats, updateAbility } from './abilities.ts';
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
  const solids: Solid[] = [];
  return {
    name: 'test',
    tileSize: 16,
    bounds: null,
    spawnX: 0,
    spawnY: 0,
    wavesTable: 'default',
    solids,
    structures: [],
    hasCollision: false,
    clampToBounds: (x: number, y: number) => [x, y] as [number, number],
    resolveSolids: (x: number, y: number) => [x, y] as [number, number],
    resolveTiles: (x: number, y: number) => [x, y] as [number, number],
    isSolidTile: () => false,
    // Functional mini-implementation of TileMap's runtime-solid contract (not
    // no-ops) so headless tests can prove the gate-breach bookkeeping.
    // hasCollision stays false, so movement in tests is unchanged.
    addRuntimeSolid: (x: number, y: number, r: number) => {
      solids.push({ x, y, r });
      return solids.length - 1;
    },
    removeRuntimeSolid: (index: number) => {
      const solid = solids[index];
      if (solid) solid.r = 0;
    },
    clearRuntimeSolids: () => {
      solids.length = 0;
    },
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

function makeHarness(characterId = CHARACTER_LIST[0]!.id, seed = 12345, metaMods: MetaMods = {}): Harness {
  const world = new World();
  const run = new Run(characterId, metaMods);
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
    abilityQueued: false,
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

        updateAbility(ctx, FIXED_DT);
        updateEnemyProjectiles(ctx, FIXED_DT);
        updateWeapons(ctx, FIXED_DT);
        updatePlayerProjectiles(ctx, FIXED_DT);
        updateHazards(ctx, FIXED_DT);
        updateStructures(ctx, FIXED_DT);

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
          applyOffer(ctx, offers[0]!, offers);
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
      applyOffer(ctx, offers[0]!, offers);
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
      applyOffer(ctx, offers[0]!, offers);
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

describe('active abilities', () => {
  it('normalizes a valid ability block and defaults missing params', () => {
    const def = normalizeAbility(
      { name: 'Test Nova', kind: 'nova', cooldown: 15, params: { damage: 40, count: 10 } },
      'test',
    )!;
    expect(def).not.toBeNull();
    expect(def.kind).toBe('nova');
    expect(def.cooldown).toBe(15);
    expect(def.params.damage).toBe(40);
    expect(def.params.count).toBe(10);
    // Missing params fall back to per-key defaults rather than exploding.
    expect(def.params.pierce).toBe(1);
    expect(def.params.lifetime).toBe(1);
    expect(def.sprite).toBe('proj_bolt');
    expect(def.mods).toEqual({});
  });

  it('omits abilities with unknown kinds and warns instead of throwing', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      // Unknown kind: the ability is dropped, the character stays playable.
      expect(normalizeAbility({ name: 'Bad', kind: 'summon' }, 'test')).toBeNull();
      expect(normalizeAbility('not an object', 'test')).toBeNull();
      expect(warnings.some((w) => w.includes('summon'))).toBe(true);
      // Unknown mod keys are dropped with a warning; valid ones survive.
      const buff = normalizeAbility(
        { name: 'B', kind: 'buff', cooldown: 25, duration: 5, mods: { armor: 10, banana: 3 } },
        'test',
      )!;
      expect(buff.mods).toEqual({ armor: 10 });
      expect(warnings.some((w) => w.includes('banana'))).toBe(true);
      // No ability block at all is legal and silent.
      expect(normalizeAbility(undefined, 'test')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('warns and falls back to a 5s duration for buff/volley kinds missing one', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      // duration <= 0 is fail-soft, not fatal: the ability survives with a
      // sane fallback rather than shipping a buff/volley that can never end.
      const buff = normalizeAbility({ name: 'B', kind: 'buff', cooldown: 25, duration: 0 }, 'test')!;
      expect(buff.duration).toBe(5);
      expect(warnings.some((w) => w.includes('buff') && w.includes('duration'))).toBe(true);

      const volley = normalizeAbility({ name: 'V', kind: 'volley', cooldown: 20 }, 'test')!;
      expect(volley.duration).toBe(5);

      // Kinds that don't need a duration (nova, zone, dash) are unaffected by
      // a missing one — they stay at 0, no warning.
      warnings.length = 0;
      const nova = normalizeAbility({ name: 'N', kind: 'nova', cooldown: 15 }, 'test')!;
      expect(nova.duration).toBe(0);
      expect(warnings).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives every character a gothic kit with a whitelisted ability', () => {
    const expected: Record<string, string> = {
      wanderer: 'nova',      // Ser Valen — Crimson Cleave
      acolyte: 'volley',     // Lady Morrigan — Night Swarm
      warden_knight: 'buff', // Ser Aldric — Sanguine Bulwark
      outrider: 'dash',      // Vespera — Mist Dash
      dragos: 'zone',        // Castellan Dragos — Unhallowed Ground
    };
    expect(CHARACTER_LIST).toHaveLength(5);
    for (const [id, kind] of Object.entries(expected)) {
      const character = CHARACTER_LIST.find((c) => c.id === id);
      expect(character, `missing character "${id}"`).toBeDefined();
      expect(character!.ability, `"${id}" has no ability`).not.toBeNull();
      expect(character!.ability!.kind).toBe(kind);
    }
  });

  it('keeps every kit inside the ability guardrails', () => {
    for (const character of CHARACTER_LIST) {
      const a = character.ability!;
      expect(a, `${character.id} lost its ability in normalization`).not.toBeNull();
      expect(a.cooldown, `${character.id} cooldown`).toBeGreaterThanOrEqual(12);
      expect(a.cooldown, `${character.id} cooldown`).toBeLessThanOrEqual(30);
      if (a.kind === 'buff') {
        // Uptime ≤ 40%: cooldown at least 2.5x the buff window.
        expect(a.cooldown).toBeGreaterThanOrEqual(2.5 * a.duration);
      }
      if (a.kind === 'dash') {
        expect(a.params.distance).toBeLessThanOrEqual(100);
        expect(a.duration, `${character.id} iframes`).toBeLessThanOrEqual(0.8);
      }
      if (a.kind === 'nova' || a.kind === 'volley') {
        expect(a.params.count, `${character.id} pool pressure`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('ships Castellan Dragos as the bloodGain 1.25 vampire-lord', () => {
    const dragos = CHARACTER_LIST.find((c) => c.id === 'dragos')!;
    expect(dragos.stats.bloodGain).toBeCloseTo(1.25);
    expect(dragos.stats.area).toBeCloseTo(1.2);
    expect(dragos.stats.duration).toBeCloseTo(1.2);
    expect(dragos.stats.maxHp).toBe(120);
    expect(dragos.startingWeapon).toBe('brazier');
    // bloodGain multiplies kill grants BEFORE the intake cap in gainBlood —
    // the Run-level unit proof that the multiplier reached the stat sheet.
    const run = new Run('dragos');
    expect(run.stats.bloodGain).toBeCloseTo(1.25);
  });

  it('seeds Run.ability ready-to-cast from the character def', () => {
    const run = new Run('wanderer');
    expect(run.ability).not.toBeNull();
    expect(run.ability!.def.name).toBe('Crimson Cleave');
    expect(run.ability!.cooldownLeft).toBe(0); // ready from the first tick
    expect(run.ability!.activeLeft).toBe(0);
    expect(run.ability!.burstLeft).toBe(0);
  });

  it('builds ability stats scaled by might, area and duration only', () => {
    const run = new Run('dragos'); // area 1.2, duration 1.2
    // Doctor the sheet with non-neutral multipliers so every claim below is
    // discriminating. Dragos ships might=1, projectileSpeed=1, amount=0 and
    // cooldown=1, so against the stock sheet the damage assertion and all
    // three NOT-scaled assertions compare against neutral values — an
    // abilityStats that copied effectiveStats wholesale (the exact mistake
    // the guardrail warns against) would still pass.
    run.stats = { ...run.stats, might: 1.5, projectileSpeed: 2, amount: 3, cooldown: 0.5 };
    const def = run.character.ability!;
    const stats = abilityStats(run, def);
    expect(stats.damage).toBeCloseTo(def.params.damage * 1.5); // might applies
    expect(stats.radius).toBeCloseTo(def.params.radius * run.stats.area); // 55 x 1.2 = 66
    expect(stats.lifetime).toBeCloseTo(def.params.lifetime * run.stats.duration); // 6 x 1.2 = 7.2
    // Explicitly NOT scaled: the guardrail says might/area/duration only.
    expect(stats.speed).toBe(def.params.speed); // projectileSpeed x2 does not apply
    expect(stats.count).toBe(def.params.count); // amount +3 does not apply
    expect(stats.pierce).toBe(def.params.pierce);
    expect(stats.knockback).toBe(def.params.knockback);
    expect(stats.interval).toBe(def.params.interval); // cooldown x0.5 does not apply
  });

  it('applies frenzy to ability damage read-side, like effectiveStats', () => {
    const run = new Run('wanderer');
    const def = run.character.ability!;
    const calm = abilityStats(run, def);
    run.frenzyT = 5;
    const frenzied = abilityStats(run, def);
    expect(frenzied.damage).toBeCloseTo(calm.damage * BLOOD_CONFIG.frenzy.mightMult);
    run.frenzyT = 0;
    // Reverts with the timer; run.stats was never written.
    expect(abilityStats(run, def).damage).toBeCloseTo(calm.damage);
  });

  it('nova: fires Crimson Cleave as a ring of player projectiles on the latched press', () => {
    const harness = makeHarness('wanderer');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no weapon noise in the projectile list
    // The ability cooldown must ignore the cooldown stat entirely (guardrail).
    ctx.run.stats.cooldown = 0.5;

    const used: Array<{ name: string; kind: string; cooldown: number }> = [];
    ctx.bus.on('ability:used', (p) => {
      used.push(p);
    });

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    const blades = world.list(Kind.Projectile).filter((id) => world.team[id] === Team.Player);
    expect(blades.length).toBe(10);
    expect(ctx.abilityQueued).toBe(false); // latch consumed by the sim
    expect(used).toHaveLength(1);
    expect(used[0]!.name).toBe('Crimson Cleave');
    // 18s flat: neither run.stats.cooldown (0.5) nor anything else scaled it.
    // Exact, not 18 - FIXED_DT: updateAbility decrements the cooldown BEFORE
    // consuming the latch, so nothing ticks it down on the cast tick itself —
    // the same consume-after-tick ordering the Phase 1 frenzyT test asserts.
    expect(ctx.run.ability!.cooldownLeft).toBe(18);

    // The blades actually cut: something in the surrounding ring dies.
    const bat = enemyDef('bat')!;
    ctx.run.ability!.cooldownLeft = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 40, Math.sin(a) * 40);
      world.hp[id] = 1;
    }
    const kills = ctx.run.kills;
    ctx.abilityQueued = true;
    harness.run(0.5);
    expect(ctx.run.kills).toBeGreaterThan(kills);
  });

  it('drops an ability press made during cooldown instead of banking it', () => {
    const harness = makeHarness('wanderer');
    const { ctx } = harness;
    ctx.run.weapons.length = 0;
    let used = 0;
    ctx.bus.on('ability:used', () => {
      used++;
    });

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(used).toBe(1);

    // Pressed again inside the 18s cooldown: consumed and dropped, not banked.
    ctx.abilityQueued = true;
    harness.run(1);
    expect(used).toBe(1);
    expect(ctx.abilityQueued).toBe(false);

    // Once the cooldown is over, a fresh press casts again.
    let ready = 0;
    ctx.bus.on('ability:ready', () => {
      ready++;
    });
    ctx.run.ability!.cooldownLeft = FIXED_DT; // fast-forward to the last tick
    harness.run(FIXED_DT * 2);
    expect(ready).toBe(1);
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(used).toBe(2);
  });

  it('volley: paces Night Swarm bats across the burst window', () => {
    const harness = makeHarness('acolyte');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    const state = ctx.run.ability!;
    // First bat leaves on the activation tick; eleven remain queued.
    expect(state.burstLeft).toBe(11);
    // Exact on the cast tick: the cooldown decrement runs before the latch is
    // consumed, so the fresh 20s value survives the tick untouched.
    expect(state.cooldownLeft).toBe(20);
    expect(
      world.list(Kind.Projectile).filter((id) => world.team[id] === Team.Player).length,
    ).toBeGreaterThanOrEqual(1);

    // Halfway through the 2.4s window roughly half the swarm is out — paced,
    // not dumped in one tick. (Range absorbs one tick of float drift.)
    harness.run(1.2);
    expect(state.burstLeft).toBeGreaterThanOrEqual(4);
    expect(state.burstLeft).toBeLessThanOrEqual(6);

    // Past the window the full dozen has launched.
    harness.run(1.5);
    expect(state.burstLeft).toBe(0);
  });

  it('zone: Unhallowed Ground damages a ring over time and its blood obeys the intake cap', () => {
    const harness = makeHarness('dragos');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    world.hp[ctx.player] = 1e9;
    ctx.run.stats.maxHp = 1e9;

    const bat = enemyDef('bat')!;
    const ring: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const id = spawnEnemy(ctx, bat, Math.cos(a) * 40, Math.sin(a) * 40);
      world.hp[id] = 1;
      ring.push(id);
    }

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    const zone = world.list(Kind.Hazard).find((id) => world.team[id] === Team.Player);
    expect(zone).toBeDefined();
    expect(world.radius[zone!]).toBeCloseTo(55 * 1.2); // radius x area stat = 66
    expect(world.lifetime[zone!]).toBeCloseTo(6 * 1.2, 1); // lifetime x duration stat

    harness.run(0.5);
    for (const id of ring) expect(world.isAlive(id)).toBe(false);
    // The cap seam, stated: 12 kills x 1 blood x bloodGain 1.25 = 15 offered,
    // but gainBlood multiplies BEFORE the per-second intake cap — the 3 above
    // the 12/sec window are discarded, exactly the Phase 1 semantics.
    expect(ctx.run.blood).toBe(BLOOD_CONFIG.intakePerSec);
  });

  it('buff: Sanguine Bulwark recomputes stats on state change only and restores them exactly', () => {
    const harness = makeHarness('warden_knight');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0; // no kills -> no level-ups -> no third-party recomputes
    world.hp[ctx.player] = 50;

    const armorBefore = ctx.run.stats.armor; // 2
    const statsBefore = JSON.stringify(ctx.run.stats);
    const spy = vi.spyOn(ctx.run, 'recomputeStats');
    try {
      ctx.abilityQueued = true;
      harness.run(FIXED_DT);
      expect(ctx.run.stats.armor).toBe(armorBefore + 10);
      // +20 instant heal plus one tick of Aldric's recovery 0.3: updatePlayer's
      // regen runs BEFORE updateAbility in the tick, so the cast tick has
      // already added 0.3 x FIXED_DT (= 0.005) hp when the heal lands.
      expect(world.hp[ctx.player]).toBeCloseTo(70 + 0.3 * FIXED_DT, 3);
      expect(spy).toHaveBeenCalledTimes(1); // activation

      // Ride out the 5s window plus a margin: exactly one more recompute (expiry),
      // and the stat sheet is byte-identical to before the cast — the invariant
      // that the buff never wrote through and never drifted the derived stats.
      harness.run(5.1);
      expect(ctx.run.stats.armor).toBe(armorBefore);
      expect(JSON.stringify(ctx.run.stats)).toBe(statsBefore);
      expect(spy).toHaveBeenCalledTimes(2); // activation + expiry, never per tick
    } finally {
      spy.mockRestore();
    }
  });

  it('buff: expiry clamps hp to the restored cap when a mod raised maxHp', () => {
    const harness = makeHarness('warden_knight');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    // Hand-built def swap: a maxHp buff instead of Bulwark's armor-only kit,
    // proving the expiry clamp holds for any mod combo, not just the shipped
    // one. Copy, not mutate: def.mods stays a fresh object either way.
    const baseDef = ctx.run.ability!.def;
    ctx.run.ability!.def = { ...baseDef, mods: { maxHpMul: 0.5 }, params: { ...baseDef.params, heal: 0 } };

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(ctx.run.stats.maxHp).toBeCloseTo(210); // 140 base x 1.5

    // Overfill relative to the restored (unbuffed) cap while the buff's
    // raised cap is still active.
    world.hp[ctx.player] = 200;

    harness.run(5.1); // ride out the buff window past expiry
    expect(ctx.run.stats.maxHp).toBeCloseTo(140); // restored to base
    expect(world.hp[ctx.player]).toBeLessThanOrEqual(140);
  });

  it('buff: the instant heal clamps at max health and reports what landed', () => {
    const harness = makeHarness('warden_knight');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;
    const heals: number[] = [];
    ctx.bus.on('player:healed', (p) => {
      heals.push(p.amount);
    });

    const maxHp = ctx.run.stats.maxHp; // 140
    world.hp[ctx.player] = maxHp - 5; // room for 5 of the 20 the kit grants
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    // healPlayer clamps at run.stats.maxHp; overheal is discarded and the
    // event reports the landed delta, not the requested 20 (cap contract).
    expect(world.hp[ctx.player]).toBeCloseTo(maxHp);
    expect(heals).toHaveLength(1);
    // updatePlayer's recovery regen (0.3 x FIXED_DT) landed before the cast on
    // the same tick, so the heal tops up 5 minus that sliver — not a flat 5.
    expect(heals[0]).toBeCloseTo(5 - 0.3 * FIXED_DT, 3);
  });

  it('dash: Mist Dash travels the configured distance, grants iframes and drops a mist trail', () => {
    const harness = makeHarness('outrider');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;

    // Aim persists from init (1, 0); the player stands still (stub input).
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    expect(world.x[ctx.player]).toBeCloseTo(80);
    expect(world.y[ctx.player]).toBeCloseTo(0);
    // Direct x/y write, deliberately NOT world.place: prev stays at the dash
    // origin, so the renderer lerps the dash across one frame (a fast smear).
    // place() would snap with no motion. This assertion is the tripwire.
    expect(world.prevX[ctx.player]).toBeCloseTo(0);
    // iframes = def.duration; set after updatePlayer ran, so exact this tick.
    expect(world.iframe[ctx.player]).toBeCloseTo(0.6, 5);

    const trail = world.list(Kind.Hazard).filter((id) => world.team[id] === Team.Player);
    expect(trail).toHaveLength(3);
    const xs = trail.map((id) => world.x[id]!).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(20);
    expect(xs[1]).toBeCloseTo(40);
    expect(xs[2]).toBeCloseTo(60);
  });

  it('dash: routes through map clamping', () => {
    const harness = makeHarness('outrider');
    const { ctx } = harness;
    ctx.run.weapons.length = 0;
    // A wall at x=30: if the dash teleported without consulting the map,
    // the player would land at 80.
    (ctx.map as { clampToBounds: (x: number, y: number, r: number) => [number, number] }).clampToBounds =
      (x: number, y: number) => [Math.min(x, 30), y];

    ctx.abilityQueued = true;
    harness.run(FIXED_DT);
    expect(ctx.world.x[ctx.player]).toBeCloseTo(30);
  });

  it('dash: never shortens an existing longer iframe window', () => {
    const harness = makeHarness('outrider');
    const { ctx } = harness;
    const world = ctx.world;
    ctx.run.weapons.length = 0;

    // The revive path grants 2.5s of iframes; panic-dashing inside that window
    // must extend-or-keep, never truncate to the dash's 0.6s.
    world.iframe[ctx.player] = 2.5;
    ctx.abilityQueued = true;
    harness.run(FIXED_DT);

    // updatePlayer ticks iframes down by dt before the cast resolves; the dash
    // then takes max(existing, 0.6) — the revive window survives.
    expect(world.iframe[ctx.player]).toBeCloseTo(2.5 - FIXED_DT, 5);
  });

  it('activates every character kit without error and engages its cooldown', () => {
    for (const character of CHARACTER_LIST) {
      const harness = makeHarness(character.id);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;

      const used: string[] = [];
      ctx.bus.on('ability:used', (p) => {
        used.push(p.kind);
      });

      ctx.abilityQueued = true;
      harness.run(1);

      const state = ctx.run.ability;
      expect(state, `${character.id} has no ability state`).not.toBeNull();
      expect(used, `${character.id} did not cast`).toHaveLength(1);
      expect(used[0]).toBe(character.ability!.kind);
      expect(state!.cooldownLeft).toBeCloseTo(state!.def.cooldown - 1, 1);
      expect(ctx.abilityQueued).toBe(false);
    }
  });

  it('keeps seeded runs deterministic with an ability cast mid-run', () => {
    const fingerprint = () => {
      const harness = makeHarness('dragos', 4242);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(5);
      ctx.abilityQueued = true;
      harness.run(25);
      return [
        ctx.run.kills,
        ctx.run.blood,
        ctx.run.gold,
        ctx.run.level,
        ctx.world.entityCount,
        ctx.run.ability!.cooldownLeft,
      ];
    };
    // Identical seed + identical inputs => identical world. Any Math.random or
    // wall-clock leak in the ability path breaks this instantly.
    expect(fingerprint()).toEqual(fingerprint());
  });

  // The design-§2 leak variant: the pre-existing 15-minute test never presses
  // the ability, so this is the only bound on ability entity pressure (nova
  // ring + zone + dash-trail hazards, cycle after cycle). Mirrors the existing
  // leak test's shape: immortal player, chunked run, 4000-entity ceiling.
  it('does not leak entities over a 15-minute run that auto-presses the ability', { timeout: 120_000 }, () => {
    const harness = makeHarness('dragos', 4242);
    const { ctx } = harness;
    const world = ctx.world;
    const victory = ctx.wave.victorySeconds;
    const chunk = 15;
    for (let elapsed = 0; elapsed < victory; elapsed += chunk) {
      world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      // Cast whenever the ability is off cooldown at a chunk boundary.
      if (ctx.run.ability!.cooldownLeft === 0) ctx.abilityQueued = true;
      harness.run(chunk);
      // The pool is 16384; anything approaching that is a leak, not load.
      expect(world.entityCount).toBeLessThan(4000);
    }
    expect(ctx.run.time).toBeGreaterThan(victory - FIXED_DT);
  });
});

describe('castle defense', () => {
  /**
   * Stands the shipped bastion layout up on the stub map (which carries no
   * structures of its own), reading the placements out of the map file rather
   * than restating them — so a structure added to bastion.json is a structure
   * the full-run tests actually simulate.
   */
  function standUpBastion(ctx: Ctx): void {
    for (const s of bastionMap.structures as { type: string; x: number; y: number }[]) {
      spawnStructure(ctx, structureDef(s.type)!, s.x, s.y);
    }
  }

  it('registers Kind.Structure as a seventh kind with its own live list', () => {
    const world = new World();
    const id = world.create(Kind.Structure);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(world.kind[id]).toBe(Kind.Structure);
    expect(world.list(Kind.Structure)).toContain(id);
    // The other kind lists are untouched by the new kind.
    expect(world.list(Kind.Enemy)).toHaveLength(0);
  });

  it('resets targetHandle on recycled ids and resolves stale handles to -1', () => {
    const world = new World();
    const structure = world.create(Kind.Structure);
    const enemy = world.create(Kind.Enemy);
    const stale = world.handleOf(structure);
    world.targetHandle[enemy] = stale;

    world.destroy(structure);
    world.flush();
    // Generation bump: the handle is dead even before the id is reused.
    expect(world.resolve(stale)).toBe(-1);

    world.destroy(enemy);
    world.flush();
    const recycled = world.create(Kind.Enemy);
    // The freelist is LIFO, so the enemy id comes straight back — the classic
    // recycled-id stale-value trap the create() reset line exists to close.
    expect(recycled).toBe(enemy);
    expect(world.targetHandle[recycled]).toBe(-1);
  });

  it('normalizes structure defs and fails soft on unknown ids', () => {
    // gate, shrine, tower — the count tripwire for structures.json.
    expect(STRUCTURE_LIST).toHaveLength(3);

    const gate = structureDef('gate')!;
    expect(gate).not.toBeNull();
    expect(gate.name).toBe('Bastion Gate');
    expect(gate.hp).toBe(300);
    expect(gate.radius).toBe(14);
    expect(gate.solid).toBe(true);
    expect(gate.gold).toBe(25);
    expect(gate.index).toBe(0);

    const shrine = structureDef('shrine')!;
    expect(shrine.solid).toBe(false);
    expect(shrine.gold).toBe(40);

    // Unknown id: warn-don't-throw, null return — the caller skips the spawn.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(structureDef('barbican')).toBeNull();
    } finally {
      spy.mockRestore();
    }

    // Index lookup mirrors enemyDefByIndex: out of range falls back to entry 0.
    expect(structureDefByIndex(0).id).toBe('gate');
    expect(structureDefByIndex(99).id).toBe('gate');
  });

  it('keeps structure-less maps untouched: a default run spawns no structures', () => {
    // The meadow case: no "structures" array in the map, no sieges in the
    // table. Everything that shipped in Phases 1-2 must behave identically.
    const harness = makeHarness();
    harness.run(30);
    const { ctx } = harness;
    expect(ctx.map.structures).toHaveLength(0);
    expect(ctx.world.list(Kind.Structure)).toHaveLength(0);
    expect(ctx.world.isAlive(ctx.player)).toBe(true);
    expect(ctx.run.kills).toBeGreaterThan(0);
  });

  it('damages a structure through the hit pipeline and reports each hit', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const gate = structureDef('gate')!;
    const id = spawnStructure(ctx, gate, 80, 0);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(ctx.world.team[id]).toBe(Team.Player);
    expect(ctx.world.maxHp[id]).toBe(gate.hp);
    // The gate registered a runtime solid at its own radius; the pip slot is 0.
    expect(ctx.map.solids).toHaveLength(1);
    expect(ctx.map.solids[0]!.r).toBe(gate.radius);
    expect(ctx.world.aiPhase[id]).toBe(0);

    const events: { hp: number; maxHp: number; index: number }[] = [];
    ctx.bus.on('structure:damaged', (e) => events.push(e));
    damageStructure(ctx, id, 40);
    expect(ctx.world.hp[id]).toBe(gate.hp - 40);
    expect(ctx.world.hitFlash[id]).toBeGreaterThan(0);
    expect(events).toEqual([{ hp: gate.hp - 40, maxHp: gate.hp, index: 0 }]);
  });

  it('destroys a fallen structure: solid tombstoned, penalty banked, event fired', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const gate = structureDef('gate')!;
    const gateId = spawnStructure(ctx, gate, 80, 0);
    spawnStructure(ctx, structureDef('shrine')!, -80, 0);
    // Only the gate is solid; the shrine is walk-through.
    expect(ctx.map.solids).toHaveLength(1);

    const destroyed: { name: string; remaining: number; index: number }[] = [];
    ctx.bus.on('structure:destroyed', (e) => destroyed.push(e));
    damageStructure(ctx, gateId, gate.hp);

    expect(destroyed).toEqual([{ name: 'Bastion Gate', remaining: 1, index: 0 }]);
    expect(ctx.run.structuresLost).toBe(1);
    // Gate breach opens the wall: the solid is disabled in place, not spliced.
    expect(ctx.map.solids).toHaveLength(1);
    expect(ctx.map.solids[0]!.r).toBe(0);
    // Deferred destruction: dead immediately, recycled at flush.
    expect(ctx.world.isAlive(gateId)).toBe(false);
    ctx.world.flush();
    expect(ctx.world.list(Kind.Structure)).toHaveLength(1);
  });

  it('runs structures through the tick with hit-flash decay and free interpolation', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const id = spawnStructure(ctx, structureDef('gate')!, 60, 0);
    damageStructure(ctx, id, 10);
    expect(ctx.world.hitFlash[id]).toBeGreaterThan(0);

    harness.run(1);

    // updateStructures ran: the flash decayed to zero over the second.
    expect(ctx.world.hitFlash[id]).toBe(0);
    expect(ctx.world.isAlive(id)).toBe(true);
    // Static entity: snapshotPositions keeps prev == current every tick.
    expect(ctx.world.prevX[id]).toBe(ctx.world.x[id]);
    expect(ctx.world.prevY[id]).toBe(ctx.world.y[id]);
  });

  it('marches a siege enemy to the wall, parks it, and swings on the 0.8s cadence', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    // Empty field: no stage spawns muddying the assertions.
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    // Player parked far away: outside peel range, contact damage irrelevant.
    world.place(ctx.player, -400, 0);
    world.hp[ctx.player] = 1e9;

    const gate = structureDef('gate')!;
    const gateId = spawnStructure(ctx, gate, 120, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 40, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    harness.run(8);

    // Parked at a stable standoff just outside the touch radius, not culled,
    // not orbiting the player.
    expect(world.isAlive(zombie)).toBe(true);
    const dist = Math.hypot(world.x[gateId]! - world.x[zombie]!, world.y[gateId]! - world.y[zombie]!);
    const touch = world.radius[zombie]! + world.radius[gateId]! + 0.5;
    expect(dist).toBeLessThanOrEqual(touch);
    expect(dist).toBeGreaterThan(touch - 3);

    // ~5.5s of contact at the 0.8s cadence: several whole swings landed, each
    // for exactly the zombie's contact damage — never a per-tick shred.
    const lost = gate.hp - world.hp[gateId]!;
    const perSwing = world.damage[zombie]!;
    expect(lost).toBeGreaterThanOrEqual(3 * perSwing);
    expect(lost).toBeLessThan(gate.hp);
    expect(lost % perSwing).toBe(0);
  });

  it('peels a siege enemy off the gate when the player closes in', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;

    const gateId = spawnStructure(ctx, structureDef('gate')!, 200, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 150, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    // The player steps to 40u from the attacker — inside the 56u peel radius.
    world.place(ctx.player, 110, 0);
    harness.run(0.5);

    // The siege order is dropped and the zombie hunts the player again
    // (the player is to its left, so its velocity points left).
    expect(world.targetHandle[zombie]).toBe(-1);
    expect(world.vx[zombie]).toBeLessThan(0);
  });

  it('retargets to the player after its structure falls', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -200, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 100, 0);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 60, 0);
    world.targetHandle[zombie] = world.handleOf(gateId);

    damageStructure(ctx, gateId, 1e9); // the gate falls
    harness.run(1);                    // flush recycles it; the handle dies

    expect(world.targetHandle[zombie]).toBe(-1);
    // Marching at the player again (player at -200: velocity points left).
    expect(world.vx[zombie]).toBeLessThan(0);
  });

  it('never lets a stale handle point at a recycled id', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -300, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 100, 0);
    const staleHandle = world.handleOf(gateId);
    const zombie = spawnEnemy(ctx, enemyDef('zombie')!, 50, 0);
    world.targetHandle[zombie] = staleHandle;

    damageStructure(ctx, gateId, 1e9);
    world.flush(); // recycle immediately, mid-scenario
    const squatter = world.create(Kind.Enemy);
    // LIFO freelist hands the gate's id straight back — the recycle trap.
    expect(squatter).toBe(gateId);
    // The generation bump means the stale handle can never reach the squatter.
    expect(world.resolve(staleHandle)).toBe(-1);

    harness.run(0.5);
    // updateEnemies saw the dead handle and cleared it — no misdirected attacks.
    expect(world.targetHandle[zombie]).toBe(-1);
    expect(world.hp[squatter]).toBe(1); // the squatter was never "attacked"
  });

  it('exempts enemies with a live siege target from distance culling', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    world.hp[ctx.player] = 1e9;

    // Both enemies are ~680u from the player at (0,0) — past CULL_DISTANCE 620.
    const gateId = spawnStructure(ctx, structureDef('gate')!, 700, 0);
    const attacker = spawnEnemy(ctx, enemyDef('zombie')!, 680, 0);
    world.targetHandle[attacker] = world.handleOf(gateId);
    const wanderer = spawnEnemy(ctx, enemyDef('zombie')!, 680, 40);

    harness.run(1);

    // The siege order holds the attacker on the field; the untargeted twin
    // is silently culled on the first tick.
    expect(world.isAlive(attacker)).toBe(true);
    expect(world.isAlive(wanderer)).toBe(false);
  });

  it('parses siege schedules with defaults and keeps default siege-free', () => {
    // The optionality tripwire for waves: shipping maps on the default table
    // keep their exact spawn stream — no sieges materialize from nowhere.
    expect(waveTable('default').sieges).toEqual([]);

    const bastion = waveTable('bastion');
    expect(bastion.sieges.length).toBeGreaterThanOrEqual(3);
    for (const siege of bastion.sieges) {
      expect(enemyDef(siege.type), `unknown siege enemy "${siege.type}"`).not.toBeNull();
      expect(siege.count).toBeGreaterThanOrEqual(1);
      expect(siege.duration).toBeGreaterThanOrEqual(1);
    }
    // Sorted by time so the spawner can walk a cursor through them.
    for (let i = 1; i < bastion.sieges.length; i++) {
      expect(bastion.sieges[i]!.at).toBeGreaterThanOrEqual(bastion.sieges[i - 1]!.at);
    }
  });

  it('spawns a siege wave aimed at the nearest living structure', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;

    const gateId = spawnStructure(ctx, structureDef('gate')!, 150, 0);
    const shrineId = spawnStructure(ctx, structureDef('shrine')!, -150, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 6, duration: 30 }],
    };

    let started = 0;
    ctx.bus.on('siege:started', ({ duration }) => {
      started++;
      expect(duration).toBe(30);
    });

    harness.run(2);

    expect(started).toBe(1);
    const enemies = world.list(Kind.Enemy);
    expect(enemies).toHaveLength(6);
    for (const id of enemies) {
      // Every attacker holds a live handle to one of the two structures.
      const target = world.resolve(world.targetHandle[id]!);
      expect([gateId, shrineId]).toContain(target);
    }
  });

  it('degrades a siege to player-chasers on a structure-less map', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    ctx.world.hp[ctx.player] = 1e9;
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 5, duration: 20 }],
    };

    harness.run(2);

    // No structures anywhere: the siege still spawns, nobody crashes, and
    // every attacker simply hunts the player (handle stays -1).
    const enemies = ctx.world.list(Kind.Enemy);
    expect(enemies).toHaveLength(5);
    for (const id of enemies) {
      expect(ctx.world.targetHandle[id]).toBe(-1);
    }
  });

  it('pays out a chest and gold when the siege window closes with a survivor', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;
    // Player parked far from the reward site so the chest is not auto-collected.
    world.place(ctx.player, -400, 0);

    spawnStructure(ctx, structureDef('gate')!, 300, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 1, duration: 5 }],
    };

    const defended: { gold: number }[] = [];
    ctx.bus.on('siege:defended', (e) => defended.push(e));

    harness.run(8); // window opens at 1s, closes at 6s; the lone zombie never reaches the gate

    expect(defended).toEqual([{ gold: structureDef('gate')!.gold }]);
    const pickups = world.list(Kind.Pickup).map((id) => world.defIndex[id]);
    expect(pickups).toContain(PickupKind.Chest);
    expect(pickups).toContain(PickupKind.Coin);
  });

  it('pays nothing when every structure fell before the window closed', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const world = ctx.world;
    world.hp[ctx.player] = 1e9;
    world.place(ctx.player, -400, 0);

    const gateId = spawnStructure(ctx, structureDef('gate')!, 300, 0);
    ctx.wave = {
      ...waveTable('default'),
      stages: [],
      elites: null,
      bosses: [],
      sieges: [{ at: 1, type: 'zombie', count: 1, duration: 5 }],
    };
    const defended: unknown[] = [];
    ctx.bus.on('siege:defended', (e) => defended.push(e));

    harness.run(2);
    damageStructure(ctx, gateId, 1e9); // the gate falls mid-siege
    harness.run(6);                    // the window closes with nothing standing

    expect(defended).toEqual([]);
    expect(ctx.run.structuresLost).toBe(1);
    const pickups = world.list(Kind.Pickup).map((id) => world.defIndex[id]);
    expect(pickups).not.toContain(PickupKind.Chest);
    // Not a fail state: the run continues, only the difficulty penalty banks.
    expect(world.isAlive(ctx.player)).toBe(true);
  });

  it('raises damage and speed difficulty by 8% per lost wall', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const base = difficultyAt(ctx, 60);

    ctx.run.wallsLost = 2;
    const bolder = difficultyAt(ctx, 60);

    // hp is untouched: sponginess would punish weapons, aggression punishes
    // the player — the penalty should feel like the latter.
    expect(bolder.hp).toBe(base.hp);
    expect(bolder.damage).toBeCloseTo(base.damage * 1.16);
    expect(bolder.speed).toBeCloseTo(base.speed * 1.16);
  });

  it('scores walls, not guns: a fallen tower costs its guns and no difficulty', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const base = difficultyAt(ctx, 60);

    const tower = spawnStructure(ctx, structureDef('tower')!, 120, 0);
    damageStructure(ctx, tower, 1e9);

    // The loss is still counted honestly...
    expect(ctx.run.structuresLost).toBe(1);
    // ...it just is not what the horde is scored on.
    expect(ctx.run.wallsLost).toBe(0);
    const after = difficultyAt(ctx, 60);
    expect(after.damage).toBeCloseTo(base.damage);
    expect(after.speed).toBeCloseTo(base.speed);

    // A wall on the same map still moves it, so the penalty is exempted for
    // emplacements rather than switched off.
    const gate = spawnStructure(ctx, structureDef('gate')!, -120, 0);
    damageStructure(ctx, gate, 1e9);
    expect(ctx.run.wallsLost).toBe(1);
    expect(difficultyAt(ctx, 60).damage).toBeCloseTo(base.damage * 1.08);
  });

  it('holds the bastion penalty ceiling at 1.16x with every shipped structure down', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const base = difficultyAt(ctx, 60);

    // The map file itself, not a synthetic count: adding structures to
    // bastion.json must never move this ceiling by accident again.
    const placed = bastionMap.structures as { type: string; x: number; y: number }[];
    for (const s of placed) {
      damageStructure(ctx, spawnStructure(ctx, structureDef(s.type)!, s.x, s.y), 1e9);
    }

    const walls = placed.filter((s) => structureDef(s.type)!.range === 0);
    expect(placed).toHaveLength(4);
    expect(walls).toHaveLength(2);
    expect(ctx.run.structuresLost).toBe(placed.length);
    expect(ctx.run.wallsLost).toBe(walls.length);

    const worst = difficultyAt(ctx, 60);
    expect(worst.damage).toBeCloseTo(base.damage * (1 + 0.08 * walls.length));
    expect(worst.damage).toBeCloseTo(base.damage * 1.16);
    expect(worst.speed).toBeCloseTo(base.speed * 1.16);
  });

  it('keeps a seeded bastion siege deterministic', { timeout: 60_000 }, () => {
    const fingerprint = (): number[] => {
      const harness = makeHarness('wanderer', 777);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      ctx.wave = waveTable('bastion');
      // The stub map has no structures; stand the real bastion layout up
      // manually, towers included — their fire, their bolts and their ctx.rng
      // draws are part of what has to come out identical.
      standUpBastion(ctx);
      harness.run(150); // covers the 120s siege start plus 30s of fighting
      let structureHp = 0;
      for (const sid of ctx.world.list(Kind.Structure)) {
        structureHp += ctx.world.hp[sid]!;
      }
      return [
        ctx.run.kills,
        ctx.run.gold,
        ctx.run.structuresLost,
        ctx.world.entityCount,
        Math.round(structureHp),
      ];
    };
    // Identical seed => identical world. Any Math.random or wall-clock leak in
    // the siege path (spawn points, targeting, rewards) breaks this instantly.
    expect(fingerprint()).toEqual(fingerprint());
  });

  it('does not leak entities over a full bastion run with sieges', { timeout: 120_000 }, () => {
    const harness = makeHarness('wanderer', 4242);
    const { ctx } = harness;
    const world = ctx.world;
    ctx.wave = waveTable('bastion');
    standUpBastion(ctx);
    const placed = (bastionMap.structures as unknown[]).length;

    const victory = ctx.wave.victorySeconds;
    const chunk = 15;
    for (let elapsed = 0; elapsed < victory; elapsed += chunk) {
      world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(chunk);
      // The cull exemption must never balloon the field: siege durations are
      // bounded, so attackers either die, land their handle on a corpse and
      // resume normal culling, or the window ends. 4000 = leak, not load.
      expect(world.entityCount).toBeLessThan(4000);
    }
    expect(ctx.run.time).toBeGreaterThan(victory - FIXED_DT);

    // Counter coherence across the whole run: every spawned structure is
    // either lost or still alive — no double-counts, no ghosts.
    let aliveStructures = 0;
    for (const sid of world.list(Kind.Structure)) {
      if (world.isAlive(sid)) aliveStructures++;
    }
    expect(placed).toBe(4);
    expect(ctx.run.structuresLost + aliveStructures).toBe(placed);
    // Only walls feed the difficulty penalty, so the counter it actually reads
    // can never run past the walls the map shipped.
    expect(ctx.run.wallsLost).toBeLessThanOrEqual(2);

    // Balance tripwire: a full seeded run banked ~603 gold once the bastion's
    // two watchtowers were part of it (~253 with the phase-3 pair alone — the
    // towers earn their keep in kills). Half-to-double catches order-of-
    // magnitude economy regressions without pinning every balance tweak.
    expect(ctx.run.gold).toBeGreaterThan(300);
    expect(ctx.run.gold).toBeLessThan(1200);
  });
});

describe('watchtowers', () => {
  /**
   * A field with nothing on it but the tower, its target and a disarmed player:
   * every projectile that exists is one the tower fired, so the counts below
   * mean what they say.
   */
  function towerField(): { harness: Harness; ctx: Ctx; def: StructureDef } {
    const harness = makeHarness();
    const { ctx } = harness;
    ctx.wave = { ...waveTable('default'), stages: [], elites: null, bosses: [] };
    // Disarm the player: the tower is then the only projectile source alive.
    ctx.run.weapons.length = 0;
    ctx.world.hp[ctx.player] = 1e5;
    return { harness, ctx, def: structureDef('tower')! };
  }

  /** A target that stays put, so range and cadence assertions stay honest. */
  function pinnedEnemy(ctx: Ctx, x: number, y: number, hp = 5000): number {
    const id = spawnEnemy(ctx, enemyDef('zombie')!, x, y);
    ctx.world.speed[id] = 0;
    ctx.world.hp[id] = hp;
    return id;
  }

  it('normalizes the watchtower as an armed structure and leaves gate and shrine passive', () => {
    const tower = structureDef('tower')!;
    expect(tower.name).toBe('Watchtower');
    expect(tower.hp).toBe(140);
    expect(tower.radius).toBe(10);
    expect(tower.solid).toBe(true);
    expect(tower.gold).toBe(30);
    expect(tower.range).toBe(170);
    expect(tower.shootInterval).toBeCloseTo(1.4);
    expect(tower.projectileDamage).toBe(14);
    expect(tower.projectileSpeed).toBe(190);
    expect(tower.projectileLifetime).toBeCloseTo(1.2);
    expect(tower.projectileSprite).toBe('proj_bolt');
    // A bolt must outlive the range it was fired across, or shots at the rim
    // expire in mid-air.
    expect(tower.projectileSpeed * tower.projectileLifetime).toBeGreaterThan(tower.range);

    // range is the armed/unarmed switch: the phase-3 pair keeps its old shape.
    expect(structureDef('gate')!.range).toBe(0);
    expect(structureDef('shrine')!.range).toBe(0);
    // ...and still gets safe defaults for the fields their JSON omits, so a
    // half-written content entry can never divide by zero or fire forever.
    expect(structureDef('gate')!.shootInterval).toBeGreaterThan(0);
    expect(structureDef('gate')!.projectileLifetime).toBeGreaterThan(0);
  });

  it('arms a tower at spawn and leaves the gate a passive wall', () => {
    const { ctx, def } = towerField();
    const tower = spawnStructure(ctx, def, 40, 0);
    const gate = spawnStructure(ctx, structureDef('gate')!, -40, 0);

    expect(ctx.world.has(tower, Comp.Shooter)).toBe(true);
    expect(ctx.world.has(gate, Comp.Shooter)).toBe(false);
    // hitCooldown is the fire timer, zeroed by World.create: a fresh tower is
    // loaded and shoots the first thing that walks into range.
    expect(ctx.world.hitCooldown[tower]).toBe(0);
  });

  it('shoots a player-team bolt at an enemy inside its range', () => {
    const { harness, ctx, def } = towerField();
    const world = ctx.world;
    const tower = spawnStructure(ctx, def, 300, 0);
    pinnedEnemy(ctx, 380, 0);

    harness.run(FIXED_DT * 2);

    const bolts = world.list(Kind.Projectile);
    expect(bolts).toHaveLength(1);
    const bolt = bolts[0]!;
    // Team.Player is the whole point: only player-team projectiles are resolved
    // against the enemy hash, so an enemy-team bolt could damage nothing.
    expect(world.team[bolt]).toBe(Team.Player);
    expect(world.damage[bolt]).toBe(def.projectileDamage);
    expect(Math.hypot(world.vx[bolt]!, world.vy[bolt]!)).toBeCloseTo(def.projectileSpeed);
    expect(world.vx[bolt]).toBeGreaterThan(0);
    // Fired from the crenellations, so it aims down at a target on the ground.
    expect(world.vy[bolt]).toBeGreaterThan(0);
    // The shot started the reload, which has been running since (one tick).
    expect(world.hitCooldown[tower]).toBeLessThanOrEqual(def.shootInterval);
    expect(world.hitCooldown[tower]).toBeGreaterThan(def.shootInterval - 3 * FIXED_DT);
  });

  it('holds fire when the nearest enemy is outside its range', () => {
    const { harness, ctx, def } = towerField();
    const tower = spawnStructure(ctx, def, 300, 0);
    pinnedEnemy(ctx, 300 + def.range + 30, 0);

    harness.run(2);

    expect(ctx.world.list(Kind.Projectile)).toHaveLength(0);
    // Idle time does not bank: the timer never drifts negative and the tower
    // never owes itself shots. It rests on the 100ms rescan interval rather
    // than at zero, so an idle tower is not re-querying the hash every tick.
    expect(ctx.world.hitCooldown[tower]).toBeGreaterThan(0);
    // 0.11, not 0.1: hitCooldown is a Float32Array, so the stored interval
    // reads back a hair above the literal.
    expect(ctx.world.hitCooldown[tower]).toBeLessThan(0.11);
  });

  it('throttles its hash queries while the field is clear, and fires the moment it is not', () => {
    const { harness, ctx, def } = towerField();
    // Count the sweeps the tower costs: same field twice, once with the tower
    // and once without, so every other per-tick query cancels out.
    const sweeps = (withTower: boolean): number => {
      const field = towerField();
      const hash = field.ctx.enemyHash;
      const real = hash.query.bind(hash);
      let calls = 0;
      hash.query = (x: number, y: number, r: number, out: Int32Array): number => {
        calls++;
        return real(x, y, r, out);
      };
      if (withTower) spawnStructure(field.ctx, def, 300, 0);
      // Far out of range: the tower sweeps, finds nothing, and sleeps.
      pinnedEnemy(field.ctx, 300 + def.range + 200, 0);
      field.harness.run(3);
      return calls;
    };
    const ticks = Math.round(3 / FIXED_DT);
    const idleSweeps = sweeps(true) - sweeps(false);
    // One sweep per 0.1s rather than one per tick — a full order of magnitude
    // below the 180 an unthrottled tower ran here.
    expect(idleSweeps).toBeGreaterThan(0);
    expect(idleSweeps).toBeLessThan(ticks / 4);

    // The throttle is a rescan interval, not a hold: a target that walks in is
    // engaged within it, and the first bolt still carries the full damage.
    spawnStructure(ctx, def, 300, 0);
    harness.run(1); // the tower goes idle and starts resting on the interval
    expect(ctx.world.list(Kind.Projectile)).toHaveLength(0);

    const zombie = pinnedEnemy(ctx, 350, 0);
    harness.run(0.1 + FIXED_DT);
    const fired = ctx.world.list(Kind.Projectile);
    expect(fired).toHaveLength(1);
    expect(ctx.world.damage[fired[0]!]).toBe(def.projectileDamage);
    harness.run(0.5); // flight time across the 50px gap
    expect(ctx.world.hp[zombie]).toBe(5000 - def.projectileDamage);
  });

  it('cannot friendly-fire the wall it guards or the player standing under it', () => {
    const { harness, ctx, def } = towerField();
    const world = ctx.world;
    const gateDef = structureDef('gate')!;
    spawnStructure(ctx, def, 300, 0);
    const gate = spawnStructure(ctx, gateDef, 330, 0);
    const zombie = pinnedEnemy(ctx, 360, 0);
    const playerHp = world.hp[ctx.player]!;

    harness.run(3);

    // Bolts fly straight over the gate and land on the enemy behind it.
    expect(world.hp[zombie]).toBeLessThan(5000);
    expect(world.hp[gate]).toBe(gateDef.hp);
    expect(world.hp[ctx.player]).toBe(playerHp);
  });

  it('fires on its own cadence with numbers no passive, level, frenzy or crit can touch', () => {
    const { harness, ctx, def } = towerField();
    const world = ctx.world;
    // Everything that scales the player's own damage, cranked to absurdity —
    // crits included: guaranteed and quintupled, so if a single tower bolt
    // could crit this assertion would come back 5x.
    ctx.run.stats.might = 10;
    ctx.run.frenzyT = 999;
    ctx.run.stats.critChance = 1;
    ctx.run.stats.critMult = 5;

    spawnStructure(ctx, def, 300, 0);
    const zombie = pinnedEnemy(ctx, 350, 0);

    harness.run(5);

    // Loaded at t=0, then every 1.4s: four bolts land inside five seconds,
    // each for exactly the number in structures.json and nothing more.
    const lost = 5000 - world.hp[zombie]!;
    expect(lost).toBe(4 * def.projectileDamage);
  });

  it('leaves the player their crits: the exemption is the bolt, not the stat', () => {
    const { ctx } = towerField();
    const world = ctx.world;
    ctx.run.stats.critChance = 1;
    ctx.run.stats.critMult = 5;
    const zombie = pinnedEnemy(ctx, 60, 0);

    // The player's own damage path is untouched by the tower exemption — the
    // guard is per-shot ownership, not a global "crits off".
    const dealt = damageEnemy(ctx, zombie, 10, 0, 0, 0);
    expect(dealt).toBe(50);
    expect(world.hp[zombie]).toBe(4950);
  });

  it('stops shooting the moment it falls', () => {
    const { harness, ctx, def } = towerField();
    const tower = spawnStructure(ctx, def, 300, 0);
    pinnedEnemy(ctx, 350, 0);

    harness.run(FIXED_DT * 2);
    expect(ctx.world.list(Kind.Projectile)).toHaveLength(1);

    damageStructure(ctx, tower, def.hp);
    harness.run(3);

    // The in-flight bolt resolved or expired and no new one was ever fired.
    expect(ctx.world.list(Kind.Structure)).toHaveLength(0);
    expect(ctx.world.list(Kind.Projectile)).toHaveLength(0);
  });

  it('flanks the bastion gate with two towers covering its approach', () => {
    const placed = bastionMap.structures as { type: string; x: number; y: number }[];
    const gate = placed.find((s) => s.type === 'gate')!;
    const towers = placed.filter((s) => s.type === 'tower');
    expect(towers).toHaveLength(2);

    const def = structureDef('tower')!;
    const gateDef = structureDef('gate')!;
    for (const t of towers) {
      const d = Math.hypot(t.x - gate.x, t.y - gate.y);
      // Set back from the gate rather than stacked on it...
      expect(d).toBeGreaterThan(def.radius + gateDef.radius + 20);
      // ...but close enough that its range covers the ground an attacker has
      // to cross to reach the gate.
      expect(d).toBeLessThan(def.range);
    }
    // One either side of the gate line, so the approach is covered from both
    // flanks instead of leaving a blind arc.
    expect(towers[0]!.y * towers[1]!.y).toBeLessThan(0);
    // Payout order is list order, so the gate must still be the first
    // structure in the map file — the siege reward keeps landing at the wall.
    expect(placed[0]!.type).toBe('gate');
  });
});

describe('meta progression', () => {
  it('normalizes the 10-node sanctum tree with derived max ranks', () => {
    expect(META_LIST.length).toBe(10);
    const bloodthirst = metaNodeDef('bloodthirst')!;
    expect(bloodthirst.maxRank).toBe(5);
    expect(bloodthirst.costs).toEqual([100, 250, 600, 1400, 3000]);
    expect(bloodthirst.perRank).toEqual({ might: 0.05 });
    expect(metaNodeDef('second_wind')!.perRank).toEqual({ revives: 1 });
    expect(metaNodeDef('second_wind')!.maxRank).toBe(1);
    expect(metaNodeDef('nonsense')).toBeNull();
  });

  it('prices the full tree at the designed total sink', () => {
    const total = META_LIST.reduce((sum, node) => sum + node.costs.reduce((a, b) => a + b, 0), 0);
    // The design table sums to 35,150 (its "~42k" prose was arithmetic-off);
    // character unlocks add another 24,500 on top.
    expect(total).toBe(35150);
  });

  it('drops unknown perRank stats and cost-less nodes with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { list } = normalizeMeta({
      good: { costs: [100], perRank: { might: 0.1, banana: 3 } },
      broken: { perRank: { might: 0.1 } },
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.perRank).toEqual({ might: 0.1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('seeds recomputeStats from metaMods with the existing clamps intact', () => {
    const run = new Run('wanderer', { might: 0.15, armor: 2, maxHpMul: 0.2 });
    expect(run.stats.might).toBeCloseTo(1.25); // 1.1 base + 0.15 meta
    expect(run.stats.armor).toBe(2);
    expect(run.stats.maxHp).toBe(120); // round(100 * 1.2)
    // The MIN_COOLDOWN_MUL floor holds against absurd meta stacking.
    expect(new Run('wanderer', { cooldown: -10 }).stats.cooldown).toBe(0.35);
  });

  it('keeps meta mods applied when passives recompute stats', () => {
    const run = new Run('wanderer', { might: 0.15 });
    run.addPassive('bloodthirst');
    expect(run.stats.might).toBeCloseTo(1.25);    // meta survived the recompute
    expect(run.stats.bloodGain).toBeCloseTo(1.1); // passive applied on top
  });

  it('grants extra revives from meta without touching derived stats', () => {
    const run = new Run('wanderer', { revives: 1 });
    expect(run.revivesLeft).toBe(1);   // wanderer base is 0
    expect(run.stats.revives).toBe(0); // stats keep the base value
  });

  it('defaults to no meta mods — Run(id) is identical to Run(id, {})', () => {
    const plain = new Run('wanderer');
    const empty = new Run('wanderer', {});
    expect(empty.stats).toEqual(plain.stats);
    expect(empty.revivesLeft).toBe(plain.revivesLeft);
  });

  it('applies meta greed to banked run gold deterministically', () => {
    const goldAfter = (mods: MetaMods): number => {
      const harness = makeHarness('wanderer', 4141, mods);
      const { ctx } = harness;
      ctx.world.hp[ctx.player] = 1e9;
      ctx.run.stats.maxHp = 1e9;
      harness.run(180);
      return ctx.run.gold;
    };
    const base = goldAfter({});
    const greedy = goldAfter({ greed: 1 });
    expect(base).toBeGreaterThan(0);
    expect(greedy).toBeGreaterThan(base);
    // Same seed + same mods ⇒ same wallet: greed multiplies payouts without
    // perturbing the sim, so any drift here is a determinism leak.
    expect(goldAfter({ greed: 1 })).toBe(greedy);
  });

  it('parses unlock costs, defaults to free, and keeps the first character free', () => {
    expect(characterDef('wanderer').unlock).toBeNull();
    expect(characterDef('acolyte').unlock).toEqual({ gold: 2500 });
    expect(characterDef('outrider').unlock).toEqual({ gold: 4000 });
    expect(characterDef('warden_knight').unlock).toEqual({ gold: 6000 });
    expect(characterDef('dragos').unlock).toEqual({ gold: 12000 });
  });
});

describe('pickup magnetism', () => {
  it('pulls experience from further out than it pulls spoils', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const { world } = ctx;
    const px = world.x[ctx.player]!;
    const py = world.y[ctx.player]!;
    const magnet = ctx.run.stats.magnet;

    // A ring that experience should reach across but gold should not: outside
    // the spoils share of the magnet, comfortably inside the full range.
    const ring = magnet * 0.8;
    expect(ring).toBeGreaterThan(magnet * 0.55);
    expect(ring).toBeLessThan(magnet);

    const gem = spawnGem(ctx, px + ring, py, 1);
    const coin = spawnCoin(ctx, px, py + ring, 1);
    expect(gem).toBeGreaterThanOrEqual(0);
    expect(coin).toBeGreaterThanOrEqual(0);

    updatePickups(ctx, FIXED_DT);

    // Attraction latches through aiPhase, so it reports intent rather than a
    // position that a single tick has barely moved.
    expect(world.aiPhase[gem]).toBe(1);
    expect(world.aiPhase[coin]).toBe(0);
  });

  it('still collects gold the player walks onto', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const { world } = ctx;
    const before = ctx.run.gold;
    const coin = spawnCoin(ctx, world.x[ctx.player]!, world.y[ctx.player]!, 7);
    expect(coin).toBeGreaterThanOrEqual(0);

    updatePickups(ctx, FIXED_DT);

    expect(ctx.run.gold).toBe(before + 7);
    expect(world.isAlive(coin)).toBe(false);
  });
});

describe('engagement range', () => {
  it('answers for what the camera frames, not what the player is nearest to', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const near = spawnEnemy(ctx, enemyDef('zombie')!, ctx.camera.x + 100, ctx.camera.y);
    const far = spawnEnemy(ctx, enemyDef('zombie')!, ctx.camera.x + 400, ctx.camera.y);

    expect(withinEngagement(ctx, near)).toBe(true);
    expect(withinEngagement(ctx, far)).toBe(false);
  });

  it('will not let the player hit what the screen does not show', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const { world } = ctx;
    const near = spawnEnemy(ctx, enemyDef('zombie')!, ctx.camera.x + 120, ctx.camera.y);
    const far = spawnEnemy(ctx, enemyDef('zombie')!, ctx.camera.x + 420, ctx.camera.y);
    const nearHp = world.hp[near]!;
    const farHp = world.hp[far]!;

    // A hazard wide enough to cover both, owned by the player. Without the
    // engagement rule its reach alone would decide, and it would sweep up a
    // kill four hundred units into the dark.
    const stats = effectiveStats(ctx.run, ctx.run.weapons[0]!);
    const hazard = spawnHazard(ctx, 'hazard_mist', ctx.camera.x, ctx.camera.y, 600, 5, stats, 0);
    expect(hazard).toBeGreaterThanOrEqual(0);

    // Damage resolves against the post-movement hash, exactly as the tick does.
    ctx.enemyHash.build(world, world.list(Kind.Enemy));
    updateHazards(ctx, FIXED_DT);

    expect(world.hp[near]!).toBeLessThan(nearHp);
    expect(world.hp[far]!).toBe(farHp);
  });
});

describe('a run reports what happened to it', () => {
  it('names the enemy whose body killed the player', () => {
    const harness = makeHarness();
    const { ctx, ctx: { world } } = harness;
    let cause: GameEvents['player:died'] | null = null;
    ctx.bus.on('player:died', (payload) => {
      cause = cause ?? payload;
    });

    world.hp[ctx.player] = 1;
    // Touching distance: contact damage resolves on the very next tick.
    spawnEnemy(ctx, enemyDef('brute')!, 4, 0);
    harness.run(FIXED_DT * 2);

    expect(cause).not.toBeNull();
    expect(cause!.killedBy.kind).toBe('contact');
    expect(cause!.killedBy.enemyId).toBe('brute');
    // The blow after armour — what the player actually felt, not the raw stat.
    expect(cause!.killedBy.damage).toBeGreaterThan(0);
  });

  it('names the shooter behind a projectile, not the projectile', () => {
    const harness = makeHarness();
    const { ctx, ctx: { world } } = harness;
    let cause: GameEvents['player:died'] | null = null;
    ctx.bus.on('player:died', (payload) => {
      cause = cause ?? payload;
    });

    // Far enough that the wisp shoots rather than touches, and unkillable so
    // the player's own weapons can't end the exchange early.
    const wisp = spawnEnemy(ctx, enemyDef('wisp')!, 90, 0);
    world.hp[wisp] = 1e9;
    world.hp[ctx.player] = 1;
    harness.run(4);

    expect(cause).not.toBeNull();
    expect(cause!.killedBy.kind).toBe('projectile');
    expect(cause!.killedBy.enemyId).toBe('wisp');
  });

  it('announces which upgrade was taken out of what was offered', () => {
    const harness = makeHarness();
    const { ctx } = harness;
    const picked: GameEvents['draft:picked'][] = [];
    ctx.bus.on('draft:picked', (payload) => picked.push(payload));

    ctx.run.pendingLevelUps = 1;
    const offers = rollOffers(ctx);
    applyOffer(ctx, offers[1] ?? offers[0]!, offers);

    expect(picked.length).toBe(1);
    const taken = offers[1] ?? offers[0]!;
    expect(picked[0]!.id).toBe(taken.id);
    expect(picked[0]!.kind).toBe(taken.kind);
    expect(picked[0]!.level).toBe(taken.level);
    expect(picked[0]!.isNew).toBe(taken.isNew);
    expect(picked[0]!.atLevel).toBe(ctx.run.level);
    // Every id in the draft, the taken one included: take-rate needs the
    // offers that were declined, not just the one that won.
    expect(picked[0]!.offered).toEqual(offers.map((o) => o.id));
    expect(picked[0]!.offered).toContain(taken.id);
  });
});
