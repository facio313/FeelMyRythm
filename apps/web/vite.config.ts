import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
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
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
});
