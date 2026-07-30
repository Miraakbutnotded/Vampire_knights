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

export interface GameEvents {
  'player:damaged': { amount: number; hp: number; maxHp: number };
  'player:healed': { amount: number; hp: number; maxHp: number };
  'player:died': { survivedSeconds: number; kills: number };
  'player:levelup': { level: number };
  'run:victory': { survivedSeconds: number; kills: number };
  'xp:gained': { amount: number; xp: number; needed: number; level: number };
  'enemy:killed': { x: number; y: number; kills: number };
  'gold:gained': { amount: number; total: number };
  'boss:spawned': { name: string };
  'stats:changed': undefined;
  'blood:gained': { amount: number; blood: number; max: number };
  'blood:ready': undefined;
  'blood:feast': { spent: number; healed: number };
  'blood:frenzy': { spent: number; duration: number };
}
