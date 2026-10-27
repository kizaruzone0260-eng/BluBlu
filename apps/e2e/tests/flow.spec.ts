import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// .stack.json is written by the webServer a beat after the health check passes —
// on a fresh CI checkout it does not exist at import time. Read it lazily.
function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as {
        port: number; teacherEmail: string; teacherPassword: string;
      };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error('.stack.json never appeared');
}
const stack = readStack();
const BASE = `http://127.0.0.1:${stack.port}`;

// The full suite runs 21 specs through one IP, so a login can hit the shared
// 300/min rate limiter and return 429 → an undefined token → a later GET yields
// an error object and `.find` crashes. Back off and retry like the UI login does.
async function apiLogin(api: any): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const r = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    if (r.status() === 200) {
      const tok = (await r.json()).accessToken as string;
      if (tok) return tok;
    }
    await new Promise((res) => setTimeout(res, 12_000));
  }
  throw new Error('teacher api login failed after retries (rate limit?)');
}

async function forceRuProfile(email?: string, password?: string) {
  // separate context: page.request would share (and race) the browser cookie jar
  const api = await pw.newContext({ baseURL: BASE });
  const token = email ? (await (await api.post('/api/auth/login', { data: { email, password } })).json()).accessToken as string
    : await apiLogin(api);
  const me = await (await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
  // this file asserts Russian UI text, and since task 1 a fresh account is English by default —
  // so the language is SET here (a profile PATCH is an explicit choice), not assumed
  await api.patch('/api/me/profile', { headers: { authorization: `Bearer ${token}` }, data: { name: me.name, locale: 'ru', tz: me.tz } });
  await api.dispose();
}

let classLink = '';
let classIdForFlow = '';

/**
 * Ученик регистрируется сам по одноразовой ссылке (2026-10-27: приём по коду класса выведен,
 * `/api/auth/register` отвечает 410, а экрана `/register` больше не форма — там объяснение).
 * Письмо-подтверждение здесь не нажимается: в e2e-стеке транспорт почты выключен, и поля
 * `join-send-code`/`join-email-code` просто не рисуются.
 */
async function registerStudent(page: import('@playwright/test').Page, first: string, last: string, email: string, password: string, linkUrl: string) {
  const token = linkUrl.includes('#') ? linkUrl.split('#')[1] : linkUrl;
  await page.goto(`/join#${token}`);
  await expect(page.getByTestId('join-first')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('join-first').fill(first);
  await page.getByTestId('join-last').fill(last);
  await page.getByTestId('join-email').fill(email);
  await page.getByTestId('join-password').fill(password);
  await page.getByTestId('join-consent').check();
  await page.getByTestId('join-register').click();
  await expect(page.getByTestId('join-done-text')).toBeVisible({ timeout: 20_000 });
  // экран сам ведёт в приглашённый класс; «в приложении» = Главная, она следующим шагом
  await expect(page).toHaveURL(/\/classes\//, { timeout: 20_000 });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
}

test.describe.serial('klass core flows', () => {
  test('teacher: login, create class, create an invitation link', async ({ page }) => {
    await forceRuProfile();
    await page.goto('/login');
    await page.getByTestId('email').fill(stack.teacherEmail);
    await page.getByTestId('password').fill(stack.teacherPassword);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('home-title')).toBeVisible();

    await page.goto('/classes');
    await page.getByTestId('new-class-name').fill('E2E Математика 7А');
    await page.getByTestId('create-class').click();
    await expect(page.getByTestId('class-card').first()).toContainText('E2E Математика 7А');
    classIdForFlow = 'created';

    await page.getByTestId('class-card').first().locator('a').first().click();
    await expect(page).toHaveURL(/\/classes\/[0-9a-f-]+/);
    // кнопки «создать код» больше нет совсем: её тест был утверждением про восьмизначный алфавит,
    // теперь это утверждение про то, что алфавиту месту в продукте быть не может
    await expect(page.getByTestId('create-invite')).toHaveCount(0);
    await expect(page.getByTestId('invite-code')).toHaveCount(0);
    await expect(page.getByTestId('invite-link-section')).toBeVisible();

    await page.getByTestId('invite-link-label').fill('Проверка');
    await page.getByTestId('create-invite-link').click();
    const box = page.getByTestId('invite-link-box');
    await expect(box).toBeVisible({ timeout: 15_000 });
    classLink = (await box.locator('.invite-url').innerText()).trim();
    // токен живёт во фрагменте и ровно в этом ответе: 32 символа [A-Za-z0-9_-]
    expect(classLink).toMatch(/#([A-Za-z0-9_-]{32})$/);

    await page.getByTestId('invite-link-done').click();
    // «показать ещё раз» честного способа нет: сервер хранит хеш, ссылка отдаётся один раз
    await expect(page.getByTestId('invite-link-box')).toHaveCount(0);
    await page.getByTestId('create-invite-link').click();
    await expect(page.getByTestId('invite-link-box')).toBeVisible({ timeout: 15_000 });
    const again = (await page.getByTestId('invite-link-box').locator('.invite-url').innerText()).trim();
    expect(again, 'вторая ссылка — новый токен, а не возврат прежнего').not.toBe(classLink);
    await page.getByTestId('invite-link-done').click();
  });

  test('student registers by an invitation link and sees the class', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await registerStudent(page, 'Ученик', 'Тест', `e2estudent${Date.now()}@x.io`, 'Secret1234', classLink);
    await page.goto('/classes');
    await expect(page.getByTestId('class-card').first()).toContainText('E2E Математика 7А');
    // ссылка одноразовая: второй заход той же ссылкой обязан быть отказом
    const page2 = await ctx.newPage();
    await page2.goto(classLink);
    await expect(page2.getByTestId('join-broken')).toBeVisible({ timeout: 20_000 });
    await expect(page2.getByTestId('auth-error')).toContainText(/уже использована|already been used|ishlatilgan/i);
    await ctx.close();
  });

  test('teacher creates a lesson event in calendar', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('email').fill(stack.teacherEmail);
    await page.getByTestId('password').fill(stack.teacherPassword);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await page.goto('/calendar');
    await expect(page.getByTestId('new-event')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('new-event').click();
    await page.getByTestId('event-title').fill('Ежегодная контрольная');
    const d = new Date(Date.now() + 2 * 86400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:00`;
    // часть B: поля даты больше не нативные (`type="datetime-local"` рисовал формат браузера),
    // поэтому цель — testid. Формат значения тот же (`ГГГГ-ММ-ДДЧЧ:ММ`), и разбор его принимает.
    await page.getByTestId('event-start').fill(iso);
    await page.getByTestId('event-save').click();
    await expect(page.locator('.fc-event, .fc-list-event').first()).toBeVisible();
  });

  test('lesson start + board + student sheets (API-backed join)', async ({ browser }) => {
    // get classId via API using teacher session
    const api = await pw.newContext({ baseURL: BASE });
    const token = await apiLogin(api);
    const classes = await (await api.get('/api/classes', { headers: { authorization: `Bearer ${token}` } })).json();
    const cls = classes.find((c: { name: string }) => c.name.includes('E2E'));
    expect(cls).toBeTruthy();
    const start = await api.post(`/api/lessons/start`, {
      headers: { authorization: `Bearer ${token}` },
      data: { classId: cls.id },
    });
    expect(start.status()).toBe(201);
    const session = await start.json();

    // student context
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // create a fresh one-time link for this student (ссылка расходуется первым удачным входом)
    const inv = await api.post(`/api/classes/${cls.id}/invites/link`, { headers: { authorization: `Bearer ${token}` }, data: {} });
    expect(inv.status(), `учитель обязан уметь выпускать ссылку: ${inv.status()}`).toBe(201);
    const linkUrl = String((await inv.json()).url as string);
    const sheetStudent = `e2esheet${Date.now()}@x.io`;
    await registerStudent(page, 'Листок', 'Тест', sheetStudent, 'Secret1234', linkUrl);
    // the assertions below read Russian UI strings («Сохранено»), so this account chooses Russian
    await forceRuProfile(sheetStudent, 'Secret1234');

    // open lesson page by classId → session active, board visible to student (view-mode), drawer exists
    // task 4: the board must not reach out to excalidraw.com / libraries.excalidraw.com
    const external: string[] = [];
    page.on('request', (r) => {
      const h = new URL(r.url()).host;
      if (/excalidraw\.com$/i.test(h)) external.push(r.url());
    });
    await page.goto(`/lesson?classId=${cls.id}`);
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('sheet-fab')).toBeVisible();
    await page.getByTestId('sheet-fab').click();
    await page.getByRole('button', { name: /\+ / }).first().click();
    await page.getByTestId('sheet-body').fill('Тема дрогби: oʻ gʻ — кириллица тоже: Привет');
    await page.waitForTimeout(1500); // debounce save
    await expect(page.getByText(/Сохранено/).first()).toBeVisible({ timeout: 5000 });

    // sheet survived "reload" (persisted to server)
    await page.reload();
    await page.getByTestId('sheet-fab').click();
    await page.locator('.sheet-panel button', { hasText: /Листок|Varaq/ }).first().click();
    await expect(page.getByTestId('sheet-body')).toHaveValue(/oʻ gʻ/);

    // teacher can join for real: join endpoint issues a LiveKit token
    const join = await api.post(`/api/lessons/${session.id}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(join.status()).toBe(200);
    expect((await join.json()).token).toBeTruthy();

    // task 4: nothing in the board UI may call excalidraw.com / libraries.excalidraw.com
    expect(external, `external excalidraw requests: ${external.join(', ')}`).toEqual([]);

    await ctx.close();
    await api.dispose();
  });
});
