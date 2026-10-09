import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
  // the product rate-limits /api/auth/login to 10/min/IP — many specs log in,
  // so back off and retry once when we hit the window (§4 behaviour, not a bug)
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    const ok = await page.getByTestId('home-title').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error('login failed after retries (rate limit?)');
}

async function forceLocale(locale: 'ru' | 'uz' | 'en') {
  // IMPORTANT: use a SEPARATE api context — page.request shares the browser's
  // cookie jar, and its login/rotation would race with the UI session.
  const base = `http://127.0.0.1:${stack.port}`;
  const api = await pw.newContext({ baseURL: base });
  const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
  const token = (await l.json()).accessToken as string;
  const me = await (await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json();
  await api.patch('/api/me/profile', { headers: { authorization: `Bearer ${token}` }, data: { name: me.name, locale, tz: me.tz } });
  await api.dispose();
}

async function openLangMenu(page: import('@playwright/test').Page) {
  // desktop: the dropdown lives in the sidebar user menu; mobile: in the app bar
  const wrap = page.locator('.lang-wrap').first();
  if (await wrap.isVisible().catch(() => false)) return;
  await page.locator('.side-user').click();
}

async function pickLang(page: import('@playwright/test').Page, native: string) {
  await openLangMenu(page);
  await page.locator('.lang-wrap > button').first().click();
  await page.locator('.lang-menu button', { hasText: native }).first().click();
}

test.describe.serial('redesign (A/B/D/E)', () => {
  test('language switcher: current-language caption + RU→UZ→EN content', async ({ page }) => {
    await forceLocale('ru');
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);
    await expect(page.getByTestId('home-title')).toHaveText('Главная');
    await openLangMenu(page);
    // caption = CURRENT language (the old bug showed the target one)
    await expect(page.locator('.lang-wrap > button').first()).toContainText('RU');

    await pickLang(page, "Oʻzbekcha");
    await expect(page.getByTestId('home-title')).toHaveText('Bosh sahifa');
    await expect(page.locator('.lang-wrap > button').first()).toContainText('UZ');

    await pickLang(page, 'English');
    await expect(page.getByTestId('home-title')).toHaveText('Home');
    await expect(page.locator('.lang-wrap > button').first()).toContainText('EN');
    // localized calendar buttons follow the language (B.3)
    await page.goto('/calendar');
    await expect(page.getByTestId('new-event')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.fc-today-button')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.fc-today-button')).toHaveText('Today');

    // profile language is the single source of truth — survives a hard reload
    await page.goto('/');
    await page.reload();
    await expect(page.getByTestId('home-title')).toHaveText('Home', { timeout: 15_000 });

    await pickLang(page, 'Русский');
    await expect(page.getByTestId('home-title')).toHaveText('Главная');
  });

  test('logo click navigates to Home (A.1)', async ({ page }) => {
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto('/calendar');
    await page.locator('.sidebar .side-brand, .appbar .side-brand').first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('home-title')).toBeVisible();
  });

  test('notes (D): empty state → add → autosave → pin → filter → delete', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
    // deterministic starting point: remove every leftover note via the API
    {
      const api = await pw.newContext({ baseURL: `http://127.0.0.1:${stack.port}` });
      const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
      const token = (await l.json()).accessToken as string;
      const rows = await (await api.get('/api/notes', { headers: { authorization: `Bearer ${token}` } })).json();
      for (const n of rows as { id: string }[]) await api.delete(`/api/notes/${n.id}`, { headers: { authorization: `Bearer ${token}` } });
      await api.dispose();
    }
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto('/notes');
    await expect(page.locator('.empty-state').first()).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('notes-add').click();
    await expect(page.getByTestId('note-title')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('note-title').fill(`Заметка проверки ${Date.now()}`);
    await page.locator('.tiptap').click();
    await page.keyboard.type('Текст заметки с oʻ gʻ и кириллицей');
    await expect(page.getByTestId('notes-saved')).toContainText(/Сохранено|Saving|saved/i, { timeout: 10_000 });

    await page.getByTestId('note-pin').click();
    await page.waitForTimeout(700);
    await page.reload();
    await page.locator('[data-testid="note-item"]').first().click(); // reopen after reload
    await expect(page.locator('.note-item .pin-star').first()).toBeVisible({ timeout: 10_000 });

    // «вне уроков» filter keeps a class-less note visible
    await page.getByTestId('notes-filter').selectOption('noclass');
    await expect(page.locator('[data-testid="note-item"]').first()).toBeVisible();

    // search finds it
    await page.getByTestId('notes-filter').selectOption('');
    await page.getByTestId('notes-search').fill('Заметка проверки');
    await expect(page.locator('[data-testid="note-item"]')).toHaveCount(1);

    await page.getByTestId('note-delete').click();
    if ((await page.locator('[data-testid="note-item"]').count()) === 0) {
      await expect(page.locator('.empty-state').first()).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(page.locator('[data-testid="note-item"]').filter({ hasText: 'Заметка проверки' })).toHaveCount(0);
    }
  });

  test('calendar events (C.2): create → edit → delete', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);

    // need a class fixture for the event
    await page.goto('/classes');
    const name = `E2E-события ${Date.now()}`;
    await page.getByTestId('new-class-name').fill(name);
    await page.getByTestId('create-class').click();
    await expect(page.getByTestId('class-card').filter({ hasText: name })).toBeVisible({ timeout: 15_000 });

    await page.goto('/calendar?new=1');
    await expect(page.getByTestId('event-title')).toBeVisible({ timeout: 15_000 });
    const uniq = `Контрольная-дроби-${Date.now()}`;
    await page.getByTestId('event-title').fill(uniq);
    const d = new Date(Date.now() + 3 * 86400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T10:00`;
    await page.locator('input[type="datetime-local"]').fill(iso);
    await page.getByTestId('event-save').click();
    await expect(page.locator('.fc-event', { hasText: uniq }).first()).toBeVisible({ timeout: 15_000 });

    // edit via click on the event
    await page.locator('.fc-event', { hasText: uniq }).first().click();
    await expect(page.getByTestId('event-title')).toHaveValue(uniq, { timeout: 10_000 });
    await page.getByTestId('event-title').fill(`${uniq} — перенесена`);
    await page.getByTestId('event-save').click();
    await expect(page.locator('.fc-event', { hasText: 'перенесена' }).first()).toBeVisible({ timeout: 15_000 });

    // delete
    await page.locator('.fc-event', { hasText: 'перенесена' }).first().click();
    await page.getByTestId('event-delete').click();
    await expect(page.locator('.fc-event', { hasText: 'перенесена' })).toHaveCount(0, { timeout: 15_000 });
  });

  test('class settings (C.2): rename + archive', async ({ page }) => {
    // History of this test's instability, measured rather than guessed:
    //  * 2026-10-09 — one failure in a 14.7-minute full run: `Tearing down "context" exceeded the
    //    test timeout of 150000ms`, after every assertion had passed. 30 isolated repeats + 9 runs
    //    next to its four neighbouring specs, all under a 100 % CPU load: 39/39 green.
    //  * 2026-10-10 — the budget was NOT the answer: in a 16.7-minute full run the same teardown
    //    outlived 240000ms too. So the fixture teardown itself is the thing that stalls, and a
    //    bigger number only delays the diagnosis. The page is now closed INSIDE the test, where a
    //    hang has a name and a duration, instead of anonymously in a fixture. No assertion changed.
    test.setTimeout(240_000);
    page.on('dialog', (d) => void d.accept());
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto('/classes');
    const name = `E2E-настройки ${Date.now()}`;
    await page.getByTestId('new-class-name').fill(name);
    await page.getByTestId('create-class').click();
    await page.getByTestId('class-card').filter({ hasText: name }).locator('a').first().click();
    await expect(page.getByTestId('class-title')).toContainText(name.slice(0, 12));
    await page.getByTestId('cls-name').fill(name + ' — правка');
    await page.getByTestId('cls-save').click();
    await expect(page.getByTestId('class-title')).toContainText('правка', { timeout: 15_000 });
    // the save answers with a toast now, not with `window.alert` — the native modal is what made
    // this page unclosable (235 s) when the client moved on while it was still up
    await expect(page.getByTestId('class-toast')).toContainText(/Сохранено|Saved|Saqlandi/, { timeout: 10_000 });
    await page.getByTestId('cls-archive').click();
    await expect(page.getByTestId('class-card').filter({ hasText: 'правка' })).toHaveCount(0, { timeout: 15_000 });
    // and the redirect is the router's, so the URL is the SPA's own /classes — not a fresh
    // document load started the same moment the client left the page
    await expect(page).toHaveURL(/\/classes$/, { timeout: 15_000 });

    // cleanup done by the test, timed: if closing the SPA page is ever slow again, the log says so
    // with a number instead of leaving it to the fixture ("every assertion passed, then silence")
    const t0 = Date.now();
    await page.close();
    console.log(`MEASURE redesign:177 page.close took ${Date.now() - t0}ms`);
  });
});
