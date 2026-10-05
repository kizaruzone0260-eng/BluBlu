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
const stack = readStack();
const BASE = `http://127.0.0.1:${stack.port}`;
const PW = 'Passw0rd123'; // same e2e hash seeded for every gate account

async function loginNew(browser: import('@playwright/test').Browser, email: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('login-submit').click();
    const landed = await Promise.race([
      page.getByTestId('home-title').waitFor({ timeout: 10_000 }).then(() => 'home' as const).catch(() => null),
      page.getByTestId('name-gate').waitFor({ timeout: 10_000 }).then(() => 'gate' as const).catch(() => null),
    ]);
    if (landed) return { ctx, page, landed };
    await ctx.close();
    await new Promise((r) => setTimeout(r, 20_000)); // login rate limit (10/min/IP)
  }
  throw new Error('login did not land on home or the name screen');
}

test.describe.serial('name screen after login (task 2)', () => {
  test('teacher first login: name screen blocks the app, save lands on Home', async ({ browser }) => {
    const { ctx, page, landed } = await loginNew(browser, 'gate@e2e.io');
    expect(landed).toBe('gate');
    await expect(page.getByTestId('home-title')).toBeHidden();
    await expect(page.getByTestId('name-gate')).toBeVisible();
    await expect(page.getByTestId('gate-save')).toBeDisabled(); // not fillable-through
    await page.getByTestId('gate-first').fill('Гат');
    await page.getByTestId('gate-last').fill('Тестер');
    await page.getByTestId('gate-save').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('same teacher re-logs in WITHOUT the screen', async ({ browser }) => {
    const { ctx, landed } = await loginNew(browser, 'gate@e2e.io');
    expect(landed).toBe('home');
    await ctx.close();
  });

  test('old student without a family name sees the screen once', async ({ browser }) => {
    const a = await loginNew(browser, 'old@e2e.io');
    expect(a.landed).toBe('gate');
    await a.page.getByTestId('gate-first').fill('Старый');
    await a.page.getByTestId('gate-last').fill('Ученик');
    await a.page.getByTestId('gate-save').click();
    await expect(a.page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await a.ctx.close();
    const b = await loginNew(browser, 'old@e2e.io');
    expect(b.landed).toBe('home');
    await b.ctx.close();
  });

  test('logout from the name screen works and re-login shows it again — no redirect loop', async ({ browser }) => {
    const { ctx, page, landed } = await loginNew(browser, 'loop@e2e.io');
    expect(landed).toBe('gate');
    await page.getByTestId('gate-logout').click();
    await expect(page.getByTestId('email')).toBeVisible({ timeout: 15_000 }); // back at the login form
    // log in again in the SAME context — the gate must simply re-appear
    await page.getByTestId('email').fill('loop@e2e.io');
    await page.getByTestId('password').fill(PW);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('name-gate')).toBeVisible({ timeout: 15_000 });
    await page.reload(); // a hard reload must not bounce through '/' infinitely either
    await expect(page.getByTestId('name-gate')).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });
});
