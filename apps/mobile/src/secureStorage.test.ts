import { describe, expect, it, vi } from 'vitest';
import {
  createPlatformStorage,
  type SecureStoragePluginContract,
  type WebStorageContract,
} from './secureStorage';

function memoryWebStorage(): WebStorageContract {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function memorySecurePlugin() {
  const values = new Map<string, string>();
  const get = vi.fn<SecureStoragePluginContract['get']>(async ({ key }) => ({
    value: values.get(key) ?? null,
  }));
  const set = vi.fn<SecureStoragePluginContract['set']>(async ({ key, value }) => {
    values.set(key, value);
  });
  const remove = vi.fn<SecureStoragePluginContract['remove']>(async ({ key }) => {
    values.delete(key);
  });
  return { get, set, remove } satisfies SecureStoragePluginContract;
}

describe('platform storage', () => {
  it('keeps the existing web storage contract in browsers', async () => {
    const webStorage = memoryWebStorage();
    const plugin = memorySecurePlugin();
    const storage = createPlatformStorage({ native: false, plugin, webStorage });

    await storage.setItem('fmr.auth.tokens.v1', 'web-session');
    await expect(storage.getItem('fmr.auth.tokens.v1')).resolves.toBe('web-session');
    await storage.removeItem('fmr.auth.tokens.v1');

    await expect(storage.getItem('fmr.auth.tokens.v1')).resolves.toBeNull();
    expect(storage.secure).toBe(false);
    expect(plugin.set).not.toHaveBeenCalled();
  });

  it('uses only the OS plugin on native platforms', async () => {
    const plugin = memorySecurePlugin();
    const webSetItem = vi.fn(() => {
      throw new Error('native storage must not write localStorage');
    });
    const webStorage: WebStorageContract = {
      getItem: vi.fn(() => {
        throw new Error('native storage must not read localStorage');
      }),
      setItem: webSetItem,
      removeItem: vi.fn(() => {
        throw new Error('native storage must not clear localStorage');
      }),
    };
    const storage = createPlatformStorage({ native: true, plugin, webStorage });

    await storage.setItem('fmr.auth.tokens.v1', 'native-session');
    await expect(storage.getItem('fmr.auth.tokens.v1')).resolves.toBe('native-session');
    await storage.removeItem('fmr.auth.tokens.v1');

    await expect(storage.getItem('fmr.auth.tokens.v1')).resolves.toBeNull();
    expect(storage.secure).toBe(true);
    expect(webSetItem).not.toHaveBeenCalled();
  });
});
