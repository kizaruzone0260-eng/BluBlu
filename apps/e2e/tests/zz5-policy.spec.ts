import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as {
        port: number; teacherEmail: string; teacherPassword: string;
      };
    } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
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
  return (await r.json()).accessToken as string;
}

/** токен из фрагмента ссылки-приглашения (сервер кладёт его только в адрес, наружу больше nowhere) */
const tokenOf = (url: string) => new URL(url, BASE).hash.slice(1);

/**
 * Аккаунт ученика ТОЛЬКО через API (без принятия документов) → creds остаются в closure.
 *
 * С 2026-10-27 это `POST /api/invitations/register` по одноразовой ссылке: прежний
 * `/api/auth/register` с кодом класса отвечает 410. Свойство, ради которого существует хелпер,
 * то же и то же по причине — отметку о согласии ставит ВТОРОЙ вызов экрана (`acceptPolicy`),
 * а не регистрация, поэтому аккаунт, заведённый этим хелпером, строки принятия не имеет и
 * попадает на калитку документов.
 */
async function apiRegisterNoAccept(tok: string, classId: string, email: string): Promise<void> {
  const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
  })).json();
  const r = await fetch(`${BASE}/api/invitations/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: tokenOf(inv.url), firstName: 'Policy', lastName: 'Test', email, password: 'Secret1234',
    }),
  });
  if (!r.ok) throw new Error(`api register ${r.status}`);
}

test.describe.serial('legal consent (Phase 2)', () => {
  const stamp = Date.now();
  let classId = '';
  let link = '';

  test('setup: class + invitation link', async () => {
    const tok = await apiLogin();
    const cls = await (await fetch(`${BASE}/api/classes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: `E2E Политика ${stamp}`, description: '', color: '#0ea5a5' }),
    })).json();
    classId = cls.id as string;
    const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites/link`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
    })).json();
    link = String(inv.url as string);
    expect(classId && link && tokenOf(link)).toBeTruthy();
  });

  test('registration requires the consent checkbox', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/join#${tokenOf(link)}`);
    await expect(page.getByTestId('join-first')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('join-first').fill('Политика');
    await page.getByTestId('join-last').fill('Тест');
    await page.getByTestId('join-email').fill(`polA${stamp}@x.io`);
    await page.getByTestId('join-password').fill('Secret1234');
    // submit WITHOUT consent → blocked with a localized message, no login
    await page.getByTestId('join-register').click();
    await expect(page.getByTestId('join-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('join-error')).toContainText(/примите.*соглашение|accept.*(policy|terms)|qabul/i, { timeout: 5_000 });
    await expect(page.getByTestId('home-title')).toHaveCount(0);
    await expect(page.getByTestId('join-done-text')).toHaveCount(0);
    // now accept the checkbox → the account is created and the app opens
    await page.getByTestId('join-consent').check();
    await page.getByTestId('join-register').click();
    await expect(page.getByTestId('join-done-text')).toBeVisible({ timeout: 20_000 });
    // отказ не израсходовал ссылку: членство появилось с первой же успешной отправки
    await page.goto('/');
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('a user who has not accepted sees the policy gate, then reaches the app', async ({ browser }) => {
    const tok = await apiLogin();
    const email = `polB${stamp}@x.io`;
    await apiRegisterNoAccept(tok, classId, email); // created WITHOUT policy accept
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill('Secret1234');
    await page.getByTestId('login-submit').click();
    // the policy gate replaces the app until accepted
    await expect(page.getByTestId('policy-gate')).toBeVisible({ timeout: 15_000 });
    // legal pages are reachable from the gate
    await page.getByTestId('gate-privacy-link').click();
    await expect(page.locator('h1')).toContainText(/./);
    await page.goBack();
    await expect(page.getByTestId('policy-gate')).toBeVisible({ timeout: 10_000 });
    // accept → the app unlocks
    await page.getByTestId('gate-accept').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('cleanup archive', async () => {
    const tok = await apiLogin();
    if (classId) {
      await fetch(`${BASE}/api/classes/${classId}/archive`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } }).catch(() => undefined);
    }
  });
});
