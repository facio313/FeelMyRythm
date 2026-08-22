import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  define: {
    __FMR_PORTFOLIO_AUTH_MODE__: JSON.stringify('local'),
    __FMR_MANAGED_LOCAL_SSO__: JSON.stringify(false),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
