/**
 * Procedural placeholder art.
 *
 * The point of this file is that the game is fully playable before any real
 * sprite exists. Every sprite in content/sprites.json declares a `placeholder`
 * describing a simple shape; if the matching PNG is absent we paint an animated
 * strip from that description instead. Drop the PNG in and the loader silently
 * prefers it — no code or content changes.
 *
 * Nothing here is meant to survive into the finished game.
 */

export type PlaceholderShape =
  | 'capsule'
  | 'blob'
  | 'bat'
  | 'ghost'
  | 'skull'
  | 'gem'
  | 'coin'
  | 'orb'
  | 'slash'
  | 'knife'
  | 'ring'
  | 'square'
  | 'diamond'
  | 'star';

export interface PlaceholderSpec {
  shape: PlaceholderShape;
  /** Body colour. */
  color: string;
  /** Outline / detail colour. Defaults to a dark tint of `color`. */
  accent?: string;
  /** Frame size in pixels. Also the sprite's logical size. */
  size?: number;
  /** How many animation frames to bake. */
  frames?: number;
  /** Vertical bob amplitude in pixels across the animation. */
  bob?: number;
}

const DEFAULT_FRAMES = 4;

export interface GeneratedStrip {
  canvas: HTMLCanvasElement;
  frameW: number;
  frameH: number;
  frames: number;
}

/**
 * Paints a horizontal strip of frames. Frames differ by a small vertical bob and
 * a squash, which is enough to tell at a glance that animation is wired up.
 */
export function generateStrip(spec: PlaceholderSpec): GeneratedStrip {
  const size = Math.max(4, Math.round(spec.size ?? 16));
  const frames = Math.max(1, Math.round(spec.frames ?? DEFAULT_FRAMES));
  // Pad so bob and outlines can't clip at the frame edge.
  const pad = 2;
  const frameW = size + pad * 2;
  const frameH = size + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = frameW * frames;
  canvas.height = frameH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const accent = spec.accent ?? darken(spec.color, 0.55);
  const bobAmp = spec.bob ?? Math.max(1, Math.round(size * 0.08));

  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 0 : f / frames;
    const bob = Math.round(-Math.sin(t * Math.PI * 2) * bobAmp);
    // Squash counter-phase to the bob, so it reads as weight.
    const squash = 1 + Math.sin(t * Math.PI * 2) * 0.06;

    ctx.save();
    ctx.translate(f * frameW + frameW / 2, frameH / 2 + bob);
    ctx.scale(1 / squash, squash);
    drawShape(ctx, spec.shape, size, spec.color, accent, t);
    ctx.restore();
  }

  return { canvas, frameW, frameH, frames };
}

/** Shapes are drawn centred on the origin, fitting inside `size`. */
function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: PlaceholderShape,
  size: number,
  color: string,
  accent: string,
  t: number,
): void {
  const r = size / 2;
  ctx.lineWidth = Math.max(1, Math.round(size / 16));
  ctx.strokeStyle = accent;
  ctx.fillStyle = color;
  ctx.lineJoin = 'round';

  switch (shape) {
    case 'capsule': {
      // Stand-in humanoid: rounded body plus a head, so facing is legible.
      const bodyW = size * 0.62;
      const bodyH = size * 0.6;
      roundRect(ctx, -bodyW / 2, r - bodyH, bodyW, bodyH, bodyW * 0.32);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, r - bodyH - size * 0.16, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      eyes(ctx, size * 0.2, r - bodyH - size * 0.18, size * 0.055, accent);
      break;
    }
    case 'blob': {
      ctx.beginPath();
      // Wobbly radius so it looks organic rather than like a plain circle.
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const wob = 1 + Math.sin(a * 3 + t * Math.PI * 2) * 0.07;
        const rr = r * 0.92 * wob;
        const px = Math.cos(a) * rr;
        const py = Math.sin(a) * rr * 0.88;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      eyes(ctx, size * 0.22, -size * 0.06, size * 0.07, accent);
      break;
    }
    case 'bat': {
      const flap = Math.sin(t * Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-r * 0.7, -r * 0.5 * flap - r * 0.2, -r, r * 0.25);
      ctx.quadraticCurveTo(-r * 0.55, r * 0.05, 0, r * 0.3);
      ctx.quadraticCurveTo(r * 0.55, r * 0.05, r, r * 0.25);
      ctx.quadraticCurveTo(r * 0.7, -r * 0.5 * flap - r * 0.2, 0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      eyes(ctx, size * 0.11, -size * 0.02, size * 0.05, accent);
      break;
    }
    case 'ghost': {
      ctx.beginPath();
      ctx.arc(0, -r * 0.15, r * 0.78, Math.PI, 0);
      // Scalloped hem, phase-shifted per frame so it ripples.
      const hem = 4;
      const left = -r * 0.78;
      const width = r * 1.56;
      ctx.lineTo(r * 0.78, r * 0.62);
      for (let i = hem; i >= 0; i--) {
        const px = left + (width * i) / hem;
        const py = r * 0.62 + Math.sin(i * 1.6 + t * Math.PI * 2) * r * 0.16;
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      eyes(ctx, size * 0.2, -size * 0.12, size * 0.07, accent);
      break;
    }
    case 'skull': {
      ctx.beginPath();
      ctx.arc(0, -r * 0.15, r * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      roundRect(ctx, -r * 0.34, r * 0.35, r * 0.68, r * 0.42, r * 0.14);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(-r * 0.28, -r * 0.2, r * 0.2, 0, Math.PI * 2);
      ctx.arc(r * 0.28, -r * 0.2, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'gem': {
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9);
      ctx.lineTo(r * 0.72, -r * 0.15);
      ctx.lineTo(0, r * 0.9);
      ctx.lineTo(-r * 0.72, -r * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Facet highlight, brightening on the bob peak so gems twinkle.
      ctx.fillStyle = lighten(color, 0.45 + 0.25 * Math.sin(t * Math.PI * 2));
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9);
      ctx.lineTo(r * 0.72, -r * 0.15);
      ctx.lineTo(0, -r * 0.05);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'coin': {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.78, r * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = lighten(color, 0.5);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.46, r * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'orb': {
      const grad = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r * 0.85);
      grad.addColorStop(0, lighten(color, 0.65));
      grad.addColorStop(1, color);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'slash': {
      // Crescent: outer arc minus an offset inner arc.
      ctx.beginPath();
      ctx.arc(-r * 0.35, 0, r * 0.95, -Math.PI * 0.42, Math.PI * 0.42);
      ctx.arc(-r * 0.05, 0, r * 0.72, Math.PI * 0.42, -Math.PI * 0.42, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'knife': {
      ctx.beginPath();
      ctx.moveTo(r * 0.9, 0);
      ctx.lineTo(-r * 0.5, -r * 0.3);
      ctx.lineTo(-r * 0.25, 0);
      ctx.lineTo(-r * 0.5, r * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'ring': {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, size / 9);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(1, size / 22);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'square': {
      roundRect(ctx, -r * 0.72, -r * 0.72, r * 1.44, r * 1.44, r * 0.18);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.85);
      ctx.lineTo(r * 0.85, 0);
      ctx.lineTo(0, r * 0.85);
      ctx.lineTo(-r * 0.85, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'star': {
      const spin = t * Math.PI * 0.25;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = spin - Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r * 0.9 : r * 0.4;
        const px = Math.cos(a) * rr;
        const py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
  }
}

export interface TilePlaceholderSpec {
  color: string;
  accent?: string;
  /** 0..1 how much speckle detail to scatter. */
  detail?: number;
  size?: number;
  /** Deterministic variation between tiles that share a colour. */
  seed?: number;
}

/**
 * Flat colour plus deterministic speckle. Enough texture that the ground reads
 * as ground and you can see yourself moving across it.
 */
export function generateTileTexture(spec: TilePlaceholderSpec): HTMLCanvasElement {
  const size = Math.max(4, Math.round(spec.size ?? 16));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = spec.color;
  ctx.fillRect(0, 0, size, size);

  const detail = spec.detail ?? 0.5;
  if (detail > 0) {
    const accent = spec.accent ?? darken(spec.color, 0.18);
    const highlight = lighten(spec.color, 0.14);
    // A tiny LCG keyed on the seed, so a given tile always looks the same.
    let state = ((spec.seed ?? 1) * 2654435761) >>> 0;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const specks = Math.round(size * size * 0.09 * detail);
    for (let i = 0; i < specks; i++) {
      ctx.fillStyle = rand() < 0.5 ? accent : highlight;
      const px = Math.floor(rand() * size);
      const py = Math.floor(rand() * size);
      const w = rand() < 0.75 ? 1 : 2;
      ctx.fillRect(px, py, w, 1);
    }
  }

  return canvas;
}

function eyes(
  ctx: CanvasRenderingContext2D,
  spread: number,
  yOffset: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(-spread, yOffset, radius, 0, Math.PI * 2);
  ctx.arc(spread, yOffset, radius, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// --- colour helpers -------------------------------------------------------

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return [255, 0, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function darken(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

export function lighten(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}
