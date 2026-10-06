/**
 * Part 3 e2e — the forgotten-password lifecycle through the real UI:
 *  1. a teacher creates a class + an invite code;
 *  2. a student registers with that code and lands straight in the app
 *     (registration is NOT flagged mustChangePassword);
 *  3. the teacher resets that student's password from the member list and the
 *     one-time temp password is shown there once;
 *  4. the student logs in with the temp password → the forced change-password
 *     gate blocks the app; a wrong "current" is rejected, then a valid change
 *     unlocks it;
 *  5. the student re-logs in with the NEW password and reaches Home — no gate.
 * The server-side mechanics (session revocation, audit) are covered by
 * test/integration/phase3-passwords.test.ts; this proves the SPA gates + forms.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as { port: number };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error('.stack.json never appeared');
}
const BASE = `http://127.0.0.1:${readStack().port}`;
const TEACHER = 'owner@e2e.io';
const TEACHER_PW = 'Passw0rd123';

// shared across the serial tests (one module instance per worker)
let className = '';
let inviteCode = '';
let studentEmail = '';
let tempPw = '';

type Landed = 'home' | 'name-gate' | 'password-gate';
async function loginUI(page: import('@playwright/test').Page, email: string, pw: string): Promise<Landed> {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(pw);
  await page.getByTestId('login-submit').click();
  const where = await Promise.race([
    page.getByTestId('home-title').waitFor({ timeout: 15_000 }).then(() => 'home' as const).catch(() => null),
    page.getByTestId('name-gate').waitFor({ timeout: 15_000 }).then(() => 'name-gate' as const).catch(() => null),
    page.getByTestId('password-gate').waitFor({ timeout: 15_000 }).then(() => 'password-gate' as const).catch(() => null),
  ]);
  if (!where) throw new Error(`login ${email} landed nowhere within timeout`);
  return where;
}

test.describe.serial('Part 3: forgotten password & gate', () => {
  test('teacher creates a class and an invite code', async ({ page }) => {
    await loginUI(page, TEACHER, TEACHER_PW);
    className = `E2E Пароли ${Date.now()}`;
    await page.goto(`${BASE}/classes`);
    await page.getByTestId('new-class-name').fill(className);
    await page.getByTestId('create-class').click();
    const card = page.getByTestId('class-card').filter({ hasText: className });
    await expect(card).toHaveCount(1);
    await card.locator('a').first().click();
    await expect(page).toHaveURL(/\/classes\/[0-9a-f-]+/);
    await page.getByTestId('create-invite').click();
    await expect(page.getByTestId('invite-code')).toBeVisible();
    inviteCode = (await page.getByTestId('invite-code').textContent())!.trim();
    expect(inviteCode).toMatch(/^[2-9A-HJ-KMNP-Z]{8}$/);
  });

  test('student registers by code — lands in the app, no password gate', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    studentEmail = `e2epw${Date.now()}@x.io`;
    await page.goto(`${BASE}/register`);
    await page.getByTestId('reg-code').fill(inviteCode);
    await page.getByTestId('reg-email').fill(studentEmail);
    await page.getByTestId('reg-password').fill('Secret1234');
    await page.getByTestId('register-step1').click();
    await expect(page.getByTestId('reg-first')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('reg-first').fill('Пина');
    await page.getByTestId('reg-last').fill('Код');
    await page.getByTestId('reg-consent').check();
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('teacher resets the student password and reads the one-time temp', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginUI(page, TEACHER, TEACHER_PW);
    await page.goto(`${BASE}/classes`);
    await page.getByTestId('class-card').filter({ hasText: className }).locator('a').first().click();
    const row = page.locator('tr', { hasText: studentEmail });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId('member-reset-pw').click();
    await expect(page.getByTestId('member-temp-pw')).toBeVisible({ timeout: 15_000 });
    tempPw = (await page.getByTestId('member-temp-pw').textContent())!.trim();
    expect(tempPw.length).toBeGreaterThanOrEqual(8);
    await ctx.close();
  });

  test('student logs in with the temp password → forced change gate', async ({ browser }) => {
    expect(tempPw).toBeTruthy();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const landed = await loginUI(page, studentEmail, tempPw);
    expect(landed).toBe('password-gate');
    await expect(page.getByTestId('home-title')).toBeHidden(); // the app stays locked

    // wrong "current" password → an inline, translated error (server 403)
    await page.getByTestId('cp-current').fill('wrong-current-1');
    await page.getByTestId('cp-new').fill('FreshPass9999');
    await page.getByTestId('cp-confirm').fill('FreshPass9999');
    await page.getByTestId('cp-submit').click();
    await expect(page.getByTestId('cp-error')).toBeVisible({ timeout: 10_000 });

    // correct change → the gate unlocks into Home
    await page.getByTestId('cp-current').fill(tempPw);
    await page.getByTestId('cp-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('student re-logs in with the NEW password — no gate', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const landed = await loginUI(page, studentEmail, 'FreshPass9999');
    expect(landed).toBe('home');
    await ctx.close();
  });
});
