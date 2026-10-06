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

/** Register a student through the API only (no policy accept) → returns creds. */
async function apiRegisterNoAccept(tok: string, classId: string, email: string): Promise<void> {
  const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
  })).json();
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Policy', lastName: 'Test', email, password: 'Secret1234', code: inv.code }),
  });
  if (!r.ok) throw new Error(`api register ${r.status}`);
}

test.describe.serial('legal consent (Phase 2)', () => {
  const stamp = Date.now();
  let classId = '';
  let code = '';

  test('setup: class + invite', async () => {
    const tok = await apiLogin();
    const cls = await (await fetch(`${BASE}/api/classes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: `E2E Политика ${stamp}`, description: '', color: '#0ea5a5' }),
    })).json();
    classId = cls.id as string;
    const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
    })).json();
    code = inv.code as string;
    expect(classId && code).toBeTruthy();
  });

  test('registration step 2 requires the consent checkbox', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/register');
    await page.getByTestId('reg-code').fill(code);
    await page.getByTestId('reg-email').fill(`polA${stamp}@x.io`);
    await page.getByTestId('reg-password').fill('Secret1234');
    await page.getByTestId('register-step1').click();
    await expect(page.getByTestId('reg-first')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('reg-first').fill('Политика');
    await page.getByTestId('reg-last').fill('Тест');
    // submit WITHOUT consent → blocked with a localized message, no login
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('reg-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('home-title')).toHaveCount(0);
    // now accept the checkbox → the account is created and the app opens
    await page.getByTestId('reg-consent').check();
    await page.getByTestId('register-submit').click();
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
