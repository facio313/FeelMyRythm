const serviceWorker = /** @type {ServiceWorkerGlobalScope} */ (globalThis);

serviceWorker.addEventListener('install', (event) => {
  event.waitUntil(serviceWorker.skipWaiting());
});
serviceWorker.addEventListener('activate', (event) =>
  event.waitUntil(serviceWorker.clients.claim()),
);

serviceWorker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/feelmyrythm/api/')) return;

  event.respondWith(
    (async () => {
      const cache = await serviceWorker.caches.open('fmr-api');
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await serviceWorker.fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});
