import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'audio',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
