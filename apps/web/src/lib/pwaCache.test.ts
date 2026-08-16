import { describe, expect, it, vi } from 'vitest';
import {
  establishSafePwaRuntime,
  purgeLegacyRuntimeCaches,
  PwaSecurityTransitionError,
  SAFE_SERVICE_WORKER_SCOPE,
} from './pwaCache';

const APP_URL = 'https://app.example/feelmyrythm/login';
const SAFE_WORKER_URL = 'https://app.example/feelmyrythm/sw.js?fmr-safety=v1';

function cacheStorage(initialNames: readonly string[]) {
  const names = new Set(initialNames);
  const keys = vi.fn(async () => [...names]);
  const deleteCache = vi.fn(async (name: string) => names.delete(name));
  return {
    names,
    keys,
    deleteCache,
    storage: { keys, delete: deleteCache } as Pick<CacheStorage, 'keys' | 'delete'>,
  };
}

class FakeWorker extends EventTarget {
  readonly scriptURL: string;
  private currentState: ServiceWorkerState;

  constructor(scriptURL: string, state: ServiceWorkerState = 'activated') {
    super();
    this.scriptURL = scriptURL;
    this.currentState = state;
  }

  get state() {
    return this.currentState;
  }

  setState(state: ServiceWorkerState) {
    this.currentState = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration {
  readonly scope = 'https://app.example/feelmyrythm/';
  installing: ServiceWorker | null = null;
  waiting: ServiceWorker | null = null;
  active: ServiceWorker | null;

  constructor(active: ServiceWorker | null) {
    this.active = active;
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null;
  readonly register =
    vi.fn<
      (scriptURL: string | URL, options?: RegistrationOptions) => Promise<ServiceWorkerRegistration>
    >();
  readonly getRegistrations = vi.fn<() => Promise<readonly ServiceWorkerRegistration[]>>();

  constructor(controller: ServiceWorker | null) {
    super();
    this.controller = controller;
  }
}

function asWorker(worker: FakeWorker): ServiceWorker {
  return worker as unknown as ServiceWorker;
}

function asRegistration(registration: FakeRegistration): ServiceWorkerRegistration {
  return registration as unknown as ServiceWorkerRegistration;
}

function asContainer(container: FakeServiceWorkerContainer): ServiceWorkerContainer {
  return container as unknown as ServiceWorkerContainer;
}

describe('PWA runtime cache migration', () => {
  it('fails closed when sensitive cache enumeration fails', async () => {
    const storage = {
      keys: vi.fn().mockRejectedValue(new Error('cache storage unavailable')),
      delete: vi.fn(),
    } as Pick<CacheStorage, 'keys' | 'delete'>;

    await expect(purgeLegacyRuntimeCaches(storage)).rejects.toBeInstanceOf(
      PwaSecurityTransitionError,
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('fails closed when fmr-api deletion rejects or reports failure', async () => {
    const rejected = cacheStorage(['fmr-api']);
    rejected.deleteCache.mockRejectedValueOnce(new Error('delete unavailable'));
    await expect(purgeLegacyRuntimeCaches(rejected.storage)).rejects.toThrow(
      '민감한 레거시 캐시(fmr-api)를 삭제하지 못했습니다.',
    );

    const refused = cacheStorage(['fmr-api']);
    refused.deleteCache.mockResolvedValueOnce(false);
    await expect(purgeLegacyRuntimeCaches(refused.storage)).rejects.toThrow(
      '민감한 레거시 캐시(fmr-api) 삭제가 거부되었습니다.',
    );
  });

  it('keeps asset cleanup best-effort only after fmr-api is proven absent', async () => {
    const cache = cacheStorage(['fmr-api', 'fmr-assets', 'fmr-public-assets-v2']);
    cache.deleteCache.mockImplementation(async (name: string) => {
      if (name === 'fmr-assets') throw new Error('asset cache busy');
      return cache.names.delete(name);
    });

    await expect(purgeLegacyRuntimeCaches(cache.storage)).resolves.toBeUndefined();
    expect(cache.names.has('fmr-api')).toBe(false);
    expect(cache.deleteCache).toHaveBeenCalledWith('fmr-public-assets-v2');
  });

  it('waits for the versioned safe controller, retires the legacy worker, and purges again', async () => {
    const cache = cacheStorage(['fmr-api']);
    const legacyWorker = new FakeWorker('https://app.example/feelmyrythm/sw.js');
    const safeWorker = new FakeWorker(SAFE_WORKER_URL);
    const registration = new FakeRegistration(asWorker(legacyWorker));
    const container = new FakeServiceWorkerContainer(asWorker(legacyWorker));

    container.getRegistrations.mockImplementation(async () => [asRegistration(registration)]);
    container.register.mockImplementation(async () => {
      globalThis.setTimeout(() => {
        // A final legacy fetch can recreate the cache while the replacement installs.
        cache.names.add('fmr-api');
        legacyWorker.setState('redundant');
        registration.active = asWorker(safeWorker);
        container.controller = asWorker(safeWorker);
        container.dispatchEvent(new Event('controllerchange'));
      }, 0);
      return asRegistration(registration);
    });

    await expect(
      establishSafePwaRuntime({
        cacheStorage: cache.storage,
        serviceWorker: asContainer(container),
        locationHref: APP_URL,
        transitionTimeoutMs: 100,
      }),
    ).resolves.toBe('controlled');

    expect(container.register).toHaveBeenCalledWith(
      '/feelmyrythm/sw.js?fmr-safety=v1',
      expect.objectContaining({ scope: SAFE_SERVICE_WORKER_SCOPE, updateViaCache: 'none' }),
    );
    expect(cache.deleteCache.mock.calls.filter(([name]) => name === 'fmr-api')).toHaveLength(2);
    expect(cache.names.has('fmr-api')).toBe(false);
    expect(container.controller?.scriptURL).toBe(SAFE_WORKER_URL);
  });

  it('fails closed when a legacy controller never transitions', async () => {
    const cache = cacheStorage([]);
    const legacyWorker = new FakeWorker('https://app.example/feelmyrythm/sw.js');
    const registration = new FakeRegistration(asWorker(legacyWorker));
    const container = new FakeServiceWorkerContainer(asWorker(legacyWorker));
    container.getRegistrations.mockResolvedValue([asRegistration(registration)]);
    container.register.mockResolvedValue(asRegistration(registration));

    await expect(
      establishSafePwaRuntime({
        cacheStorage: cache.storage,
        serviceWorker: asContainer(container),
        locationHref: APP_URL,
        transitionTimeoutMs: 5,
      }),
    ).rejects.toThrow('안전한 서비스 워커가 제어권을 가져오지 못했습니다.');
  });

  it('fails closed when service-worker registrations cannot be enumerated', async () => {
    const cache = cacheStorage([]);
    const container = new FakeServiceWorkerContainer(null);
    container.getRegistrations.mockRejectedValue(new Error('registration store unavailable'));

    await expect(
      establishSafePwaRuntime({
        cacheStorage: cache.storage,
        serviceWorker: asContainer(container),
        locationHref: APP_URL,
      }),
    ).rejects.toThrow('서비스 워커 등록 상태를 확인할 수 없습니다.');
    expect(container.register).not.toHaveBeenCalled();
  });

  it('allows a registered safe worker when the current page is provably uncontrolled', async () => {
    const cache = cacheStorage([]);
    const safeWorker = new FakeWorker(SAFE_WORKER_URL);
    const registration = new FakeRegistration(asWorker(safeWorker));
    const container = new FakeServiceWorkerContainer(null);
    container.getRegistrations.mockResolvedValue([asRegistration(registration)]);
    container.register.mockResolvedValue(asRegistration(registration));

    await expect(
      establishSafePwaRuntime({
        cacheStorage: cache.storage,
        serviceWorker: asContainer(container),
        locationHref: APP_URL,
        transitionTimeoutMs: 5,
      }),
    ).resolves.toBe('uncontrolled');
    expect(container.controller).toBeNull();
    expect(cache.keys).toHaveBeenCalledTimes(4);
  });

  it('allows a proven uncontrolled environment after both sensitive-cache checks', async () => {
    const cache = cacheStorage([]);

    await expect(
      establishSafePwaRuntime({
        cacheStorage: cache.storage,
        serviceWorker: null,
        locationHref: APP_URL,
      }),
    ).resolves.toBe('uncontrolled');
    expect(cache.keys).toHaveBeenCalledTimes(4);
  });
});
