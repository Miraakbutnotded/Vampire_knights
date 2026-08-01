import { EventBus } from './core/events.ts';
import type { GameEvents } from './core/events.ts';
import { Input } from './core/input.ts';
import { Rng } from './core/rng.ts';
import { lerp } from './core/math.ts';
import type { LoopHooks } from './core/loop.ts';

import { Comp, Kind } from './ecs/components.ts';
import { World } from './ecs/world.ts';

import { Camera } from './render/camera.ts';
import { Fx } from './render/fx.ts';
import { Renderer, VIEW_H, VIEW_W } from './render/renderer.ts';
import { TileMap, availableMaps } from './render/tilemap.ts';
import type { SpriteTable } from './render/sprites.ts';

import { MAX_QUERY_RESULTS, SpatialHash } from './gameplay/collision.ts';
import { CHARACTER_LIST, META_LIST, characterDef, structureDef, waveTable } from './gameplay/content.ts';
import { updateEnemies, updateEnemyProjectiles } from './gameplay/enemies.ts';
import { playerAlpha, spawnPlayer, updatePlayer } from './gameplay/player.ts';
import { updatePickups } from './gameplay/pickups.ts';
import { updateBlood } from './gameplay/blood.ts';
import { updateAbility } from './gameplay/abilities.ts';
import { spawnStructure, updateStructures } from './gameplay/structures.ts';
import { Run } from './gameplay/run.ts';
import { Spawner, difficultyAt } from './gameplay/spawner.ts';
import { applyOffer, rollOffers } from './gameplay/upgrades.ts';
import { updateHazards, updatePlayerProjectiles, updateWeapons } from './gameplay/weapons.ts';
import type { Ctx } from './gameplay/context.ts';

import { Hud } from './ui/hud.ts';
import { Screens } from './ui/screens.ts';

import type { MetaService } from './services/meta.ts';

type State = 'title' | 'loading' | 'playing' | 'levelup' | 'paused' | 'results' | 'sanctum';

/**
 * Owns the game's state machine and the fixed order that systems run in.
 *
 * That ordering is deliberate and load-bearing — see `tick()`. Everything else
 * here is wiring: build the context object, hand it to the systems, and keep the
 * DOM layer in sync with what the simulation reports through the event bus.
 */
export class Game implements LoopHooks {
  private world = new World();
  private camera = new Camera();
  private fx = new Fx();
  private bus = new EventBus<GameEvents>();
  private rng = new Rng();
  private spawner = new Spawner();
  private input: Input;

  private renderer: Renderer;
  private hud: Hud;
  private screens: Screens;

  private state: State = 'title';
  private run: Run;
  private map: TileMap | null = null;
  private mapCache = new Map<string, TileMap>();
  private lastCharacterId: string;
  private lastMapId: string;

  private ctx: Ctx;
  private debugVisible = false;
  /** Sim time the current siege banner/marker window closes. Frame-side only. */
  private siegeUntil = 0;
  /** True once this run's summary events have fired — endRun's exactly-once guard. */
  private runEnded = false;
  /** Monotonic per-run token passed to bankRun — the service ignores repeats. */
  private runToken = 0;
  private debugEl: HTMLElement;
  /** Rolling fps, mirrored from the loop for the debug overlay. */
  fps = 0;

  constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    private sprites: SpriteTable,
    private meta: MetaService,
  ) {
    this.input = new Input();
    this.renderer = new Renderer(canvas, sprites);
    this.hud = new Hud(sprites);

    const maps = availableMaps();
    this.lastMapId = maps[0] ?? 'meadow';
    this.lastCharacterId = CHARACTER_LIST[0]!.id;
    this.screens = new Screens(sprites, maps);

    this.debugEl = document.createElement('div');
    this.debugEl.className = 'debug';

    uiRoot.append(this.hud.root, this.screens.root, this.debugEl);

    // A placeholder Run exists from the start so `ctx` is never half-built; it
    // is replaced wholesale when a real run begins.
    this.run = new Run(this.lastCharacterId);

    this.ctx = {
      world: this.world,
      run: this.run,
      sprites,
      fx: this.fx,
      camera: this.camera,
      // Assigned for real in startRun; the title screen never ticks systems.
      map: null as unknown as TileMap,
      rng: this.rng,
      bus: this.bus,
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

    this.wireEvents();
    this.hud.bindBloodButtons((intent) => {
      if (this.state === 'playing') this.ctx.bloodIntent = intent;
    });
    this.hud.bindAbilityButton(() => {
      // Through the synthetic-press path, not a direct latch write: touch,
      // keyboard and gamepad all converge on the one consuming wasPressed
      // read in beforeFrame.
      if (this.state === 'playing') this.input.injectPress('Space');
    });
    this.openTitle();
  }

  private wireEvents(): void {
    this.bus.on('player:died', () => {
      this.endRun(false);
    });

    this.bus.on('boss:spawned', ({ name }) => {
      this.hud.showBanner(`${name.toUpperCase()} APPROACHES`);
    });

    this.bus.on('siege:started', ({ duration }) => {
      this.siegeUntil = this.run.time + duration;
      this.hud.showBanner('SIEGE! DEFEND THE BASTION');
    });

    this.bus.on('siege:defended', () => {
      this.siegeUntil = 0;
      this.hud.showBanner('SIEGE REPELLED');
    });

    this.bus.on('structure:damaged', ({ hp, maxHp, index }) => {
      this.hud.updateStructurePip(index, hp, maxHp);
    });

    this.bus.on('structure:destroyed', ({ name, remaining, index }) => {
      this.hud.destroyStructurePip(index);
      this.hud.showBanner(
        remaining > 0 ? `THE ${name.toUpperCase()} HAS FALLEN` : 'EVERY WALL HAS FALLEN',
      );
    });
  }

  // --- state transitions --------------------------------------------------

  private openTitle(): void {
    this.state = 'title';
    this.hud.setVisible(false);
    this.screens.showTitle(
      CHARACTER_LIST,
      { gold: this.meta.gold, isUnlocked: (c) => this.meta.isUnlocked(c) },
      {
        onStart: (characterId, mapId) => void this.startRun(characterId, mapId),
        onUnlock: (characterId) => {
          const def = characterDef(characterId);
          if (this.meta.unlockCharacter(def)) {
            this.bus.emit('character:unlocked', { id: characterId });
          }
          // Re-render either way: success shows the unlocked card and the
          // smaller wallet; failure re-renders unchanged (priced card is
          // its own "not enough gold" message at v1).
          this.openTitle();
        },
        onSanctum: () => this.openSanctum(),
      },
    );
  }

  private openSanctum(focus = 0): void {
    this.state = 'sanctum';
    this.hud.setVisible(false);
    this.screens.showSanctum(
      { gold: this.meta.gold, rankOf: (id) => this.meta.rankOf(id) },
      {
        onBuy: (nodeId) => {
          if (this.meta.buyNode(nodeId)) {
            this.bus.emit('meta:purchased', { nodeId, rank: this.meta.rankOf(nodeId) });
          }
          // Re-render with the new wallet/ranks, keeping focus on the node.
          this.openSanctum(META_LIST.findIndex((n) => n.id === nodeId));
        },
        onBack: () => this.openTitle(),
      },
      focus,
    );
  }

  async startRun(characterId: string, mapId: string): Promise<void> {
    this.state = 'loading';
    this.screens.hide();
    this.lastCharacterId = characterId;
    this.lastMapId = mapId;

    // Maps are cached because a restart is the common case and re-decoding
    // tilesets would put a visible hitch between runs.
    let map = this.mapCache.get(mapId);
    if (!map) {
      map = await TileMap.load(mapId);
      this.mapCache.set(mapId, map);
    }
    this.map = map;
    // Maps persist across runs in the cache: strip the previous run's
    // structure solids before this run registers its own.
    map.clearRuntimeSolids();

    this.world.reset();
    this.fx.clear();
    this.spawner.reset();
    this.rng.reseed((Math.random() * 0xffffffff) >>> 0);

    this.run = new Run(characterId, this.meta.computeMetaMods());
    this.ctx.run = this.run;
    this.ctx.map = map;
    this.ctx.wave = waveTable(map.wavesTable);
    this.ctx.aimX = 1;
    this.ctx.aimY = 0;
    this.ctx.hpScale = 1;
    this.ctx.damageScale = 1;
    this.ctx.speedScale = 1;
    this.ctx.bloodIntent = null;
    this.ctx.abilityQueued = false;

    this.ctx.player = spawnPlayer(this.ctx, map.spawnX, map.spawnY);
    const pips: { name: string; hp: number }[] = [];
    for (const entry of map.structures) {
      const def = structureDef(entry.type);
      if (!def) continue; // warn-don't-throw: a typo costs one structure, not the run
      if (spawnStructure(this.ctx, def, entry.x, entry.y) >= 0) {
        pips.push({ name: def.name, hp: def.hp });
      }
    }
    this.hud.setStructurePips(pips);
    this.siegeUntil = 0;
    this.runEnded = false;
    this.runToken++;
    this.camera.bounds = map.bounds;
    this.camera.snapTo(map.spawnX, map.spawnY);

    this.hud.setVisible(true);
    this.state = 'playing';
  }

  private openLevelUp(): void {
    this.state = 'levelup';
    // Drop any intent latched on the way in: updateBlood is frozen while a menu
    // is up, so it would otherwise fire the instant play resumes — long after
    // the press, and possibly on a bar the player has since read differently.
    this.ctx.bloodIntent = null;
    this.ctx.abilityQueued = false;
    this.screens.showLevelUp(rollOffers(this.ctx), (offer) => {
      applyOffer(this.ctx, offer);
      // More level-ups can be banked than one draft resolves — keep drafting
      // until the queue is empty rather than dropping the extras.
      if (this.run.pendingLevelUps > 0) this.openLevelUp();
      else {
        this.screens.hide();
        this.state = 'playing';
      }
    });
  }

  private openPause(): void {
    this.state = 'paused';
    // Same reason as the level-up draft: no spend may survive the pause.
    this.ctx.bloodIntent = null;
    this.ctx.abilityQueued = false;
    this.screens.showPause(this.run, {
      onResume: () => {
        this.screens.hide();
        this.state = 'playing';
      },
      onRestart: () => void this.startRun(this.lastCharacterId, this.lastMapId),
      onQuit: () => this.openTitle(),
    });
  }

  private declareVictory(): void {
    this.bus.emit('run:victory', { survivedSeconds: this.run.time, kills: this.run.kills });
    this.endRun(true);
  }

  /**
   * The single funnel for both end-of-run paths (death and victory): emit
   * the summary event, bank gold into the persistent wallet exactly once,
   * then show the results screen. Persistence is fire-and-forget inside the
   * service — nothing here waits on storage.
   */
  private endRun(victory: boolean): void {
    this.state = 'results';
    this.hud.setVisible(false);
    // endRun can legitimately fire twice per run (death on the
    // victory-crossing tick; a second death after the die+level-up
    // same-tick resume), so the summary emits and the banking share one
    // exactly-once guard — a 'run:ended' listener must never see two
    // conflicting summaries for the same run. bankRun's token dedup is
    // the headless-tested belt to this browser-side brace. The state
    // transition and showResults stay unconditional so the final screen
    // always reflects the last transition.
    let walletTotal = this.meta.gold;
    if (!this.runEnded) {
      this.runEnded = true;
      this.bus.emit('run:ended', {
        victory,
        survivedSeconds: this.run.time,
        kills: this.run.kills,
        gold: this.run.gold,
        level: this.run.level,
      });
      walletTotal = this.meta.bankRun(this.run.gold, this.runToken);
      this.bus.emit('meta:goldBanked', { banked: this.run.gold, total: walletTotal });
    }
    this.screens.showResults(
      { victory, run: this.run, walletGold: walletTotal },
      {
        onRetry: () => void this.startRun(this.lastCharacterId, this.lastMapId),
        onTitle: () => this.openTitle(),
      },
    );
  }

  // --- loop hooks ---------------------------------------------------------

  beforeFrame(): void {
    this.input.beginFrame();

    if (this.input.wasPressed('F3')) {
      this.debugVisible = !this.debugVisible;
      this.debugEl.classList.toggle('visible', this.debugVisible);
    }

    if (this.screens.isOpen) {
      // ESC closes the pause screen; on other screens it is ignored so the
      // player can't escape a level-up draft without picking.
      if (this.state === 'paused' && this.input.wasPressed('Escape')) {
        this.screens.hide();
        this.state = 'playing';
        return;
      }
      if (this.state === 'sanctum' && this.input.wasPressed('Escape')) {
        this.openTitle();
        return;
      }
      this.screens.handleInput(this.input);
      return;
    }

    if (this.state !== 'playing') return;

    if (this.input.wasPressed('Escape')) {
      this.openPause();
      return;
    }

    // Blood intents latch here — edge-triggered input lives frame-side only
    // (the sim may run 0..5 times per frame) — and updateBlood consumes the
    // latch on the next sim tick. Distinct codes from Escape, so wasPressed
    // consumption order stays safe.
    if (this.input.wasPressed('KeyQ')) this.ctx.bloodIntent = 'heal';
    else if (this.input.wasPressed('KeyE')) this.ctx.bloodIntent = 'burst';

    // Ability cast latches exactly like the blood intents: edge input lives
    // frame-side, updateAbility consumes the latch on the next sim tick.
    if (this.input.wasPressed('Space')) this.ctx.abilityQueued = true;
  }

  update(dt: number): void {
    if (this.state !== 'playing') return;
    this.tick(dt);
  }

  afterFrame(): void {
    this.input.endFrame();
  }

  /**
   * One simulation tick.
   *
   * The order matters in three specific ways:
   *  - positions are snapshotted first so the renderer can interpolate;
   *  - the enemy broadphase is rebuilt *after* enemies move, so weapons resolve
   *    against where enemies actually are rather than where they were;
   *  - `world.flush()` runs last, because destroying entities mid-tick only
   *    marks them dead and every system above tolerates reading a dead entity,
   *    but none tolerate the id lists being compacted underneath them.
   */
  private tick(dt: number): void {
    const ctx = this.ctx;

    this.run.time += dt;

    const difficulty = difficultyAt(ctx, this.run.time);
    ctx.hpScale = difficulty.hp;
    ctx.damageScale = difficulty.damage;
    ctx.speedScale = difficulty.speed;

    this.world.snapshotPositions();

    // Pre-movement index: crowd separation and contact damage read this.
    ctx.enemyHash.build(this.world, this.world.list(Kind.Enemy));

    updatePlayer(ctx, dt, this.input);
    this.spawner.update(ctx, dt);
    updateEnemies(ctx, dt);

    // Post-movement index, for anything that deals damage.
    ctx.enemyHash.build(this.world, this.world.list(Kind.Enemy));

    updateAbility(ctx, dt);
    updateEnemyProjectiles(ctx, dt);
    updateWeapons(ctx, dt);
    updatePlayerProjectiles(ctx, dt);
    updateHazards(ctx, dt);
    updateStructures(ctx, dt);

    ctx.pickupHash.build(this.world, this.world.list(Kind.Pickup));
    updatePickups(ctx, dt);
    updateBlood(ctx, dt);

    this.fx.update(dt);

    if (ctx.player >= 0 && this.world.isAlive(ctx.player)) {
      this.camera.follow(this.world.x[ctx.player]!, this.world.y[ctx.player]!, dt);
    }

    this.world.flush();

    // State changes are deferred to the end of the tick so systems always run
    // against a consistent world.
    if (this.run.pendingLevelUps > 0) {
      this.openLevelUp();
      return;
    }
    if (this.run.time >= ctx.wave.victorySeconds) {
      this.declareVictory();
    }
  }

  render(alpha: number, frameDt: number): void {
    const { world } = this;

    if (this.state === 'title' || this.state === 'loading' || this.state === 'sanctum' || !this.map) {
      // Nothing to draw behind the title screen; a flat wash reads as intentional.
      this.renderer.begin(this.camera);
      this.renderer.present();
      this.syncUiMetrics();
      return;
    }

    this.renderer.begin(this.camera);
    this.map.drawGround(this.renderer);
    this.fx.drawParticles(this.renderer);
    this.map.queueScenery(this.renderer, this.sprites);

    // Hazards first: auras and burning ground use a large negative draw bias so
    // they sit under everything, while orbiting tomes sort normally.
    this.queueKind(Kind.Hazard, alpha);
    this.queueKind(Kind.Structure, alpha);
    this.queueKind(Kind.Pickup, alpha);
    this.queueKind(Kind.Enemy, alpha);
    this.queueKind(Kind.Projectile, alpha);
    this.queuePlayer(alpha);

    // Off-screen structure markers during an active siege: the structure's own
    // sprite at half scale, clamped 8px inside the 480x270 buffer edge, always
    // on top of the sprite pass (flat decor uses -1e6; this is its ceiling twin).
    if (this.siegeUntil > this.run.time) {
      const view = this.renderer.viewRect();
      const ids = world.list(Kind.Structure);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const x = lerp(world.prevX[id]!, world.x[id]!, alpha);
        const y = lerp(world.prevY[id]!, world.y[id]!, alpha);
        if (x >= view.left && x <= view.right && y >= view.top && y <= view.bottom) continue;
        const mx = Math.max(view.left + 8, Math.min(view.right - 8, x));
        const my = Math.max(view.top + 8, Math.min(view.bottom - 8, y));
        this.renderer.queue(world.spriteId[id]!, world.animState[id]!, world.animTime[id]!, mx, my, {
          scale: 0.5,
          depth: 1e6,
        });
      }
    }

    this.renderer.flushSprites();
    this.fx.drawNumbers(this.renderer);
    this.renderer.present();

    this.syncUiMetrics();

    if (this.state !== 'results') {
      const hp = this.ctx.player >= 0 ? world.hp[this.ctx.player]! : 0;
      this.hud.update(this.run, hp, frameDt);
    }

    if (this.debugVisible) this.updateDebug();
  }

  /** Queues every live entity of a kind, interpolated between ticks. */
  private queueKind(kind: Kind, alpha: number): void {
    const { world, renderer } = this;
    const view = renderer.visibleBounds();
    const ids = world.list(kind);

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const x = lerp(world.prevX[id]!, world.x[id]!, alpha);
      const y = lerp(world.prevY[id]!, world.y[id]!, alpha);
      if (x < view.left || x > view.right || y < view.top || y > view.bottom) continue;

      renderer.queue(world.spriteId[id]!, world.animState[id]!, world.animTime[id]!, x, y, {
        facing: world.facing[id]!,
        scale: world.scale[id]!,
        // Only projectiles and orbiting hazards carry meaningful rotation;
        // rotating a walking enemy sprite would look wrong.
        rot: kind === Kind.Projectile || world.has(id, Comp.Orbit) ? world.rot[id]! : 0,
        flash: world.hitFlash[id]! > 0 ? world.hitFlash[id]! * 6 : 0,
        depth: y + world.drawBias[id]!,
      });
    }
  }

  private queuePlayer(alpha: number): void {
    const id = this.ctx.player;
    if (id < 0 || !this.world.isAlive(id)) return;
    const { world } = this;
    const x = lerp(world.prevX[id]!, world.x[id]!, alpha);
    const y = lerp(world.prevY[id]!, world.y[id]!, alpha);
    this.renderer.queue(world.spriteId[id]!, world.animState[id]!, world.animTime[id]!, x, y, {
      facing: world.facing[id]!,
      flash: world.hitFlash[id]! > 0 ? world.hitFlash[id]! * 5 : 0,
      alpha: playerAlpha(this.ctx),
      depth: y,
    });
  }

  /**
   * Publishes the renderer's letterbox geometry as CSS variables, so the DOM UI
   * covers exactly the play area and its text scales with the art.
   */
  private lastMetrics = '';

  private syncUiMetrics(): void {
    const { scale, offsetX, offsetY } = this.renderer.viewportMetrics();
    // Writing custom properties on the root element invalidates style for the
    // whole UI subtree, so only touch them when the viewport actually changed —
    // otherwise this forces a recalc on every single frame.
    const signature = `${scale}|${offsetX}|${offsetY}`;
    if (signature === this.lastMetrics) return;
    this.lastMetrics = signature;

    const style = document.documentElement.style;
    style.setProperty('--scale', String(Math.max(1, scale)));
    style.setProperty('--offset-x', `${offsetX}px`);
    style.setProperty('--offset-y', `${offsetY}px`);
    style.setProperty('--play-w', `${VIEW_W * scale}px`);
    style.setProperty('--play-h', `${VIEW_H * scale}px`);
  }

  private updateDebug(): void {
    const world = this.world;
    const lines = [
      `fps      ${this.fps.toFixed(0)}`,
      `entities ${world.entityCount}`,
      `enemies  ${world.list(Kind.Enemy).length}`,
      `pickups  ${world.list(Kind.Pickup).length}`,
      `shots    ${world.list(Kind.Projectile).length}`,
      `hazards  ${world.list(Kind.Hazard).length}`,
      `structures ${world.list(Kind.Structure).length}`,
      `particles ${this.fx.activeParticles}`,
      `hp x${this.ctx.hpScale.toFixed(2)}  dmg x${this.ctx.damageScale.toFixed(2)}`,
    ];
    if (this.sprites.missing.length > 0) {
      lines.push(`placeholder art: ${this.sprites.missing.length}`);
    }
    this.debugEl.textContent = lines.join('\n');
  }

  dispose(): void {
    this.input.dispose();
    this.bus.clear();
  }
}
