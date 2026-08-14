import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const MOBILE_SERVER_ORIGIN = 'https://bonifacio.work';

export default defineConfig(({ mode }) => {
  const mobile = mode === 'mobile';

  return {
    base: mobile ? './' : '/feelmyrythm/',
    ...(mobile ? { build: { outDir: '../mobile/web', emptyOutDir: true } } : {}),
    define: {
      __FMR_MOBILE_SERVER_ORIGIN__: JSON.stringify(MOBILE_SERVER_ORIGIN),
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(mobile
        ? [
            {
              name: 'feelmyrythm-mobile-index-paths',
              transformIndexHtml: (html: string) =>
                html.replace(/(src|href)="\/feelmyrythm\//g, '$1="./'),
            },
          ]
        : []),
      VitePWA({
        disable: mobile,
        filename: 'sw.js',
        injectRegister: false,
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'icon-192.png',
          'icon-512.png',
          'icon-maskable-512.png',
          'apple-touch-icon.png',
        ],
        manifest: {
          id: '/feelmyrythm/',
          name: 'FeelMyRythm',
          short_name: 'FeelMyRythm',
          lang: 'ko-KR',
          description: '앙상블 동기화 메트로놈과 연습 관리',
          categories: ['music', 'productivity', 'utilities'],
          theme_color: '#0C0D10',
          background_color: '#0C0D10',
          display: 'standalone',
          start_url: '/feelmyrythm/',
          scope: '/feelmyrythm/',
          icons: [
            {
              src: 'icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // Registration is security-gated in main.tsx. Since injectRegister is false,
          // vite-plugin-pwa does not infer these auto-update flags for us.
          skipWaiting: true,
          clientsClaim: true,
          navigateFallback: '/feelmyrythm/index.html',
          navigateFallbackDenylist: [/^\/feelmyrythm\/api(?:\/|$)/],
          globIgnores: ['**/pdf.worker.min-*.mjs', '**/pdf-*.js', '**/opensheetmusicdisplay*.js'],
          runtimeCaching: [
            {
              urlPattern: ({ url }) =>
                /\/(?:pdf(?:\.worker\.min)?|opensheetmusicdisplay)[^/]*\.(?:js|mjs)$/.test(
                  url.pathname,
                ),
              handler: 'CacheFirst',
              options: {
                cacheName: 'fmr-score-renderers',
                expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: ({ request, url }) =>
                url.origin === self.location.origin &&
                !/^\/feelmyrythm\/api(?:\/|$)/.test(url.pathname) &&
                (request.destination === 'image' || request.destination === 'font'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'fmr-public-assets-v3',
                expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        '/feelmyrythm/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/feelmyrythm/, ''),
        },
        '/feelmyrythm/ws': {
          target: 'ws://127.0.0.1:8000',
          ws: true,
          rewrite: (path) => path.replace(/^\/feelmyrythm/, ''),
        },
      },
    },
  };
});
