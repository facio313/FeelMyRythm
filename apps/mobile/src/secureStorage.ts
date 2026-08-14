import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SecureStoragePluginContract {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export interface WebStorageContract {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PlatformStorage {
  readonly secure: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const SecureStorage = registerPlugin<SecureStoragePluginContract>('SecureStorage');

export function createPlatformStorage({
  native,
  plugin,
  webStorage,
}: {
  native: boolean;
  plugin: SecureStoragePluginContract;
  webStorage?: WebStorageContract;
}): PlatformStorage {
  const requireWebStorage = (): WebStorageContract => {
    if (!webStorage) throw new Error('Web storage is not available');
    return webStorage;
  };

  return {
    secure: native,
    async getItem(key) {
      if (native) return (await plugin.get({ key })).value;
      return requireWebStorage().getItem(key);
    },
    async setItem(key, value) {
      if (native) {
        await plugin.set({ key, value });
        return;
      }
      requireWebStorage().setItem(key, value);
    },
    async removeItem(key) {
      if (native) {
        await plugin.remove({ key });
        return;
      }
      requireWebStorage().removeItem(key);
    },
  };
}

export const platformStorage = createPlatformStorage({
  native: Capacitor.isNativePlatform(),
  plugin: SecureStorage,
  ...(typeof window === 'undefined' ? {} : { webStorage: window.localStorage }),
});
