import { describe, expect, it } from 'vitest';

import { AudioEnvironmentError, BrowserWakeLockAdapter } from '../src/index.js';

describe('BrowserWakeLockAdapter', () => {
  it('acquires and releases a screen lock through an injected browser adapter', async () => {
    let released = false;
    const sentinel = {
      released: false,
      release: async () => {
        released = true;
      },
      addEventListener: () => undefined,
    };
    const adapter = new BrowserWakeLockAdapter({
      navigator: {
        wakeLock: {
          request: async () => sentinel,
        },
      },
    });

    await adapter.acquire();
    expect(adapter.held).toBe(true);
    await adapter.release();
    expect(released).toBe(true);
  });

  it('fails explicitly when Wake Lock is unsupported', async () => {
    const adapter = new BrowserWakeLockAdapter({ navigator: {} });
    await expect(adapter.acquire()).rejects.toBeInstanceOf(AudioEnvironmentError);
  });
});
