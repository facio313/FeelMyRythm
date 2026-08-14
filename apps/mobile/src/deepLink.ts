export interface DeepLinkSource {
  addListener(
    eventName: 'appUrlOpen',
    listener: (event: { url: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  getLaunchUrl(): Promise<{ url: string } | undefined>;
}

function parseCredentialRoute(
  parsed: URL,
  route: '/login' | '/settings',
  allowedFragmentKeys: readonly string[],
): string | null {
  if (parsed.search) return null;
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const entries = [...fragment.entries()];
  if (entries.length === 0) return route === '/login' ? route : null;
  if (entries.length !== 1) return null;
  const [key, value] = entries[0] ?? [];
  if (!key || !value || !allowedFragmentKeys.includes(key)) return null;
  return `${route}#${new URLSearchParams([[key, value]]).toString()}`;
}

export function parseDeepLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'feelmyrythm:') {
      if (parsed.host === 'login' && (parsed.pathname === '' || parsed.pathname === '/')) {
        return parseCredentialRoute(parsed, '/login', ['verificationToken', 'passwordResetToken']);
      }
      if (parsed.host === 'settings' && (parsed.pathname === '' || parsed.pathname === '/')) {
        return parseCredentialRoute(parsed, '/settings', ['accountDeleteToken']);
      }
      if (parsed.host !== 'session' || parsed.pathname === '/') return null;
      return `/session${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    if (parsed.protocol !== 'https:' || parsed.host !== 'bonifacio.work') return null;

    if (parsed.pathname === '/feelmyrythm/login') {
      return parseCredentialRoute(parsed, '/login', ['verificationToken', 'passwordResetToken']);
    }
    if (parsed.pathname === '/feelmyrythm/settings') {
      return parseCredentialRoute(parsed, '/settings', ['accountDeleteToken']);
    }

    const marker = '/feelmyrythm/session/';
    if (!parsed.pathname.startsWith(marker) || parsed.pathname === marker) return null;
    return `/session/${parsed.pathname.slice(marker.length)}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export async function subscribeToDeepLinks(
  source: DeepLinkSource,
  listener: (path: string) => void,
): Promise<() => void> {
  let active = true;
  let receivedOpenEvent = false;
  let lastDispatch: { url: string; time: number } | null = null;
  const dispatch = (url: string): boolean => {
    if (!active) return false;
    const path = parseDeepLink(url);
    if (path) {
      const time = Date.now();
      if (lastDispatch?.url === url && time - lastDispatch.time < 1_000) return true;
      lastDispatch = { url, time };
      listener(path);
      return true;
    }
    return false;
  };
  const registration = await source.addListener('appUrlOpen', (event) => {
    if (dispatch(event.url)) receivedOpenEvent = true;
  });

  try {
    const launch = await source.getLaunchUrl();
    if (!receivedOpenEvent && launch?.url) dispatch(launch.url);
  } catch {
    // A launch URL lookup failure must not disable the live appUrlOpen listener.
  }

  return () => {
    active = false;
    void registration.remove().catch(() => undefined);
  };
}
