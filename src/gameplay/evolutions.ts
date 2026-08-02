import { passiveDef, weaponDef } from './content.ts';
import type { Ctx } from './context.ts';

/**
 * Weapon evolutions: a weapon carried to its ceiling and the passive it was
 * built around fuse into a different weapon.
 *
 * The trigger is a chest, not a level-up — chests come from `dropsChest`
 * enemies and from surviving a siege, both rare, both landmark moments. An
 * evolution should read as the reward for holding a position rather than as a
 * pick you happened to be offered.
 */

export interface EvolutionResult {
  baseId: string;
  intoId: string;
  /** Display name of the evolved weapon, for the announcement. */
  name: string;
}

/**
 * Fuses at most one eligible pairing and reports it, or returns null.
 *
 * **Consumes no `ctx.rng` draws.** This is an invariant, not a preference: a
 * draw on a conditional path would shift every later draw in the run and
 * silently rewrite the expected values of every seeded test. That is why the
 * tie-break below is positional rather than random.
 *
 * Exactly one evolution resolves per chest. The winner is the eligible pairing
 * whose base sits lowest in `run.weapons` — the weapon you have carried
 * longest. The loser stays eligible and fires on the next chest: resolving both
 * at once would halve the weight of the moment and double the power spike in
 * the same second.
 *
 * Nothing consults `MAX_WEAPON_SLOTS`, because `run.weapons.length` never
 * changes here — a full loadout evolves exactly like a fresh one.
 *
 * Each evolution fires at most once per run. The content rules in
 * `linkEvolutions` only make each pairing unique; they cannot see the loadout,
 * so owning the target is checked here.
 */
export function tryEvolve(ctx: Ctx): EvolutionResult | null {
  const { run, world } = ctx;

  for (const owned of run.weapons) {
    const evolution = owned.def.evolution;
    if (!evolution) continue;
    if (owned.level < owned.def.maxLevel) continue;

    // linkEvolutions already proved both halves resolve, so these lookups are
    // belt and braces — but they are the fail-soft contract, so they stay.
    const passive = passiveDef(evolution.passiveId);
    if (!passive || run.passiveLevel(evolution.passiveId) < passive.maxLevel) continue;
    const into = weaponDef(evolution.intoId);
    if (!into) continue;

    // One fusion per pairing per run, enforced on the target rather than on the
    // base. The swap overwrites the slot, so the base leaves `run.weapons`
    // entirely and `weaponLevel(baseId)` reads 0 again — a re-drafted copy
    // carried back to the ceiling would otherwise mint a second evolved weapon
    // sharing one def, doubling its damage while `weaponLevel` reported only
    // the first. `continue`, not `return`: another pairing may still be
    // eligible this chest, and it should not be punished for this one.
    if (run.weaponLevel(into.id) > 0) continue;

    const baseId = owned.def.id;

    // Before the swap, and load-bearing: Run has no World, and `activeIds` is
    // the only surviving reference to the aura ring and the orbit satellites.
    // maintainAura strips Comp.Lifetime from its hazard, so an orphaned ring
    // would keep damaging enemies at the old weapon's numbers for the rest of
    // the run. Destroying from inside a system is safe — the tick's single
    // flush recycles them; never flush here.
    for (const id of owned.activeIds) world.destroy(id);

    if (!run.evolveWeapon(baseId, into.id)) return null;

    // The required passive is deliberately not consumed: taking it back would
    // cut the player's stats at the moment they were rewarded.
    ctx.bus.emit('weapon:evolved', { baseId, intoId: into.id, name: into.name });

    if (ctx.player >= 0) {
      const px = world.x[ctx.player]!;
      const py = world.y[ctx.player]!;
      // The name goes out on the bus for the DOM banner; in-world feedback is
      // shape and colour, since the 3x5 pixel font has no letters.
      ctx.fx.shockwave(px, py, '#ffd23f', 0.7, 14);
      ctx.fx.burst(px, py, 22, 110, '#ffe9a8', 0.7, 2);
      ctx.fx.floatingText(px, py - 16, '!', '#ffd23f', 2);
    }

    return { baseId, intoId: into.id, name: into.name };
  }

  return null;
}
