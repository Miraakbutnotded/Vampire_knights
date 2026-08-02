import { EVOLVED_WEAPON_IDS, PASSIVE_LIST, WEAPON_LIST, weaponStatsAtLevel } from './content.ts';
import { healPlayer } from './pickups.ts';
import type { DraftPickKind } from '../core/events.ts';
import type { Ctx } from './context.ts';

/**
 * Upgrading something you already own is weighted above picking up something
 * new, so builds deepen into a specialty instead of spreading thin across six
 * level-one weapons.
 */
const EXISTING_WEIGHT_BONUS = 1.6;

/** Aliased rather than redeclared, so the event vocabulary is the only copy. */
export type OfferKind = DraftPickKind;

export interface Offer {
  kind: OfferKind;
  id: string;
  name: string;
  /** What this pick does, phrased for the player. */
  description: string;
  /** Level after taking it. 0 for consolation offers. */
  level: number;
  maxLevel: number;
  isNew: boolean;
  /** Sprite name for the icon, when there is one. */
  sprite: string | null;
}

interface Candidate {
  offer: Offer;
  weight: number;
}

/**
 * Builds the level-up draft.
 *
 * Every eligible weapon and passive becomes a weighted candidate, then options
 * are drawn without replacement so the same pick can't appear twice in one
 * draft. When the loadout is completely maxed there is nothing left to offer, so
 * the draft falls back to health and gold rather than showing an empty screen.
 */
export function rollOffers(ctx: Ctx, count = 3): Offer[] {
  const { run } = ctx;
  const candidates: Candidate[] = [];

  for (const def of WEAPON_LIST) {
    const level = run.weaponLevel(def.id);
    if (level === 0) {
      // An evolution is earned at a chest, never drafted. This is the real
      // guard; maxLevel 1 keeps it out of the upgrade branch below once owned,
      // and weight 0 is a third line of defence in the content itself.
      if (EVOLVED_WEAPON_IDS.has(def.id)) continue;
      // A base whose evolution is already owned reads as level 0 again, because
      // the fusion overwrote its slot. Offering it back would sell a weapon
      // slot and eight picks for a weapon that can never fuse again — tryEvolve
      // refuses the second copy. Keep the dead end out of the draft.
      const evolution = def.evolution;
      if (evolution && run.weaponLevel(evolution.intoId) > 0) continue;
      if (!run.hasWeaponSlot()) continue;
      candidates.push({
        offer: {
          kind: 'weapon',
          id: def.id,
          name: def.name,
          description: def.description,
          level: 1,
          maxLevel: def.maxLevel,
          isNew: true,
          sprite: def.sprite,
        },
        weight: def.weight,
      });
    } else if (level < def.maxLevel) {
      candidates.push({
        offer: {
          kind: 'weapon',
          id: def.id,
          name: def.name,
          // The note for the level being unlocked, so the player knows what
          // they're buying rather than just "level 4".
          description: def.levels[level - 1]?.note ?? 'Improved',
          level: level + 1,
          maxLevel: def.maxLevel,
          isNew: false,
          sprite: def.sprite,
        },
        weight: def.weight * EXISTING_WEIGHT_BONUS,
      });
    }
  }

  for (const def of PASSIVE_LIST) {
    const level = run.passiveLevel(def.id);
    if (level === 0) {
      if (!run.hasPassiveSlot()) continue;
      candidates.push({
        offer: {
          kind: 'passive',
          id: def.id,
          name: def.name,
          description: def.description,
          level: 1,
          maxLevel: def.maxLevel,
          isNew: true,
          sprite: null,
        },
        weight: def.weight,
      });
    } else if (level < def.maxLevel) {
      candidates.push({
        offer: {
          kind: 'passive',
          id: def.id,
          name: def.name,
          description: def.description,
          level: level + 1,
          maxLevel: def.maxLevel,
          isNew: false,
          sprite: null,
        },
        weight: def.weight * EXISTING_WEIGHT_BONUS,
      });
    }
  }

  const chosen: Offer[] = [];
  const weights = candidates.map((c) => c.weight);

  while (chosen.length < count && candidates.length > 0) {
    const index = ctx.rng.weightedIndex(weights);
    if (index < 0) break;
    chosen.push(candidates[index]!.offer);
    // Zero the weight rather than splicing, so indices stay aligned.
    weights[index] = 0;
    if (weights.every((w) => w <= 0)) break;
  }

  // Nothing left to learn: offer something still worth having.
  if (chosen.length === 0) {
    chosen.push({
      kind: 'heal',
      id: 'heal',
      name: 'Restoration',
      description: 'Recover 40% of your maximum health.',
      level: 0,
      maxLevel: 0,
      isNew: false,
      sprite: 'meat',
    });
    chosen.push({
      kind: 'gold',
      id: 'gold',
      name: "Miser's Reward",
      description: 'Gain a purse of gold.',
      level: 0,
      maxLevel: 0,
      isNew: false,
      sprite: 'coin',
    });
  }

  return chosen;
}

/**
 * Applies a drafted offer. Consumes one banked level-up.
 *
 * `offered` is the whole draft this pick came out of. It is a parameter rather
 * than something reconstructed later because the draft is drawn without
 * replacement from a weighted pool: the offers that were declined exist
 * nowhere else once the screen closes, and without them "popularity" is just
 * the weight table read back.
 */
export function applyOffer(ctx: Ctx, offer: Offer, offered: readonly Offer[]): void {
  const { run, world } = ctx;

  switch (offer.kind) {
    case 'weapon':
      run.addWeapon(offer.id);
      break;

    case 'passive': {
      run.addPassive(offer.id);
      // A max-health passive should feel immediate, so grant the new headroom
      // as current health rather than leaving the player at their old value.
      if (run.maxHpDelta > 0 && ctx.player >= 0) {
        world.hp[ctx.player] = Math.min(run.stats.maxHp, world.hp[ctx.player]! + run.maxHpDelta);
      }
      break;
    }

    case 'heal':
      healPlayer(ctx, run.stats.maxHp * 0.4);
      break;

    case 'gold': {
      const gained = run.gainGold(ctx.rng.int(20, 60));
      ctx.bus.emit('gold:gained', { amount: gained, total: run.gold });
      break;
    }
  }

  // Emitted before the level-up is consumed, so `atLevel` is the level the
  // player was actually drafting at.
  ctx.bus.emit('draft:picked', {
    kind: offer.kind,
    id: offer.id,
    level: offer.level,
    isNew: offer.isNew,
    atLevel: run.level,
    offered: offered.map((o) => o.id),
  });

  if (run.pendingLevelUps > 0) run.pendingLevelUps--;
  ctx.bus.emit('stats:changed', undefined);
}

/** One-line summary of a weapon's current numbers, for the HUD tooltip. */
export function weaponSummary(ctx: Ctx, weaponId: string): string {
  const owned = ctx.run.weapons.find((w) => w.def.id === weaponId);
  if (!owned) return '';
  const stats = weaponStatsAtLevel(owned.def, owned.level);
  const damage = Math.round(stats.damage * ctx.run.stats.might);
  return `Lv ${owned.level}/${owned.def.maxLevel} — ${damage} dmg`;
}
