import { META_LIST, metaNodeDef } from '../gameplay/content.ts';
import type { CharacterDef, MetaMods } from '../gameplay/content.ts';
import { coachPrompt } from './coach.ts';
import type { CoachSave } from './coach.ts';
import { foldDaily, rolloverDaily } from './daily.ts';
import type { DailyPayout, DailySave } from './daily.ts';
import { featMet, featProgress, foldFeats } from './feats.ts';
import type { FeatSave } from './feats.ts';
import { SaveStore, defaultSave } from './save.ts';
import type { SaveData } from './save.ts';
import type { StorageAdapter } from './storage.ts';

/** Why a character is still locked, and how close the player is to fixing it. */
export interface LockState {
  gold: number;
  /** Whether the wallet covers the price today. */
  affordable: boolean;
  /** The feat gating the purchase, with progress, or null when gold is the only gate. */
  requirement: {
    label: string;
    target: number;
    /** Whole units, clamped to target — a card never prints 34/20 or 107.78/600. */
    progress: number;
    met: boolean;
  } | null;
}

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
  /** Last daily-committed run token — the same guard, for the same reason. */
  private lastDailyToken = 0;
  /** Last feat-recorded run token — the same guard again. */
  private lastFeatToken = 0;
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

  /** Today's oath record. Replaced on every change, so this is safe to hold. */
  get dailyState(): Readonly<DailySave> {
    return this.data.daily;
  }

  /**
   * Advances the daily set if the local day has moved forward. Persists only
   * when it actually rolled; returns whether it did.
   *
   * Evaluated at exactly three points, none of them during a run — boot,
   * openTitle, and resume from background. Freezing the day for the duration of
   * a run is what stops a run that starts at 23:59 and ends at 00:02 from
   * watching its own progress bar reset.
   */
  rollDaily(now: number, tzOffsetMinutes?: number): boolean {
    const { state, rolled } = rolloverDaily(this.data.daily, now, tzOffsetMinutes);
    if (!rolled) return false;
    this.data = { ...this.data, daily: state };
    this.persist();
    return true;
  }

  /**
   * Folds one finished run into the day, pays whatever it completed, and
   * persists once.
   *
   * Guarded on `runToken` exactly like bankRun: Game passes a counter
   * incremented in startRun, and a token that has already committed is ignored,
   * so the browser-side double-settle paths cannot pay a daily twice.
   *
   * `runDay` is the day the run *started* on. Rollover is confined to boot and
   * the title screen (onResumed refuses to roll unless the title is up), so a
   * mismatch means the day moved while a run was open — a state the callers are
   * built to make unreachable. The discard stays as the backstop for it: paying
   * a fresh day's set from a run banked against yesterday's would be worse.
   */
  commitDailyRun(
    delta: Record<string, number>,
    runDay: number,
    runToken: number,
  ): DailyPayout {
    if (runToken === this.lastDailyToken) return { completed: [], gold: 0 };
    this.lastDailyToken = runToken;
    if (runDay !== this.data.daily.day) return { completed: [], gold: 0 };

    const folded = foldDaily(this.data.daily, delta);
    this.data = {
      ...this.data,
      gold: this.data.gold + folded.gold,
      daily: folded.state,
    };
    this.persist();
    return { completed: folded.completed, gold: folded.gold };
  }

  /** The permanent feat record. Replaced on change, so this is safe to hold. */
  get feats(): Readonly<FeatSave> {
    return this.data.feats;
  }

  /**
   * Folds one finished run into the feat record, exactly once per run token.
   *
   * Guarded like bankRun and commitDailyRun, and for the same reason: the
   * browser-side settle can be reached twice for one run, and a doubled fold
   * would inflate every 'sum' requirement. Unlike those two this pays nothing —
   * it only records — so a repeat costs progress accuracy rather than gold,
   * which is precisely why it must not rely on the caller's own guard.
   *
   * Unconditional in the other direction: a run that scored nothing on every
   * signal still burns the token, because whether it wrote anything is
   * foldFeats' business and re-folding an empty delta later is not.
   */
  recordFeats(delta: Record<string, number>, runToken: number): void {
    if (runToken === this.lastFeatToken) return;
    this.lastFeatToken = runToken;
    this.data = { ...this.data, feats: foldFeats(this.data.feats, delta) };
    this.persist();
  }

  /** Which coach lines have already been said. Replaced on change, safe to hold. */
  get coachState(): Readonly<CoachSave> {
    return this.data.coach;
  }

  /**
   * Records one coach line as permanently said.
   *
   * Idempotent and pool-checked, so a repeat or a stale id costs nothing and
   * cannot grow the record — the same discipline migrateCoach applies on the way
   * in. No run token here: unlike a payout, saying a line twice in one session
   * is already impossible (the director marks it seen at show time and never
   * offers it again), and the worst a duplicated call could do is a redundant
   * write, which this returns early from anyway.
   */
  markCoachSeen(id: string): void {
    if (!coachPrompt(id)) return;
    if (this.data.coach.seen.includes(id)) return;
    this.data = { ...this.data, coach: { seen: [...this.data.coach.seen, id] } };
    this.persist();
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

  /** Playable, whether because it is free or because it was bought. */
  isUnlocked(character: CharacterDef): boolean {
    return this.lockStateOf(character) === null;
  }

  /**
   * Everything the title screen needs to print a locked card, or null when the
   * character is free or already owned.
   *
   * The one answer to "why is this locked", which is what `isUnlocked` above
   * and `unlockCharacter` below both read: the card and the purchase cannot
   * disagree about a gate neither of them evaluates for itself.
   */
  lockStateOf(character: CharacterDef): LockState | null {
    const unlock = character.unlock;
    if (unlock === null || this.data.unlockedCharacters.includes(character.id)) return null;
    const requirement =
      unlock.requirement === null
        ? null
        : {
            label: unlock.requirement.label,
            target: unlock.requirement.target,
            // Floored as well as clamped: `survive` accumulates in fractional
            // simulation seconds, and a card is a place for "107/600", not for
            // 107.78333333333285.
            progress: Math.floor(
              Math.min(featProgress(this.data.feats, unlock.requirement), unlock.requirement.target),
            ),
            met: featMet(this.data.feats, unlock.requirement),
          };
    return {
      gold: unlock.gold,
      affordable: this.data.gold >= unlock.gold,
      requirement,
    };
  }

  /**
   * Buys a character. False = free, already owned, requirement unearned, or too
   * poor.
   *
   * Both gates are checked here rather than only at the card: the screen is one
   * caller, and a gate that lives in the UI is a gate a second caller walks
   * straight past. They are read off the same LockState the card renders, in
   * the order the player has to satisfy them — feat first, then price.
   */
  unlockCharacter(character: CharacterDef): boolean {
    const lock = this.lockStateOf(character);
    if (lock === null) return false;
    if (lock.requirement !== null && !lock.requirement.met) return false;
    if (!lock.affordable) return false;
    this.data = {
      ...this.data,
      gold: this.data.gold - lock.gold,
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
