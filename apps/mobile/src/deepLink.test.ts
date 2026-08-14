import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDeepLink, subscribeToDeepLinks, type DeepLinkSource } from './deepLink';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseDeepLink', () => {
  it.each([
    ['feelmyrythm://session/room-1', '/session/room-1'],
    ['https://bonifacio.work/feelmyrythm/session/room-2', '/session/room-2'],
    ['feelmyrythm://session/room-3?invite=member#ready', '/session/room-3?invite=member#ready'],
    ['feelmyrythm://login#verificationToken=signed', '/login#verificationToken=signed'],
    [
      'https://bonifacio.work/feelmyrythm/login#passwordResetToken=signed',
      '/login#passwordResetToken=signed',
    ],
    [
      'https://bonifacio.work/feelmyrythm/settings#accountDeleteToken=delete-signed',
      '/settings#accountDeleteToken=delete-signed',
    ],
    [
      'feelmyrythm://settings#accountDeleteToken=delete-signed',
      '/settings#accountDeleteToken=delete-signed',
    ],
  ])('maps an app link %s to %s', (url, expected) => {
    expect(parseDeepLink(url)).toBe(expected);
  });

  it.each([
    'not a URL',
    'http://bonifacio.work/feelmyrythm/session/room-1',
    'https://example.com/feelmyrythm/session/room-1',
    'https://bonifacio.work/another-app/session/room-1',
    'https://bonifacio.work/other/feelmyrythm/session/room-1',
    'feelmyrythm://settings',
    'feelmyrythm://session/',
    'https://bonifacio.work/feelmyrythm/login/extra#verificationToken=signed',
    'https://bonifacio.work/feelmyrythm/login?token=leak#verificationToken=signed',
    'https://bonifacio.work/feelmyrythm/login#verificationToken=one&passwordResetToken=two',
    'https://bonifacio.work/feelmyrythm/login#unexpectedToken=signed',
    'https://bonifacio.work/feelmyrythm/settings#verificationToken=signed',
    'https://bonifacio.work/feelmyrythm/settings',
  ])('rejects an untrusted or malformed URL %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });
});

describe('subscribeToDeepLinks', () => {
  it('registers the live listener before dispatching the cold-launch URL', async () => {
    const events: string[] = [];
    let onOpen: ((event: { url: string }) => void) | undefined;
    const remove = vi.fn(async () => undefined);
    const source: DeepLinkSource = {
      async addListener(_eventName, listener) {
        events.push('listener');
        onOpen = listener;
        return { remove };
      },
      async getLaunchUrl() {
        events.push('launch');
        return { url: 'feelmyrythm://session/cold-room' };
      },
    };
    const paths: string[] = [];

    const unsubscribe = await subscribeToDeepLinks(source, (path) => paths.push(path));
    onOpen?.({ url: 'feelmyrythm://session/live-room' });

    expect(events).toEqual(['listener', 'launch']);
    expect(paths).toEqual(['/session/cold-room', '/session/live-room']);
    unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps the live listener when launch URL lookup fails', async () => {
    let onOpen: ((event: { url: string }) => void) | undefined;
    const source: DeepLinkSource = {
      async addListener(_eventName, listener) {
        onOpen = listener;
        return { remove: async () => undefined };
      },
      async getLaunchUrl() {
        throw new Error('launch lookup unavailable');
      },
    };
    const listener = vi.fn();

    await expect(subscribeToDeepLinks(source, listener)).resolves.toBeTypeOf('function');
    onOpen?.({ url: 'feelmyrythm://session/recovered-room' });

    expect(listener).toHaveBeenCalledWith('/session/recovered-room');
  });

  it('does not let an untrusted open event suppress a valid cold-launch URL', async () => {
    const source: DeepLinkSource = {
      async addListener(_eventName, listener) {
        listener({ url: 'https://example.com/feelmyrythm/session/untrusted' });
        return { remove: async () => undefined };
      },
      async getLaunchUrl() {
        return { url: 'feelmyrythm://session/trusted-room' };
      },
    };
    const listener = vi.fn();

    await subscribeToDeepLinks(source, listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('/session/trusted-room');
  });

  it('does not dispatch the same cold-launch URL twice when native also emits appUrlOpen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    let onOpen: ((event: { url: string }) => void) | undefined;
    const launchUrl = 'feelmyrythm://session/cold-room';
    const source: DeepLinkSource = {
      async addListener(_eventName, listener) {
        onOpen = listener;
        return { remove: async () => undefined };
      },
      async getLaunchUrl() {
        return { url: launchUrl };
      },
    };
    const listener = vi.fn();

    await subscribeToDeepLinks(source, listener);
    onOpen?.({ url: launchUrl });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('/session/cold-room');
    vi.advanceTimersByTime(1_001);
    onOpen?.({ url: launchUrl });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('native deep-link declarations', () => {
  it('declares exact Android login and settings credential routes', () => {
    const manifest = readFileSync(
      new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url),
      'utf8',
    );

    expect(manifest).toMatch(
      /android:host="settings"\s+android:scheme="@string\/custom_url_scheme"/,
    );
    expect(manifest).toMatch(
      /android:host="bonifacio\.work"\s+android:path="\/feelmyrythm\/login"\s+android:scheme="https"/,
    );
    expect(manifest).toMatch(
      /android:host="bonifacio\.work"\s+android:path="\/feelmyrythm\/settings"\s+android:scheme="https"/,
    );
    expect(manifest).not.toContain('android:pathPrefix="/feelmyrythm/settings/"');
  });
});
