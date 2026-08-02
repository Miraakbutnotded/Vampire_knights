import { SAVE_BACKUP_KEY, SAVE_KEY } from './save.ts';
import type { StorageAdapter } from './storage.ts';
import { TELEMETRY_KEY } from './telemetry.ts';

/**
 * One-time lift of an existing localStorage save onto whatever store the app
 * now writes through (Capacitor Preferences on device).
 *
 * A player who has been playing the web build, or an earlier native build that
 * still wrote to the WebView's localStorage, must not lose their wallet the day
 * the backing store changes. This module is the whole of that guarantee, and it
 * is a plain function over two StorageAdapters so every failure state is
 * reachable from vitest with MemoryStorageAdapter on both sides.
 *
 * Four decisions hold it together:
 *
 * 1. **The marker lives in the destination.** A marker in localStorage would be
 *    erased by exactly the eviction this migration exists to survive, and the
 *    re-run would then lift a stale (or absent) old save over a good new one.
 *    In the destination it is as durable as the save it guards.
 *
 * 2. **The destination always wins, key by key.** A key already present in the
 *    destination is left alone, because it is either the same bytes a previous
 *    attempt copied or a newer save written since. This — not the marker — is
 *    what makes the lift idempotent; the marker is only there to stop us reading
 *    three dead localStorage keys on every subsequent boot.
 *
 * 3. **The source is never deleted.** The stale copy costs a few KB and is the
 *    only fallback if the destination itself is ever wiped. Deleting it would
 *    make a half-finished lift unrecoverable, which is the one outcome worse
 *    than not migrating at all.
 *
 * 4. **Values are copied verbatim, never parsed.** Corruption is not this
 *    module's business: SaveStore's checksum already decides that, and it can
 *    heal a corrupt primary slot from a good backup — but only if both slots
 *    arrive intact. Validating here could only throw away bytes that the layer
 *    above knows how to use.
 */

/** Marker key, written to the destination and read before anything else. */
export const MIGRATION_KEY = 'vk-storage-lifted';

/** Marker payload. Any non-null value counts as done; this is for the human. */
export const MIGRATION_STAMP = '1';

/**
 * Every key the app owns, in the order they are lifted. The two save slots come
 * first so a lift interrupted partway through has moved the wallet, not the
 * telemetry log.
 */
export const MIGRATED_KEYS: readonly string[] = [SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY];

/**
 * - `already-done`  the marker was present; the source was never touched.
 * - `nothing-to-lift`  no old save existed (a fresh install); marker written.
 * - `lifted`  at least one key moved across; marker written.
 * - `incomplete`  something failed. No marker, so the next boot retries.
 */
export type MigrationOutcome = 'already-done' | 'nothing-to-lift' | 'lifted' | 'incomplete';

export interface MigrationReport {
  outcome: MigrationOutcome;
  /** Keys copied by this call. */
  lifted: string[];
  /** Keys the destination already had, or the source did not have. */
  skipped: string[];
  /** Keys whose read or write threw. Non-empty ⇒ outcome is `incomplete`. */
  failed: string[];
}

/**
 * Copies the old keys from `from` to `to` once, then stamps the destination.
 *
 * Never throws and never rejects: a migration that cannot finish must not stop
 * the game from booting, because the game boots perfectly well on an empty
 * store. Failures are reported, and the absent marker means the next boot tries
 * again — including after the app is killed mid-lift, since the marker is
 * written last and only when every key is accounted for.
 */
export async function liftStorage(
  from: StorageAdapter,
  to: StorageAdapter,
): Promise<MigrationReport> {
  const report: MigrationReport = { outcome: 'nothing-to-lift', lifted: [], skipped: [], failed: [] };

  // Reading the marker is itself a destination call and can fail. If it does we
  // cannot know whether the lift already ran, and re-running it would be safe
  // (decision 2) but pointless with a store this sick — bail and retry later.
  try {
    if ((await to.get(MIGRATION_KEY)) !== null) {
      return { ...report, outcome: 'already-done' };
    }
  } catch (error) {
    console.error('[migration] marker read failed:', error);
    return { ...report, outcome: 'incomplete', failed: [MIGRATION_KEY] };
  }

  for (const key of MIGRATED_KEYS) {
    try {
      // Destination first: cheapest way to establish that this key is settled,
      // and it is the check that makes a resumed lift leave newer data alone.
      if ((await to.get(key)) !== null) {
        report.skipped.push(key);
        continue;
      }
      const value = await from.get(key);
      if (value === null) {
        report.skipped.push(key);
        continue;
      }
      await to.set(key, value);
      report.lifted.push(key);
    } catch (error) {
      // One bad key does not abandon the others: the telemetry log failing to
      // write must not cost the player their gold.
      console.error(`[migration] ${key} failed to lift:`, error);
      report.failed.push(key);
    }
  }

  if (report.failed.length > 0) {
    return { ...report, outcome: 'incomplete' };
  }

  try {
    await to.set(MIGRATION_KEY, MIGRATION_STAMP);
  } catch (error) {
    // The data is across; only the stamp failed. Next boot re-walks the keys,
    // finds them all present in the destination, and skips every one — so the
    // retry is free and correct, just noisier than it should be.
    console.error('[migration] marker write failed:', error);
    return { ...report, outcome: 'incomplete', failed: [MIGRATION_KEY] };
  }

  return { ...report, outcome: report.lifted.length > 0 ? 'lifted' : 'nothing-to-lift' };
}
