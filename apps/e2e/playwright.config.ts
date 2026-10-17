import { defineConfig, devices } from '@playwright/test';

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
    /*
     * 2026-10-17 (прогон 38997323161): у действия таймаута не было вовсе, оно ограничено только
     * таймаутом теста. Красный клик ждал 150–420 с и повторял попытку каждые 500 мс — восемь
     * таких кликов съели 40-минутный лимит джобы, и Playwright не успел напечатать отчёт: без
     * сообщений и трасс разбирать было нечего. Ожидание клика — секунды; минуты waits — это
     * `expect(...)` со своим таймаутом или `test.setTimeout`.
     */
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // local dev box has no browser download → installed Edge; CI installs chromium
    channel: process.env.CI ? undefined : 'msedge',
    permissions: ['camera', 'microphone'],
    video: 'off',
    /*
     * Упавший RTC-тест иначе нечем объяснить: тайминги распространения прав в комнате нельзя
     * восстановить по строке «Expected true / Received false». Трасса и скриншот держатся только
     * на падении (retention в CI — 7 дней), поэтому набор не дорожает в зелёных прогонах.
     * Снимки DOM и источники — с 2026-10-15: красный zz10 разбирался по трассе, но в ней не было
     * ни одного снимка страницы, и промежуточное состояние редактора (какой именно символ куда
     * вставился) восстановить было нечем. Теперь снимается DOM, а не только картинка.
     */
    trace: { mode: 'retain-on-failure', snapshots: true, screenshots: true, sources: true },
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  /*
   * B2 (2026-10-16): два проекта. `desktop` — весь прежний набор, ровно как он бегал до появления
   * `projects` (implicit-проект наследовал `use`, здесь он назван явно и больше ничего не меняет).
   * `pixel7` — только файлы `m-*.spec.ts`, на реальном мобильном дескрипторе Playwright:
   * 393×851, DPR 2.75, тач и `isMobile`+`hasTouch` (с ними браузер ведёт себя как на телефоне:
   * viewport meta, hover не «вечно», пальцы вместо курсора). Chromium обязателен — на этой машине
   * браузер не скачивается, поэтому мобильный проект исполняется в CI (там `playwright install
   * --with-deps chromium`), а локально не запускается вовсе: так же, как и остальные браузерные
   * проверки.
   */
  projects: [
    {
      name: 'desktop',
      testIgnore: /m-.*\.spec\.ts/,
    },
    {
      name: 'pixel7',
      testMatch: /m-.*\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        channel: undefined,          // устройства Playwright — это chromium, Edge тут не вариант
        permissions: ['camera', 'microphone'],
      },
    },
  ],
  webServer: {
    command: 'node scripts/e2e-stack.mjs',
    url: 'http://127.0.0.1:3123/api/health/live',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
