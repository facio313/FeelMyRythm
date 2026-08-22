import { defineConfig, devices } from '@playwright/test';

const localBaseUrl = 'http://127.0.0.1:4173/feelmyrythm/';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? localBaseUrl;
const usesExternalServer = process.env.PLAYWRIGHT_BASE_URL !== undefined;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'e2e/test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/playwright-report' }]],
  use: {
    baseURL,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.CI ? {} : { channel: 'chrome' }),
      },
    },
  ],
  ...(usesExternalServer
    ? {}
    : {
        webServer: {
          command:
            'PORTFOLIO_BRANCH=e2e PORTFOLIO_AUTH_MODE=local corepack pnpm build:workspace-libs && PORTFOLIO_BRANCH=e2e PORTFOLIO_AUTH_MODE=local corepack pnpm --filter @feelmyrythm/web build:e2e && corepack pnpm --filter @feelmyrythm/web preview --host 127.0.0.1 --port 4173 --strictPort',
          url: localBaseUrl,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'pipe' as const,
          stderr: 'pipe' as const,
        },
      }),
});
