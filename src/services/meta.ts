import { META_LIST, metaNodeDef } from '../gameplay/content.ts';
import type { CharacterDef, MetaMods } from '../gameplay/content.ts';
import { SaveStore, defaultSave } from './save.ts';
import type { SaveData } from './save.ts';
import type { StorageAdapter } from './storage.ts';

/**
 * The persistent wallet and Sanctum progression, wrapped around one SaveData.
 *
 * All mutation goes through methods that persist fire-and-forget: UI code
 * never blocks a frame on storage, and a failed write costs at most the delta
 * since the previous successful one. State is replaced, never mutated, so a
 * half-applied purchase can't be persisted. The engine never imports this
 * module — main.ts, game.ts and the screens are the only callers.
 */
export class MetaService {
  private store: SaveStore;
  private data: SaveData = defaultSave();
  /** Last banked run token — bankRun's exactly-once guard (session-scoped, never persisted). */
  private lastBankedToken = 0;
  /** Serialized write chain; flush() awaits it (tests + future lifecycle hooks). */
  private pending: Promise<void> = Promise.resolve();

  constructor(adapter: StorageAdapter) {
    this.store = new SaveStore(adapter);
  }

  /** The second async boot step (after SpriteTable.load) — call before openTitle. */
  async load(): Promise<void> {
    this.data = await this.store.load();
  }

  get gold(): number {
    return this.data.gold;
  }

  /**
   * Banks a finished run's gold exactly once per run token: Game passes a
   * counter incremented in startRun, and a token that has already banked is
   * ignored. This is the headless-testable half of the "banks exactly once"
   * invariant — the browser-bound endRun double-invocation paths (death on
   * the victory-crossing tick; a second death after the die+level-up
   * same-tick resume) cannot bank twice even if Game's own guard is ever
   * refactored away. Returns the wallet total.
   */
  bankRun(runGold: number, runToken: number): number {
    if (runToken === this.lastBankedToken) return this.data.gold;
    this.lastBankedToken = runToken;
    const amount = Math.max(0, Math.floor(runGold));
    if (amount > 0) {
      this.data = { ...this.data, gold: this.data.gold + amount };
      this.persist();
    }
    return this.data.gold;
  }

  rankOf(nodeId: string): number {
    return this.data.sanctum[nodeId] ?? 0;
  }

  /** Buys the next rank of a node. False = unknown node, maxed out, or too poor. */
  buyNode(nodeId: string): boolean {
    const def = metaNodeDef(nodeId);
    if (!def) return false;
    const rank = this.rankOf(nodeId);
    if (rank >= def.maxRank) return false;
    const cost = def.costs[rank]!;
    if (this.data.gold < cost) return false;
    this.data = {
      ...this.data,
      gold: this.data.gold - cost,
      sanctum: { ...this.data.sanctum, [nodeId]: rank + 1 },
    };
    this.persist();
    return true;
  }

  /** Sums every owned rank into the mods bag the Run constructor consumes. */
  computeMetaMods(): MetaMods {
    const mods: MetaMods = {};
    for (const node of META_LIST) {
      const rank = this.rankOf(node.id);
      if (rank <= 0) continue;
      for (const [key, perRank] of Object.entries(node.perRank)) {
        if (perRank === undefined) continue;
        const k = key as keyof MetaMods;
        mods[k] = (mods[k] ?? 0) + perRank * rank;
      }
    }
    return mods;
  }

  isUnlocked(character: CharacterDef): boolean {
    return character.unlock === null || this.data.unlockedCharacters.includes(character.id);
  }

  /** Spends gold to unlock a character. False = free, already owned, or too poor. */
  unlockCharacter(character: CharacterDef): boolean {
    const cost = character.unlock?.gold;
    if (cost === undefined) return false;
    if (this.data.unlockedCharacters.includes(character.id)) return false;
    if (this.data.gold < cost) return false;
    this.data = {
      ...this.data,
      gold: this.data.gold - cost,
      unlockedCharacters: [...this.data.unlockedCharacters, character.id],
    };
    this.persist();
    return true;
  }

  /** Awaits any in-flight writes. Tests and lifecycle hooks only — never per frame. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private persist(): void {
    // Chained, not raced: writes land in call order even on a slow adapter.
    this.pending = this.pending.then(() => this.store.persist(this.data));
  }
}
