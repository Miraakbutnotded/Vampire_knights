import { describe, expect, it } from 'vitest';

import { MemoryStorageAdapter } from './storage.ts';
import type { StorageAdapter } from './storage.ts';
import {
  MAX_BYTES,
  MAX_PICKS_PER_RUN,
  MAX_RECORDS,
  TELEMETRY_KEY,
  TELEMETRY_VERSION,
  TelemetryService,
  decodeTelemetry,
  encodeTelemetry,
  migrateTelemetry,
} from './telemetry.ts';
import type { RunRecord, RunSummary, TelemetryDoc } from './telemetry.ts';

// The module's own source, read the same way isolation.test.ts reads the
// engine: Vite inlines it at transform time, so the no-network and no-PII
// gates below run in the same environment as every other test.
const telemetrySource = (
  import.meta.glob(['./telemetry.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['./telemetry.ts']!;

// The identifier gates below judge code, not prose — a comment is free to say
// the word "document". This module contains no string literal holding a comment
// marker, so stripping comments by pattern is exact here.
const telemetryCode = telemetrySource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SUMMARY: RunSummary = { survivedSeconds: 61.25, kills: 40, gold: 12, level: 5 };

function aRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: 1_700_000_000_000,
    characterId: 'wanderer',
    mapId: 'meadow',
    seed: 12345,
    outcome: 'death',
    survivedSeconds: 61.3,
    kills: 40,
    gold: 12,
    level: 5,
    killedBy: { enemyId: 'brute', cause: 'contact', damage: 14 },
    levelUps: 4,
    picks: [],
    ...over,
  };
}

/** A service with a pinned clock, so startedAt is assertable. */
function service(adapter: StorageAdapter = new MemoryStorageAdapter(), at = 1_000): TelemetryService {
  return new TelemetryService(adapter, () => at);
}

async function loaded(adapter: StorageAdapter, at = 1_000): Promise<TelemetryService> {
  const t = service(adapter, at);
  await t.load();
  return t;
}

describe('telemetry codec', () => {
  it('round-trips a document through encode/decode', () => {
    const doc: TelemetryDoc = {
      version: TELEMETRY_VERSION,
      records: [
        aRecord(),
        aRecord({
          outcome: 'victory',
          killedBy: null,
          picks: [
            { kind: 'weapon', id: 'stake', level: 2, isNew: false, atLevel: 4, offered: ['stake', 'garlic'] },
          ],
        }),
      ],
    };
    expect(decodeTelemetry(encodeTelemetry(doc))).toEqual(doc);
  });

  it('rejects tampered or malformed payloads via the checksum', () => {
    const encoded = encodeTelemetry({ version: TELEMETRY_VERSION, records: [aRecord()] });
    const tampered = encoded.replace('\\"kills\\":40', '\\"kills\\":999');
    expect(tampered).not.toBe(encoded); // sanity: the replace found its target
    expect(decodeTelemetry(tampered)).toBeNull();
    expect(decodeTelemetry('not json at all')).toBeNull();
    expect(decodeTelemetry('{"payload":123,"checksum":"x"}')).toBeNull();
  });

  it('salvages per record: a malformed row drops, its siblings survive', () => {
    const good = aRecord({ seed: 1 });
    const alsoGood = aRecord({ seed: 2 });
    const doc = migrateTelemetry({
      version: TELEMETRY_VERSION,
      records: [
        good,
        { ...aRecord(), outcome: 'exploded' }, // not a known outcome
        'not even an object',
        { ...aRecord(), characterId: 42 },
        alsoGood,
      ],
    });
    expect(doc?.records.map((r) => r.seed)).toEqual([1, 2]);
  });

  it('drops malformed picks inside an otherwise good record', () => {
    const doc = migrateTelemetry({
      version: TELEMETRY_VERSION,
      records: [
        aRecord({
          picks: [
            { kind: 'weapon', id: 'stake', level: 2, isNew: false, atLevel: 3, offered: ['stake', 7] },
            { kind: 'nonsense', id: 'x', level: 1, isNew: true, atLevel: 2, offered: [] },
            null,
          ] as unknown as RunRecord['picks'],
        }),
      ],
    });
    // The one salvageable pick survives with its non-string offer filtered out.
    expect(doc?.records[0]!.picks).toEqual([
      { kind: 'weapon', id: 'stake', level: 2, isNew: false, atLevel: 3, offered: ['stake'] },
    ]);
  });

  it('rejects documents from the future and non-objects', () => {
    expect(migrateTelemetry({ version: TELEMETRY_VERSION + 1, records: [] })).toBeNull();
    expect(migrateTelemetry('records')).toBeNull();
    expect(migrateTelemetry(null)).toBeNull();
    // A version-less document is early-dev, not future — its records still load.
    expect(migrateTelemetry({ records: [aRecord()] })?.records.length).toBe(1);
  });
});

describe('telemetry service — recording a run', () => {
  it('records which upgrade was taken, at what level, against what was offered', async () => {
    const adapter = new MemoryStorageAdapter();
    const t = await loaded(adapter);
    t.beginRun('wanderer', 'meadow', 99);
    t.recordPick({
      kind: 'weapon',
      id: 'stake',
      level: 1,
      isNew: true,
      atLevel: 2,
      offered: ['stake', 'garlic', 'boots'],
    });
    t.finishRun(false, SUMMARY);
    await t.flush();

    const record = t.records[0]!;
    expect(record.picks).toEqual([
      { kind: 'weapon', id: 'stake', level: 1, isNew: true, atLevel: 2, offered: ['stake', 'garlic', 'boots'] },
    ]);
    expect(record.levelUps).toBe(1);
    expect(record.characterId).toBe('wanderer');
    expect(record.mapId).toBe('meadow');
    expect(record.seed).toBe(99);
    expect(record.outcome).toBe('death');
    expect(record.survivedSeconds).toBe(61.3); // rounded to a tenth
  });

  it('records what killed the player', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 1);
    t.recordDeath({ enemyId: 'brute', kind: 'contact', damage: 14 });
    t.finishRun(false, SUMMARY);
    expect(t.records[0]!.killedBy).toEqual({ enemyId: 'brute', cause: 'contact', damage: 14 });
  });

  it('leaves killedBy null on a victory', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 1);
    t.finishRun(true, SUMMARY);
    expect(t.records[0]!.outcome).toBe('victory');
    expect(t.records[0]!.killedBy).toBeNull();
  });

  it('ignores picks and deaths reported outside a run', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.recordPick({ kind: 'weapon', id: 'stake', level: 1, isNew: true, atLevel: 2, offered: ['stake'] });
    t.recordDeath({ enemyId: 'brute', kind: 'contact', damage: 3 });
    t.finishRun(false, SUMMARY);
    expect(t.records).toEqual([]);
  });

  it('closes an open run as abandoned when the next one begins, and on quit', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 1);
    t.beginRun('acolyte', 'crypt', 2); // restart from pause
    expect(t.records.map((r) => r.outcome)).toEqual(['abandoned']);
    t.abandonRun({ survivedSeconds: 30.04, kills: 9, gold: 3, level: 2 }); // quit to title
    expect(t.records.map((r) => r.outcome)).toEqual(['abandoned', 'abandoned']);
    expect(t.records[1]).toMatchObject({ characterId: 'acolyte', mapId: 'crypt', survivedSeconds: 30 });
    // Nothing open: a second quit records nothing.
    t.abandonRun();
    expect(t.records.length).toBe(2);
  });
});

describe('telemetry service — bounds', () => {
  it('drops picks past the per-run cap but still counts level-ups truthfully', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 1);
    const total = MAX_PICKS_PER_RUN + 25;
    for (let i = 0; i < total; i++) {
      t.recordPick({ kind: 'passive', id: `p${i}`, level: 1, isNew: true, atLevel: i + 2, offered: [`p${i}`] });
    }
    t.finishRun(false, SUMMARY);

    const record = t.records[0]!;
    expect(record.picks.length).toBe(MAX_PICKS_PER_RUN);
    // The kept window is the *first* picks — an early build is what explains a run.
    expect(record.picks[0]!.id).toBe('p0');
    expect(record.picks[MAX_PICKS_PER_RUN - 1]!.id).toBe(`p${MAX_PICKS_PER_RUN - 1}`);
    // Truncation stays visible instead of silently rewriting history.
    expect(record.levelUps).toBe(total);
  });

  it('keeps only the newest MAX_RECORDS runs', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    for (let i = 0; i < MAX_RECORDS + 10; i++) {
      t.beginRun('wanderer', 'meadow', i);
      t.finishRun(false, SUMMARY);
    }
    expect(t.records.length).toBe(MAX_RECORDS);
    expect(t.records[0]!.seed).toBe(10); // the ten oldest fell off the front
    expect(t.records[MAX_RECORDS - 1]!.seed).toBe(MAX_RECORDS + 9);
  });

  it('drops oldest records until the encoded document fits the byte budget', async () => {
    const adapter = new MemoryStorageAdapter();
    const t = await loaded(adapter);
    // Records fat enough that the ring alone cannot hold the payload under the
    // cap: the byte backstop has to bite as well.
    const fatOffer = 'x'.repeat(400);
    for (let i = 0; i < MAX_RECORDS; i++) {
      t.beginRun('wanderer', 'meadow', i);
      for (let p = 0; p < MAX_PICKS_PER_RUN; p++) {
        t.recordPick({ kind: 'weapon', id: fatOffer, level: 1, isNew: true, atLevel: p + 2, offered: [fatOffer] });
      }
      t.finishRun(false, SUMMARY);
    }
    await t.flush();

    const stored = (await adapter.get(TELEMETRY_KEY))!;
    expect(stored.length).toBeLessThanOrEqual(MAX_BYTES);
    expect(t.records.length).toBeLessThan(MAX_RECORDS);
    // What survives is the newest, and memory agrees with what was written.
    expect(t.records[t.records.length - 1]!.seed).toBe(MAX_RECORDS - 1);
    expect(decodeTelemetry(stored)!.records.length).toBe(t.records.length);
  });
});

describe('telemetry service — persistence', () => {
  it('persists finished runs and reloads them on the next boot', async () => {
    const adapter = new MemoryStorageAdapter();
    const t = await loaded(adapter);
    t.beginRun('wanderer', 'meadow', 7);
    t.recordPick({ kind: 'passive', id: 'boots', level: 1, isNew: true, atLevel: 2, offered: ['boots', 'stake'] });
    t.finishRun(true, SUMMARY);
    await t.flush();

    const rebooted = await loaded(adapter);
    expect(rebooted.records.length).toBe(1);
    expect(rebooted.records[0]!.seed).toBe(7);
    expect(rebooted.records[0]!.picks[0]!.id).toBe('boots');
  });

  it('recovers from corrupted stored data instead of losing the next run', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.set(TELEMETRY_KEY, '{"payload": "garbage"');
    const t = await loaded(adapter);
    expect(t.records).toEqual([]); // no throw, no backup slot — just an empty log

    t.beginRun('wanderer', 'meadow', 3);
    t.finishRun(false, SUMMARY);
    await t.flush();
    const rebooted = await loaded(adapter);
    expect(rebooted.records.map((r) => r.seed)).toEqual([3]);
  });

  it('survives an adapter that throws on read and on write', async () => {
    const broken: StorageAdapter = {
      get: () => Promise.reject(new Error('read denied')),
      set: () => Promise.reject(new Error('quota exceeded')),
      remove: () => Promise.resolve(),
    };
    const t = await loaded(broken);
    expect(t.records).toEqual([]);
    t.beginRun('wanderer', 'meadow', 1);
    t.finishRun(false, SUMMARY);
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.records.length).toBe(1); // still readable in memory this session
  });

  it('writes nothing mid-run: only a closed run touches storage', async () => {
    const adapter = new MemoryStorageAdapter();
    const t = await loaded(adapter);
    t.beginRun('wanderer', 'meadow', 1);
    t.recordPick({ kind: 'weapon', id: 'stake', level: 1, isNew: true, atLevel: 2, offered: ['stake'] });
    t.recordDeath({ enemyId: 'brute', kind: 'contact', damage: 5 });
    await t.flush();
    expect(await adapter.get(TELEMETRY_KEY)).toBeNull();
  });

  it('stamps the wall clock once, at the start of the run', async () => {
    let clock = 500;
    const t = new TelemetryService(new MemoryStorageAdapter(), () => clock);
    await t.load();
    t.beginRun('wanderer', 'meadow', 1);
    clock = 90_000;
    t.finishRun(false, SUMMARY);
    expect(t.records[0]!.startedAt).toBe(500);
  });
});

describe('telemetry service — reading it back', () => {
  it('summarizes outcomes, killers and the worst take-rate', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    // Three deaths to the brute, one to the acolyte, one victory.
    const killers = ['brute', 'brute', 'brute', 'acolyte'];
    for (let i = 0; i < killers.length; i++) {
      t.beginRun('wanderer', 'meadow', i);
      t.recordDeath({ enemyId: killers[i]!, kind: 'contact', damage: 10 });
      // 'garlic' is offered every run and never taken; 'stake' is always taken.
      t.recordPick({ kind: 'weapon', id: 'stake', level: 1, isNew: true, atLevel: 2, offered: ['stake', 'garlic'] });
      t.finishRun(false, { ...SUMMARY, survivedSeconds: (i + 1) * 10 });
    }
    for (let i = 0; i < 8; i++) {
      t.beginRun('wanderer', 'meadow', 100 + i);
      t.recordPick({ kind: 'weapon', id: 'stake', level: 1, isNew: true, atLevel: 2, offered: ['stake', 'garlic'] });
      t.finishRun(true, SUMMARY);
    }

    const text = t.summary().join('\n');
    expect(text).toContain('runs 12');
    expect(text).toContain('deaths 4');
    expect(text).toContain('wins 8');
    expect(text).toMatch(/brute\s+75%/); // 3 of 4 deaths
    expect(text).toContain('garlic'); // 12 offers, 0 takes — the worst take-rate
    expect(text).toContain('0%');
  });

  it('reports an empty log without dividing by zero', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    expect(t.summary().join('\n')).toContain('runs 0');
  });

  it('recomputes the summary only when a run closes', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    const first = t.summary();
    expect(t.summary()).toBe(first); // memoised: the F3 overlay asks every frame
    t.beginRun('wanderer', 'meadow', 1);
    expect(t.summary()).toBe(first); // an open run changes nothing
    t.finishRun(false, SUMMARY);
    expect(t.summary()).not.toBe(first);
  });

  it('dumps the whole log as pasteable JSON', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 5);
    t.finishRun(false, SUMMARY);
    const parsed = JSON.parse(t.dump()) as TelemetryDoc;
    expect(parsed.version).toBe(TELEMETRY_VERSION);
    expect(parsed.records[0]!.seed).toBe(5);
    expect(t.dump()).toContain('\n'); // pretty-printed, not one long line
  });
});

describe('telemetry stays on device', () => {
  it('has no transport: no fetch, XHR, beacon or websocket anywhere in the module', () => {
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource']) {
      expect(telemetrySource, `telemetry.ts must not reference ${banned}`).not.toContain(banned);
    }
    // Nothing it imports can smuggle one in either: its only edges are the
    // storage contract, the save checksum and core event types.
    const specifiers = Array.from(telemetrySource.matchAll(/from\s*['"]([^'"]+)['"]/g), (m) => m[1]);
    expect(specifiers.every((s) => s!.startsWith('./') || s!.startsWith('../core/'))).toBe(true);
  });

  it('collects no identifier that could join two installs', () => {
    for (const banned of [
      'navigator',
      'userAgent',
      'randomUUID',
      'localStorage',
      'document.',
      'window.',
      'screen.',
      'Intl.',
    ]) {
      expect(telemetryCode, `telemetry.ts must not reference ${banned}`).not.toContain(banned);
    }
  });

  it('reads the wall clock in exactly one place', () => {
    expect(telemetryCode.match(/Date\.now/g)?.length ?? 0).toBe(1);
  });

  it('records nothing beyond the declared run fields', async () => {
    const t = await loaded(new MemoryStorageAdapter());
    t.beginRun('wanderer', 'meadow', 1);
    t.finishRun(false, SUMMARY);
    expect(Object.keys(t.records[0]!).sort()).toEqual(
      [
        'characterId',
        'gold',
        'killedBy',
        'kills',
        'level',
        'levelUps',
        'mapId',
        'outcome',
        'picks',
        'seed',
        'startedAt',
        'survivedSeconds',
      ].sort(),
    );
  });
});
