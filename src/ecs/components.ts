/**
 * Component layout notes
 * ----------------------
 * Hot per-entity data lives in parallel typed arrays on `World` (structure of
 * arrays), indexed by entity id. That keeps the inner loops — movement,
 * broadphase, drawing — over contiguous memory, which matters once a few
 * thousand enemies and gems are alive at once.
 *
 * `Comp` is a bitmask of which arrays are meaningful for a given entity, so a
 * system can skip entities it doesn't care about with a single AND.
 *
 * Rarely-touched data (an enemy's death-drop table, a weapon's owner chain)
 * lives in plain Maps on World instead. Cold data doesn't belong in the hot loop.
 */

/** Broad category, used to keep per-kind iteration lists. */
export const Kind = {
  None: 0,
  Player: 1,
  Enemy: 2,
  Projectile: 3,
  Pickup: 4,
  /** Persistent damaging area — auras, lingering fire, garlic. */
  Hazard: 5,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const Comp = {
  Transform: 1 << 0,
  Velocity: 1 << 1,
  Sprite: 1 << 2,
  Health: 1 << 3,
  Collider: 1 << 4,
  /** Steers toward the player each tick. */
  Chase: 1 << 5,
  /** Expires when `lifetime` reaches zero. */
  Lifetime: 1 << 6,
  /** Deals damage on overlap. */
  Damaging: 1 << 7,
  /** Position is driven by an orbit around its owner, not by velocity. */
  Orbit: 1 << 8,
  /** Drifts toward the player when in magnet range, then is collected. */
  Magnetic: 1 << 9,
  /** Pushed around by knockback and by other enemies. */
  Pushable: 1 << 10,
  /** Never culled for being far off-screen (bosses). */
  Persistent: 1 << 11,
  /** Fires projectiles at the player on a timer. */
  Shooter: 1 << 12,
} as const;
export type Comp = (typeof Comp)[keyof typeof Comp];

export const Team = {
  Player: 0,
  Enemy: 1,
} as const;
export type Team = (typeof Team)[keyof typeof Team];

/** Which animation strip an entity is currently playing. */
export const AnimState = {
  Idle: 0,
  Walk: 1,
  Hurt: 2,
  Death: 3,
} as const;
export type AnimState = (typeof AnimState)[keyof typeof AnimState];

/** How an enemy moves. Selected per enemy type in `content/enemies.json`. */
export const Behavior = {
  /** Beeline at the player forever. The baseline swarm enemy. */
  Chase: 0,
  /** Chases, but periodically locks direction and dashes. */
  Charger: 1,
  /** Circles the player at a preferred radius instead of closing in. */
  Orbiter: 2,
  /** Keeps its distance and fires projectiles. */
  Ranged: 3,
  /** Moves in a straight line across the arena, ignoring the player. */
  Drifter: 4,
  /** Chase, but in bursts with pauses — reads as hopping. */
  Hopper: 5,
} as const;
export type Behavior = (typeof Behavior)[keyof typeof Behavior];

export function behaviorFromName(name: string | undefined): Behavior {
  switch (name) {
    case 'charger':
      return Behavior.Charger;
    case 'orbiter':
      return Behavior.Orbiter;
    case 'ranged':
      return Behavior.Ranged;
    case 'drifter':
      return Behavior.Drifter;
    case 'hopper':
      return Behavior.Hopper;
    case 'chase':
    case undefined:
      return Behavior.Chase;
    default:
      console.warn(`[content] unknown enemy behavior "${name}", falling back to chase`);
      return Behavior.Chase;
  }
}
