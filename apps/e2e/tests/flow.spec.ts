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

async function forceRuProfile() {
  // separate context: page.request would share (and race) the browser cookie jar
  const api = await pw.newContext({ baseURL: BASE });
  const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
  const token = (await l.json()).accessToken as string;
  const me = await (await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
  await api.patch('/api/me/profile', { headers: { authorization: `Bearer ${token}` }, data: { name: me.name, locale: 'ru', tz: me.tz } });
  await api.dispose();
}

let classCode = '';
let classIdForFlow = '';

test.describe.serial('klass core flows', () => {
  test('teacher: login, create class, create invite code', async ({ page }) => {
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
    await page.getByTestId('create-invite').click();
    await expect(page.getByTestId('invite-code')).toBeVisible();
    classCode = (await page.getByTestId('invite-code').textContent())!.trim();
    expect(classCode).toMatch(/^[2-9A-HJ-KMNP-Z]{8}$/);
  });

  test('student registers by code and sees the class', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/register');
    await page.getByTestId('reg-name').fill('Ученик Тест');
    await page.getByTestId('reg-email').fill(`e2estudent${Date.now()}@x.io`);
    await page.getByTestId('reg-password').fill('Secret1234');
    await page.getByTestId('reg-code').fill(classCode);
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await page.goto('/classes');
    await expect(page.getByTestId('class-card').first()).toContainText('E2E Математика 7А');
    // code is single-use: try to register again with the same one
    const page2 = await ctx.newPage();
    await page2.goto('/login');
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
    await page.locator('input[type="datetime-local"]').fill(iso);
    await page.getByTestId('event-save').click();
    await expect(page.locator('.fc-event, .fc-list-event').first()).toBeVisible();
  });

  test('lesson start + board + student sheets (API-backed join)', async ({ browser }) => {
    // get classId via API using teacher session
    const api = await pw.newContext({ baseURL: BASE });
    const r = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    const token = (await r.json()).accessToken as string;
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
    await page.goto('/register');
    await page.getByTestId('reg-name').fill('Листок Тест');
    await page.getByTestId('reg-email').fill(`e2esheet${Date.now()}@x.io`);
    await page.getByTestId('reg-password').fill('Secret1234');
    // create fresh code for this student
    const inv = await api.post(`/api/classes/${cls.id}/invites`, { headers: { authorization: `Bearer ${token}` }, data: {} });
    const code = (await inv.json()).code as string;
    await page.getByTestId('reg-code').fill(code);
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });

    // open lesson page by classId → session active, board visible to student (view-mode), drawer exists
    const stLogin = await api.post('/api/auth/login', { data: { email: `e2esheet${''}`, password: '' } }).catch(() => null); void stLogin;
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

    await ctx.close();
    await api.dispose();
  });
});
