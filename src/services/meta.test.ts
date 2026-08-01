import { describe, expect, it } from 'vitest';

import { characterDef } from '../gameplay/content.ts';
import {
  SAVE_BACKUP_KEY,
  SAVE_KEY,
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
      version: 1,
      gold: 1234,
      unlockedCharacters: ['acolyte'],
      sanctum: { greed: 2, haste: 1 },
    };
    expect(decodeSave(encodeSave(data))).toEqual(data);
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

  it('migrates a version-less v0 save to v1 defaults', () => {
    expect(migrate({ gold: 500 })).toEqual({
      version: 1,
      gold: 500,
      unlockedCharacters: [],
      sanctum: {},
    });
    // Garbage fields sanitize instead of poisoning the state: negative gold
    // clamps, fractional ranks drop, non-strings fall out of the unlock list.
    expect(migrate({ gold: -5, sanctum: { greed: 1.5, haste: 2 }, unlockedCharacters: ['a', 7] })).toEqual({
      version: 1,
      gold: 0,
      unlockedCharacters: ['a'],
      sanctum: { haste: 2 },
    });
  });

  it('rejects saves from the future and non-objects', () => {
    expect(migrate({ version: 2, gold: 10 })).toBeNull();
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
