import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3123',
    // no browser download available in this env — use installed Edge
    channel: 'msedge',
    permissions: ['camera', 'microphone'],
    video: 'off',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: {
    command: 'node scripts/e2e-stack.mjs',
    url: 'http://127.0.0.1:3123/api/health/live',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
