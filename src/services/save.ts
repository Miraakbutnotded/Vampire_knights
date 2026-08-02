import { defaultCoach, migrateCoach } from './coach.ts';
import type { CoachSave } from './coach.ts';
import { defaultDaily, migrateDaily } from './daily.ts';
import type { DailySave } from './daily.ts';
import type { StorageAdapter } from './storage.ts';

export const SAVE_VERSION = 3;
export const SAVE_KEY = 'vk-save';
export const SAVE_BACKUP_KEY = 'vk-save.bak';

/**
 * Everything Vampire Knights persists between runs.
 *
 * Version 1 (Phase 4) added `sanctum`; version 2 added `daily`; version 3 added
 * `coach`.
 *
 * **Adding a field here is not enough.** encodeSave() below builds an explicit
 * literal rather than spreading, so a field added to this interface and not to
 * that literal typechecks, round-trips through migrate() as "missing →
 * default", and silently never persists. Add it to both.
 */
export interface SaveData {
  version: number;
  gold: number;
  unlockedCharacters: string[];
  /** Sanctum node ranks by node id; absent key = rank 0. */
  sanctum: Record<string, number>;
  /** Tonight's Oaths: the day floor, its progress, and what it has paid. */
  daily: DailySave;
  /** Which of the coach's lines the player has already been told. */
  coach: CoachSave;
}

export function defaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    gold: 0,
    unlockedCharacters: [],
    sanctum: {},
    daily: defaultDaily(),
    coach: defaultCoach(),
  };
}

/** FNV-1a over the payload string — a corruption tripwire, not security. */
export function checksum(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Serializes with the checksum computed over a stable-ordered payload. */
export function encodeSave(data: SaveData): string {
  const payload = JSON.stringify({
    version: data.version,
    gold: data.gold,
    unlockedCharacters: data.unlockedCharacters,
    sanctum: data.sanctum,
    daily: data.daily,
    coach: data.coach,
  });
  return JSON.stringify({ payload, checksum: checksum(payload) });
}

/**
 * Parses one slot. Returns null on any corruption — bad JSON, checksum
 * mismatch, a payload migrate() rejects — so the caller can fall through to
 * the backup slot or defaults. Never throws.
 */
export function decodeSave(rawSlot: string): SaveData | null {
  try {
    const outer = JSON.parse(rawSlot) as unknown;
    if (typeof outer !== 'object' || outer === null) return null;
    const { payload, checksum: stored } = outer as { payload?: unknown; checksum?: unknown };
    if (typeof payload !== 'string' || typeof stored !== 'string') return null;
    if (checksum(payload) !== stored) return null;
    return migrate(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * Coerces a decoded payload of any known version into the current SaveData.
 * Missing fields (a version-less early-dev "v0" save) fill from defaults —
 * the same warn-don't-throw spirit as content normalization. Unknown future
 * versions are rejected (null) rather than guessed at, so a downgraded build
 * falls back to the backup slot instead of mangling a newer save.
 */
export function migrate(raw: unknown): SaveData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const version = typeof rec['version'] === 'number' ? rec['version'] : 0;
  if (version > SAVE_VERSION) return null;

  const base = defaultSave();
  const gold =
    typeof rec['gold'] === 'number' && Number.isFinite(rec['gold'])
      ? Math.max(0, Math.floor(rec['gold']))
      : base.gold;
  const unlockedCharacters = Array.isArray(rec['unlockedCharacters'])
    ? (rec['unlockedCharacters'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : base.unlockedCharacters;
  const sanctumRaw =
    typeof rec['sanctum'] === 'object' && rec['sanctum'] !== null
      ? (rec['sanctum'] as Record<string, unknown>)
      : {};
  const sanctum: Record<string, number> = {};
  for (const [id, rank] of Object.entries(sanctumRaw)) {
    if (typeof rank === 'number' && Number.isInteger(rank) && rank > 0) sanctum[id] = rank;
  }
  // Unconditional, not version-gated: a v1 save simply has no `daily` and falls
  // to defaults, the same way a v0 save had no `sanctum` and a v2 save has no
  // `coach`. Every added field goes on this list and nowhere else.
  const daily = migrateDaily(rec['daily']);
  const coach = migrateCoach(rec['coach']);
  return { version: SAVE_VERSION, gold, unlockedCharacters, sanctum, daily, coach };
}

/**
 * Dual-slot persistence: every persist writes the primary slot first, then the
 * backup. A write interrupted between the two leaves the previous good save in
 * the backup, which load() falls back to (healing the primary) before giving
 * up and returning defaults. Adapter failures are logged, never thrown — a
 * failed save must not take the game down, and the next persist retries.
 */
export class SaveStore {
  constructor(private adapter: StorageAdapter) {}

  async load(): Promise<SaveData> {
    const primary = await this.readSlot(SAVE_KEY);
    if (primary) return primary;
    const backup = await this.readSlot(SAVE_BACKUP_KEY);
    if (backup) {
      await this.writeSlot(SAVE_KEY, backup);
      return backup;
    }
    return defaultSave();
  }

  async persist(data: SaveData): Promise<void> {
    await this.writeSlot(SAVE_KEY, data);
    await this.writeSlot(SAVE_BACKUP_KEY, data);
  }

  private async readSlot(key: string): Promise<SaveData | null> {
    try {
      const raw = await this.adapter.get(key);
      return raw === null ? null : decodeSave(raw);
    } catch (error) {
      console.error('[save] read failed:', error);
      return null;
    }
  }

  private async writeSlot(key: string, data: SaveData): Promise<void> {
    try {
      await this.adapter.set(key, encodeSave(data));
    } catch (error) {
      console.error('[save] write failed:', error);
    }
  }
}
