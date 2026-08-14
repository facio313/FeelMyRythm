import { expect, test } from '@playwright/test';

test('migrates a seeded legacy API cache before mounting App', async ({ page, request }) => {
  await page.goto('/feelmyrythm/pwa/legacy-setup.html');
  await expect(page.getByRole('status')).toHaveText('ready');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toContain('/feelmyrythm/pwa/legacy-sw.js');
  await expect.poll(() => page.evaluate(async () => await caches.keys())).toContain('fmr-api');

  expect((await request.post('/__pwa/block-worker')).ok()).toBe(true);
  await page.goto('/feelmyrythm/login');

  await expect(page.getByRole('status', { name: '보안 업데이트 확인 중' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '다시 연습을 시작하세요' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => await caches.keys())).not.toContain('fmr-api');

  // Simulate a final in-flight legacy handler writing after the initial purge.
  await page.evaluate(async () => {
    const cache = await caches.open('fmr-api');
    await cache.put(
      '/feelmyrythm/api/pwa-probe',
      new Response(JSON.stringify({ source: 'legacy-user-a' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  await expect.poll(() => page.evaluate(async () => await caches.keys())).toContain('fmr-api');

  expect((await request.post('/__pwa/release-worker')).ok()).toBe(true);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toContain('/feelmyrythm/sw.js?fmr-safety=v1');
  await expect(page.getByRole('heading', { name: '다시 연습을 시작하세요' })).toBeVisible();

  const probe = await page.evaluate(async () => {
    const response = await fetch('/feelmyrythm/api/pwa-probe');
    return (await response.json()) as { source: string };
  });
  expect(probe).toEqual({ source: 'network-user-b' });

  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys();
    const apiRequests: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/feelmyrythm/api/')) {
          apiRequests.push(request.url);
        }
      }
    }
    return { names, apiRequests };
  });
  expect(cacheState.names).not.toContain('fmr-api');
  expect(cacheState.apiRequests).toEqual([]);
});

test('ships split any and maskable PNG manifest icons', async ({ request }) => {
  const manifestResponse = await request.get('/feelmyrythm/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };

  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: 'icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      }),
      expect.objectContaining({
        src: 'icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      }),
      expect.objectContaining({
        src: 'icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      }),
    ]),
  );
  expect(manifest.icons.some((icon) => icon.purpose.includes('any maskable'))).toBe(false);

  for (const icon of manifest.icons) {
    const response = await request.get(`/feelmyrythm/${icon.src}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toBe('image/png');
  }
});
