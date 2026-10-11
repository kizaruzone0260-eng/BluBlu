import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // loginAs retries a 10/min login limit with a 20 s backoff — give it room
  timeout: 150_000,
  workers: 1,
  /*
   * json-отчёт нужен CI-гейту «пропущенных тестов не бывает»: у RTC-спеков есть self-skip, когда
   * медиа-сервер недоступен, и без счётчика пропусков такой прогон выглядел бы зелёным, хотя
   * половина проверок не выполнялась. Файл — apps/e2e/e2e-results.json, в .gitignore.
   */
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:3123',
    // local dev box has no browser download → installed Edge; CI installs chromium
    channel: process.env.CI ? undefined : 'msedge',
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
