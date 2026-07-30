import { generateStrip } from '../core/placeholders.ts';
import type { PlaceholderShape, PlaceholderSpec } from '../core/placeholders.ts';
import { AnimState } from '../ecs/components.ts';
import spritesContent from '../content/sprites.json';

const ASSET_ROOT = 'assets/';
const ANIM_SLOTS = 4; // AnimState: idle, walk, hurt, death

const VALID_SHAPES = new Set<string>([
  'capsule',
  'blob',
  'bat',
  'ghost',
  'skull',
  'gem',
  'coin',
  'orb',
  'slash',
  'knife',
  'ring',
  'square',
  'diamond',
  'star',
]);

/** One animation strip: a horizontal row of equally sized frames. */
export interface Anim {
  source: CanvasImageSource;
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** Seconds for one full cycle. */
  duration: number;
}

export interface Sprite {
  name: string;
  /** Indexed by AnimState. Slots with no art of their own reuse Idle. */
  anims: Anim[];
  /** Draw size in world units (world units are pixels at 1x zoom). */
  width: number;
  height: number;
  /**
   * Anchor within the frame, 0..1. Characters usually want (0.5, 0.85) so the
   * sprite's feet sit on its world position and depth sorting looks right.
   */
  originX: number;
  originY: number;
  /** True when this is placeholder art, so a debug overlay can call it out. */
  generated: boolean;
}

interface AnimJson {
  src?: string;
  fps?: number;
  loop?: boolean;
  frameW?: number;
  frameH?: number;
}

interface SpriteJson {
  anims?: Record<string, AnimJson>;
  origin?: [number, number];
  placeholder?: { shape?: string; color?: string; accent?: string; size?: number; frames?: number; bob?: number };
}

const ANIM_KEY_BY_STATE: Record<number, string> = {
  [AnimState.Idle]: 'idle',
  [AnimState.Walk]: 'walk',
  [AnimState.Hurt]: 'hurt',
  [AnimState.Death]: 'death',
};

/**
 * Holds every sprite, addressed by a small integer so the ECS can store a
 * sprite reference in a Uint16Array.
 */
export class SpriteTable {
  private sprites: Sprite[] = [];
  private idByName = new Map<string, number>();

  /** Names that fell back to placeholder art, for the debug overlay. */
  readonly missing: string[] = [];

  id(name: string): number {
    const id = this.idByName.get(name);
    if (id !== undefined) return id;
    // An unknown name is a content bug, not a crash. Point at sprite 0 and warn once.
    if (!this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[sprites] "${name}" is not defined in content/sprites.json`);
    }
    return 0;
  }

  private warned = new Set<string>();

  has(name: string): boolean {
    return this.idByName.has(name);
  }

  get(id: number): Sprite {
    return this.sprites[id] ?? this.sprites[0]!;
  }

  /** Resolves the strip to play, falling back to Idle when a state has no art. */
  anim(id: number, state: number): Anim {
    const sprite = this.get(id);
    return sprite.anims[state] ?? sprite.anims[AnimState.Idle]!;
  }

  /**
   * Renders a sprite's first idle frame into a standalone canvas, for use as a
   * DOM icon in the HUD and level-up cards.
   *
   * The frame is centred in a square and scaled to fit so icons of different
   * source sizes line up in a row.
   */
  iconCanvas(name: string, size = 32): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.imageSmoothingEnabled = false;

    const anim = this.anim(this.id(name), AnimState.Idle);
    const fit = Math.min(size / anim.frameW, size / anim.frameH);
    // Integer scaling keeps pixel art even; only go fractional to fit at all.
    const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const dw = anim.frameW * scale;
    const dh = anim.frameH * scale;
    ctx.drawImage(
      anim.source,
      0,
      0,
      anim.frameW,
      anim.frameH,
      Math.round((size - dw) / 2),
      Math.round((size - dh) / 2),
      dw,
      dh,
    );
    return canvas;
  }

  /** Loads every sprite declared in content/sprites.json. */
  static async load(): Promise<SpriteTable> {
    const table = new SpriteTable();
    const content = spritesContent as unknown as Record<string, SpriteJson>;

    // Load every strip concurrently — this is the bulk of startup time.
    const jobs: Promise<void>[] = [];

    for (const [name, def] of Object.entries(content)) {
      const sprite: Sprite = {
        name,
        anims: new Array<Anim>(ANIM_SLOTS),
        width: 16,
        height: 16,
        originX: def.origin?.[0] ?? 0.5,
        originY: def.origin?.[1] ?? 0.5,
        generated: false,
      };
      const id = table.sprites.length;
      table.sprites.push(sprite);
      table.idByName.set(name, id);

      const placeholder = normalizePlaceholder(name, def.placeholder);

      for (let state = 0; state < ANIM_SLOTS; state++) {
        const key = ANIM_KEY_BY_STATE[state]!;
        const animJson = def.anims?.[key];
        // Only Idle is required. Other states legitimately have no art.
        if (!animJson && state !== AnimState.Idle) continue;

        jobs.push(
          buildAnim(animJson, placeholder, state).then((result) => {
            sprite.anims[state] = result.anim;
            if (result.generated) sprite.generated = true;
          }),
        );
      }
    }

    await Promise.all(jobs);

    // Derive logical draw size from the idle strip, and record what's still placeholder.
    for (const sprite of table.sprites) {
      const idle = sprite.anims[AnimState.Idle]!;
      sprite.width = idle.frameW;
      sprite.height = idle.frameH;
      if (sprite.generated) table.missing.push(sprite.name);
    }

    if (table.sprites.length === 0) {
      throw new Error('content/sprites.json defines no sprites');
    }
    if (table.missing.length > 0) {
      console.info(
        `[sprites] using placeholder art for ${table.missing.length} sprite(s): ${table.missing.join(', ')}\n` +
          `Drop a PNG at the path in content/sprites.json to replace one.`,
      );
    }
    return table;
  }
}

async function buildAnim(
  animJson: AnimJson | undefined,
  placeholder: PlaceholderSpec,
  state: number,
): Promise<{ anim: Anim; generated: boolean }> {
  const fps = animJson?.fps ?? 8;
  const loop = animJson?.loop ?? state !== AnimState.Death;

  if (animJson?.src) {
    const image = await loadImage(ASSET_ROOT + animJson.src);
    if (image) {
      // Square frames inferred from height is the common case for a strip, so
      // frameW/frameH only need declaring for non-square art.
      const frameH = animJson.frameH ?? image.naturalHeight;
      const frameW = animJson.frameW ?? frameH;
      const frames = Math.max(1, Math.floor(image.naturalWidth / frameW));
      return {
        anim: { source: image, frameW, frameH, frames, fps, loop, duration: frames / fps },
        generated: false,
      };
    }
    // Fall through to a placeholder — a missing file must not stop the run.
  }

  const strip = generateStrip(placeholder);
  const genFps = animJson?.fps ?? (state === AnimState.Walk ? 10 : 6);
  return {
    anim: {
      source: strip.canvas,
      frameW: strip.frameW,
      frameH: strip.frameH,
      frames: strip.frames,
      fps: genFps,
      loop,
      duration: strip.frames / genFps,
    },
    generated: true,
  };
}

/** Resolves to null when the file is absent, rather than rejecting. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function normalizePlaceholder(
  name: string,
  raw: SpriteJson['placeholder'],
): PlaceholderSpec {
  const shape = raw?.shape;
  if (shape !== undefined && !VALID_SHAPES.has(shape)) {
    console.warn(
      `[sprites] "${name}" placeholder shape "${shape}" is unknown; using "blob". ` +
        `Valid: ${[...VALID_SHAPES].join(', ')}`,
    );
  }
  const spec: PlaceholderSpec = {
    shape: (shape && VALID_SHAPES.has(shape) ? shape : 'blob') as PlaceholderShape,
    color: raw?.color ?? '#c0447a',
  };
  if (raw?.accent !== undefined) spec.accent = raw.accent;
  spec.size = raw?.size ?? 16;
  if (raw?.frames !== undefined) spec.frames = raw.frames;
  if (raw?.bob !== undefined) spec.bob = raw.bob;
  return spec;
}

/** Current frame index for a strip, given elapsed seconds. */
export function frameIndex(anim: Anim, animTime: number): number {
  if (anim.frames <= 1) return 0;
  const raw = Math.floor(animTime * anim.fps);
  if (anim.loop) return ((raw % anim.frames) + anim.frames) % anim.frames;
  return Math.min(raw, anim.frames - 1);
}
