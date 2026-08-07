
/**
 * Minimal async key-value contract the save system writes through.
 *
 * Everything is Promise-based even though localStorage is synchronous, which is
 * what let Capacitor Preferences (genuinely async) slot in underneath without
 * touching a single call site. The engine (core/ecs/gameplay/render) never
 * imports this module — see isolation.test.ts.
 *
 * Three implementations, and which one a build gets is decided exactly once, in
 * main.ts: Preferences on device, localStorage on the web, memory in vitest.
 * Nothing in src/services may choose for itself.
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

/**
 * Native adapter: UserDefaults on iOS, SharedPreferences on Android, both
 * reached through Capacitor Preferences. The reason it exists is that a
 * WebView's localStorage is cache, not storage — Android in particular evicts
 * it under pressure, and the wallet is the one save a player files a bug about.
 *
 * The plugin is pulled in by a memoized dynamic import, the same idiom as
 * lifecycle.ts and haptics.ts: `import type` above is erased at compile time, so
 * this module stays importable in vitest and in a web build that will never
 * construct this class. The first get/set pays the import; every later call
 * awaits the already-settled promise.
 *
 * Errors propagate exactly like LocalStorageAdapter's do — SaveStore and
 * TelemetryService are the layer that catches and logs them, and moving that
 * decision down here would hide a failed write from the retry they already do.
 */
export class PreferencesStorageAdapter implements StorageAdapter {
  /**
   * The pending import holds the MODULE NAMESPACE, never the plugin itself.
   *
   * That distinction is load-bearing. Capacitor's `registerPlugin` returns a
   * Proxy whose get-trap manufactures a method for any property name — `then`
   * included — so the proxy is accidentally a thenable. Resolve a promise
   * with it and the promise machinery adopts it: it calls `proxy.then(...)`,
   * Capacitor dutifully invokes a plugin method named "then" that will never
   * answer, and the await hangs forever with no error to catch. That hang sat
   * in the boot path and kept the shipped app on a black screen.
   *
   * A module namespace has no `then` export, so it is always a safe resolution
   * value; the proxy is only ever destructured out AFTER the await, exactly as
   * lifecycle.ts and haptics.ts already do. storage.test.ts pins this against
   * a proxy with the same accidental-thenable shape.
   */
  private module: Promise<typeof import('@capacitor/preferences')> | null = null;

  private load(): Promise<typeof import('@capacitor/preferences')> {
    // Assigned before the await so two concurrent calls share one import.
    this.module ??= import('@capacitor/preferences');
    return this.module;
  }

  async get(key: string): Promise<string | null> {
    const { Preferences } = await this.load();
    const { value } = await Preferences.get({ key });
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    const { Preferences } = await this.load();
    await Preferences.set({ key, value });
  }

  async remove(key: string): Promise<void> {
    const { Preferences } = await this.load();
    await Preferences.remove({ key });
  }
}

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
