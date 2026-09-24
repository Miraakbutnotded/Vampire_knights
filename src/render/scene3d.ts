import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D, OrthographicCamera } from 'three';
import { buildSpriteAtlas } from './atlas.ts';
import type { SpriteAtlas } from './atlas.ts';
import { isoX, isoY, worldX, worldY } from './iso.ts';
import { ModelLibrary } from './models.ts';
import { frameIndex } from './sprites.ts';
import type { SpriteTable } from './sprites.ts';
import type { TileMap } from './tilemap.ts';
import {
  createIsoCamera,
  GROUND_UNITS_PER_PX,
  GROUND_UP,
  placeIsoCamera,
  PX,
  SCREEN_RIGHT,
  UPRIGHT_UNITS_PER_PX,
} from './view3d.ts';

/**
 * How a sprite sits in the 3D world.
 *
 * - `Upright` stands on its feet facing the camera, like a character.
 * - `Ground` lies on the floor as world-space art — the auras and pools whose
 *   drawn edge is their collider. One texel is one world unit, exactly as the
 *   flat renderer's `ground: true` path draws it.
 * - `Flat` lies on the floor but keeps its *screen* shape: a puddle, or a body.
 *   It draws the same pixels the upright path would, and nothing can walk
 *   behind it.
 */
export const SpriteMode = {
  Upright: 0,
  Ground: 1,
  Flat: 2,
} as const;
export type SpriteMode = (typeof SpriteMode)[keyof typeof SpriteMode];

/** Upright sprites drawn per frame. Overflow is dropped, like every fx pool. */
const UPRIGHT_CAP = 8192;
/** Floor-lying sprites per frame; they are sorted, so the cap stays modest. */
const DECAL_CAP = 2048;
const SHADOW_CAP = 4096;

/** Ground chunks kept on the GPU; the oldest is freed past this. */
const CHUNK_LIMIT = 96;

/** How high a solid tile stands, as a fraction of its width. */
const WALL_HEIGHT = 0.75;
/** How deep the edge of a grid map's floor drops into the void. */
const SLAB_DEPTH = 20;

/** Floor art is lifted this far off the ground plane so the two never fight for depth. */
const DECAL_LIFT = 0.05;

const EMPTY_CLEAR = '#0b0d14';

/**
 * The world in 3D: a WebGL canvas under the 2D one.
 *
 * The flat renderer stays in charge of the frame — its buffer becomes a
 * transparent overlay for particles, damage numbers and off-screen markers, and
 * its letterbox maths still decides where everything goes. This class draws
 * only the world under it, at the same 480x270 and upscaled the same nearest-
 * neighbour way, so the pixel grid of the two layers is one grid.
 *
 * Every sprite in the game goes through three instanced meshes — standing,
 * lying and shadows — so the whole horde is three draw calls however big it is.
 */
export class Scene3D {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;

  private readonly atlas: SpriteAtlas;
  private readonly atlasTexture: CanvasTexture;
  private readonly upright: SpriteBatch;
  private readonly decals: SpriteBatch;
  private readonly shadows: ShadowBatch;
  private readonly models: ModelLibrary;
  private readonly modelPool = new Map<number, { clones: Object3D[]; used: number }>();

  private map: TileMap | null = null;
  private readonly chunks = new Map<string, Mesh>();
  private readonly chunkPlane = new PlaneGeometry(1, 1);
  private terrain: Mesh[] = [];
  private clearColor = EMPTY_CLEAR;

  /**
   * Returns null when WebGL is unavailable, so the caller can keep the flat
   * view. A device that cannot make a context gets the game it always had.
   */
  static create(display: HTMLCanvasElement, sprites: SpriteTable, viewW: number, viewH: number): Scene3D | null {
    try {
      return new Scene3D(display, sprites, viewW, viewH);
    } catch (err) {
      console.warn('[3d] WebGL unavailable, keeping the flat view:', err);
      return null;
    }
  }

  private constructor(
    display: HTMLCanvasElement,
    private readonly sprites: SpriteTable,
    viewW: number,
    viewH: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'world3d';
    const style = this.canvas.style;
    style.position = 'absolute';
    style.imageRendering = 'pixelated';
    style.pointerEvents = 'none';

    this.gl = new WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(1);
    this.gl.setSize(viewW, viewH, false);
    this.gl.setClearColor(EMPTY_CLEAR);
    display.parentElement?.insertBefore(this.canvas, display);

    this.camera = createIsoCamera(viewW, viewH);

    this.atlas = buildSpriteAtlas(sprites);
    this.atlasTexture = pixelTexture(new CanvasTexture(this.atlas.canvas));
    // Atlas coordinates are canvas coordinates, top-left origin.
    this.atlasTexture.flipY = false;

    this.decals = new SpriteBatch(DECAL_CAP, this.atlasTexture, true);
    this.decals.mesh.renderOrder = 1;
    this.shadows = new ShadowBatch(SHADOW_CAP);
    this.shadows.mesh.renderOrder = 2;
    this.upright = new SpriteBatch(UPRIGHT_CAP, this.atlasTexture, false);
    this.scene.add(this.decals.mesh, this.shadows.mesh, this.upright.mesh);

    // Lighting touches the models only: sprites, floor and walls use unlit
    // materials, because their colours are the palette and must come out as
    // authored. Both lights are moonlight, dim and violet, so a model's own
    // daylit texture is graded down into the palette's night.
    this.scene.add(new HemisphereLight('#8f86c9', '#1a1024', 0.9));
    const key = new DirectionalLight('#c9bcff', 1.1);
    key.position.set(-0.6, 1, 0.3);
    this.scene.add(key);

    this.models = new ModelLibrary(sprites);
  }

  /** Where the canvas sits on the page, in CSS pixels — the letterboxed play box. */
  place(left: number, top: number, width: number, height: number): void {
    const style = this.canvas.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
  }

  /** Starts a frame looking at a ground position, in flat world coordinates. */
  beginFrame(wx: number, wy: number): void {
    placeIsoCamera(this.camera, wx, wy);
    this.upright.clear();
    this.decals.clear();
    this.shadows.clear();
    for (const pool of this.modelPool.values()) pool.used = 0;
    for (const chunk of this.chunks.values()) chunk.visible = false;
  }

  /**
   * Shows the ground chunks covering `view`, building any it lacks, and the
   * map's raised terrain.
   */
  ground(map: TileMap, view: { left: number; top: number; right: number; bottom: number }): void {
    if (map !== this.map) this.setMap(map);

    const size = map.chunkSize;
    const cx0 = Math.floor(view.left / size);
    const cx1 = Math.floor(view.right / size);
    const cy0 = Math.floor(view.top / size);
    const cy1 = Math.floor(view.bottom / size);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy}`;
        let chunk = this.chunks.get(key);
        if (chunk) {
          // Re-inserted so the map's order is least-recently-used first.
          this.chunks.delete(key);
        } else {
          chunk = this.buildChunk(map, cx, cy);
        }
        this.chunks.set(key, chunk);
        chunk.visible = true;
      }
    }

    while (this.chunks.size > CHUNK_LIMIT) {
      const [key, oldest] = this.chunks.entries().next().value as [string, Mesh];
      this.chunks.delete(key);
      this.scene.remove(oldest);
      disposeMesh(oldest);
    }
  }

  /**
   * Adds one sprite to this frame. The position is snapped to the pixel the
   * flat renderer would round it to, so the two views agree to the pixel and
   * the overlay's particles land where the world says they should.
   */
  sprite(
    spriteId: number,
    state: number,
    animTime: number,
    x: number,
    y: number,
    facing: number,
    scale: number,
    rot: number,
    flash: number,
    alpha: number,
    depth: number,
    mode: SpriteMode,
    shadow: boolean,
  ): void {
    const sx = Math.round(isoX(x, y));
    const sy = Math.round(isoY(x, y));
    const ax = worldX(sx, sy);
    const ay = worldY(sx, sy);

    const anim = this.sprites.anim(spriteId, state);
    const dw = anim.frameW * scale;

    if (shadow) this.shadows.push(ax, ay, (0.3 * dw) / PX);

    if (mode === SpriteMode.Upright) {
      const model = this.models.template(spriteId);
      if (model) {
        this.placeModel(spriteId, model, ax, ay, scale);
        return;
      }
    }

    const rect = this.atlas.rectOf(anim);
    if (!rect) return;
    const frame = frameIndex(anim, animTime);
    const dh = anim.frameH * scale;
    const sprite = this.sprites.get(spriteId);
    const inv = 1 / this.atlas.size;
    const u0 = (rect.x + frame * anim.frameW) * inv;
    const v0 = rect.y * inv;

    const batch = mode === SpriteMode.Upright ? this.upright : this.decals;
    batch.push(
      ax,
      mode === SpriteMode.Upright ? 0 : DECAL_LIFT,
      ay,
      Math.round(-sprite.originX * dw),
      Math.round(-sprite.originY * dh),
      dw,
      dh,
      u0,
      v0,
      u0 + anim.frameW * inv,
      v0 + anim.frameH * inv,
      rot,
      flash,
      alpha,
      facing < 0 ? -1 : 1,
      mode,
      depth,
    );
  }

  /** Draws the frame. */
  render(): void {
    this.gl.setClearColor(this.clearColor);
    this.upright.commit();
    this.decals.commit();
    this.shadows.commit();
    for (const pool of this.modelPool.values()) {
      for (let i = 0; i < pool.clones.length; i++) pool.clones[i]!.visible = i < pool.used;
    }
    this.gl.render(this.scene, this.camera);
  }

  /** Clears the canvas to the backdrop, for the screens with no world behind them. */
  renderEmpty(): void {
    this.gl.setClearColor(EMPTY_CLEAR);
    this.gl.clear();
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) disposeMesh(chunk);
    this.chunks.clear();
    this.clearTerrain();
    this.chunkPlane.dispose();
    this.upright.dispose();
    this.decals.dispose();
    this.shadows.dispose();
    this.atlasTexture.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.canvas.remove();
  }

  private placeModel(spriteId: number, template: Object3D, x: number, y: number, scale: number): void {
    let pool = this.modelPool.get(spriteId);
    if (!pool) {
      pool = { clones: [], used: 0 };
      this.modelPool.set(spriteId, pool);
    }
    let clone = pool.clones[pool.used];
    if (!clone) {
      clone = template.clone(true);
      pool.clones.push(clone);
      this.scene.add(clone);
    }
    pool.used++;
    clone.position.set(x, 0, y);
    clone.scale.setScalar(template.scale.x * scale);
  }

  private setMap(map: TileMap): void {
    this.map = map;
    this.clearColor = map.voidColor;
    for (const chunk of this.chunks.values()) {
      this.scene.remove(chunk);
      disposeMesh(chunk);
    }
    this.chunks.clear();
    this.clearTerrain();
    this.terrain = buildTerrain(map);
    for (const mesh of this.terrain) this.scene.add(mesh);
  }

  private clearTerrain(): void {
    for (const mesh of this.terrain) {
      this.scene.remove(mesh);
      disposeMesh(mesh);
    }
    this.terrain = [];
  }

  private buildChunk(map: TileMap, cx: number, cy: number): Mesh {
    const size = map.chunkSize;
    const texture = pixelTexture(new CanvasTexture(map.flatChunk(cx, cy)));
    // alphaTest cuts the void out of a grid map's floor; a scatter map's chunks
    // are fully opaque and pass it everywhere.
    const material = new MeshBasicMaterial({ map: texture, alphaTest: 0.5 });
    const mesh = new Mesh(this.chunkPlane, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(size, size, 1);
    mesh.position.set(cx * size + size / 2, 0, cy * size + size / 2);
    mesh.userData.sharedGeometry = true;
    this.scene.add(mesh);
    return mesh;
  }
}

/** Nearest-neighbour, no mipmaps, sRGB: a texture that keeps pixel art as drawn. */
function pixelTexture<T extends Texture>(texture: T): T {
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function disposeMesh(mesh: Mesh): void {
  const material = mesh.material as Material & { map?: Texture | null };
  material.map?.dispose();
  material.dispose();
  if (!mesh.userData.sharedGeometry) mesh.geometry.dispose();
}

/**
 * Raises a grid map's solid tiles into walls, and gives its floor an edge.
 *
 * Only the faces the camera can see are built — the top, and the sides facing
 * +x and +y (toward the bottom of the screen). Shading is baked per face into
 * vertex colours on an unlit material, so the tiles keep their palette on top
 * and read as solid by their darker sides, with no lighting to tune.
 */
function buildTerrain(map: TileMap): Mesh[] {
  const grid = map.terrain();
  if (!grid) return [];

  const ts = map.tileSize;
  const wall = ts * WALL_HEIGHT;
  const byTexture = new Map<number, { pos: number[]; uv: number[]; col: number[] }>();
  const at = (tx: number, ty: number): number =>
    tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height ? -1 : grid.cells[ty * grid.width + tx]!;
  const solid = (t: number): boolean => t >= 0 && grid.textures[t]!.solid;

  const quad = (t: number, corners: number[][], shade: number): void => {
    let buf = byTexture.get(t);
    if (!buf) {
      buf = { pos: [], uv: [], col: [] };
      byTexture.set(t, buf);
    }
    // corners: top-left, top-right, bottom-right, bottom-left of the texture.
    const uvs = [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      buf.pos.push(...corners[i]!);
      buf.uv.push(...uvs[i]!);
      buf.col.push(shade, shade, shade);
    }
  };

  for (let ty = 0; ty < grid.height; ty++) {
    for (let tx = 0; tx < grid.width; tx++) {
      const t = at(tx, ty);
      if (t < 0) continue;
      const x0 = tx * ts;
      const x1 = x0 + ts;
      const z0 = ty * ts;
      const z1 = z0 + ts;

      if (solid(t)) {
        quad(t, [[x0, wall, z0], [x1, wall, z0], [x1, wall, z1], [x0, wall, z1]], 1);
        if (!solid(at(tx, ty + 1))) quad(t, [[x0, wall, z1], [x1, wall, z1], [x1, 0, z1], [x0, 0, z1]], 0.72);
        if (!solid(at(tx + 1, ty))) quad(t, [[x1, wall, z1], [x1, wall, z0], [x1, 0, z0], [x1, 0, z1]], 0.52);
      }
      // The floor's own edge, where the grid meets the void: a slab dropping
      // away, so the arena reads as ground with thickness rather than a decal.
      if (at(tx, ty + 1) < 0) quad(t, [[x0, 0, z1], [x1, 0, z1], [x1, -SLAB_DEPTH, z1], [x0, -SLAB_DEPTH, z1]], 0.38);
      if (at(tx + 1, ty) < 0) quad(t, [[x1, 0, z1], [x1, 0, z0], [x1, -SLAB_DEPTH, z0], [x1, -SLAB_DEPTH, z1]], 0.28);
    }
  }

  const meshes: Mesh[] = [];
  for (const [t, buf] of byTexture) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(buf.pos, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(buf.uv, 2));
    geometry.setAttribute('color', new Float32BufferAttribute(buf.col, 3));
    const texture = pixelTexture(new Texture(grid.textures[t]!.source as TexImageSource));
    const material = new MeshBasicMaterial({ map: texture, vertexColors: true, side: DoubleSide });
    meshes.push(new Mesh(geometry, material));
  }
  return meshes;
}

const SPRITE_VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iRect;
attribute vec4 iUv;
attribute vec4 iMisc;
attribute float iMode;

uniform vec3 uRight;
uniform vec3 uGroundUp;
uniform float uPx;
uniform float uUpright;
uniform float uGround;

varying vec2 vUv;
varying float vFlash;
varying float vAlpha;

void main() {
  vec2 corner = position.xy;
  // Pixels from the anchor, y down — the flat renderer's local draw space.
  vec2 lp = iRect.xy + corner * iRect.zw;
  // Same order as the canvas path: mirror, then rotate, about the anchor.
  lp.x *= iMisc.w;
  float c = cos(iMisc.x);
  float s = sin(iMisc.x);
  lp = vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y);

  vec3 p = iPos;
  if (iMode < 0.5) {
    // Standing. Corners above the feet rise vertically; corners below them —
    // the 15% of a character under its anchor — are laid on the floor toward
    // the camera instead of sunk into it. The card between them leans, but the
    // projection is affine, so every pixel still lands exactly where the flat
    // renderer puts it; only depth sees the lean, and the floor no longer
    // swallows anyone's feet.
    p += uRight * (lp.x / uPx);
    p += lp.y < 0.0 ? vec3(0.0, -lp.y * uUpright, 0.0) : -uGroundUp * (lp.y * uGround);
  } else if (iMode < 1.5) {
    // On the ground, in world units: exactly the flat renderer's ground matrix.
    p += vec3(lp.x, 0.0, lp.y);
  } else {
    // Lying flat but screen-shaped.
    p += uRight * (lp.x / uPx) - uGroundUp * (lp.y * uGround);
  }

  vUv = vec2(mix(iUv.x, iUv.z, corner.x), mix(iUv.y, iUv.w, corner.y));
  vFlash = iMisc.y;
  vAlpha = iMisc.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uDither;

varying vec2 vUv;
varying float vFlash;
varying float vAlpha;

// 4x4 ordered dither: standing sprites write depth, so partial transparency is
// drawn as a screen-door pattern instead of a blend — pixel art's own idiom
// for see-through, and one that needs no sorting.
float bayer4(vec2 fc) {
  ivec2 p = ivec2(mod(fc, 4.0));
  int i = p.x + p.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}

void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (uDither > 0.5) {
    if (a < bayer4(gl_FragCoord.xy)) discard;
    a = 1.0;
  } else if (a < 0.004) {
    discard;
  }
  vec3 rgb = mix(t.rgb, vec3(1.0), clamp(vFlash, 0.0, 1.0));
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

/** A unit quad whose corners the shader reads as (0,0) top-left to (1,1). */
function quadGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function instanced(geometry: InstancedBufferGeometry, name: string, capacity: number, size: number): Float32Array {
  const array = new Float32Array(capacity * size);
  const attr = new InstancedBufferAttribute(array, size);
  attr.setUsage(DynamicDrawUsage);
  geometry.setAttribute(name, attr);
  return array;
}

/**
 * Fixed-capacity instance storage for one sprite mesh. Written in place every
 * frame, no allocation, and the overflow is dropped rather than grown — the
 * same contract as the flat renderer's draw list and the fx pools.
 */
class SpriteBatch {
  readonly mesh: Mesh;
  private readonly geometry = quadGeometry();
  private readonly pos: Float32Array;
  private readonly rect: Float32Array;
  private readonly uv: Float32Array;
  private readonly misc: Float32Array;
  private readonly mode: Float32Array;
  private readonly depth: Float32Array;
  /** Sort scratch, used only by a batch that draws back to front. */
  private readonly order: Uint32Array;
  private readonly scratch: Float32Array;
  private count = 0;

  constructor(
    private readonly capacity: number,
    map: Texture,
    /** Floor art blends and draws in the flat renderer's depth order instead of writing depth. */
    private readonly sorted: boolean,
  ) {
    this.pos = instanced(this.geometry, 'iPos', capacity, 3);
    this.rect = instanced(this.geometry, 'iRect', capacity, 4);
    this.uv = instanced(this.geometry, 'iUv', capacity, 4);
    this.misc = instanced(this.geometry, 'iMisc', capacity, 4);
    this.mode = instanced(this.geometry, 'iMode', capacity, 1);
    this.depth = new Float32Array(capacity);
    this.order = new Uint32Array(sorted ? capacity : 0);
    this.scratch = new Float32Array(sorted ? capacity * 4 : 0);

    const material = new ShaderMaterial({
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      uniforms: {
        uMap: { value: map },
        uDither: { value: sorted ? 0 : 1 },
        uRight: { value: SCREEN_RIGHT },
        uGroundUp: { value: GROUND_UP },
        uPx: { value: PX },
        uUpright: { value: UPRIGHT_UNITS_PER_PX },
        uGround: { value: GROUND_UNITS_PER_PX },
      },
      side: DoubleSide,
      transparent: sorted,
      depthWrite: !sorted,
    });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
  }

  clear(): void {
    this.count = 0;
  }

  push(
    x: number, y: number, z: number,
    offX: number, offY: number, w: number, h: number,
    u0: number, v0: number, u1: number, v1: number,
    rot: number, flash: number, alpha: number, flip: number,
    mode: number,
    depth: number,
  ): void {
    const i = this.count;
    if (i >= this.capacity) return;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.rect[i * 4] = offX;
    this.rect[i * 4 + 1] = offY;
    this.rect[i * 4 + 2] = w;
    this.rect[i * 4 + 3] = h;
    this.uv[i * 4] = u0;
    this.uv[i * 4 + 1] = v0;
    this.uv[i * 4 + 2] = u1;
    this.uv[i * 4 + 3] = v1;
    this.misc[i * 4] = rot;
    this.misc[i * 4 + 1] = flash;
    this.misc[i * 4 + 2] = alpha;
    this.misc[i * 4 + 3] = flip;
    this.mode[i] = mode;
    this.depth[i] = depth;
    this.count++;
  }

  /** Uploads this frame's instances; a sorted batch is reordered back to front first. */
  commit(): void {
    const n = this.count;
    if (this.sorted && n > 1) {
      const order = this.order.subarray(0, n);
      for (let i = 0; i < n; i++) order[i] = i;
      const depth = this.depth;
      order.sort((a, b) => depth[a]! - depth[b]!);
      this.permute(this.pos, 3, order);
      this.permute(this.rect, 4, order);
      this.permute(this.uv, 4, order);
      this.permute(this.misc, 4, order);
      this.permute(this.mode, 1, order);
    }
    for (const name of ['iPos', 'iRect', 'iUv', 'iMisc', 'iMode']) {
      const attr = this.geometry.getAttribute(name) as InstancedBufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  private permute(array: Float32Array, size: number, order: Uint32Array): void {
    const n = order.length;
    const tmp = this.scratch;
    for (let k = 0; k < n; k++) {
      const src = order[k]! * size;
      for (let c = 0; c < size; c++) tmp[k * size + c] = array[src + c]!;
    }
    array.set(tmp.subarray(0, n * size));
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as Material).dispose();
  }
}

/**
 * Soft round shadows under everything standing. Not cast by a light: a disc on
 * the floor is what grounds a sprite in a 3D view, and the pixel art has none
 * of its own to cast.
 */
class ShadowBatch {
  readonly mesh: Mesh;
  private readonly geometry = quadGeometry();
  private readonly data: Float32Array;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.data = instanced(this.geometry, 'iShadow', capacity, 3);
    const material = new ShaderMaterial({
      // The palette's void black, read as sRGB so it survives the output encode.
      uniforms: { uColor: { value: new Color('#040109') } },
      vertexShader: /* glsl */ `
        attribute vec3 iShadow;
        varying vec2 vLocal;
        void main() {
          vLocal = position.xy * 2.0 - 1.0;
          vec3 p = vec3(iShadow.x + vLocal.x * iShadow.z, ${DECAL_LIFT / 2}, iShadow.y + vLocal.y * iShadow.z);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vLocal;
        void main() {
          if (dot(vLocal, vLocal) > 1.0) discard;
          gl_FragColor = vec4(uColor, 0.4);
          #include <colorspace_fragment>
        }
      `,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
  }

  clear(): void {
    this.count = 0;
  }

  push(x: number, z: number, radius: number): void {
    const i = this.count;
    if (i >= this.capacity) return;
    this.data[i * 3] = x;
    this.data[i * 3 + 1] = z;
    this.data[i * 3 + 2] = Math.max(2, radius);
    this.count++;
  }

  commit(): void {
    const attr = this.geometry.getAttribute('iShadow') as InstancedBufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.count * 3);
    attr.needsUpdate = true;
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as Material).dispose();
  }
}
