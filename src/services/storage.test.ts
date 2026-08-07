import { describe, expect, it, vi } from 'vitest';

import { PreferencesStorageAdapter } from './storage.ts';

/**
 * Capacitor's registerPlugin returns a Proxy whose get-trap manufactures a
 * method for ANY property name — which makes the plugin object an accidental
 * thenable. This fake reproduces exactly that behaviour: reading `.then` off
 * it yields a callable that never invokes its arguments, the same shape that
 * hung the shipped app's boot on a black screen.
 */
function capacitorLikeProxy(store: Map<string, string>): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'get') {
          return ({ key }: { key: string }) => Promise.resolve({ value: store.get(key) ?? null });
        }
        if (prop === 'set') {
          return ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
            return Promise.resolve();
          };
        }
        if (prop === 'remove') {
          return ({ key }: { key: string }) => {
            store.delete(key);
            return Promise.resolve();
          };
        }
        // Any other name — `then` included — becomes a plugin call that never
        // answers, exactly like a bridged method the native side ignores.
        return (..._args: unknown[]) => new Promise(() => {});
      },
    },
  );
}

const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({ Preferences: capacitorLikeProxy(store) }));

describe('preferences adapter vs the thenable proxy', () => {
  it('survives a plugin object whose .then never answers', async () => {
    const adapter = new PreferencesStorageAdapter();

    // The regression this pins: resolving a promise WITH the proxy adopts it
    // as a thenable and hangs forever. The adapter must therefore only ever
    // resolve module namespaces and destructure the proxy after the await.
    // A short real-time race keeps a regression from hanging the suite.
    const outcome = await Promise.race([
      (async () => {
        await adapter.set('k', 'v');
        return adapter.get('k');
      })(),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);

    expect(outcome).toBe('v');
  });
});
