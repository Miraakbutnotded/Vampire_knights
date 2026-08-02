import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATED_KEYS, MIGRATION_KEY, MIGRATION_STAMP, liftStorage } from './migration.ts';
import {
  SAVE_BACKUP_KEY,
  SAVE_KEY,
  SaveStore,
  decodeSave,
  defaultSave,
  encodeSave,
} from './save.ts';
import { MemoryStorageAdapter } from './storage.ts';
import type { StorageAdapter } from './storage.ts';
import { TELEMETRY_KEY } from './telemetry.ts';

/** A store that fails a named set of keys, on read, on write, or both. */
class FlakyStorageAdapter extends MemoryStorageAdapter {
  constructor(
    private readonly failing: Set<string>,
    private readonly mode: 'get' | 'set' | 'both' = 'both',
  ) {
    super();
  }

  override async get(key: string): Promise<string | null> {
    if (this.failing.has(key) && this.mode !== 'set') throw new Error(`get ${key} refused`);
    return super.get(key);
  }

  override async set(key: string, value: string): Promise<void> {
    if (this.failing.has(key) && this.mode !== 'get') throw new Error(`set ${key} refused`);
    return super.set(key, value);
  }
}

/** A store that dies after N successful writes, standing in for a killed app. */
class DyingStorageAdapter extends MemoryStorageAdapter {
  private writes = 0;

  constructor(private readonly budget: number) {
    super();
  }

  override async set(key: string, value: string): Promise<void> {
    if (this.writes >= this.budget) throw new Error('app terminated');
    this.writes++;
    return super.set(key, value);
  }
}

function goldSave(gold: number): string {
  return encodeSave({ ...defaultSave(), gold });
}

/** An old localStorage-side store holding a complete save plus telemetry. */
async function populatedSource(gold = 250): Promise<MemoryStorageAdapter> {
  const from = new MemoryStorageAdapter();
  await from.set(SAVE_KEY, goldSave(gold));
  await from.set(SAVE_BACKUP_KEY, goldSave(gold));
  await from.set(TELEMETRY_KEY, '{"runs":[]}');
  return from;
}

// Half of these cases provoke a logged failure on purpose. Silenced rather than
// left to spam the run, and restored after each so the spy never stacks.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage lift', () => {
  it('covers every key the app persists, and nothing else', () => {
    expect([...MIGRATED_KEYS]).toEqual([SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY]);
    expect(MIGRATED_KEYS).not.toContain(MIGRATION_KEY);
  });

  it('carries an existing save across and stamps the destination', async () => {
    const from = await populatedSource(250);
    const to = new MemoryStorageAdapter();

    const report = await liftStorage(from, to);

    expect(report.outcome).toBe('lifted');
    expect(report.lifted).toEqual([SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY]);
    expect(report.failed).toEqual([]);
    expect(await to.get(MIGRATION_KEY)).toBe(MIGRATION_STAMP);
    // The wallet is the point of the whole exercise.
    expect((await new SaveStore(to).load()).gold).toBe(250);
  });

  it('leaves the old store intact so a wiped destination still has a fallback', async () => {
    const from = await populatedSource(120);
    const to = new MemoryStorageAdapter();

    await liftStorage(from, to);

    expect(await from.get(SAVE_KEY)).toBe(goldSave(120));
    expect(await from.get(SAVE_BACKUP_KEY)).toBe(goldSave(120));
    expect(await from.get(TELEMETRY_KEY)).not.toBeNull();
  });

  describe('no old save', () => {
    it('stamps a fresh install without writing any game key', async () => {
      const to = new MemoryStorageAdapter();

      const report = await liftStorage(new MemoryStorageAdapter(), to);

      expect(report.outcome).toBe('nothing-to-lift');
      expect(report.lifted).toEqual([]);
      expect(report.skipped).toEqual([SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY]);
      expect(await to.get(SAVE_KEY)).toBeNull();
      expect(await to.get(MIGRATION_KEY)).toBe(MIGRATION_STAMP);
    });

    it('lifts the slots that do exist when the source is only half populated', async () => {
      const from = new MemoryStorageAdapter();
      await from.set(SAVE_BACKUP_KEY, goldSave(70));
      const to = new MemoryStorageAdapter();

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('lifted');
      expect(report.lifted).toEqual([SAVE_BACKUP_KEY]);
      expect(report.skipped).toEqual([SAVE_KEY, TELEMETRY_KEY]);
      // SaveStore heals the primary slot from the backup, so the gold survives.
      expect((await new SaveStore(to).load()).gold).toBe(70);
    });
  });

  describe('corrupt old save', () => {
    it('copies the bytes verbatim and lets the checksum decide', async () => {
      const from = new MemoryStorageAdapter();
      await from.set(SAVE_KEY, '{"payload":"{}","checksum":"deadbeef"}');
      await from.set(SAVE_BACKUP_KEY, goldSave(999));
      const to = new MemoryStorageAdapter();

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('lifted');
      expect(report.failed).toEqual([]);
      // Verbatim: the corrupt slot arrives corrupt, and the good backup arrives
      // good — which is exactly what lets SaveStore heal instead of defaulting.
      expect(decodeSave((await to.get(SAVE_KEY))!)).toBeNull();
      expect((await new SaveStore(to).load()).gold).toBe(999);
    });

    it('lifts unparseable junk rather than dropping it', async () => {
      const from = new MemoryStorageAdapter();
      await from.set(SAVE_KEY, 'not json at all');
      const to = new MemoryStorageAdapter();

      await liftStorage(from, to);

      expect(await to.get(SAVE_KEY)).toBe('not json at all');
      // Both slots unreadable ⇒ defaults, the same as it would have on the web.
      expect(await new SaveStore(to).load()).toEqual(defaultSave());
    });
  });

  describe('runs exactly once', () => {
    it('does not touch the source when the marker is already there', async () => {
      const from = await populatedSource(300);
      const to = new MemoryStorageAdapter();
      await to.set(MIGRATION_KEY, MIGRATION_STAMP);
      const peek = vi.spyOn(from, 'get');

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('already-done');
      expect(peek).not.toHaveBeenCalled();
      expect(await to.get(SAVE_KEY)).toBeNull();
    });

    it('never overwrites a newer destination save on a second call', async () => {
      const from = await populatedSource(250);
      const to = new MemoryStorageAdapter();

      await liftStorage(from, to);
      // The player earns more gold on the new store…
      await new SaveStore(to).persist({ ...defaultSave(), gold: 400 });
      // …and then the lift is somehow attempted again.
      const second = await liftStorage(from, to);

      expect(second.outcome).toBe('already-done');
      expect((await new SaveStore(to).load()).gold).toBe(400);
    });

    it('still refuses to clobber a newer save if the marker itself is lost', async () => {
      const from = await populatedSource(250);
      const to = new MemoryStorageAdapter();
      await liftStorage(from, to);
      await new SaveStore(to).persist({ ...defaultSave(), gold: 400 });
      await to.remove(MIGRATION_KEY);

      const second = await liftStorage(from, to);

      // Destination-wins is the real guard; the marker is only an optimisation.
      expect(second.outcome).toBe('nothing-to-lift');
      expect(second.lifted).toEqual([]);
      expect((await new SaveStore(to).load()).gold).toBe(400);
    });
  });

  describe('partial write', () => {
    it('keeps going past a failing key and withholds the marker', async () => {
      const from = await populatedSource(180);
      const to = new FlakyStorageAdapter(new Set([SAVE_BACKUP_KEY]), 'set');

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('incomplete');
      expect(report.lifted).toEqual([SAVE_KEY, TELEMETRY_KEY]);
      expect(report.failed).toEqual([SAVE_BACKUP_KEY]);
      // The wallet made it even though a later key did not.
      expect((await new SaveStore(to).load()).gold).toBe(180);
      expect(await to.get(MIGRATION_KEY)).toBeNull();
    });

    it('finishes the job on the next boot, lifting only what is missing', async () => {
      const from = await populatedSource(180);
      const flaky = new Set([SAVE_BACKUP_KEY]);
      const to = new FlakyStorageAdapter(flaky, 'set');
      await liftStorage(from, to);

      flaky.clear();
      const retry = await liftStorage(from, to);

      expect(retry.outcome).toBe('lifted');
      expect(retry.lifted).toEqual([SAVE_BACKUP_KEY]);
      expect(retry.skipped).toEqual([SAVE_KEY, TELEMETRY_KEY]);
      expect(await to.get(MIGRATION_KEY)).toBe(MIGRATION_STAMP);
    });

    it('reports incomplete when only the marker write fails, and self-heals', async () => {
      const from = await populatedSource(90);
      const blocked = new Set([MIGRATION_KEY]);
      const to = new FlakyStorageAdapter(blocked, 'set');

      const first = await liftStorage(from, to);
      expect(first.outcome).toBe('incomplete');
      expect(first.lifted).toEqual([SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY]);
      expect(first.failed).toEqual([MIGRATION_KEY]);

      blocked.clear();
      const retry = await liftStorage(from, to);
      expect(retry.outcome).toBe('nothing-to-lift');
      expect(retry.lifted).toEqual([]);
      expect((await new SaveStore(to).load()).gold).toBe(90);
    });

    it('retries later rather than guessing when the marker cannot be read', async () => {
      const from = await populatedSource(60);
      const to = new FlakyStorageAdapter(new Set([MIGRATION_KEY]), 'get');

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('incomplete');
      expect(report.failed).toEqual([MIGRATION_KEY]);
      expect(report.lifted).toEqual([]);
      // Nothing was moved, so nothing can be half-moved.
      expect(await to.get(SAVE_KEY)).toBeNull();
    });

    it('survives a source that throws on read', async () => {
      const from = new FlakyStorageAdapter(new Set([SAVE_KEY]), 'get');
      await from.set(SAVE_BACKUP_KEY, goldSave(45));
      const to = new MemoryStorageAdapter();

      const report = await liftStorage(from, to);

      expect(report.outcome).toBe('incomplete');
      expect(report.failed).toEqual([SAVE_KEY]);
      expect(report.lifted).toEqual([SAVE_BACKUP_KEY]);
      expect((await new SaveStore(to).load()).gold).toBe(45);
    });
  });

  describe('killed mid-migration', () => {
    it('resumes from wherever the process died, without losing gold', async () => {
      const from = await populatedSource(500);

      // The app is terminated after the very first successful write.
      const to = new DyingStorageAdapter(1);
      const killed = await liftStorage(from, to);
      expect(killed.outcome).toBe('incomplete');
      expect(killed.lifted).toEqual([SAVE_KEY]);
      expect(await to.get(MIGRATION_KEY)).toBeNull();

      // Relaunch: same destination contents, a store that now works.
      const relaunched = new MemoryStorageAdapter();
      for (const key of MIGRATED_KEYS) {
        const carried = await to.get(key);
        if (carried !== null) await relaunched.set(key, carried);
      }
      const resumed = await liftStorage(from, relaunched);

      expect(resumed.outcome).toBe('lifted');
      expect(resumed.skipped).toEqual([SAVE_KEY]);
      expect(resumed.lifted).toEqual([SAVE_BACKUP_KEY, TELEMETRY_KEY]);
      expect(await relaunched.get(MIGRATION_KEY)).toBe(MIGRATION_STAMP);
      expect((await new SaveStore(relaunched).load()).gold).toBe(500);
    });

    it('is a no-op on relaunch if it died before writing anything', async () => {
      const from = await populatedSource(75);
      const to = new DyingStorageAdapter(0);

      const killed = await liftStorage(from, to);
      expect(killed.outcome).toBe('incomplete');
      expect(killed.failed).toEqual([SAVE_KEY, SAVE_BACKUP_KEY, TELEMETRY_KEY]);

      const relaunched = new MemoryStorageAdapter();
      const resumed = await liftStorage(from, relaunched);
      expect(resumed.outcome).toBe('lifted');
      expect((await new SaveStore(relaunched).load()).gold).toBe(75);
    });
  });

  it('never rejects, whatever the adapters do', async () => {
    const explode: StorageAdapter = {
      get: () => Promise.reject(new Error('dead')),
      set: () => Promise.reject(new Error('dead')),
      remove: () => Promise.reject(new Error('dead')),
    };

    await expect(liftStorage(explode, explode)).resolves.toMatchObject({ outcome: 'incomplete' });
  });
});
