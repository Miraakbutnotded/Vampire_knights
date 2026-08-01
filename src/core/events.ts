/**
 * Typed pub/sub used to keep gameplay systems from reaching into the UI.
 * Systems emit ("player:levelup"); the UI layer listens.
 */
export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: unknown) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => set!.delete(erased);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so a handler that unsubscribes during dispatch can't corrupt iteration.
    for (const handler of [...set]) handler(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}

/**
 * What shape of thing landed the killing blow. Contact is an enemy body, a
 * projectile is something it threw. 'unknown' is the honest answer when a
 * damage source arrives without attribution rather than a guess.
 */
export type DeathCauseKind = 'contact' | 'projectile' | 'unknown';

export interface DeathCause {
  kind: DeathCauseKind;
  /** Enemy content id ('brute'); '' when no enemy is behind the blow. */
  enemyId: string;
  /** The killing blow after armour — what the player actually felt. */
  damage: number;
}

/**
 * The four things a level-up draft can hand out. Declared here rather than in
 * gameplay so that `draft:picked` and anything persisting it (services) share
 * one vocabulary; `OfferKind` in upgrades.ts is an alias of this.
 */
export type DraftPickKind = 'weapon' | 'passive' | 'heal' | 'gold';

export interface GameEvents {
  'player:damaged': { amount: number; hp: number; maxHp: number };
  'player:healed': { amount: number; hp: number; maxHp: number };
  /**
   * Widened rather than shadowed by a sibling 'player:killedBy': there is
   * exactly one emit site and the killer is in scope there, so the cause can
   * never desynchronise from the death. Existing subscribers ignore the payload.
   */
  'player:died': { survivedSeconds: number; kills: number; killedBy: DeathCause };
  'player:levelup': { level: number };
  'run:victory': { survivedSeconds: number; kills: number };
  /**
   * A level-up draft resolved. `offered` carries every id in that draft, the
   * taken one included: popularity without a denominator is confounded by the
   * draft's own weighting, so take-rate needs the offers that were declined.
   */
  'draft:picked': {
    kind: DraftPickKind;
    id: string;
    /** Level after taking it; 0 for the heal/gold consolation offers. */
    level: number;
    isNew: boolean;
    /** run.level when the draft resolved. */
    atLevel: number;
    offered: string[];
  };
  'xp:gained': { amount: number; xp: number; needed: number; level: number };
  'enemy:killed': { x: number; y: number; kills: number };
  'gold:gained': { amount: number; total: number };
  'boss:spawned': { name: string };
  'stats:changed': undefined;
  'blood:gained': { amount: number; blood: number; max: number };
  'blood:ready': undefined;
  'blood:feast': { spent: number; healed: number };
  'blood:frenzy': { spent: number; duration: number };
  'ability:used': { name: string; kind: string; cooldown: number };
  'ability:ready': undefined;
  'structure:damaged': { hp: number; maxHp: number; index: number };
  'structure:destroyed': { name: string; remaining: number; index: number };
  'siege:started': { duration: number };
  'siege:defended': { gold: number };
  'run:ended': { victory: boolean; survivedSeconds: number; kills: number; gold: number; level: number };
  'meta:goldBanked': { banked: number; total: number };
  'meta:purchased': { nodeId: string; rank: number };
  'character:unlocked': { id: string };
}
