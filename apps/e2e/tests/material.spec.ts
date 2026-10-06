import { test, expect } from '@playwright/test';
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
const BASE = `http://127.0.0.1:${stack.port}`;

async function apiLogin(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: stack.teacherEmail, password: stack.teacherPassword }),
  });
  if (!r.ok) throw new Error(`teacher api login ${r.status}`);
  return (await r.json()).accessToken as string;
}

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    const ok = await page.getByTestId('home-title').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error('login failed after retries');
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('material e2e body')]);

test.describe.serial('material form (task A)', () => {
  const stamp = Date.now();
  let classId = '';
  let code = '';
  const stuEmail = `e2emat${stamp}@x.io`;

  test('setup: class + invite', async () => {
    const tok = await apiLogin();
    const cls = await (await fetch(`${BASE}/api/classes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: `E2E Материал ${stamp}`, description: '', color: '#0ea5a5' }),
    })).json();
    classId = cls.id as string;
    const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
    })).json();
    code = inv.code as string;
    expect(classId && code).toBeTruthy();
  });

  test('student registers by code', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/register');
    await page.getByTestId('reg-code').fill(code);
    await page.getByTestId('reg-email').fill(stuEmail);
    await page.getByTestId('reg-password').fill('Secret1234');
    await page.getByTestId('register-step1').click();
    await expect(page.getByTestId('reg-first')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('reg-first').fill('Материал');
    await page.getByTestId('reg-last').fill('Тест');
    await page.getByTestId('reg-consent').check();
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('teacher: required-field error, full create with file+link+youtube+topic+audience', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, stack.teacherEmail, stack.teacherPassword);
    await page.goto(`/classes/${classId}`);
    await page.getByTestId('new-material-link').click();
    await expect(page.getByTestId('material-page')).toBeVisible();

    // required title
    await page.getByTestId('material-publish').click();
    await expect(page.getByTestId('material-title-err')).toHaveText('Обязательное поле');

    await page.getByTestId('material-title').fill(`Дроби. Урок ${stamp}`);
    // a file, a plain link and a YouTube link
    await page.getByTestId('att-files').setInputFiles({ name: 'лист.pdf', mimeType: 'application/pdf', buffer: PDF });
    await page.getByTestId('att-link').click();
    await page.getByTestId('link-url').fill('https://example.com/konspekt');
    await page.getByTestId('link-add').click();
    await page.getByTestId('att-youtube').click();
    await page.getByTestId('link-url').fill('https://youtu.be/dQw4w9WgXcQ');
    await page.getByTestId('link-add').click();
    await expect(page.getByTestId('att-card-youtube')).toHaveCount(1);
    // dangerous scheme is refused by the add button (disabled until a safe URL)
    await page.getByTestId('att-link').click();
    await page.getByTestId('link-url').fill('javascript:alert(1)');
    await expect(page.getByTestId('link-add')).toBeDisabled();

    // topic: create a new one
    await page.getByTestId('topic-create').click();
    await page.getByTestId('topic-new').fill('Сложение');
    // audience: only the registered student
    await page.getByTestId('aud-some').check();
    await expect(page.getByTestId('aud-list')).toBeVisible();
    await page.getByTestId('aud-list').locator('input[type="checkbox"]').first().check();

    await page.getByTestId('material-publish').click();
    await page.waitForURL((u) => u.pathname === `/classes/${classId}`, { timeout: 20_000 });
    // the feed shows the post under its topic with the three cards
    await expect(page.getByTestId(/^topic-toggle/).filter({ hasText: 'Сложение' })).toBeVisible();
    await expect(page.getByTestId('feed-item').filter({ hasText: `Дроби. Урок ${stamp}` })).toBeVisible();
    await expect(page.getByTestId('att-link-card')).toBeVisible();
    await expect(page.getByTestId('att-youtube-card')).toBeVisible();
    await expect(page.getByTestId('att-file-card')).toBeVisible();
    // every external link is noopener
    const hrefs = await page.locator('.att-card a[target="_blank"]').evaluateAll(
      (els) => els.map((e) => `${e.getAttribute('href')}|${e.getAttribute('rel')}`));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h.endsWith('|noopener noreferrer')).toBeTruthy();
    await ctx.close();
  });

  test('student sees the material; YouTube embeds only after a click', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, stuEmail, 'Secret1234');
    await page.goto(`/classes/${classId}`);
    const card = page.getByTestId('feed-item').filter({ hasText: `Дроби. Урок ${stamp}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // no iframe before the click (no third-party loads without consent)
    await expect(card.locator('iframe')).toHaveCount(0);
    await card.getByTestId('att-yt-play').click();
    const frame = card.getByTestId('att-yt-frame');
    await expect(frame).toHaveCount(1);
    expect(await frame.getAttribute('src')).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    await ctx.close();
  });

  test('draft is teacher-only; scheduled becomes visible after its time', async ({ browser }) => {
    test.setTimeout(240_000);
    const tCtx = await browser.newContext();
    const tp = await tCtx.newPage();
    await loginAs(tp, stack.teacherEmail, stack.teacherPassword);

    // draft
    await tp.goto(`/classes/${classId}/material/new`);
    await tp.getByTestId('material-title').fill(`Черновик ${stamp}`);
    await tp.getByTestId('publish-menu').click();
    await tp.getByTestId('pub-draft').click();
    await tp.getByTestId('material-publish').click();
    await tp.waitForURL((u) => u.pathname === `/classes/${classId}`, { timeout: 20_000 });
    await expect(tp.getByTestId('drafts-section')).toBeVisible();
    await expect(tp.getByTestId('draft-item').filter({ hasText: `Черновик ${stamp}` })).toBeVisible();

    // scheduled 45 s ahead
    await tp.goto(`/classes/${classId}/material/new`);
    await tp.getByTestId('material-title').fill(`По расписанию ${stamp}`);
    await tp.getByTestId('publish-menu').click();
    await tp.getByTestId('pub-schedule').click();
    // Round UP to the next whole minute: `datetime-local` here has minute
    // granularity, so a naive now+45s truncated to HH:MM could land at/before now
    // (when the current second is 0–14) and the client would (correctly) refuse to
    // publish a non-future time. The next minute boundary is always 1–59 s ahead
    // and still well inside the 80 s visibility wait below.
    const when = new Date();
    when.setSeconds(0, 0);
    when.setMinutes(when.getMinutes() + 1);
    const local = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}T${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    await tp.getByTestId('material-when').fill(local);
    await tp.getByTestId('material-publish').click();
    await tp.waitForURL((u) => u.pathname === `/classes/${classId}`, { timeout: 20_000 });
    await expect(tp.getByTestId('draft-item').filter({ hasText: `По расписанию ${stamp}` })).toBeVisible();

    // the student sees neither of them yet
    const sCtx = await browser.newContext();
    const sp = await sCtx.newPage();
    await loginAs(sp, stuEmail, 'Secret1234');
    await sp.goto(`/classes/${classId}`);
    await expect(sp.getByTestId('feed-item').filter({ hasText: `Черновик ${stamp}` })).toHaveCount(0);
    await expect(sp.getByTestId('feed-item').filter({ hasText: `По расписанию ${stamp}` })).toHaveCount(0);

    // after the scheduled time (+ heartbeat/publish margin) it appears on reload
    // (the next-minute boundary is ≤ 60 s ahead, so 100 s guarantees the schedule
    // has fired even at the slowest poll interval)
    await sp.waitForTimeout(100_000);
    await sp.reload();
    await expect(sp.getByTestId('feed-item').filter({ hasText: `По расписанию ${stamp}` })).toBeVisible({ timeout: 20_000 });
    // the draft stays private
    await expect(sp.getByTestId('feed-item').filter({ hasText: `Черновик ${stamp}` })).toHaveCount(0);

    await tCtx.close(); await sCtx.close();
  });
});
