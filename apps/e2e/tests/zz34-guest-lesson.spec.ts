/**
 * Гостевая ссылка на урок (задача 2026-10-28, часть 3) — глазами учителя и гостя.
 *
 * Серверный контракт (одна ссылка, хеш токена, зрительские права LiveKit, отзыв, конец урока,
 * перебор) закреплён интеграционным набором `apps/api/test/integration/guest-links.test.ts`.
 * Здесь проверяется то, что видит человек:
 *  - учитель открывает «Ещё → Поделиться уроком», выпускает ссылку и видит её адрес;
 *  - адрес не содержит идентификаторов урока/класса, а фрагмент исчезает из строки браузера;
 *  - гость без аккаунта и без входа заполняет имя, ждёт одобрения и получает доступ;
 *  - отзыв закрывает дверь ожидающему, старая ссылка больше ничего не открывает, а новая
 *    ссылка выпускается тем же окном;
 *  - завершение урока переводит гостя в «урок завершён».
 *
 * Медиа: e2e-стек не поднимает LiveKit. Как и zz17/zz-camera, проверка «гость реально видит
 * комнату» делается только когда медиасервер доступен (CI поднимает контейнер); без него
 * страница честно уходит в «связь прервалась» после одобрения — и это тоже проверяется, потому
 * что одобрение уже состоялось на сервере. Тексты не утверждаются: у учителя язык профиля,
 * у гостя — язык браузера, поэтому всё ищется по `data-testid`.
 */
import { test, expect, request as pw, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE, loginUi, makeLesson, stack, teacherToken, type Ctx } from './boardFixtures';
import { openMore } from './controlBar';

type View = { ctx: BrowserContext; page: Page };

const GUEST_NAME_1 = 'Гость Первый';
const GUEST_NAME_2 = 'Гость Второй';
const GUEST_NAME_3 = 'Гость Третий';

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test.describe.serial('гостевая ссылка на урок (2026-10-28, часть 3)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let className = '';
  let sessionId = '';
  let media = false;
  let guestUrl = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Гость E2E');
    classId = lesson.classId; className = lesson.className; sessionId = lesson.sessionId;
    const join = await api.post(`/api/lessons/${sessionId}/join`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const wsUrl = join.status() === 200 ? String((await join.json()).wsUrl as string) : '';
    media = await livekitReachable(wsUrl);
  });

  test.afterAll(async () => { await api?.dispose(); });

  async function teacherView(browser: Browser): Promise<View> {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/lesson?classId=${classId}`);
    await expect(page.getByTestId('lesson-bar')).toBeVisible({ timeout: 25_000 });
    /*
     * Войти в комнату, а не остаться на проверке устройств: `lesson-bar` есть и до входа.
     * Первый прогон этой ветки в CI (run 40849751562) упал ровно на этом: гость был одобрен
     * и подключён, но учитель стоял на «Войти в урок», дорожек в комнате не было, и пустой
     * `guest-videos` законно оставался скрытым. Тот же вход, что в zz-camera: проверка
     * устройств, «Войти в урок», своя плитка с ненулевыми размерами.
     */
    if (media) {
      await page.getByTestId('check-devices').click();
      await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 20_000 });
      await page.getByTestId('join-lesson').click();
      await expect(async () => {
        const dims = await page.evaluate(() => {
          const v = document.querySelector('.videos [data-local="1"] video') as HTMLVideoElement | null;
          return v ? [v.videoWidth, v.clientWidth, v.clientHeight] : [0, 0, 0];
        });
        expect(dims[0] > 0 && dims[1] > 0 && dims[2] > 0, 'учитель публикует свою камеру').toBeTruthy();
      }).toPass({ timeout: 30_000 });
    }
    return { ctx, page };
  }

  /** «Ещё» → «Поделиться уроком» → окно гостевой ссылки. */
  async function openGuests(view: View): Promise<void> {
    await openMore(view.page);
    await view.page.getByTestId('share-lesson').click();
    await expect(view.page.getByTestId('guests-modal')).toBeVisible({ timeout: 15_000 });
  }

  const row = (page: Page, name: string) => page.locator('[data-testid^="guest-request-"]').filter({ hasText: name });

  /** Гость без аккаунта: ссылка открывается, имя отправляется, страница ждёт решения. */
  async function guestAsks(browser: Browser, url: string, name: string): Promise<View> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(url);
    await expect(page.getByTestId('guest-form')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('guest-name').fill(name);
    await page.getByTestId('guest-request').click();
    await expect(page.getByTestId('guest-waiting')).toBeVisible({ timeout: 20_000 });
    return { ctx, page };
  }

  test('учитель выпускает ссылку, гость просит доступ и получает его', async ({ browser }) => {
    const t = await teacherView(browser);
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      await openGuests(t);
      await t.page.getByTestId('guest-link-create').click();
      await expect(t.page.getByTestId('guest-link-url')).toBeVisible({ timeout: 20_000 });
      guestUrl = (await t.page.getByTestId('guest-link-url').textContent())!.trim();

      const u = new URL(guestUrl);
      expect(u.pathname, 'ссылка ведёт на гостевую страницу').toBe('/guest');
      expect(u.search, 'в ссылке нет параметров с идентификаторами').toBe('');
      expect(u.hash.slice(1), 'токен — 32 случайных байта в base64url').toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(guestUrl, 'ссылка не выдаёт урок').not.toContain(sessionId);
      expect(guestUrl, 'ссылка не выдаёт класс').not.toContain(classId);

      // гость приходит по ссылке в чистом браузере: без входа, без user-сессии
      const g = await guest.newPage();
      await g.goto(guestUrl);
      await expect(g.getByTestId('guest-form'), 'гостя не отправляют на /login').toBeVisible({ timeout: 20_000 });
      expect(new URL(g.url()).pathname).toBe('/guest');
      expect(new URL(g.url()).hash, 'фрагмент с токеном вычищен до формы').toBe('');
      expect(await g.content(), 'токен не лежит в разметке').not.toContain(u.hash.slice(1));
      await expect(g.getByTestId('guest-class')).toHaveText(className);

      await g.getByTestId('guest-name').fill(GUEST_NAME_1);
      await g.getByTestId('guest-request').click();
      await expect(g.getByTestId('guest-waiting')).toBeVisible({ timeout: 20_000 });

      // учитель видит заявку по имени и пускает её
      const r1 = row(t.page, GUEST_NAME_1);
      await expect(r1, 'заявка гостя видна учителю').toBeVisible({ timeout: 25_000 });
      await r1.locator('[data-testid^="guest-approve-"]').click();
      await expect(r1.locator('[data-testid^="guest-approve-"]'), 'после решения кнопка «пустить» исчезает')
        .toHaveCount(0, { timeout: 20_000 });
      await expect(r1.locator('[data-testid^="guest-reject-"]'), 'гостя можно убрать').toBeVisible();

      // гость узнаёт об одобрении опросом и заходит в комнату, если медиасервер есть
      const approved = g.getByTestId('guest-approved');
      const closed = g.getByTestId('guest-closed');
      if (media) {
        await expect(approved, 'одобренный гость получает комнату').toBeVisible({ timeout: 40_000 });
        await expect(g.getByTestId('guest-videos'), 'гость видит плитки комнаты').toBeVisible({ timeout: 20_000 });
      } else {
        await expect(approved.or(closed), 'одобрение доходит до гостя и без медиасервера').toBeVisible({ timeout: 40_000 });
      }
      // страница гостя по-прежнему не имеет входа в аккаунт
      await expect(g.getByTestId('guest-form')).toHaveCount(0);
      await expect(g.getByTestId('guest-waiting')).toHaveCount(0);
    } finally {
      await guest.close();
      await t.ctx.close();
    }
  });

  test('отзыв закрывает дверь ожидающему, старая ссылка не оживает, новая — работает', async ({ browser }) => {
    const t = await teacherView(browser);
    const g2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      // второй человек по той же ссылке — отдельная заявка (свой ключ браузера)
      const p2 = await g2.newPage();
      await p2.goto(guestUrl);
      await expect(p2.getByTestId('guest-form')).toBeVisible({ timeout: 20_000 });
      await p2.getByTestId('guest-name').fill(GUEST_NAME_2);
      await p2.getByTestId('guest-request').click();
      await expect(p2.getByTestId('guest-waiting')).toBeVisible({ timeout: 20_000 });

      await openGuests(t);
      await expect(row(t.page, GUEST_NAME_2), 'учитель видит и вторую заявку').toBeVisible({ timeout: 25_000 });
      await t.page.getByTestId('guest-link-revoke').click();

      // ожидающий узнаёт, что ссылку отозвали — не «пустят позже»
      await expect(p2.getByTestId('guest-revoked'), 'отзыв закрывает ожидающего').toBeVisible({ timeout: 25_000 });

      // та же старая ссылка в новой вкладке ничего не открывает
      const replay = await g2.newPage();
      await replay.goto(guestUrl);
      await expect(replay.getByTestId('guest-revoked'), 'старая ссылка не пускает после отзыва').toBeVisible({ timeout: 20_000 });
      await expect(replay.getByTestId('guest-form')).toHaveCount(0);

      // новая ссылка выпускается тем же окном и отличается от старой
      await t.page.getByTestId('guest-link-new').click();
      await expect(t.page.getByTestId('guest-link-url')).toBeVisible({ timeout: 20_000 });
      const fresh = (await t.page.getByTestId('guest-link-url').textContent())!.trim();
      expect(fresh).not.toBe(guestUrl);
      expect(new URL(fresh).hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      await g2.close();
      await t.ctx.close();
    }
  });

  test('завершение урока закрывает гостевую дверь', async ({ browser }) => {
    const fresh = await api.post(`/api/lessons/${sessionId}/guest-link`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    });
    expect(fresh.status(), 'учитель выпускает ссылку через API').toBe(201);
    const url = String((await fresh.json()).url as string);

    const guest = await guestAsks(browser, url, GUEST_NAME_3);
    try {
      const end = await api.post(`/api/lessons/${sessionId}/end`, {
        headers: { authorization: `Bearer ${token}` }, data: {},
      });
      expect([200, 201], `конец урока: ${end.status()}`).toContain(end.status());
      await expect(guest.page.getByTestId('guest-ended'), 'гость видит «урок завершён»').toBeVisible({ timeout: 25_000 });
    } finally {
      await guest.ctx.close();
    }
  });
});
