import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sessionInviteUrl', () => {
  it('keeps the current browser origin and uses the public app path', async () => {
    vi.stubEnv('MODE', 'test');
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:4173' } });
    const { sessionInviteUrl } = await import('./paths');

    expect(sessionInviteUrl('room-1')).toBe('http://127.0.0.1:4173/feelmyrythm/session/room-1');
    expect(sessionInviteUrl('room/#')).toBe('http://127.0.0.1:4173/feelmyrythm/session/room%2F%23');
  });

  it.each(['capacitor://app.feelmyrythm.local', 'https://app.feelmyrythm.local'])(
    'uses the configured public server instead of the native origin %s',
    async (origin) => {
      vi.stubEnv('MODE', 'mobile');
      vi.stubGlobal('__FMR_MOBILE_SERVER_ORIGIN__', 'https://rehearsal.example.test:9443');
      vi.stubGlobal('window', { location: { origin } });
      const { sessionInviteUrl } = await import('./paths');

      expect(sessionInviteUrl('room-2')).toBe(
        'https://rehearsal.example.test:9443/feelmyrythm/session/room-2',
      );
    },
  );
});
