const SENSITIVE_RUNTIME_CACHES = ['fmr-api'] as const;
const LEGACY_ASSET_CACHES = ['fmr-assets', 'fmr-public-assets-v2'] as const;

// Keep the generated filename stable so browsers registered against the legacy /sw.js
// can still discover the update. The query is the security-generation identity checked
// against ServiceWorker.controller.scriptURL before the application is mounted.
export const SAFE_SERVICE_WORKER_SCRIPT = '/feelmyrythm/sw.js?fmr-safety=v1';
export const SAFE_SERVICE_WORKER_SCOPE = '/feelmyrythm/';

const DEFAULT_TRANSITION_TIMEOUT_MS = 15_000;

type CacheStoragePort = Pick<CacheStorage, 'delete' | 'keys'>;

export type SafePwaRuntimeState = 'controlled' | 'uncontrolled';

export interface SafePwaRuntimeOptions {
  cacheStorage?: CacheStoragePort | null;
  serviceWorker?: ServiceWorkerContainer | null;
  locationHref?: string;
  enableServiceWorker?: boolean;
  transitionTimeoutMs?: number;
}

export class PwaSecurityTransitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PwaSecurityTransitionError';
  }
}

function resolveCacheStorage(
  providedStorage: CacheStoragePort | null | undefined,
): CacheStoragePort | undefined {
  if (providedStorage !== undefined) return providedStorage ?? undefined;
  try {
    return 'caches' in globalThis ? globalThis.caches : undefined;
  } catch (cause) {
    throw new PwaSecurityTransitionError('브라우저 캐시 저장소에 접근할 수 없습니다.', {
      cause,
    });
  }
}

async function readCacheNames(cacheStorage: CacheStoragePort): Promise<readonly string[]> {
  try {
    return await cacheStorage.keys();
  } catch (cause) {
    throw new PwaSecurityTransitionError('민감한 레거시 캐시를 확인할 수 없습니다.', { cause });
  }
}

async function purgeSensitiveRuntimeCaches(cacheStorage: CacheStoragePort): Promise<void> {
  const names = await readCacheNames(cacheStorage);

  for (const name of SENSITIVE_RUNTIME_CACHES) {
    if (!names.includes(name)) continue;

    let deleted: boolean;
    try {
      deleted = await cacheStorage.delete(name);
    } catch (cause) {
      throw new PwaSecurityTransitionError(`민감한 레거시 캐시(${name})를 삭제하지 못했습니다.`, {
        cause,
      });
    }
    if (!deleted) {
      throw new PwaSecurityTransitionError(`민감한 레거시 캐시(${name}) 삭제가 거부되었습니다.`);
    }
  }

  const remaining = await readCacheNames(cacheStorage);
  const residual = SENSITIVE_RUNTIME_CACHES.find((name) => remaining.includes(name));
  if (residual) {
    throw new PwaSecurityTransitionError(`민감한 레거시 캐시(${residual})가 남아 있습니다.`);
  }
}

export async function purgeLegacyRuntimeCaches(
  providedStorage?: CacheStoragePort | null,
): Promise<void> {
  const cacheStorage = resolveCacheStorage(providedStorage);
  if (!cacheStorage) return;

  // Authenticated API data is fail-closed. Asset-only caches are safe to clean up
  // best-effort after the sensitive cache has been proven absent.
  await purgeSensitiveRuntimeCaches(cacheStorage);
  await Promise.allSettled(
    LEGACY_ASSET_CACHES.map(async (name) => {
      await cacheStorage.delete(name);
    }),
  );
}

function resolveServiceWorker(
  providedServiceWorker: ServiceWorkerContainer | null | undefined,
): ServiceWorkerContainer | null {
  if (providedServiceWorker !== undefined) return providedServiceWorker;
  try {
    return 'navigator' in globalThis && 'serviceWorker' in globalThis.navigator
      ? globalThis.navigator.serviceWorker
      : null;
  } catch (cause) {
    throw new PwaSecurityTransitionError('서비스 워커 상태를 확인할 수 없습니다.', { cause });
  }
}

function resolveLocationHref(providedHref?: string): string {
  if (providedHref) return providedHref;
  if ('location' in globalThis && globalThis.location?.href) return globalThis.location.href;
  throw new PwaSecurityTransitionError('현재 애플리케이션 주소를 확인할 수 없습니다.');
}

function expectedWorkerUrl(locationHref: string): string {
  return new URL(SAFE_SERVICE_WORKER_SCRIPT, locationHref).href;
}

function expectedWorkerScope(locationHref: string): string {
  return new URL(SAFE_SERVICE_WORKER_SCOPE, locationHref).href;
}

function isSafeWorker(worker: ServiceWorker | null, locationHref: string): worker is ServiceWorker {
  if (!worker) return false;
  try {
    return new URL(worker.scriptURL, locationHref).href === expectedWorkerUrl(locationHref);
  } catch {
    return false;
  }
}

function registrationCoversPage(registration: ServiceWorkerRegistration, locationHref: string) {
  try {
    return locationHref.startsWith(new URL(registration.scope, locationHref).href);
  } catch {
    return false;
  }
}

function registrationWorkers(registration: ServiceWorkerRegistration): Array<ServiceWorker> {
  return [registration.installing, registration.waiting, registration.active].filter(
    (worker): worker is ServiceWorker => worker !== null,
  );
}

async function readRegistrations(
  serviceWorker: ServiceWorkerContainer,
): Promise<readonly ServiceWorkerRegistration[]> {
  try {
    return await serviceWorker.getRegistrations();
  } catch (cause) {
    throw new PwaSecurityTransitionError('서비스 워커 등록 상태를 확인할 수 없습니다.', { cause });
  }
}

function hasSafeRegistration(
  registrations: readonly ServiceWorkerRegistration[],
  locationHref: string,
): boolean {
  const expectedScope = expectedWorkerScope(locationHref);
  return registrations.some(
    (registration) =>
      new URL(registration.scope, locationHref).href === expectedScope &&
      isSafeWorker(registration.active, locationHref),
  );
}

function hasApplicableRegistration(
  registrations: readonly ServiceWorkerRegistration[],
  locationHref: string,
): boolean {
  return registrations.some(
    (registration) =>
      registrationCoversPage(registration, locationHref) &&
      registrationWorkers(registration).length > 0,
  );
}

function waitForSafeController(
  serviceWorker: ServiceWorkerContainer,
  locationHref: string,
  timeoutMs: number,
): Promise<ServiceWorker> {
  const current = serviceWorker.controller;
  if (isSafeWorker(current, locationHref)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (worker?: ServiceWorker, error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (worker) resolve(worker);
      else
        reject(error ?? new PwaSecurityTransitionError('서비스 워커 제어권 전환에 실패했습니다.'));
    };
    const onControllerChange = () => {
      const controller = serviceWorker.controller;
      if (isSafeWorker(controller, locationHref)) finish(controller);
    };
    const timeout = globalThis.setTimeout(() => {
      finish(
        undefined,
        new PwaSecurityTransitionError('안전한 서비스 워커가 제어권을 가져오지 못했습니다.'),
      );
    }, timeoutMs);

    serviceWorker.addEventListener('controllerchange', onControllerChange);
    // Close the race where controllerchange fires between the initial check and listener setup.
    onControllerChange();
  });
}

function waitForRedundantWorker(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  if (worker.state === 'redundant') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.removeEventListener('statechange', onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const onStateChange = () => {
      if (worker.state === 'redundant') finish();
    };
    const timeout = globalThis.setTimeout(() => {
      finish(new PwaSecurityTransitionError('레거시 서비스 워커가 종료되지 않았습니다.'));
    }, timeoutMs);

    worker.addEventListener('statechange', onStateChange);
    onStateChange();
  });
}

export async function establishSafePwaRuntime(
  options: SafePwaRuntimeOptions = {},
): Promise<SafePwaRuntimeState> {
  const cacheStorage = resolveCacheStorage(options.cacheStorage);
  const serviceWorker = resolveServiceWorker(options.serviceWorker);
  const locationHref = resolveLocationHref(options.locationHref);
  const transitionTimeoutMs = options.transitionTimeoutMs ?? DEFAULT_TRANSITION_TIMEOUT_MS;

  // Remove any already-persisted authenticated response before an update can start.
  await purgeLegacyRuntimeCaches(cacheStorage);

  if (!serviceWorker) {
    await purgeLegacyRuntimeCaches(cacheStorage);
    return 'uncontrolled';
  }

  const registrationsBefore = await readRegistrations(serviceWorker);
  const initialController = serviceWorker.controller;

  if (options.enableServiceWorker === false) {
    if (initialController || hasApplicableRegistration(registrationsBefore, locationHref)) {
      throw new PwaSecurityTransitionError(
        '서비스 워커가 비활성화된 환경에서 기존 제어권을 안전하게 해제할 수 없습니다.',
      );
    }
    await purgeLegacyRuntimeCaches(cacheStorage);
    return 'uncontrolled';
  }

  const initialRegistration = initialController
    ? registrationsBefore.find((registration) =>
        registrationWorkers(registration).includes(initialController),
      )
    : undefined;

  try {
    await serviceWorker.register(SAFE_SERVICE_WORKER_SCRIPT, {
      scope: SAFE_SERVICE_WORKER_SCOPE,
      updateViaCache: 'none',
    });
  } catch (cause) {
    const registrationsAfterFailure = await readRegistrations(serviceWorker);
    if (
      isSafeWorker(serviceWorker.controller, locationHref) &&
      hasSafeRegistration(registrationsAfterFailure, locationHref)
    ) {
      await purgeLegacyRuntimeCaches(cacheStorage);
      return 'controlled';
    }
    if (
      !serviceWorker.controller &&
      !hasApplicableRegistration(registrationsAfterFailure, locationHref)
    ) {
      await purgeLegacyRuntimeCaches(cacheStorage);
      return 'uncontrolled';
    }
    throw new PwaSecurityTransitionError('안전한 서비스 워커를 등록하지 못했습니다.', { cause });
  }

  if (!serviceWorker.controller) {
    const uncontrolledRegistrations = await readRegistrations(serviceWorker);
    if (hasSafeRegistration(uncontrolledRegistrations, locationHref)) {
      await purgeLegacyRuntimeCaches(cacheStorage);
      return 'uncontrolled';
    }
  }

  await waitForSafeController(serviceWorker, locationHref, transitionTimeoutMs);

  if (
    initialController &&
    !isSafeWorker(initialController, locationHref) &&
    initialRegistration &&
    new URL(initialRegistration.scope, locationHref).href === expectedWorkerScope(locationHref)
  ) {
    await waitForRedundantWorker(initialController, transitionTimeoutMs);
  }

  const registrationsAfter = await readRegistrations(serviceWorker);
  if (
    !isSafeWorker(serviceWorker.controller, locationHref) ||
    !hasSafeRegistration(registrationsAfter, locationHref)
  ) {
    throw new PwaSecurityTransitionError('서비스 워커의 안전한 제어권을 검증하지 못했습니다.');
  }

  // A legacy worker may have recreated fmr-api while its replacement installed. Purge and
  // verify again only after the safe controller owns fetches and the same-scope worker retired.
  await purgeLegacyRuntimeCaches(cacheStorage);
  return 'controlled';
}
