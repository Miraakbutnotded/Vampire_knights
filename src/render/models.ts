import { Box3, Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import modelsContent from '../content/models.json';
import type { SpriteTable } from './sprites.ts';
import { UPRIGHT_UNITS_PER_PX } from './view3d.ts';

const ASSET_ROOT = 'assets/';

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
  return pivot;
}
