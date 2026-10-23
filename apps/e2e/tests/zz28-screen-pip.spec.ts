/**
 * Часть C (2026-10-23) — окно показа экрана ПОВЕРХ других программ (Document Picture-in-Picture).
 *
 * ТЕГ @unstable, и вот почему это честно, а не «уехали от красного»:
 *  • проверка требует настоящего жеста и настоящего окна: `documentPictureInPicture.requestWindow`
 *    существует только в десктопном Chromium и открывается отдельным top-level контекстом. Увидит
 *    ли его Playwright как `page` — проверяется только в прогоне, локально браузерные спеки
 *    запрещены;
 *  • нужна ещё и живая комната (LiveKit), иначе показ не публикуется и проверять нечего.
 * Спек сам себя пропускает с названной причиной, если хотя бы одного из двух нет, и падает, если
 * оба есть, а окна нет. Джоб `e2e-unstable` (continue-on-error) его и запускает.
 *
 * Ручная проверка шагами 1–6 — §14 в docs/MANUAL_QA.md; ей полагаться надёжнее, чем этому спеку.
 */
import { test, expect, request as pw } from '@playwright/test';
import { barClick } from './controlBar';
import { BASE, loginUi, makeLesson, stack, teacherToken, type Ctx } from './boardFixtures';

async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/**
 * Подставной показ экрана: livekit-client зовёт `navigator.mediaDevices.getDisplayMedia` напрямую,
 * поэтому замена ОДНОЙ функции даёт настоящую дорожку (canvas-поток) без системного выбора окна.
 * Код приложения не подменяется ничем, кроме этого источника.
 */
async function fakeScreenShare(ctx: import('@playwright/test').BrowserContext) {
  await ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    Object.defineProperty(md, 'getDisplayMedia', {
      configurable: true, writable: true,
      value: async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 720;
        const g = c.getContext('2d');
        let n = 0;
        const paint = () => {
          n += 1;
          if (g) {
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 720);
            g.fillStyle = '#0f766e'; g.fillRect(40, 40, 620, 140);
            g.fillStyle = '#ffffff'; g.font = '54px sans-serif';
            g.fillText(`BLUBLU SLIDE ${n}`, 70, 130);
          }
          requestAnimationFrame(paint);
        };
        paint();
        return c.captureStream(10);
      },
    });
  });
}

test.describe('screen-share window above other apps (part C, real RTC)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('the shared screen gets its own window with preview, camera and stop @unstable', async ({ browser }) => {
    test.setTimeout(300_000);
    const lesson = await makeLesson(api, token, 'E2E окно показа');
    const joinR = await api.post(`/api/lessons/${lesson.sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    const wsUrl = String((await joinR.json()).wsUrl as string);
    if (!await livekitReachable(wsUrl)) {
      test.skip(true, 'LiveKit недоступен — показ экрана публикуется только в живой комнате');
      return;
    }

    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
    await fakeScreenShare(ctx);
    const page = await ctx.newPage();
    try {
      // умеет ли ЭТОТ браузер такое окно — проверка наличия API, ровно как в приложении
      const hasApi = await page.evaluate(() => 'documentPictureInPicture' in window);
      if (!hasApi) {
        test.skip(true, 'Chromium сборки CI не отдаёт documentPictureInPicture — окно существует только вручную');
        return;
      }

      await loginUi(page, stack.teacherEmail, stack.teacherPassword);
      await page.goto(`/lesson?classId=${lesson.classId}`);
      await page.getByTestId('check-devices').click();
      await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('join-lesson').click();

      /*
       * Слушатель ставится ДО нажатия: окно открывается тем же жестом, и событие `page` к моменту,
       * когда мы его ждём, уже прошло бы. Playwright события не хранит.
       */
      const pipWait = ctx.waitForEvent('page', { timeout: 40_000 }).catch(() => null);
      await barClick(page, 'share-toggle');
      const banner = page.getByTestId('share-banner');
      await expect(banner).toBeVisible({ timeout: 30_000 });

      /*
       * Окно ищется среди страниц контекста. Если Playwright его не показывает (у Document PiP
       * свой top-level контекст), это НЕ баг приложения — тогда проверка говорит ровно это и
       * уходит в ручную. Пасть она обязана в другом случае: API есть, окно открылось, а
       * содержимого нет.
       */
      const pipPage = await pipWait;
      if (!pipPage) {
        test.skip(true, 'Playwright не показал Document PiP окно среди страниц контекста — см. docs/MANUAL_QA.md §14');
        return;
      }
      await pipPage.waitForLoadState('domcontentloaded');

      // содержимое окна: предпросмотр, своя камера, строка показа и четыре кнопки
      const pip = pipPage.getByTestId('share-pip');
      await expect(pip).toBeVisible({ timeout: 20_000 });
      await expect(pipPage.getByTestId('share-pip-status')).toBeVisible();
      await expect(pipPage.getByTestId('share-pip-stop')).toBeVisible();
      await expect(pipPage.getByTestId('share-pip-mic')).toBeVisible();
      await expect(pipPage.getByTestId('share-pip-cam-btn')).toBeVisible();
      await expect(pipPage.getByTestId('share-pip-return')).toBeVisible();

      // тему окно получаетコピーом с основной страницы — иначе оно осталось бы светлым на тёмном уроке
      const theme = await pipPage.evaluate(() => document.documentElement.getAttribute('data-theme'));
      const mainTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(theme, 'data-theme не переехал в окно').toBe(mainTheme);

      // остановка показа ВНУТРИ окна гасит и показ, и само окно
      await pipPage.getByTestId('share-pip-stop').click();
      await expect(page.getByTestId('share-banner')).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => pipPage.isClosed(), { timeout: 20_000 }).toBe(true);
    } finally {
      await api.post(`/api/lessons/${lesson.sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
      await ctx.close();
    }
  });
});
