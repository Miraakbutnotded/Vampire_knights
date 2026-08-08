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
  /** Defendable castle objective — gates, shrines. Static, player-team, has HP. */
  Structure: 6,
  /**
   * A body playing out its death animation. Purely cosmetic: no collider, no
   * health, no team. It is its own Kind rather than a flagged enemy precisely
   * so every enemy system — the broadphase, contact damage, weapon targeting,
   * the wave cap — keeps ignoring it for free, by iterating a list it is not on.
   */
  Corpse: 7,
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
  /**
   * Closes to touching range, lights a fuse, then detonates in an area.
   * Deals no contact damage: the blast is its entire damage budget, so killing
   * it on the fuse costs the player nothing.
   */
  Exploder: 6,
  /** Chases like the baseline swarm, but breaks into smaller enemies on death. */
  Splitter: 7,
} as const;
export type Behavior = (typeof Behavior)[keyof typeof Behavior];

/**
 * Charger phases, stored in `aiPhase`.
 *
 * The AI phase vocabularies live beside `Behavior` rather than in the system
 * that reads them, because both the spawn path (which seeds a phase) and the
 * update path (which advances it) need them, and those two are deliberately in
 * different modules — see the note atop `gameplay/spawn.ts`.
 */
export const ChargePhase = {
  Approach: 0,
  Windup: 1,
  Dash: 2,
  Rest: 3,
} as const;
export type ChargePhase = (typeof ChargePhase)[keyof typeof ChargePhase];

/** Exploder phases, stored in `aiPhase`. */
export const FusePhase = {
  /** Closing on the target, harmless. */
  Approach: 0,
  /** Stopped, flashing, counting down `aiTimer` to the blast. */
  Lit: 1,
} as const;
export type FusePhase = (typeof FusePhase)[keyof typeof FusePhase];

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
    case 'exploder':
      return Behavior.Exploder;
    case 'splitter':
      return Behavior.Splitter;
    case 'chase':
    case undefined:
      return Behavior.Chase;
    default:
      console.warn(`[content] unknown enemy behavior "${name}", falling back to chase`);
      return Behavior.Chase;
  }
}
