import { dailyDelta } from './daily.ts';
import type { DailyRunSummary, DailyRunTally } from './daily.ts';

/**
 * The permanent record a character unlock requirement reads.
 *
 * Pure, like daily.ts and for the same reason: MetaService owns the one
 * SaveData, and a second service persisting its own copy of this would make the
 * two overwrite each other. Free functions over plain data, no storage, no
 * clock.
 *
 * The vocabulary is deliberately not a new one. `featDelta` is `dailyDelta`
 * plus a victory flag, so every requirement resolves against a signal gameplay
 * already emits and nothing new has to be tracked in the sim to add one.
 *
 * **Nothing here imports gameplay/**, which is why the signal list below is
 * spelled out rather than imported from content.ts's `UnlockSignal` whitelist:
 * this module is in save.ts's import closure, and telemetry.test.ts walks that
 * closure to prove it never leaves services/ and core/. The two lists are held
 * equal by feats.test.ts instead — the same duplicate-and-pin the tick order
 * uses. Change one, change both.
 */
export const FEAT_SIGNAL_IDS: ReadonlySet<string> = new Set([
  'kills',
  'level',
  'picks',
  'gold',
  'survive',
  'frenzy',
  'feast',
  'siege',
  'evolve',
  'walls',
  'victory',
]);

/**
 * The half of a character's unlock requirement this module needs to resolve
 * one. Structural on purpose: content.ts's `UnlockRequirement` satisfies it
 * without this file having to import it.
 */
export interface FeatRequirement {
  id: string;
  target: number;
  mode: 'sum' | 'best';
}

/**
 * Every signal, folded both ways.
 *
 * Storing both is what lets `mode` stay a property of the requirement rather
 * than of the record: a lifetime-total requirement and an in-one-run
 * requirement can name the same signal without either one having to know the
 * other exists.
 */
export interface FeatSave {
  /** Lifetime total per signal id. Absent key = 0. */
  sum: Record<string, number>;
  /** Best single run per signal id. Absent key = 0. */
  best: Record<string, number>;
}

export function defaultFeats(): FeatSave {
  return { sum: {}, best: {} };
}

/**
 * One finished run, expressed per signal.
 *
 * `victory` is the only key this adds to the daily vocabulary, and it is a flag
 * rather than a count: a run is won or it is not, so folding it as 'best' with
 * target 1 asks "have you ever won", and as 'sum' asks "how many times".
 */
export function featDelta(
  tally: DailyRunTally,
  summary: DailyRunSummary,
  victory: boolean,
): Record<string, number> {
  return { ...dailyDelta(tally, summary), victory: victory ? 1 : 0 };
}

/**
 * Folds one run's delta into the record. Replaced, never mutated — the same
 * discipline the rest of the save uses, so a half-applied fold can't persist.
 *
 * Zero and negative contributions are dropped rather than written: a run that
 * scored nothing on a signal must not put a 0 key in `best`, which would be
 * indistinguishable from progress on a signal but cost a save slot forever.
 */
export function foldFeats(state: FeatSave, delta: Record<string, number>): FeatSave {
  const sum = { ...state.sum };
  const best = { ...state.best };
  for (const [id, value] of Object.entries(delta)) {
    if (!FEAT_SIGNAL_IDS.has(id)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    sum[id] = (sum[id] ?? 0) + value;
    best[id] = Math.max(best[id] ?? 0, value);
  }
  return { sum, best };
}

/** What the player has against one requirement, in that requirement's mode. */
export function featProgress(state: FeatSave, requirement: FeatRequirement): number {
  const record = requirement.mode === 'sum' ? state.sum : state.best;
  return record[requirement.id] ?? 0;
}

export function featMet(state: FeatSave, requirement: FeatRequirement): boolean {
  return featProgress(state, requirement) >= requirement.target;
}

/**
 * Coerces a persisted `feats` field of any vintage into a FeatSave.
 *
 * Same defensive shape as migrateDaily: field by field, no version branching,
 * absent fields fall to defaults. Keys are filtered against the signal
 * whitelist so a hand-edited save cannot grow the record without bound, and a
 * signal retired from the whitelist stops being read rather than lingering.
 */
export function migrateFeats(raw: unknown): FeatSave {
  const base = defaultFeats();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const rec = raw as Record<string, unknown>;
  return { sum: readRecord(rec['sum']), best: readRecord(rec['best']) };
}

function readRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FEAT_SIGNAL_IDS.has(id)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    out[id] = value;
  }
  return out;
}
