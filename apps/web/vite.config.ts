import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const appBase = '/feelmyrythm/';

export default defineConfig({
  base: appBase,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@feelmyrythm/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@feelmyrythm/audio': path.resolve(__dirname, '../../packages/audio/src/index.ts'),
      '@feelmyrythm/protocol': path.resolve(__dirname, '../../packages/protocol/src/index.ts'),
      '@feelmyrythm/ui': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
  server: {
    proxy: {
      [`${appBase}api`]: {
        target: 'http://localhost:8000',
        rewrite: (requestPath) => requestPath.replace(/^\/feelmyrythm/, ''),
      },
      [`${appBase}ws`]: {
        target: 'ws://localhost:8000',
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/feelmyrythm/, ''),
      },
    },
  },
});
