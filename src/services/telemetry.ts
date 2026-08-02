import type { DeathCauseKind, DraftPickKind } from '../core/events.ts';
import { checksum } from './save.ts';
import type { StorageAdapter } from './storage.ts';

/**
 * On-device run telemetry: what the player built, and what killed them.
 *
 * Everything here stays on the device. There is no transport, no queue and no
 * backend — and that is the design, not a gap. The natural write cadence is
 * once per run end, roughly twice an hour, so a debounce timer would be
 * scheduling machinery with nothing to schedule. A developer reads this back
 * three ways: the F3 overlay (`summary()`), the console (`dump()`), or by
 * pulling the `vk-telemetry` key straight out of web storage in a Safari Web
 * Inspector attached to the iOS build. That last path is why the payload stays
 * plain JSON rather than anything compressed or bit-packed: it has to survive
 * being pasted into any JSON tool.
 *
 * The service takes primitives only — never a Ctx, never a World. The engine
 * isolation gate does not police services→gameplay, so that discipline is
 * self-imposed here.
 */

export const TELEMETRY_VERSION = 1;
export const TELEMETRY_KEY = 'vk-telemetry';

/** Ring bound: the newest N runs, oldest dropped on append. */
export const MAX_RECORDS = 50;
/** Per-run pick bound. Past it picks drop (the Fx-pool policy: drop, never grow). */
export const MAX_PICKS_PER_RUN = 60;
/**
 * Backstop on the encoded document. Counted in UTF-16 code units, which for an
 * all-ASCII payload of content ids is bytes; the point is a ceiling that
 * survives someone adding a field without redoing the arithmetic above.
 */
export const MAX_BYTES = 256 * 1024;

export interface PickRecord {
  kind: DraftPickKind;
  id: string;
  /** Level after taking it; 0 for the heal/gold consolation offers. */
  level: number;
  isNew: boolean;
  /** run.level when the draft resolved. */
  atLevel: number;
  /** Every id in that draft, the taken one included — the take-rate denominator. */
  offered: string[];
}

export interface DeathRecord {
  enemyId: string;
  cause: string;
  damage: number;
}

export type RunOutcome = 'victory' | 'death' | 'abandoned';

export interface RunRecord {
  /** The only wall clock in the record: one stamp, taken at beginRun. */
  startedAt: number;
  characterId: string;
  mapId: string;
  /** The run is replayable from this. */
  seed: number;
  outcome: RunOutcome;
  survivedSeconds: number;
  kills: number;
  gold: number;
  level: number;
  killedBy: DeathRecord | null;
  /** True count, even when `picks` was truncated — so truncation is detectable. */
  levelUps: number;
  picks: PickRecord[];
}

export interface TelemetryDoc {
  version: number;
  records: RunRecord[];
}

/** What a closing run reports about itself. Shared by finish and abandon. */
export interface RunSummary {
  survivedSeconds: number;
  kills: number;
  gold: number;
  level: number;
}

const ZERO_SUMMARY: RunSummary = { survivedSeconds: 0, kills: 0, gold: 0, level: 0 };

const PICK_KINDS: readonly string[] = ['weapon', 'passive', 'heal', 'gold'];
const OUTCOMES: readonly string[] = ['victory', 'death', 'abandoned'];

/** Ids with fewer offers than this have no meaningful take-rate yet. */
const TAKE_RATE_MIN_OFFERS = 10;

// --- codec ----------------------------------------------------------------
//
// Same {payload, checksum} envelope as save.ts, with two deliberate divergences:
//
//  - Single slot, no backup. Losing the wallet loses the player's progress;
//    losing telemetry loses a debugging convenience. A backup would double the
//    writes and the footprint for disposable data, so a null decode falls
//    through to an empty log rather than to a second slot.
//  - Per-record salvage. migrateTelemetry filters `records` element-wise: a
//    malformed record drops and its siblings survive. That is the warn-don't-throw
//    content rule applied to a log. save.ts cannot do it — all its fields are
//    load-bearing.

export function encodeTelemetry(doc: TelemetryDoc): string {
  const payload = JSON.stringify({ version: doc.version, records: doc.records });
  return JSON.stringify({ payload, checksum: checksum(payload) });
}

/** Parses the slot. Returns null on any corruption. Never throws. */
export function decodeTelemetry(raw: string): TelemetryDoc | null {
  try {
    const outer = JSON.parse(raw) as unknown;
    if (typeof outer !== 'object' || outer === null) return null;
    const { payload, checksum: stored } = outer as { payload?: unknown; checksum?: unknown };
    if (typeof payload !== 'string' || typeof stored !== 'string') return null;
    if (checksum(payload) !== stored) return null;
    return migrateTelemetry(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * Coerces a decoded payload into the current document. A version-less document
 * is early-dev, not future, and still loads; an unknown future version is
 * rejected rather than guessed at.
 */
export function migrateTelemetry(raw: unknown): TelemetryDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const version = typeof rec['version'] === 'number' ? rec['version'] : 0;
  if (version > TELEMETRY_VERSION) return null;

  const rows = Array.isArray(rec['records']) ? (rec['records'] as unknown[]) : [];
  const records: RunRecord[] = [];
  for (const row of rows) {
    const record = migrateRecord(row);
    if (record) records.push(record);
  }
  return { version: TELEMETRY_VERSION, records: records.slice(-MAX_RECORDS) };
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function migrateRecord(raw: unknown): RunRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  const startedAt = num(rec['startedAt']);
  const seed = num(rec['seed']);
  const survivedSeconds = num(rec['survivedSeconds']);
  const kills = num(rec['kills']);
  const gold = num(rec['gold']);
  const level = num(rec['level']);
  const levelUps = num(rec['levelUps']);
  const { characterId, mapId, outcome } = rec;
  if (startedAt === null || seed === null || survivedSeconds === null) return null;
  if (kills === null || gold === null || level === null || levelUps === null) return null;
  if (typeof characterId !== 'string' || typeof mapId !== 'string') return null;
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;

  const picks: PickRecord[] = [];
  if (Array.isArray(rec['picks'])) {
    for (const row of rec['picks'] as unknown[]) {
      const pick = migratePick(row);
      if (pick) picks.push(pick);
    }
  }

  return {
    startedAt,
    characterId,
    mapId,
    seed,
    outcome: outcome as RunOutcome,
    survivedSeconds,
    kills,
    gold,
    level,
    killedBy: migrateDeath(rec['killedBy']),
    levelUps,
    picks: picks.slice(0, MAX_PICKS_PER_RUN),
  };
}

function migratePick(raw: unknown): PickRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const level = num(rec['level']);
  const atLevel = num(rec['atLevel']);
  const { kind, id } = rec;
  if (typeof kind !== 'string' || !PICK_KINDS.includes(kind)) return null;
  if (typeof id !== 'string' || level === null || atLevel === null) return null;
  const offered = Array.isArray(rec['offered'])
    ? (rec['offered'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return { kind: kind as DraftPickKind, id, level, isNew: rec['isNew'] === true, atLevel, offered };
}

function migrateDeath(raw: unknown): DeathRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const damage = num(rec['damage']);
  const { enemyId, cause } = rec;
  if (typeof enemyId !== 'string' || typeof cause !== 'string' || damage === null) return null;
  return { enemyId, cause, damage };
}

/** Tenths of a second: finer than that is noise in an aggregate. */
const tenths = (seconds: number): number => Math.round(seconds * 10) / 10;

// --- service --------------------------------------------------------------

export class TelemetryService {
  private list: RunRecord[] = [];
  /** The run in flight. Accumulates in memory; nothing touches storage mid-run. */
  private current: RunRecord | null = null;
  /** Serialized write chain, exactly like MetaService.persist(). */
  private pending: Promise<void> = Promise.resolve();
  /** Bumped whenever the log changes — a load, a run closing, a trim. */
  private revision = 0;
  private memo: { revision: number; lines: string[] } | null = null;

  /**
   * The clock is injected so tests can pin `startedAt`, and so the module holds
   * exactly one wall-clock read — the default below, taken once per run.
   */
  constructor(
    private adapter: StorageAdapter,
    private now: () => number = Date.now,
  ) {}

  /** Boot step. Corruption is not fatal: a bad slot loads as an empty log. */
  async load(): Promise<void> {
    try {
      const raw = await this.adapter.get(TELEMETRY_KEY);
      this.list = raw === null ? [] : (decodeTelemetry(raw)?.records ?? []);
    } catch (error) {
      console.error('[telemetry] read failed:', error);
      this.list = [];
    }
    this.revision++;
  }

  /** Newest last. A live view for the debug read-out and tests — do not mutate. */
  get records(): readonly RunRecord[] {
    return this.list;
  }

  /**
   * Opens a run. Any run still open is closed as 'abandoned' first, which
   * covers restart-from-pause for free.
   */
  beginRun(characterId: string, mapId: string, seed: number): void {
    this.abandonRun();
    this.current = {
      startedAt: this.now(),
      characterId,
      mapId,
      seed,
      outcome: 'abandoned',
      survivedSeconds: 0,
      kills: 0,
      gold: 0,
      level: 0,
      killedBy: null,
      levelUps: 0,
      picks: [],
    };
  }

  /** A resolved level-up draft. Silently dropped past the per-run cap. */
  recordPick(pick: PickRecord): void {
    const run = this.current;
    if (!run) return;
    // levelUps counts the truth even when the pick itself is dropped, so a
    // truncated run reads as truncated instead of as a short one.
    run.levelUps++;
    if (run.picks.length >= MAX_PICKS_PER_RUN) return;
    run.picks.push({ ...pick, offered: [...pick.offered] });
  }

  /**
   * The killing blow. Must land before the run closes — the wiring in game.ts
   * subscribes this ahead of the handler that ends the run.
   */
  recordDeath(cause: { enemyId: string; kind: DeathCauseKind; damage: number }): void {
    if (!this.current) return;
    this.current.killedBy = { enemyId: cause.enemyId, cause: cause.kind, damage: cause.damage };
  }

  /** Closes the open run as won or lost, and writes. No-op when none is open. */
  finishRun(victory: boolean, summary: RunSummary): void {
    this.close(victory ? 'victory' : 'death', summary);
  }

  /** Closes the open run as abandoned (quit to title). No-op when none is open. */
  abandonRun(summary: RunSummary = ZERO_SUMMARY): void {
    this.close('abandoned', summary);
  }

  /**
   * Three lines that answer both questions at a glance, for the F3 overlay.
   * Memoised against `revision` because updateDebug runs every frame while the
   * overlay is visible: this recomputes when the log changes, never per frame.
   */
  summary(): string[] {
    if (this.memo && this.memo.revision === this.revision) return this.memo.lines;
    const lines = this.computeSummary();
    this.memo = { revision: this.revision, lines };
    return lines;
  }

  /** Pretty-printed JSON of the whole log — `copy(vkTelemetry.dump())`. */
  dump(): string {
    return JSON.stringify({ version: TELEMETRY_VERSION, records: this.list }, null, 2);
  }

  /** Awaits in-flight writes. Tests and lifecycle hooks only — never per frame. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private close(outcome: RunOutcome, summary: RunSummary): void {
    const run = this.current;
    if (!run) return;
    this.current = null;

    run.outcome = outcome;
    run.survivedSeconds = tenths(summary.survivedSeconds);
    run.kills = summary.kills;
    run.gold = summary.gold;
    run.level = summary.level;

    this.list.push(run);
    this.trimTo(MAX_RECORDS);
    this.revision++;
    this.persist();
  }

  /**
   * Drops the oldest records down to `count` — the only place the log shrinks,
   * which is why the memo key moves with it.
   *
   * summary() is read from render(), and the loop runs beforeFrame → update →
   * render → afterFrame synchronously, so a microtask cannot drain mid-frame:
   * the overlay always reads before the write chained by the run that just
   * closed gets to trim. A trim that left `revision` alone would therefore
   * leave the F3 read-out quoting records the byte backstop had already
   * dropped, for the rest of the session.
   */
  private trimTo(count: number): void {
    if (this.list.length <= count) return;
    this.list = this.list.slice(-count);
    this.revision++;
  }

  private persist(): void {
    // Chained, not raced: writes land in call order even on a slow adapter.
    this.pending = this.pending.then(() => this.write());
  }

  private async write(): Promise<void> {
    try {
      await this.adapter.set(TELEMETRY_KEY, this.encodeWithinBudget());
    } catch (error) {
      // A failed write must not take the game down. The likeliest cause is a
      // full origin quota — shared with the wallet, which is load-bearing where
      // this is disposable — so shed half the log and try once. Re-offering the
      // same payload every run would leave the quota pinned by the data that
      // matters least. One retry only: a second failure is not about size.
      console.error('[telemetry] write failed:', error);
      if (this.list.length <= 1) return;
      this.trimTo(this.list.length >> 1);
      try {
        await this.adapter.set(TELEMETRY_KEY, this.encodeWithinBudget());
      } catch (retryError) {
        console.error('[telemetry] write failed after shedding half the log:', retryError);
      }
    }
  }

  /**
   * Encodes the log, dropping the oldest records until it fits the byte
   * backstop. The trim is in-memory too, so what is readable this session is
   * exactly what a reboot would load.
   */
  private encodeWithinBudget(): string {
    let encoded = encodeTelemetry({ version: TELEMETRY_VERSION, records: this.list });
    while (encoded.length > MAX_BYTES && this.list.length > 1) {
      this.trimTo(this.list.length - 1);
      encoded = encodeTelemetry({ version: TELEMETRY_VERSION, records: this.list });
    }
    return encoded;
  }

  private computeSummary(): string[] {
    const runs = this.list.length;
    const deaths = this.list.filter((r) => r.outcome === 'death');
    const wins = this.list.filter((r) => r.outcome === 'victory').length;
    const survived = this.list.map((r) => r.survivedSeconds).sort((a, b) => a - b);
    const median = survived.length === 0 ? 0 : survived[survived.length >> 1]!;

    const lines = [
      `telemetry runs ${runs}  deaths ${deaths.length}  wins ${wins}`,
      `median survival ${median.toFixed(1)}s`,
    ];

    const killers = new Map<string, number>();
    for (const run of deaths) {
      const id = run.killedBy?.enemyId || '(unattributed)';
      killers.set(id, (killers.get(id) ?? 0) + 1);
    }
    const top = [...killers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length > 0) {
      const share = top.map(([id, n]) => `${id} ${Math.round((n / deaths.length) * 100)}%`);
      lines.push(`killers ${share.join('  ')}`);
    }

    const offers = new Map<string, number>();
    const takes = new Map<string, number>();
    for (const run of this.list) {
      for (const pick of run.picks) {
        for (const id of pick.offered) offers.set(id, (offers.get(id) ?? 0) + 1);
        takes.set(pick.id, (takes.get(pick.id) ?? 0) + 1);
      }
    }
    let worstId = '';
    let worstRate = Infinity;
    for (const [id, seen] of offers) {
      if (seen < TAKE_RATE_MIN_OFFERS) continue;
      const rate = (takes.get(id) ?? 0) / seen;
      if (rate < worstRate) {
        worstRate = rate;
        worstId = id;
      }
    }
    if (worstId !== '') {
      lines.push(`worst take-rate ${worstId} ${Math.round(worstRate * 100)}% of ${offers.get(worstId)}`);
    }

    return lines;
  }
}
