import { describe, expect, it } from 'vitest';

import { characterDef } from '../gameplay/content.ts';
import { defaultCoach } from './coach.ts';
import {
  DAILY_BONUS_GOLD,
  DAILY_OBJECTIVE_GOLD,
  DAY_MS,
  dailySet,
  defaultDaily,
} from './daily.ts';
import {
  SAVE_BACKUP_KEY,
  SAVE_KEY,
  SAVE_VERSION,
  SaveStore,
  checksum,
  decodeSave,
  defaultSave,
  encodeSave,
  migrate,
} from './save.ts';
import type { SaveData } from './save.ts';
import { MemoryStorageAdapter } from './storage.ts';
import { MetaService } from './meta.ts';

describe('storage adapters', () => {
  it('round-trips values through the in-memory adapter', async () => {
    const store = new MemoryStorageAdapter();
    expect(await store.get('missing')).toBeNull();
    await store.set('k', 'v1');
    expect(await store.get('k')).toBe('v1');
    await store.set('k', 'v2');
    expect(await store.get('k')).toBe('v2');
  });

  it('removes keys', async () => {
    const store = new MemoryStorageAdapter();
    await store.set('k', 'v');
    await store.remove('k');
    expect(await store.get('k')).toBeNull();
  });
});

describe('save codec', () => {
  it('round-trips SaveData through encode/decode', () => {
    const data: SaveData = {
      version: SAVE_VERSION,
      gold: 1234,
      unlockedCharacters: ['acolyte'],
      sanctum: { greed: 2, haste: 1 },
      daily: { day: 20447, progress: { kills: 120 }, claimed: ['gold'], bonusClaimed: false },
      coach: { seen: ['move', 'auto'] },
    };
    expect(decodeSave(encodeSave(data))).toEqual(data);
  });

  /**
   * encodeSave builds an explicit literal rather than spreading `data`, so a
   * field added to SaveData but not to that literal typechecks, round-trips
   * through migrate() as "missing → default", and silently never persists.
   * This asserts against the encoded bytes so the omission cannot hide.
   */
  it('writes every SaveData field into the payload, not just the ones it started with', () => {
    const data: SaveData = {
      ...defaultSave(),
      gold: 9,
      daily: { day: 20447, progress: { kills: 3 }, claimed: [], bonusClaimed: true },
    };
    const payload = JSON.parse(JSON.parse(encodeSave(data)).payload as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual(Object.keys(data).sort());
    expect(payload['daily']).toEqual(data.daily);
  });

  it('rejects tampered or malformed slots via the checksum', () => {
    const encoded = encodeSave(defaultSave());
    // The payload is a nested JSON string, so its quotes are escaped.
    const tampered = encoded.replace('\\"gold\\":0', '\\"gold\\":9999');
    expect(tampered).not.toBe(encoded); // sanity: the replace found its target
    expect(decodeSave(tampered)).toBeNull();
    expect(decodeSave('not json at all')).toBeNull();
    expect(decodeSave('{"payload":123,"checksum":"x"}')).toBeNull();
    expect(checksum('a')).not.toBe(checksum('b'));
  });

  it('migrates a version-less v0 save to current defaults', () => {
    expect(migrate({ gold: 500 })).toEqual({
      version: SAVE_VERSION,
      gold: 500,
      unlockedCharacters: [],
      sanctum: {},
      daily: defaultDaily(),
      coach: defaultCoach(),
    });
    // Garbage fields sanitize instead of poisoning the state: negative gold
    // clamps, fractional ranks drop, non-strings fall out of the unlock list.
    expect(migrate({ gold: -5, sanctum: { greed: 1.5, haste: 2 }, unlockedCharacters: ['a', 7] })).toEqual({
      version: SAVE_VERSION,
      gold: 0,
      unlockedCharacters: ['a'],
      sanctum: { haste: 2 },
      daily: defaultDaily(),
      coach: defaultCoach(),
    });
  });

  /**
   * The v1 → v2 → v3 steps, and the reason migrate() still branches on nothing:
   * a real v1 save has no `daily` and no `coach` at all, and both absent fields
   * fall to defaults exactly the way `sanctum` did on v0 → v1.
   */
  it('migrates a real v1 save forward, adopting a fresh daily record', () => {
    const v1 = { version: 1, gold: 3200, unlockedCharacters: ['acolyte'], sanctum: { greed: 2 } };
    expect(migrate(v1)).toEqual({
      version: SAVE_VERSION,
      gold: 3200,
      unlockedCharacters: ['acolyte'],
      sanctum: { greed: 2 },
      daily: { day: 0, progress: {}, claimed: [], bonusClaimed: false },
      coach: { seen: [] },
    });
    // day 0 reads as "never rolled": the first rollover adopts the observed day
    // without paying out for the set it replaces.
    expect(migrate(v1)!.daily.day).toBe(0);
  });

  it('sanitizes a hand-edited daily record on the way in', () => {
    const migrated = migrate({
      version: 2,
      gold: 0,
      daily: {
        day: -4,
        progress: { kills: 10, madeUpObjective: 1e9, gold: -1 },
        claimed: ['level', 'level', 'notAnObjective'],
        bonusClaimed: 'yes',
      },
    });
    expect(migrated!.daily).toEqual({
      day: 0,
      progress: { kills: 10 },
      claimed: ['level'],
      bonusClaimed: false,
    });
  });

  it('rejects saves from the future and non-objects', () => {
    // The guard is what makes a downgraded build fall to the backup slot
    // instead of mangling a newer save.
    expect(migrate({ version: SAVE_VERSION + 1, gold: 10 })).toBeNull();
    expect(migrate('gold')).toBeNull();
    expect(migrate(null)).toBeNull();
  });
});

describe('save store', () => {
  it('persists to both slots and loads the primary', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new SaveStore(adapter);
    await store.persist({ ...defaultSave(), gold: 777 });
    expect(await adapter.get(SAVE_KEY)).not.toBeNull();
    expect(await adapter.get(SAVE_BACKUP_KEY)).not.toBeNull();
    expect((await store.load()).gold).toBe(777);
  });

  it('recovers from the backup when the primary is corrupt, healing it', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new SaveStore(adapter);
    await store.persist({ ...defaultSave(), gold: 4242 });
    await adapter.set(SAVE_KEY, '{"payload": "garbage"');
    expect((await store.load()).gold).toBe(4242);
    // The corrupt primary was healed from the backup on the way through.
    expect(decodeSave((await adapter.get(SAVE_KEY))!)?.gold).toBe(4242);
  });

  it('falls back to defaults when both slots are corrupt or missing', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.set(SAVE_KEY, 'garbage');
    await adapter.set(SAVE_BACKUP_KEY, 'more garbage');
    expect(await new SaveStore(adapter).load()).toEqual(defaultSave());
    expect(await new SaveStore(new MemoryStorageAdapter()).load()).toEqual(defaultSave());
  });
});

describe('meta service — wallet', () => {
  it('banks run gold and persists it for the next boot', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = new MetaService(adapter);
    await meta.load();
    expect(meta.gold).toBe(0);
    expect(meta.bankRun(320, 1)).toBe(320);
    expect(meta.bankRun(180, 2)).toBe(500);
    await meta.flush();
    const rebooted = new MetaService(adapter);
    await rebooted.load();
    expect(rebooted.gold).toBe(500);
  });

  it('ignores non-positive bank amounts and floors fractional gold', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(100, 1);
    expect(meta.bankRun(0, 2)).toBe(100);
    expect(meta.bankRun(-50, 3)).toBe(100);
    expect(meta.bankRun(12.9, 4)).toBe(112);
  });

  it('banks each run token exactly once', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.bankRun(300, 1)).toBe(300);
    // Same token again (a double-invoked end-of-run path) banks nothing.
    expect(meta.bankRun(300, 1)).toBe(300);
    expect(meta.bankRun(100, 2)).toBe(400);
  });
});

describe('meta service — sanctum', () => {
  it('buys ranks at exact costs and rejects when poor or maxed', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(760, 1); // magnetism costs 80/200/500
    expect(meta.buyNode('magnetism')).toBe(true);  // -80  → 680
    expect(meta.buyNode('magnetism')).toBe(true);  // -200 → 480
    expect(meta.buyNode('magnetism')).toBe(false); // rank 3 costs 500 > 480
    expect(meta.gold).toBe(480);
    expect(meta.rankOf('magnetism')).toBe(2);
    meta.bankRun(20, 2);
    expect(meta.buyNode('magnetism')).toBe(true);  // -500 → 0
    expect(meta.buyNode('magnetism')).toBe(false); // maxed
    expect(meta.rankOf('magnetism')).toBe(3);
    expect(meta.gold).toBe(0);
  });

  it('rejects unknown nodes without touching the wallet', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(1000, 1);
    expect(meta.buyNode('nonsense')).toBe(false);
    expect(meta.gold).toBe(1000);
  });

  it('sums owned ranks into meta mods including revives', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(20000, 1);
    meta.buyNode('bloodthirst');
    meta.buyNode('bloodthirst'); // might 0.05 × 2
    meta.buyNode('haste');       // cooldown -0.025
    meta.buyNode('second_wind'); // revives 1
    expect(meta.computeMetaMods()).toEqual({ might: 0.1, cooldown: -0.025, revives: 1 });
  });

  it('returns an empty mods bag for a fresh save', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.computeMetaMods()).toEqual({});
  });
});

describe('meta service — character unlocks', () => {
  it('treats free characters as always unlocked', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    expect(meta.isUnlocked(characterDef('wanderer'))).toBe(true);
    expect(meta.isUnlocked(characterDef('acolyte'))).toBe(false);
    // Unlocking a free character is a no-op, not a purchase.
    expect(meta.unlockCharacter(characterDef('wanderer'))).toBe(false);
  });

  it('unlocks a character at the exact gold cost exactly once', async () => {
    const meta = new MetaService(new MemoryStorageAdapter());
    await meta.load();
    meta.bankRun(3000, 1);
    const acolyte = characterDef('acolyte'); // costs 2500
    expect(meta.unlockCharacter(acolyte)).toBe(true);
    expect(meta.gold).toBe(500);
    expect(meta.isUnlocked(acolyte)).toBe(true);
    expect(meta.unlockCharacter(acolyte)).toBe(false); // no double-charge
    expect(meta.gold).toBe(500);
    expect(meta.unlockCharacter(characterDef('dragos'))).toBe(false); // 12000 > 500
  });

  it('persists unlocks across a reload', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = new MetaService(adapter);
    await meta.load();
    meta.bankRun(2500, 1);
    meta.unlockCharacter(characterDef('acolyte'));
    await meta.flush();
    const rebooted = new MetaService(adapter);
    await rebooted.load();
    expect(rebooted.isUnlocked(characterDef('acolyte'))).toBe(true);
    expect(rebooted.gold).toBe(0);
  });
});

describe('meta service — daily objectives', () => {
  const TZ = 0; // judged in UTC so the host's own timezone never leaks in
  const at = (day: number, hour = 12): number => day * DAY_MS + hour * 3_600_000;

  const loaded = async (adapter = new MemoryStorageAdapter()) => {
    const meta = new MetaService(adapter);
    await meta.load();
    return meta;
  };

  it('starts never-rolled and adopts the observed day on the first roll', async () => {
    const meta = await loaded();
    expect(meta.dailyState.day).toBe(0);
    expect(meta.rollDaily(at(20447), TZ)).toBe(true);
    expect(meta.dailyState.day).toBe(20447);
    // Same day again is a no-op, and must not re-roll the set out from under a
    // player mid-session.
    expect(meta.rollDaily(at(20447, 23), TZ)).toBe(false);
    expect(meta.rollDaily(at(20448), TZ)).toBe(true);
  });

  it('persists a roll, and only when it actually rolled', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = await loaded(adapter);
    meta.rollDaily(at(20447), TZ);
    await meta.flush();
    const before = await adapter.get(SAVE_KEY);
    meta.rollDaily(at(20447, 20), TZ); // no change
    await meta.flush();
    expect(await adapter.get(SAVE_KEY)).toBe(before);

    const rebooted = await loaded(adapter);
    expect(rebooted.dailyState.day).toBe(20447);
  });

  it('pays a completed objective into the wallet and persists once', async () => {
    const adapter = new MemoryStorageAdapter();
    const meta = await loaded(adapter);
    meta.rollDaily(at(20447), TZ);
    const [first] = dailySet(meta.dailyState.day);
    const payout = meta.commitDailyRun({ [first!.id]: first!.target }, 20447, 1);
    expect(payout.completed).toEqual([first!.id]);
    expect(payout.gold).toBe(DAILY_OBJECTIVE_GOLD);
    expect(meta.gold).toBe(DAILY_OBJECTIVE_GOLD);
    await meta.flush();

    const rebooted = await loaded(adapter);
    expect(rebooted.gold).toBe(DAILY_OBJECTIVE_GOLD);
    expect(rebooted.dailyState.claimed).toEqual([first!.id]);
  });

  it('ignores a run token that already committed, exactly like bankRun', async () => {
    const meta = await loaded();
    meta.rollDaily(at(20447), TZ);
    const [first] = dailySet(meta.dailyState.day);
    const delta = { [first!.id]: first!.target };
    expect(meta.commitDailyRun(delta, 20447, 3).gold).toBe(DAILY_OBJECTIVE_GOLD);
    const repeat = meta.commitDailyRun(delta, 20447, 3);
    expect(repeat).toEqual({ completed: [], gold: 0 });
    expect(meta.gold).toBe(DAILY_OBJECTIVE_GOLD);
    // A genuinely new run still folds — progress is not frozen by the guard.
    expect(meta.commitDailyRun(delta, 20447, 4).gold).toBe(0); // already claimed
    expect(meta.dailyState.progress[first!.id]).toBe(first!.target * 2);
  });

  /**
   * Unreachable by construction — Game freezes runDay for the duration of a run
   * and rollover is never evaluated during one — so this pins the branch rather
   * than inviting someone to delete it.
   */
  it('discards a run that started on a different day than the one now stored', async () => {
    const meta = await loaded();
    meta.rollDaily(at(20447), TZ);
    const [first] = dailySet(meta.dailyState.day);
    const stale = meta.commitDailyRun({ [first!.id]: first!.target }, 20446, 1);
    expect(stale).toEqual({ completed: [], gold: 0 });
    expect(meta.gold).toBe(0);
    expect(meta.dailyState.progress).toEqual({});
  });

  it('pays the all-three bonus once the day is cleared', async () => {
    const meta = await loaded();
    meta.rollDaily(at(20447), TZ);
    const set = dailySet(meta.dailyState.day);
    const delta = Object.fromEntries(set.map((def) => [def.id, def.target]));
    const payout = meta.commitDailyRun(delta, 20447, 1);
    expect(payout.completed.sort()).toEqual(set.map((d) => d.id).sort());
    expect(payout.gold).toBe(3 * DAILY_OBJECTIVE_GOLD + DAILY_BONUS_GOLD);
    expect(meta.dailyState.bonusClaimed).toBe(true);
  });

  it('wipes progress on the next roll, so yesterday cannot be banked twice', async () => {
    const meta = await loaded();
    meta.rollDaily(at(20447), TZ);
    const [first] = dailySet(meta.dailyState.day);
    meta.commitDailyRun({ [first!.id]: first!.target }, 20447, 1);
    const banked = meta.gold;
    meta.rollDaily(at(20448), TZ);
    expect(meta.dailyState).toEqual({
      day: 20448,
      progress: {},
      claimed: [],
      bonusClaimed: false,
    });
    expect(meta.gold).toBe(banked);
  });

  it('exposes daily state read-only — callers cannot fold progress by hand', async () => {
    const meta = await loaded();
    meta.rollDaily(at(20447), TZ);
    const snapshot = meta.dailyState;
    meta.commitDailyRun({ kills: 50 }, 20447, 1);
    // Replaced, never mutated: the old reference is still yesterday's truth.
    expect(snapshot.progress).toEqual({});
    expect(meta.dailyState.progress['kills']).toBe(50);
  });
});
