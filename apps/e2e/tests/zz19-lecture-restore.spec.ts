/**
 * Часть 1 (2026-10-13) — «после режима лекции».
 *
 * Матрица прав и «502 без записи состояния» живут на сервере
 * (`apps/api/test/integration/lecture-restore.test.ts`), арифметика разрешения — в
 * `apps/api/test/unit/floor-permission.test.ts`. Браузером проверяется ровно то, без чего нельзя:
 * что устройство, горевшее в МОМЕНТ включения лекции, включается само после выключения; что
 * выключивший себя во время лекции получает его обратно (это и есть симптом), а выключивший себя
 * ДО — нет; что пришедшему во время лекции не включается ничего; и что кнопка «Выключить» в тосте
 * работает.
 *
 * Почему именно так: LiveKit не останавливает уже опубликованный трек при `canPublish: false`
 * (замерено в zz17: «a lecture-mode student cannot publish» — про вход, а не про тех, кто уже
 * публикуется). Значит «не включается сам» видно не на том, кто молчал до лекции, а на том, кто
 * замолчал во время неё.
 *
 * Как и в zz17: стороны одного урока говорят на разных языках (задача 1 работает как задумано),
 * поэтому подписи сопоставляются со всеми тремя наборами; без доступного медиа-сервера спек
 * self-skip, а `scripts/ci-no-skips.mjs` не даст такому пропуску притвориться зелёным.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginUi, makeLesson, registerStudent, stack, teacherToken, type Ctx } from './boardFixtures';

const BASE = `http://127.0.0.1:${stack.port}`;
const STUDENT_PW = 'Secret1234';
type Lesson = { lesson: Record<string, string> };
const BUNDLES = (['ru', 'uz', 'en'] as const).map((lng) => JSON.parse(
  readFileSync(new URL(`../../../packages/shared/src/locales/${lng}.json`, import.meta.url), 'utf8'),
) as Lesson);
/** подпись так, как её напишет любой из трёх языков (учитель ru, ученик без выбора — en) */
function anyLoc(...keys: string[]): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = keys.flatMap((k) => BUNDLES.map((b) => b.lesson[k] ?? ''));
  return new RegExp(forms.filter(Boolean).map(esc).join('|'));
}

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test.describe('after lecture mode: devices come back (part 1)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let aEmail = '';
  let bEmail = '';
  let cEmail = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Лекция');
    classId = lesson.classId; sessionId = lesson.sessionId;
    const stamp = Date.now();
    aEmail = `lrA${stamp}@x.io`; bEmail = `lrB${stamp}@x.io`; cEmail = `lrC${stamp}@x.io`;
    /*
     * Код приглашения одноразовый (задача 9: он списывается на шаге имени), поэтому на каждого
     * ученика — свой. Первая версия файла регистрировала троих по одному коду и падала на втором:
     * шаг 1 честно отвечал `invalidCode`, а форма не переходила дальше.
     */
    const codes = [lesson.inviteCode];
    for (let i = 0; i < 2; i++) {
      const r = await api.post(`/api/classes/${classId}/invites`, { headers: { authorization: `Bearer ${token}` }, data: {} });
      expect(r.status(), 'учитель обязан уметь выпускать новый одноразовый код').toBe(201);
      codes.push(String((await r.json()).code as string));
    }
    for (const [[email, name], code] of [[[aEmail, 'Анна'], codes[0]], [[bEmail, 'Борис'], codes[1]], [[cEmail, 'Вера'], codes[2]]] as const) {
      const p = await (await browser.newContext()).newPage();
      await registerStudent(p, code, name, email);
      await p.context().close();
    }
  });

  test.afterAll(async () => { await api?.dispose(); });

  /**
   * Вход в комнату по-настоящему: фейковые устройства, «Проверить устройства», «Войти».
   * Один и тот же путь и для учителя, и для ученика — различие только в пароле.
   */
  async function joinRoom(browser: Browser, email: string, password: string) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    const join = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(join.status(), 'урок этого класса обязан открываться для его участников').toBe(200);
    const wsUrl = String((await join.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)),
      `LiveKit at ${wsUrl} недоступен: возврат устройств проверяется только в живой комнате`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    // гонка входа: экран проверки устройств обязан исчезнуть, иначе клики ниже уйдут не туда
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    return { ctx, page };
  }

  const teacher = (browser: Browser) => joinRoom(browser, stack.teacherEmail, stack.teacherPassword);
  const student = (browser: Browser, email: string) => joinRoom(browser, email, STUDENT_PW);

  const micOn = (page: Page) => page.getByTestId('mic-toggle').getAttribute('aria-pressed');
  const camOn = (page: Page) => page.getByTestId('cam-toggle').getAttribute('aria-pressed');
  /** свой тайл с кадром: трек опубликован, а не «кнопка нажата» */
  const selfPublishesVideo = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0));

  /** переключатель возврата — по умолчанию включён; выключить его можно только здесь */
  async function lectureOn(page: Page, restore: boolean) {
    await page.getByTestId('lecture-mode').click();
    const dialog = page.getByTestId('lecture-confirm');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const box = page.getByTestId('lecture-restore');
    expect(await box.isChecked(), 'переключатель возврата по умолчанию включён').toBe(true);
    if (!restore) await box.uncheck();
    await page.getByTestId('lecture-confirm-ok').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('lecture-mode')).toHaveAttribute('aria-checked', 'true');
  }
  async function lectureOff(page: Page) {
    await page.getByTestId('lecture-mode').click();
    await expect(page.getByTestId('lecture-mode')).toHaveAttribute('aria-checked', 'false');
  }

  test('what burned at the moment of the lecture is what comes back', async ({ browser }) => {
    const t = await teacher(browser);
    const a = await student(browser, aEmail);   // микрофон и камера горят
    const b = await student(browser, bEmail);   // выключит себя САМ до лекции

    await expect.poll(() => micOn(a.page), { timeout: 30_000 }).toBe('true');
    await expect.poll(() => camOn(a.page), { timeout: 30_000 }).toBe('true');
    expect(await selfPublishesVideo(a.page)).toBe(true);
    await b.page.getByTestId('mic-toggle').click();
    await expect(micOn(b.page)).toBe('false');

    await lectureOn(t.page, true);
    // Вера приходит уже во время лекции: ей возвращать нечего
    const c = await student(browser, cEmail);
    await expect(micOn(c.page)).toBe('false');
    // Анна замолкает уже при лекции — это и есть тот случай, который не возвращался
    await a.page.getByTestId('mic-toggle').click();
    await expect(micOn(a.page)).toBe('false');

    await lectureOff(t.page);

    await expect.poll(() => micOn(a.page), { timeout: 30_000 }).toBe('true',
      'микрофон, горевший в момент включения лекции, обязан включиться сам');
    await expect.poll(() => camOn(a.page), { timeout: 30_000 }).toBe('true');
    expect(await selfPublishesVideo(a.page), 'камера вернулась по-настоящему, с кадром').toBe(true);
    await expect(micOn(b.page)).toBe('false', 'выключивший себя ДО лекции остаётся выключенным');
    await expect(micOn(c.page)).toBe('false', 'пришедшему во время лекции ничего не включается');

    const toast = a.page.getByTestId('lesson-toast');
    await expect(toast).toBeVisible();
    expect(await toast.innerText()).toMatch(anyLoc('lectureRestoredMic', 'lectureRestoredBoth'));
    await a.page.getByTestId('lesson-toast-action').click();
    await expect(micOn(a.page)).toBe('false', { timeout: 20_000 });

    for (const v of [t, a, b, c]) await v.ctx.close();
  });

  test('with the switch off nothing is turned on, and the choice survives a reload', async ({ browser }) => {
    const t = await teacher(browser);
    const a = await student(browser, aEmail);
    await expect.poll(() => micOn(a.page), { timeout: 30_000 }).toBe('true');

    await lectureOn(t.page, false);
    await a.page.getByTestId('mic-toggle').click();
    await expect(micOn(a.page)).toBe('false');

    // решение учителя лежит на сессии: его видит и тот, кто перезагрузил страницу посреди лекции
    await a.page.reload();
    await expect(a.page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    const st = await api.get(`/api/lessons/active?classId=${classId}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await st.json()).session.lectureRestore, 'lectureRestore переживает перезагрузку').toBe(false);

    await lectureOff(t.page);
    await expect(micOn(a.page)).toBe('false', { timeout: 20_000 });
    await expect(a.page.getByTestId('lesson-toast')).toHaveCount(0);
    await expect(a.page.getByTestId('lesson-toast-action')).toHaveCount(0);

    for (const v of [t, a]) await v.ctx.close();
  });

  test('the confirmation dialog is labelled, tappable and clean under axe', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginUi(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/lesson?classId=${classId}`);
    const open = page.getByTestId('lecture-mode');
    test.skip(await open.count() === 0, 'панель управления появляется только в комнате');
    await open.click();
    const dialog = page.getByTestId('lecture-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toBeVisible();
    expect((await page.getByTestId('lecture-restore-row').boundingBox())?.height ?? 0,
      'строка переключателя — не меньше 44 px').toBeGreaterThanOrEqual(44);
    const { AxeBuilder } = await import('@axe-core/playwright');
    const res = await new AxeBuilder({ page }).include('.modal').analyze();
    expect(res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    await page.getByTestId('lecture-confirm-cancel').click();
    await expect(dialog).toHaveCount(0);
    await ctx.close();
  });
});
