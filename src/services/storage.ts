/**
 * Minimal async key-value contract the save system writes through.
 *
 * Everything is Promise-based even though localStorage is synchronous, so the
 * Phase 5 swap to Capacitor Preferences (genuinely async) changes no call
 * sites. The engine (core/ecs/gameplay/render) never imports this module —
 * see isolation.test.ts.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Browser adapter. Constructed only from main.ts — never in headless code. */
export class LocalStorageAdapter implements StorageAdapter {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(key);
  }
}

/** In-memory adapter for vitest and any future headless tooling. */
export class MemoryStorageAdapter implements StorageAdapter {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
