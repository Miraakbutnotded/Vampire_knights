import { clamp } from '../core/math.ts';
import { BLOOD_CONFIG, characterDef, passiveDef, weaponDef } from './content.ts';
import type { AbilityDef, BaseStats, CharacterDef, MetaMods, PassiveDef, StatMods, WeaponDef } from './content.ts';

/** Weapons and passives are capped separately, as in the genre standard. */
export const MAX_WEAPON_SLOTS = 6;
export const MAX_PASSIVE_SLOTS = 6;

/** Cooldown multiplier can never fall below this, or attack rates go silly. */
const MIN_COOLDOWN_MUL = 0.35;

/**
 * Experience required to go from `level` to `level + 1`.
 *
 * Linear plus a mild power term: early levels come fast enough to establish a
 * build in the first minute, later ones slow down without ever stalling out.
 */
export function xpForLevel(level: number): number {
  const n = Math.max(1, level);
  return Math.floor(5 + 4 * (n - 1) + Math.pow(n - 1, 1.6));
}

export interface OwnedWeapon {
  def: WeaponDef;
  level: number;
  /** Seconds until it may fire again. */
  cooldown: number;
  /**
   * Behaviour-local state. Orbit uses it to track the ids of its satellites and
   * whether the volley is currently active; other behaviours ignore it.
   */
  activeIds: number[];
  activeTimer: number;
  active: boolean;
}

export interface OwnedPassive {
  def: PassiveDef;
  level: number;
}

/**
 * Per-run active-ability state, mirroring the OwnedWeapon.timer precedent:
 * cooldowns live on Run structures and are ticked by gameplay systems
 * (updateAbility) on sim dt only.
 */
export interface AbilityState {
  def: AbilityDef;
  /** Seconds until the next cast. 0 = ready. */
  cooldownLeft: number;
  /** Buff window / volley burst window remaining. */
  activeLeft: number;
  /** Volley: shots still queued in the current burst. */
  burstLeft: number;
  /** Volley: seconds until the next queued shot. */
  burstTimer: number;
}

/**
 * Everything about the current run: progression, loadout and the stats derived
 * from them.
 *
 * Derived stats are recomputed only when the loadout changes rather than per
 * tick, since weapons read them every time they fire.
 */
export class Run {
  character: CharacterDef;

  time = 0;
  level = 1;
  xp = 0;
  xpNeeded: number;
  kills = 0;
  gold = 0;

  /** Level-ups banked but not yet spent, so several can queue during a big pickup. */
  pendingLevelUps = 0;

  weapons: OwnedWeapon[] = [];
  passives: OwnedPassive[] = [];

  /** Derived from character base + passive levels. Read-only to callers. */
  stats: BaseStats;

  /** How many revives are still available this run. */
  revivesLeft: number;

  /**
   * Persistent Sanctum bonuses for this run, immutable once constructed.
   * recomputeStats() folds them into its accumulator as the first source,
   * so every existing clamp treats meta exactly like passives. `revives`
   * is handled separately in the constructor (revivesLeft, not stats).
   */
  private readonly metaMods: MetaMods;

  // --- blood economy ------------------------------------------------------
  // All timers advance only inside updateBlood on sim dt — never wall clock —
  // so a run stays reproducible from its seed.

  /** Banked blood, 0..bloodMax. */
  blood = 0;
  bloodMax = BLOOD_CONFIG.barMax;
  /** Blood absorbed during the current sim-second, for the anti-farm cap. */
  bloodIntakeWindow = 0;
  /** Seconds of Frenzy remaining. Read-side multipliers key off this. */
  frenzyT = 0;
  /** Seconds of decay grace left after the most recent gain. */
  graceT = 0;

  /** Active-ability state, or null for a character without one. */
  ability: AbilityState | null = null;

  /**
   * Stat mods from an active buff ability, or null. Set on activation and
   * cleared on expiry inside updateAbility — both state changes — and folded
   * into recomputeStats as its third source. Never touched per tick.
   */
  abilityMods: Partial<StatMods> | null = null;

  // --- castle defense -----------------------------------------------------

  /** Structures spawned this run, in spawn order — the HUD pip count. */
  structuresSpawned = 0;
  /** Structures lost this run; difficultyAt turns each into +8% damage/speed. */
  structuresLost = 0;

  constructor(characterId: string, metaMods: MetaMods = {}) {
    this.character = characterDef(characterId);
    this.metaMods = metaMods;
    this.stats = { ...this.character.stats };
    this.xpNeeded = xpForLevel(1);
    this.revivesLeft =
      this.character.stats.revives + Math.max(0, Math.floor(this.metaMods.revives ?? 0));
    this.ability = this.character.ability
      ? { def: this.character.ability, cooldownLeft: 0, activeLeft: 0, burstLeft: 0, burstTimer: 0 }
      : null;

    const starter = weaponDef(this.character.startingWeapon);
    if (starter) this.addWeapon(starter.id);
    this.recomputeStats();
  }

  // --- loadout ------------------------------------------------------------

  weaponLevel(id: string): number {
    return this.weapons.find((w) => w.def.id === id)?.level ?? 0;
  }

  passiveLevel(id: string): number {
    return this.passives.find((p) => p.def.id === id)?.level ?? 0;
  }

  hasWeaponSlot(): boolean {
    return this.weapons.length < MAX_WEAPON_SLOTS;
  }

  hasPassiveSlot(): boolean {
    return this.passives.length < MAX_PASSIVE_SLOTS;
  }

  /** Adds a weapon at level 1, or levels it up if already owned. Returns the new level. */
  addWeapon(id: string): number {
    const existing = this.weapons.find((w) => w.def.id === id);
    if (existing) {
      if (existing.level < existing.def.maxLevel) existing.level++;
      return existing.level;
    }
    const def = weaponDef(id);
    if (!def) return 0;
    if (!this.hasWeaponSlot()) return 0;
    this.weapons.push({
      def,
      level: 1,
      // Stagger the first shot slightly so a fresh weapon doesn't fire in the
      // same frame as everything else the player owns.
      cooldown: 0.15 * this.weapons.length,
      activeIds: [],
      activeTimer: 0,
      active: false,
    });
    return 1;
  }

  /** Adds a passive at level 1, or levels it up. Returns the new level. */
  addPassive(id: string): number {
    const existing = this.passives.find((p) => p.def.id === id);
    if (existing) {
      if (existing.level < existing.def.maxLevel) {
        existing.level++;
        this.recomputeStats();
      }
      return existing.level;
    }
    const def = passiveDef(id);
    if (!def) return 0;
    if (!this.hasPassiveSlot()) return 0;
    this.passives.push({ def, level: 1 });
    this.recomputeStats();
    return 1;
  }

  /**
   * Folds every passive level into the character's base stats.
   *
   * Health, move speed and magnet range are multiplicative because they scale
   * an existing quantity; the rest are additive so a +10% might passive reads as
   * exactly +0.1 to the damage multiplier and stacking stays predictable.
   */
  recomputeStats(): void {
    const base = this.character.stats;
    const sum: StatMods = {
      maxHpMul: 0,
      recovery: 0,
      armor: 0,
      moveSpeedMul: 0,
      might: 0,
      area: 0,
      projectileSpeed: 0,
      duration: 0,
      amount: 0,
      cooldown: 0,
      magnetMul: 0,
      growth: 0,
      greed: 0,
      luck: 0,
      critChance: 0,
      critMult: 0,
      bloodGain: 0,
    };

    // First source: persistent Sanctum mods. Seeding the accumulator rather
    // than adding a separate pass means the clamps below (MIN_COOLDOWN_MUL,
    // the area/duration floors, the crit clamp) apply to meta bonuses
    // identically to passives and ability buffs.
    for (const [key, value] of Object.entries(this.metaMods)) {
      if (value === undefined || key === 'revives') continue;
      sum[key as keyof StatMods] += value;
    }

    for (const owned of this.passives) {
      for (const [key, perLevel] of Object.entries(owned.def.perLevel)) {
        if (perLevel === undefined) continue;
        sum[key as keyof StatMods] += perLevel * owned.level;
      }
    }

    // Third source: an active buff ability. It enters through the same summed
    // mods as passives, so every clamp below applies identically, and the
    // restore on expiry is exact because this derives from scratch.
    if (this.abilityMods) {
      for (const [key, value] of Object.entries(this.abilityMods)) {
        if (value === undefined) continue;
        sum[key as keyof StatMods] += value;
      }
    }

    const previousMaxHp = this.stats.maxHp;

    this.stats = {
      maxHp: Math.round(base.maxHp * (1 + sum.maxHpMul)),
      recovery: base.recovery + sum.recovery,
      armor: base.armor + sum.armor,
      moveSpeed: base.moveSpeed * (1 + sum.moveSpeedMul),
      might: base.might + sum.might,
      area: Math.max(0.2, base.area + sum.area),
      projectileSpeed: Math.max(0.2, base.projectileSpeed + sum.projectileSpeed),
      duration: Math.max(0.2, base.duration + sum.duration),
      amount: base.amount + sum.amount,
      cooldown: Math.max(MIN_COOLDOWN_MUL, base.cooldown + sum.cooldown),
      magnet: base.magnet * (1 + sum.magnetMul),
      growth: Math.max(0.1, base.growth + sum.growth),
      greed: Math.max(0, base.greed + sum.greed),
      luck: Math.max(0, base.luck + sum.luck),
      critChance: clamp(base.critChance + sum.critChance, 0, 0.95),
      critMult: base.critMult + sum.critMult,
      bloodGain: Math.max(0, base.bloodGain + sum.bloodGain),
      revives: base.revives,
    };

    // Report how much the max-health cap moved so the caller can grant the
    // difference as current health — otherwise a +health passive feels like it
    // did nothing until you find a pickup.
    this.maxHpDelta = this.stats.maxHp - previousMaxHp;
  }

  /** Change in max health from the most recent recomputeStats(). */
  maxHpDelta = 0;

  // --- progression --------------------------------------------------------

  /**
   * Grants experience, applying the growth multiplier. Returns how many levels
   * were gained, and banks them in `pendingLevelUps`.
   */
  gainXp(amount: number): number {
    this.xp += amount * this.stats.growth;
    let gained = 0;
    // A single large gem can cross several thresholds at once.
    while (this.xp >= this.xpNeeded) {
      this.xp -= this.xpNeeded;
      this.level++;
      this.xpNeeded = xpForLevel(this.level);
      gained++;
    }
    this.pendingLevelUps += gained;
    return gained;
  }

  gainGold(amount: number): number {
    const total = Math.max(1, Math.round(amount * this.stats.greed));
    this.gold += total;
    return total;
  }

  /**
   * Grants blood, honouring the per-second intake cap and the bar maximum.
   * Excess above either limit is discarded, not banked — the anti-farm rule.
   * Returns the blood actually gained.
   *
   * `uncapped` is for burst rewards (Blood Vials) that are meant to land whole:
   * they sidestep the intake window in both directions — neither limited by it
   * nor consuming any of it, so a vial can't eat the allowance kills need — but
   * they still clamp to the bar and still refresh the decay grace.
   */
  gainBlood(amount: number, uncapped = false): number {
    const room = uncapped ? Infinity : BLOOD_CONFIG.intakePerSec - this.bloodIntakeWindow;
    const granted = Math.min(amount, room, this.bloodMax - this.blood);
    if (granted <= 0) return 0;
    if (!uncapped) this.bloodIntakeWindow += granted;
    this.blood += granted;
    this.graceT = BLOOD_CONFIG.decayGrace;
    return granted;
  }

  /** 0..1 progress toward the next level, for the HUD bar. */
  get xpFraction(): number {
    return this.xpNeeded <= 0 ? 0 : clamp(this.xp / this.xpNeeded, 0, 1);
  }
}
