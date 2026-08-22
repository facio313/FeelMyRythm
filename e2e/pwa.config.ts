import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: '.',
  testMatch: 'pwa-upgrade.pwa.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    baseURL,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    cwd: '..',
    command:
      'PORTFOLIO_BRANCH=e2e-pwa PORTFOLIO_AUTH_MODE=local corepack pnpm --filter @feelmyrythm/core --filter @feelmyrythm/audio build && PORTFOLIO_BRANCH=e2e-pwa PORTFOLIO_AUTH_MODE=local corepack pnpm --filter @feelmyrythm/web build && node e2e/pwa/server.mjs',
    url: `${baseURL}/__pwa/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
