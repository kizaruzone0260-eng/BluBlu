/**
 * Часть 3 (2026-10-14): ученик рисует на доске, если учитель разрешил — глазами двух участников.
 *
 * Серверная половина (право на каждом сообщении, авторство, лимиты, отзыв, «purge») доказана
 * `apps/api/test/integration/board-students.test.ts`, а арифметика авторства —
 * `apps/api/test/unit/board-gate.test.ts`. Этот спек отвечает на то, что сервером не проверяется:
 * видно ли разрешение ученику (значок), остаётся ли доска для просмотра у неразрешённого, доезжает
 * ли чужой штрих до экрана учителя вживую, и что делает с холстом отзыв и «удалить рисунки ученика».
 *
 * Как и в zz19: без доступного медиа-сервера спек пропускает себя сам, а гейт
 * `scripts/ci-no-skips.mjs` не даст такому пропуску притвориться зелёным.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import postgres from 'postgres';
import {
  BASE, inkOf, loginUi, makeLesson, openLesson, paintStable, registerStudent, stack, teacherToken,
  waitBoard, type Ctx,
} from './boardFixtures';
import { openTab } from './controlBar';

const STUDENT_PW = 'Secret1234';
const DB = `postgres://klass:klass@127.0.0.1:5455/klass`;

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/** identity участника LiveKit = uuid пользователя, поэтому ряд панели ищется по id из базы. */
async function idsByEmail(...emails: string[]): Promise<Record<string, string>> {
  const sql = postgres(DB, { max: 1 });
  try {
    const rows = await sql`select id, email from users where email = any(${emails})`;
    return Object.fromEntries(rows.map((r) => [String(r.email), String(r.id)]));
  } finally { await sql.end({ timeout: 5 }); }
}

test.describe('students drawing on the board (part 3)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let aEmail = '';
  let bEmail = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Доска для учеников');
    classId = lesson.classId; sessionId = lesson.sessionId;
    const stamp = Date.now();
    // только строчные буквы: сервер нормализует почту в lower case, а поиск id идёт по
    // точному значению — с заглавной «А» ученик не находился (бордка makeTeacher об этом же)
    aEmail = `bda${stamp}@x.io`; bEmail = `bdb${stamp}@x.io`;
    // код приглашения одноразовый: на каждого ученика — свой
    const codes = [lesson.inviteCode];
    const extra = await api.post(`/api/classes/${classId}/invites`,
      { headers: { authorization: `Bearer ${token}` }, data: {} });
    expect(extra.status(), 'учитель обязан уметь выпускать новый одноразовый код').toBe(201);
    codes.push(String((await extra.json()).code as string));
    for (const [[email, name], code] of [[[aEmail, 'Анна'], codes[0]], [[bEmail, 'Борис'], codes[1]]] as const) {
      const p = await (await browser.newContext()).newPage();
      await registerStudent(p, code, name, email);
      await p.context().close();
    }
  });

  test.afterAll(async () => {
    try { await api?.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` } }); } catch { /* уже закрыт */ }
    await api?.dispose();
  });

  /** Вход в комнату по-настоящему: фейковые устройства, «Проверить устройства», «Войти». */
  async function join(browser: Browser, email: string, password: string) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    const joined = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(joined.status(), 'урок этого класса обязан открываться для его участников').toBe(200);
    const wsUrl = String((await joined.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)),
      `LiveKit at ${wsUrl} недоступен: доска с двумя участниками проверяется только в живой комнате`);
    await page.getByTestId('check-devices').click();
    await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('join-lesson').click();
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('device-check')).toHaveCount(0, { timeout: 60_000 });
    return { ctx, page };
  }

  const badge = (page: Page) => page.getByTestId('board-draw-badge');
  const viewOnly = (page: Page) => page.getByTestId('board-readonly');
  /** переключатель «Рисовать» в строке участника: id = uuid пользователя = identity в комнате */
  const drawBtn = (page: Page, identity: string) => page.getByTestId(`peer-draw-${identity.slice(0, 8)}`);

  test('the grant is visible to the student, and only their own ink is the teacher’s to delete', async ({ browser }) => {
    test.setTimeout(300_000);
    const ids = await idsByEmail(aEmail, bEmail);
    const aId = ids[aEmail]; const bId = ids[bEmail];
    expect(aId && bId, 'оба ученика зарегистрированы').toBeTruthy();

    const t = await join(browser, stack.teacherEmail, stack.teacherPassword);
    const a = await join(browser, aEmail, STUDENT_PW);
    const b = await join(browser, bEmail, STUDENT_PW);
    /*
     * Никакого `openLesson` после входа в комнату: это `page.goto`, то есть выгрузка страницы, а
     * LiveKit SDK на выгрузке отключается сам («Page leave detected, disconnecting» в консоли
     * трассы прогона 38541787520 — все трое отвалились за секунды до проверки). В панели остаются
     * «Участники · 0», потому что список участников читается из комнаты (`refreshPeerList` по
     * `room.remoteParticipants`) — продукт прав, спека сама уничтожала своё условие.
     */
    await waitBoard(t.page);
    await waitBoard(a.page);
    await waitBoard(b.page);

    // 1. по умолчанию не рисует никто: и значка нет, и полотно в режиме просмотра
    await expect(badge(a.page)).toHaveCount(0);
    await expect(viewOnly(a.page)).toBeVisible();
    await expect(viewOnly(b.page)).toBeVisible();

    // 2. учитель даёт разрешение Анне — доходит до её экрана без перезагрузки
    await openTab(t.page, 'people');
    // сначала комната: два ряда участников, и только потом чей именно это ряд
    await expect(t.page.locator('.peer-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(drawBtn(t.page, aId)).toBeVisible({ timeout: 30_000 });
    await expect(drawBtn(t.page, aId)).toHaveAttribute('aria-pressed', 'false');
    await drawBtn(t.page, aId).click();
    await expect(badge(a.page), 'значок «вы можете рисовать» появился').toBeVisible({ timeout: 15_000 });
    await expect(badge(b.page), 'Борис не разрешён').toHaveCount(0, { timeout: 5_000 });
    await expect(viewOnly(b.page)).toBeVisible();

    // 3. Анна рисует — штрих виден и у неё, и у учителя
    const before = await inkOf(t.page, 'A');
    await paintStable(a.page, 'A');
    // сначала у неё самой: не лёг штрих — это геометрия рисования, а не распространение по WS
    await expect.poll(async () => inkOf(a.page, 'A'),
      { timeout: 15_000, message: 'штрих Анны виден у неё на полотне' }).toBeGreaterThan(before);
    await expect.poll(async () => inkOf(t.page, 'A'), { timeout: 30_000, message: 'штрих ученика доехал до учителя' })
      .toBeGreaterThan(before);
    const inkAfterA = await inkOf(t.page, 'A');

    // 4. отзыв действует сразу: значок снялся, и новый штрих никуда не едет
    await drawBtn(t.page, aId).click();
    await expect(badge(a.page), 'значок снялся вместе с разрешением').toHaveCount(0, { timeout: 15_000 });
    await expect(viewOnly(a.page), 'полотно снова только для просмотра').toBeVisible({ timeout: 15_000 });
    const bBefore = await inkOf(t.page, 'B');
    await paintStable(a.page, 'B');
    await expect.poll(async () => inkOf(t.page, 'B'), { timeout: 6_000 }).toBe(bBefore);

    // 5. «удалить рисунки ученика» снимает только Аннино: у Б на доске ничего не было
    await t.page.getByTestId('board-purge-btn').click();
    const pop = t.page.getByTestId('board-purge-pop');
    await expect(pop).toBeVisible();
    const item = pop.getByTestId(`board-purge-${aId.slice(0, 8)}`);
    await expect(item, 'в списке тот, кто рисовал').toBeVisible();
    await item.click();
    await expect.poll(async () => inkOf(t.page, 'A'), { timeout: 20_000, message: 'Аннины штрихи снялись у учителя' })
      .toBeLessThan(inkAfterA);
    await expect.poll(async () => inkOf(a.page, 'A'), { timeout: 20_000, message: 'и у Анны тоже' })
      .toBeLessThan(inkAfterA);

    for (const v of [t, a, b]) await v.ctx.close();
  });

  test('«разрешить всем» covers a student who joins afterwards', async ({ browser }) => {
    test.setTimeout(240_000);
    const ids = await idsByEmail(bEmail);
    const t = await join(browser, stack.teacherEmail, stack.teacherPassword);
    await openLesson(t.page, classId);

    await openTab(t.page, 'people');
    const all = t.page.getByTestId('panel-draw-all');
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    const c = await join(browser, bEmail, STUDENT_PW);
    await openLesson(c.page, classId);
    await expect(badge(c.page), 'пришедший после «всем» рисует').toBeVisible({ timeout: 15_000 });

    await openTab(t.page, 'people');
    await t.page.getByTestId('panel-draw-all').click();
    await expect(badge(c.page), 'а после выключения «всем» — нет').toHaveCount(0, { timeout: 15_000 });
    expect(ids[bEmail], 'Борис существует (сверка identity в первом спеке)').toBeTruthy();

    for (const v of [t, c]) await v.ctx.close();
  });
});
