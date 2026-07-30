import { Behavior, behaviorFromName } from '../ecs/components.ts';
import charactersJson from '../content/characters.json';
import enemiesJson from '../content/enemies.json';
import weaponsJson from '../content/weapons.json';
import passivesJson from '../content/passives.json';
import wavesJson from '../content/waves.json';

/**
 * Turns the hand-authored JSON in src/content into typed defs with every
 * optional field resolved to a default.
 *
 * Everything is normalized once, at module load, so no gameplay system ever has
 * to deal with an absent field or re-parse a string. Unknown references are
 * reported as warnings rather than thrown, because a typo in a content file
 * should cost you one enemy type, not the whole game.
 */

// --- enemies --------------------------------------------------------------

export interface EnemyDef {
  id: string;
  index: number;
  name: string;
  sprite: string;
  behavior: Behavior;
  hp: number;
  damage: number;
  speed: number;
  radius: number;
  xp: number;
  /** 0 = knocked back fully, 1 = immovable. */
  knockbackResist: number;
  coinChance: number;
  coin: number;
  elite: boolean;
  boss: boolean;
  dropsChest: boolean;

  // charger / hopper
  windupTime: number;
  dashTime: number;
  dashSpeed: number;
  restTime: number;
  hopTime: number;

  // orbiter
  orbitRadius: number;
  orbitSpeed: number;

  // ranged
  preferredRange: number;
  shootInterval: number;
  projectileSprite: string;
  projectileSpeed: number;
  projectileDamage: number;
  projectileRadius: number;
  projectileLifetime: number;
}

function normalizeEnemies(): { list: EnemyDef[]; byId: Map<string, EnemyDef> } {
  const raw = enemiesJson as unknown as Record<string, Record<string, unknown>>;
  const list: EnemyDef[] = [];
  const byId = new Map<string, EnemyDef>();

  for (const [id, def] of Object.entries(raw)) {
    const num = (key: string, fallback: number): number => {
      const v = def[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
    const str = (key: string, fallback: string): string => {
      const v = def[key];
      return typeof v === 'string' ? v : fallback;
    };
    const bool = (key: string): boolean => def[key] === true;

    const entry: EnemyDef = {
      id,
      index: list.length,
      name: str('name', id),
      sprite: str('sprite', 'blob'),
      behavior: behaviorFromName(typeof def['behavior'] === 'string' ? (def['behavior'] as string) : undefined),
      hp: num('hp', 10),
      damage: num('damage', 5),
      speed: num('speed', 30),
      radius: num('radius', 5),
      xp: num('xp', 1),
      knockbackResist: Math.min(1, Math.max(0, num('knockbackResist', 0))),
      coinChance: num('coinChance', 0),
      coin: num('coin', 1),
      elite: bool('elite'),
      boss: bool('boss'),
      dropsChest: bool('dropsChest'),

      windupTime: num('windupTime', 0.6),
      dashTime: num('dashTime', 0.5),
      dashSpeed: num('dashSpeed', 140),
      restTime: num('restTime', 1),
      hopTime: num('hopTime', 0.4),

      orbitRadius: num('orbitRadius', 48),
      orbitSpeed: num('orbitSpeed', 1.5),

      preferredRange: num('preferredRange', 110),
      shootInterval: num('shootInterval', 2.5),
      projectileSprite: str('projectileSprite', 'proj_enemy'),
      projectileSpeed: num('projectileSpeed', 70),
      projectileDamage: num('projectileDamage', 6),
      projectileRadius: num('projectileRadius', 4),
      projectileLifetime: num('projectileLifetime', 4),
    };

    list.push(entry);
    byId.set(id, entry);
  }

  if (list.length === 0) throw new Error('content/enemies.json defines no enemies');
  return { list, byId };
}

const enemyData = normalizeEnemies();
export const ENEMY_LIST: readonly EnemyDef[] = enemyData.list;

export function enemyDef(id: string): EnemyDef | null {
  const def = enemyData.byId.get(id);
  if (!def) {
    warnOnce(`[content] unknown enemy "${id}"`);
    return null;
  }
  return def;
}

export function enemyDefByIndex(index: number): EnemyDef {
  return enemyData.list[index] ?? enemyData.list[0]!;
}

// --- weapons --------------------------------------------------------------

export const WeaponBehavior = {
  /** Melee sweep in the facing direction. */
  Arc: 'arc',
  /** Projectile that steers toward the nearest enemy. */
  Homing: 'homing',
  /** Projectile fired in a straight line. */
  Straight: 'straight',
  /** Persistent damaging ring centred on the player. */
  Aura: 'aura',
  /** Satellites circling the player for a limited duration. */
  Orbit: 'orbit',
  /** Lobs hazards that linger on the ground. */
  Drop: 'drop',
  /** Radial burst of projectiles. */
  Nova: 'nova',
  /** Instant strikes on random on-screen enemies. */
  Lightning: 'lightning',
} as const;
export type WeaponBehavior = (typeof WeaponBehavior)[keyof typeof WeaponBehavior];

const WEAPON_BEHAVIORS = new Set<string>(Object.values(WeaponBehavior));

/** Every tunable a weapon can have. Behaviours read the subset that applies. */
export interface WeaponStats {
  damage: number;
  cooldown: number;
  count: number;
  /** Enemies a projectile passes through. -1 = unlimited. */
  pierce: number;
  area: number;
  duration: number;
  knockback: number;
  speed: number;
  lifetime: number;
  /** Seconds between repeat hits for persistent sources. */
  interval: number;
  radius: number;
  orbitSpeed: number;
  spawnRadius: number;
  reach: number;
  spread: number;
  turnRate: number;
}

const WEAPON_STAT_KEYS: readonly (keyof WeaponStats)[] = [
  'damage',
  'cooldown',
  'count',
  'pierce',
  'area',
  'duration',
  'knockback',
  'speed',
  'lifetime',
  'interval',
  'radius',
  'orbitSpeed',
  'spawnRadius',
  'reach',
  'spread',
  'turnRate',
];

const WEAPON_STAT_DEFAULTS: WeaponStats = {
  damage: 10,
  cooldown: 1,
  count: 1,
  pierce: 1,
  area: 1,
  duration: 0,
  knockback: 0,
  speed: 0,
  lifetime: 2,
  interval: 0,
  radius: 0,
  orbitSpeed: 2,
  spawnRadius: 0,
  reach: 0,
  spread: 0,
  turnRate: 0,
};

export interface WeaponLevel {
  deltas: Partial<WeaponStats>;
  note: string;
}

export interface WeaponDef {
  id: string;
  index: number;
  name: string;
  sprite: string;
  behavior: WeaponBehavior;
  description: string;
  /** Relative likelihood of being offered in a level-up draft. */
  weight: number;
  maxLevel: number;
  base: WeaponStats;
  levels: WeaponLevel[];
}

function normalizeWeapons(): { list: WeaponDef[]; byId: Map<string, WeaponDef> } {
  const raw = weaponsJson as unknown as Record<string, Record<string, unknown>>;
  const list: WeaponDef[] = [];
  const byId = new Map<string, WeaponDef>();

  for (const [id, def] of Object.entries(raw)) {
    const behaviorRaw = typeof def['behavior'] === 'string' ? (def['behavior'] as string) : '';
    if (!WEAPON_BEHAVIORS.has(behaviorRaw)) {
      console.warn(
        `[content] weapon "${id}" has unknown behavior "${behaviorRaw}"; skipping it. ` +
          `Valid: ${[...WEAPON_BEHAVIORS].join(', ')}`,
      );
      continue;
    }

    const baseRaw = (def['base'] ?? {}) as Record<string, unknown>;
    const base = { ...WEAPON_STAT_DEFAULTS };
    for (const key of WEAPON_STAT_KEYS) {
      const v = baseRaw[key];
      if (typeof v === 'number' && Number.isFinite(v)) base[key] = v;
    }

    const levelsRaw = Array.isArray(def['levels']) ? (def['levels'] as Record<string, unknown>[]) : [];
    const levels: WeaponLevel[] = levelsRaw.map((entry) => {
      const deltas: Partial<WeaponStats> = {};
      for (const key of WEAPON_STAT_KEYS) {
        const v = entry[key];
        if (typeof v === 'number' && Number.isFinite(v)) deltas[key] = v;
      }
      return { deltas, note: typeof entry['note'] === 'string' ? entry['note'] : 'Improved' };
    });

    const entry: WeaponDef = {
      id,
      index: list.length,
      name: typeof def['name'] === 'string' ? def['name'] : id,
      sprite: typeof def['sprite'] === 'string' ? def['sprite'] : 'proj_bolt',
      behavior: behaviorRaw as WeaponBehavior,
      description: typeof def['description'] === 'string' ? def['description'] : '',
      weight: typeof def['weight'] === 'number' ? def['weight'] : 100,
      // Level 1 is the base, so the ceiling is one above the number of upgrades.
      maxLevel: levels.length + 1,
      base,
      levels,
    };

    list.push(entry);
    byId.set(id, entry);
  }

  if (list.length === 0) throw new Error('content/weapons.json defines no usable weapons');
  return { list, byId };
}

const weaponData = normalizeWeapons();
export const WEAPON_LIST: readonly WeaponDef[] = weaponData.list;

export function weaponDef(id: string): WeaponDef | null {
  const def = weaponData.byId.get(id);
  if (!def) {
    warnOnce(`[content] unknown weapon "${id}"`);
    return null;
  }
  return def;
}

/** Accumulates level deltas onto the base stats. `level` is 1-based. */
export function weaponStatsAtLevel(def: WeaponDef, level: number): WeaponStats {
  const stats = { ...def.base };
  const upgrades = Math.min(Math.max(0, level - 1), def.levels.length);
  for (let i = 0; i < upgrades; i++) {
    const deltas = def.levels[i]!.deltas;
    for (const key of WEAPON_STAT_KEYS) {
      const delta = deltas[key];
      if (delta !== undefined) stats[key] += delta;
    }
  }
  return stats;
}

// --- passives -------------------------------------------------------------

/** Stat modifiers a passive can grant. All are per-level and additive. */
export interface StatMods {
  maxHpMul: number;
  recovery: number;
  armor: number;
  moveSpeedMul: number;
  might: number;
  area: number;
  projectileSpeed: number;
  duration: number;
  amount: number;
  cooldown: number;
  magnetMul: number;
  growth: number;
  greed: number;
  luck: number;
  critChance: number;
  critMult: number;
}

const STAT_MOD_KEYS: readonly (keyof StatMods)[] = [
  'maxHpMul',
  'recovery',
  'armor',
  'moveSpeedMul',
  'might',
  'area',
  'projectileSpeed',
  'duration',
  'amount',
  'cooldown',
  'magnetMul',
  'growth',
  'greed',
  'luck',
  'critChance',
  'critMult',
];

export interface PassiveDef {
  id: string;
  index: number;
  name: string;
  description: string;
  maxLevel: number;
  weight: number;
  perLevel: Partial<StatMods>;
}

function normalizePassives(): { list: PassiveDef[]; byId: Map<string, PassiveDef> } {
  const raw = passivesJson as unknown as Record<string, Record<string, unknown>>;
  const list: PassiveDef[] = [];
  const byId = new Map<string, PassiveDef>();

  for (const [id, def] of Object.entries(raw)) {
    const perLevelRaw = (def['perLevel'] ?? {}) as Record<string, unknown>;
    const perLevel: Partial<StatMods> = {};
    for (const key of STAT_MOD_KEYS) {
      const v = perLevelRaw[key];
      if (typeof v === 'number' && Number.isFinite(v)) perLevel[key] = v;
    }
    for (const key of Object.keys(perLevelRaw)) {
      if (!STAT_MOD_KEYS.includes(key as keyof StatMods)) {
        console.warn(
          `[content] passive "${id}" sets unknown stat "${key}"; it will have no effect. ` +
            `Valid: ${STAT_MOD_KEYS.join(', ')}`,
        );
      }
    }

    const entry: PassiveDef = {
      id,
      index: list.length,
      name: typeof def['name'] === 'string' ? def['name'] : id,
      description: typeof def['description'] === 'string' ? def['description'] : '',
      maxLevel: typeof def['maxLevel'] === 'number' ? def['maxLevel'] : 5,
      weight: typeof def['weight'] === 'number' ? def['weight'] : 100,
      perLevel,
    };
    list.push(entry);
    byId.set(id, entry);
  }

  return { list, byId };
}

const passiveData = normalizePassives();
export const PASSIVE_LIST: readonly PassiveDef[] = passiveData.list;

export function passiveDef(id: string): PassiveDef | null {
  return passiveData.byId.get(id) ?? null;
}

// --- characters -----------------------------------------------------------

export interface BaseStats {
  maxHp: number;
  recovery: number;
  armor: number;
  moveSpeed: number;
  might: number;
  area: number;
  projectileSpeed: number;
  duration: number;
  amount: number;
  cooldown: number;
  magnet: number;
  growth: number;
  greed: number;
  luck: number;
  critChance: number;
  critMult: number;
  revives: number;
}

const BASE_STAT_DEFAULTS: BaseStats = {
  maxHp: 100,
  recovery: 0,
  armor: 0,
  moveSpeed: 64,
  might: 1,
  area: 1,
  projectileSpeed: 1,
  duration: 1,
  amount: 0,
  cooldown: 1,
  magnet: 30,
  growth: 1,
  greed: 1,
  luck: 1,
  critChance: 0.05,
  critMult: 2,
  revives: 0,
};

export interface CharacterDef {
  id: string;
  name: string;
  sprite: string;
  description: string;
  startingWeapon: string;
  radius: number;
  stats: BaseStats;
}

function normalizeCharacters(): { list: CharacterDef[]; byId: Map<string, CharacterDef> } {
  const raw = charactersJson as unknown as Record<string, Record<string, unknown>>;
  const list: CharacterDef[] = [];
  const byId = new Map<string, CharacterDef>();

  for (const [id, def] of Object.entries(raw)) {
    const statsRaw = (def['stats'] ?? {}) as Record<string, unknown>;
    const stats = { ...BASE_STAT_DEFAULTS };
    for (const key of Object.keys(BASE_STAT_DEFAULTS) as (keyof BaseStats)[]) {
      const v = statsRaw[key];
      if (typeof v === 'number' && Number.isFinite(v)) stats[key] = v;
    }

    const startingWeapon =
      typeof def['startingWeapon'] === 'string' ? (def['startingWeapon'] as string) : WEAPON_LIST[0]!.id;
    if (!weaponData.byId.has(startingWeapon)) {
      console.warn(
        `[content] character "${id}" starts with unknown weapon "${startingWeapon}"; using "${WEAPON_LIST[0]!.id}"`,
      );
    }

    const entry: CharacterDef = {
      id,
      name: typeof def['name'] === 'string' ? def['name'] : id,
      sprite: typeof def['sprite'] === 'string' ? def['sprite'] : 'player',
      description: typeof def['description'] === 'string' ? def['description'] : '',
      startingWeapon: weaponData.byId.has(startingWeapon) ? startingWeapon : WEAPON_LIST[0]!.id,
      radius: typeof def['radius'] === 'number' ? def['radius'] : 5,
      stats,
    };
    list.push(entry);
    byId.set(id, entry);
  }

  if (list.length === 0) throw new Error('content/characters.json defines no characters');
  return { list, byId };
}

const characterData = normalizeCharacters();
export const CHARACTER_LIST: readonly CharacterDef[] = characterData.list;

export function characterDef(id: string): CharacterDef {
  return characterData.byId.get(id) ?? characterData.list[0]!;
}

// --- waves ----------------------------------------------------------------

export interface WaveEnemyEntry {
  type: string;
  weight: number;
}

export interface WaveStage {
  at: number;
  spawnInterval: number;
  perSpawn: number;
  enemies: WaveEnemyEntry[];
}

export interface EliteSchedule {
  startAt: number;
  interval: number;
  type: string;
  count: number;
  countGrowthPerMinute: number;
}

export interface BossSpawn {
  at: number;
  type: string;
  count: number;
}

export interface WaveTable {
  id: string;
  victorySeconds: number;
  maxAlive: number;
  hpPerMinute: number;
  damagePerMinute: number;
  speedPerMinute: number;
  hpExponent: number;
  stages: WaveStage[];
  elites: EliteSchedule | null;
  bosses: BossSpawn[];
}

function normalizeWaves(): Map<string, WaveTable> {
  const raw = wavesJson as unknown as Record<string, Record<string, unknown>>;
  const tables = new Map<string, WaveTable>();

  for (const [id, def] of Object.entries(raw)) {
    const scaling = (def['scaling'] ?? {}) as Record<string, unknown>;
    const numFrom = (obj: Record<string, unknown>, key: string, fallback: number): number => {
      const v = obj[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };

    const stagesRaw = Array.isArray(def['waves']) ? (def['waves'] as Record<string, unknown>[]) : [];
    const stages: WaveStage[] = stagesRaw
      .map((stage) => ({
        at: numFrom(stage, 'at', 0),
        spawnInterval: Math.max(0.05, numFrom(stage, 'spawnInterval', 1)),
        perSpawn: Math.max(1, Math.round(numFrom(stage, 'perSpawn', 1))),
        enemies: (Array.isArray(stage['enemies']) ? (stage['enemies'] as Record<string, unknown>[]) : [])
          .map((e) => ({
            type: typeof e['type'] === 'string' ? (e['type'] as string) : '',
            weight: numFrom(e, 'weight', 1),
          }))
          .filter((e) => {
            if (!e.type) return false;
            if (!enemyData.byId.has(e.type)) {
              console.warn(`[content] wave table "${id}" references unknown enemy "${e.type}"`);
              return false;
            }
            return true;
          }),
      }))
      // Sorted so the spawner can walk forward through them by time.
      .sort((a, b) => a.at - b.at);

    if (stages.length === 0 || stages[0]!.enemies.length === 0) {
      console.warn(`[content] wave table "${id}" has no usable first stage; nothing will spawn`);
    }

    const elitesRaw = def['elites'] as Record<string, unknown> | undefined;
    let elites: EliteSchedule | null = null;
    if (elitesRaw && typeof elitesRaw['type'] === 'string' && enemyData.byId.has(elitesRaw['type'])) {
      elites = {
        startAt: numFrom(elitesRaw, 'startAt', 120),
        interval: Math.max(5, numFrom(elitesRaw, 'interval', 60)),
        type: elitesRaw['type'],
        count: Math.max(1, Math.round(numFrom(elitesRaw, 'count', 1))),
        countGrowthPerMinute: numFrom(elitesRaw, 'countGrowthPerMinute', 0),
      };
    }

    const bossesRaw = Array.isArray(def['bosses']) ? (def['bosses'] as Record<string, unknown>[]) : [];
    const bosses: BossSpawn[] = bossesRaw
      .filter((b) => typeof b['type'] === 'string' && enemyData.byId.has(b['type'] as string))
      .map((b) => ({
        at: numFrom(b, 'at', 0),
        type: b['type'] as string,
        count: Math.max(1, Math.round(numFrom(b, 'count', 1))),
      }))
      .sort((a, b) => a.at - b.at);

    tables.set(id, {
      id,
      victorySeconds: numFrom(def, 'victorySeconds', 900),
      maxAlive: Math.max(20, Math.round(numFrom(def, 'maxAlive', 400))),
      hpPerMinute: numFrom(scaling, 'hpPerMinute', 0.2),
      damagePerMinute: numFrom(scaling, 'damagePerMinute', 0.05),
      speedPerMinute: numFrom(scaling, 'speedPerMinute', 0.01),
      hpExponent: numFrom(scaling, 'hpExponent', 1),
      stages,
      elites,
      bosses,
    });
  }

  if (tables.size === 0) throw new Error('content/waves.json defines no wave tables');
  return tables;
}

const waveTables = normalizeWaves();

export function waveTable(id: string): WaveTable {
  const table = waveTables.get(id);
  if (table) return table;
  const fallback = waveTables.get('default') ?? [...waveTables.values()][0]!;
  warnOnce(`[content] unknown wave table "${id}"; using "${fallback.id}"`);
  return fallback;
}

// --- shared ---------------------------------------------------------------

const warned = new Set<string>();

/** Content mistakes are usually in a hot loop; only complain about each once. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}
