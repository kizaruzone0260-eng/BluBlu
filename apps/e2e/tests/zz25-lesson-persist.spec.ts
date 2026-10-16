/*
 * Часть A (2026-10-16), шаг A5: «уйти в чат и вернуться — подключение одно».
 *
 * Проверяется то, чего не может доказать ни один не-RTC тест: что переход по сайту НЕ рвёт
 * комнату и не заводит второе подключение. Поэтому спек про Media Server и сам умеет
 * пропускать себя, когда медиа-сервера нет, — гейт `scripts/ci-no-skips.mjs` не даст такому
 * пропуску притвориться зелёным в CI, где LiveKit поднят сервис-контейнером.
 *
 * Почему соединение считается по сокету `/api/ws/lesson/`: урок заводит ещё сокет доски и ещё
 * соединение LiveKit, так что «сколько всего сокетов» ничего не доказывает. Считается только
 * переподключение урока, и оно должно остаться равным единице.
 *
 * Переходы делаются кликом по ссылке навигации, а НЕ через `goto`: переход адресом — это
 * перезагрузка документа, а livekit-клиент на выгрузке страницы разрывает комнату сам
 * («Page leave detected»), то есть тест разрушал бы собственное предусловие.
 */
import { test, expect, request as pw, type Page } from '@playwright/test';
import {
  BASE, makeLesson, teacherLessonPage, teacherToken, type Ctx,
} from './boardFixtures';

async function mediaServerUp(): Promise<boolean> {
  const ws = process.env.LIVEKIT_WS_URL ?? '';
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/** Сколько сокетов урока открыла ЭТА страница (Performance API знает все её соединения). */
function lessonSockets(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /\/api\/ws\/lesson\//.test(e.name)).length);
}

async function joinRoom(page: Page) {
  await page.getByTestId('check-devices').click();
  await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('join-lesson').click();
  await expect(page.getByTestId('tile-local')).toHaveCount(1, { timeout: 30_000 });
}

async function leaveByRouter(page: Page) {
  await page.locator('a[href="/chat"]').first().click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 20_000 });
}

test.describe('урок переживает переход по сайту (A1, A2, A3, A4)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    test.skip(!(await mediaServerUp()), 'нужен медиа-сервер: без комнаты проверка пуста');
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Урок без разрыва');
    classId = lesson.classId; sessionId = lesson.sessionId;
  });

  test.afterAll(async () => {
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  test('чат не рвёт комнату: соединение одно, мини-окно живёт, возврат одним нажатием', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await teacherLessonPage(browser, classId);
    try {
      await joinRoom(page);
      const one = await lessonSockets(page);
      expect(one, 'сокет урока заводится ровно один при входе').toBe(1);

      await leaveByRouter(page);
      await expect(page.getByTestId('lesson-mini'), 'мини-окно появилось на странице чата')
        .toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('mini-timer'), 'таймер идёт, а не стоит на нуле')
        .not.toHaveText('');
      await expect(page.getByTestId('mini-back')).toBeVisible();
      await expect(page.getByTestId('mini-mic')).toBeVisible();
      await expect(page.getByTestId('mini-cam')).toBeVisible();
      expect(await lessonSockets(page), 'переход не переподключил урок').toBe(one);

      await page.getByTestId('mini-back').click();
      await expect(page.getByTestId('lesson-shell')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('tile-local'), 'локальная плитка всё ещё одна').toHaveCount(1);
      expect(await lessonSockets(page), 'возврат не переподключил урок').toBe(one);

      // урок живой: кнопка микрофона управляется и state доехал до aria-pressed
      const mic = page.getByTestId('mic-toggle');
      const was = await mic.getAttribute('aria-pressed');
      await mic.click();
      await expect(mic).not.toHaveAttribute('aria-pressed', was ?? '', { timeout: 20_000 });
    } finally { await page.context().close(); }
  });

  test('мини-окно не появляется там, где урока нет', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await teacherLessonPage(browser, classId);
    try {
      // в комнату не входили: показывать полоску «идёт урок» на чужих экранах не за чем
      await leaveByRouter(page);
      await expect(page.getByTestId('lesson-mini'), 'без подключения мини-окна нет')
        .toHaveCount(0, { timeout: 10_000 });
    } finally { await page.context().close(); }
  });
});

/*
 * Перезагрузка посреди урока — отдельный describe, потому что после `reload` комната рвётся
 * сама (это известное поведение SDK), и проверяется здесь не комната, а метка возврата:
 * свежая → вход одним нажатием, просроченная → обычная карточка с проверкой устройств.
 */
test.describe('возврат после перезагрузки страницы (A3)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';

  test.beforeAll(async () => {
    test.skip(!(await mediaServerUp()), 'нужен медиа-сервер: вход в комнату без него невозможен');
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Перезагрузка посреди урока');
    classId = lesson.classId; sessionId = lesson.sessionId;
  });

  test.afterAll(async () => {
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  test('свежая метка: «Вернуться в урок» входит одним нажатием', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await teacherLessonPage(browser, classId);
    try {
      await joinRoom(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('device-check')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('rejoin-box'), 'метка жива → крупная кнопка возврата')
        .toBeVisible({ timeout: 30_000 });
      await page.getByTestId('rejoin-lesson').click();
      await expect(page.getByTestId('tile-local'), 'вход без повторной проверки устройств')
        .toHaveCount(1, { timeout: 40_000 });
    } finally { await page.context().close(); }
  });

  test('истёкшая метка: обычный вход с проверкой устройств', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await teacherLessonPage(browser, classId);
    try {
      await joinRoom(page);
      // та же метка, но время сдвинуто за предел срока: человек вернулся через полчаса
      await page.evaluate(() => {
        const raw = sessionStorage.getItem('blublu.rejoin');
        if (!raw) throw new Error('метка возврата не записана после входа в комнату');
        const mark = JSON.parse(raw) as { at: number };
        mark.at = Date.now() - 5 * 60_000;
        sessionStorage.setItem('blublu.rejoin', JSON.stringify(mark));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('device-check')).toBeVisible({ timeout: 40_000 });
      await expect(page.getByTestId('rejoin-box'), 'просроченная метка ничего не предлагает')
        .toHaveCount(0);
      await expect(page.getByTestId('check-devices'), 'обычный вход никуда не делся')
        .toBeVisible();
    } finally { await page.context().close(); }
  });
});
