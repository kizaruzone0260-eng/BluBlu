import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/rtc': { target: 'ws://localhost:7880', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // no inline module-preload polyfill script — keeps index.html CSP-clean
    modulePreload: { polyfill: false },
  },
});
