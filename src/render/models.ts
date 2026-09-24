import { BackSide, Box3, Color, Group, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import modelsContent from '../content/models.json';
import type { SpriteTable } from './sprites.ts';
import { PX, UPRIGHT_UNITS_PER_PX } from './view3d.ts';

const ASSET_ROOT = 'assets/';

/** Outline width around a model, in screen pixels. */
const OUTLINE_PX = 1.5;
/** How far the outline sits behind the surface it traces, in world units. */
const OUTLINE_PUSH = 0.6;
/** The palette's own outline colour — docs/art/palette.md, "void black / outline". */
const OUTLINE_COLOR = '#040109';

/**
 * One entry in content/models.json, keyed by the sprite name it stands in for.
 *
 * `height` is in screen pixels, like every other size in the game's art: the
 * model is scaled so its vertical extent draws that tall, which is how a model
 * is sized against the 30-pixel sprite it replaces without anyone converting
 * units. `yaw` turns it about the vertical, in degrees, for a model authored
 * facing some other way than the camera.
 */
interface ModelJson {
  src: string;
  height?: number;
  yaw?: number;
}

/**
 * 3D models that stand in for sprites in the 3D view.
 *
 * A sprite with an entry here draws as its model; every other sprite, and any
 * model that has not finished loading or failed to, draws as its billboard.
 * That is the same fail-soft contract as a missing PNG becoming a placeholder:
 * a bad path costs one model, never the view — and it is what lets models land
 * one at a time, with the game playable at every step.
 */
export class ModelLibrary {
  private readonly templates = new Map<number, Object3D>();

  constructor(sprites: SpriteTable) {
    const entries = Object.entries(modelsContent as Record<string, ModelJson>);
    if (entries.length === 0) return;

    const loader = new GLTFLoader();
    for (const [name, def] of entries) {
      if (!sprites.has(name)) {
        console.warn(`[models] "${name}" names no sprite in content/sprites.json; skipped`);
        continue;
      }
      const id = sprites.id(name);
      loader.load(
        ASSET_ROOT + def.src,
        (gltf) => this.templates.set(id, normalize(gltf.scene, def)),
        undefined,
        () => console.warn(`[models] could not load ${ASSET_ROOT + def.src}; "${name}" stays a sprite`),
      );
    }
  }

  /** The loaded model for a sprite, or undefined while it is (or stays) a billboard. */
  template(spriteId: number): Object3D | undefined {
    return this.templates.get(spriteId);
  }
}

/**
 * Wraps a loaded scene so its feet sit on the origin and it stands `height`
 * screen pixels tall — whatever scale and pivot the file was authored at.
 */
function normalize(scene: Object3D, def: ModelJson): Object3D {
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const targetHeight = (def.height ?? 32) * UPRIGHT_UNITS_PER_PX;
  const scale = size.y > 0 ? targetHeight / size.y : 1;

  scene.position.set(-centre.x, -box.min.y, -centre.z);
  const pivot = new Group();
  pivot.add(scene);
  pivot.scale.setScalar(scale);
  pivot.rotation.y = ((def.yaw ?? 0) * Math.PI) / 180;
  pivot.updateMatrixWorld(true);
  outline(scene);
  return pivot;
}

/**
 * Gives every mesh in a model the one-pixel dark outline every sprite in the
 * game is drawn with.
 *
 * An inverted hull: the mesh again, pushed out along its normals by about one
 * screen pixel and drawn back faces only, in the palette's near-black. Without
 * it a model reads as a render pasted into pixel art; with it, as one more
 * thing standing in the same world. Built once per template, so clones share
 * the geometry and the material.
 */
function outline(root: Object3D): void {
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof Mesh && node.geometry.getAttribute('normal')) meshes.push(node);
  });
  const worldScale = new Vector3();
  for (const mesh of meshes) {
    mesh.getWorldScale(worldScale);
    // One screen pixel is 1/PX world units across the view; the hull is built in
    // the mesh's own units, so that distance is divided back out of its scale.
    // A pixel and a half, because at exactly one the rasteriser rounds the
    // outline away on whichever side the silhouette lands between pixels.
    const thickness = OUTLINE_PX / PX / Math.max(1e-6, worldScale.x);
    const hull = new Mesh(
      mesh.geometry,
      new ShaderMaterial({
        uniforms: {
          uThickness: { value: thickness },
          uPush: { value: OUTLINE_PUSH },
          // Through Color so the hex is read as sRGB and handed to the shader
          // in linear; a raw vec4 would be brightened on its way out.
          uColor: { value: new Color(OUTLINE_COLOR) },
        },
        vertexShader: /* glsl */ `
          uniform float uThickness;
          uniform float uPush;
          void main() {
            vec4 view = modelViewMatrix * vec4(position + normal * uThickness, 1.0);
            // Slid away from the camera by a fixed distance, so where the hull
            // and the surface nearly coincide — inside a crenel, under a ledge —
            // the surface wins and the outline stays on the silhouette. A fixed
            // distance rather than polygonOffset, whose slope term shoves the
            // near-edge-on faces at the silhouette behind the floor.
            view.z -= uPush;
            gl_Position = projectionMatrix * view;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          void main() {
            gl_FragColor = vec4(uColor, 1.0);
            #include <colorspace_fragment>
          }
        `,
        side: BackSide,
      }),
    );
    mesh.add(hull);
  }
}
