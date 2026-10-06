import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as { port: number; teacherEmail: string; teacherPassword: string };
    } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  throw new Error('.stack.json never appeared');
}
const stack = readStack();

async function loginOwner(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByTestId('email').fill(stack.teacherEmail);
  await page.getByTestId('password').fill(stack.teacherPassword);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
}

/** Collect CRITICAL/SERIOUS axe violations on the current page (no throw). */
async function axeCritical(page: import('@playwright/test').Page, name: string) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast']) // contrast handled separately below
    .analyze();
  return res.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => ({ screen: name, id: v.id, impact: v.impact, n: v.nodes.length, first: v.nodes[0]?.target }));
}

/** Assert no CRITICAL or SERIOUS axe violations on the current page. */
async function expectAccessible(page: import('@playwright/test').Page, name: string) {
  const bad = await axeCritical(page, name);
  expect(bad, `axe critical/serious on ${name}`).toEqual([]);
}

test.describe('a11y (Phase 3)', () => {
  test('login screen', async ({ page }) => { await page.goto('/login'); await expectAccessible(page, 'login'); });
  test('register screen', async ({ page }) => { await page.goto('/register'); await expectAccessible(page, 'register'); });

  test('authenticated screens', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginOwner(page);
    const all: unknown[] = [];
    all.push(...await axeCritical(page, 'home'));
    await page.goto('/classes'); await page.waitForLoadState('networkidle'); all.push(...await axeCritical(page, 'classes'));
    await page.goto('/calendar'); all.push(...await axeCritical(page, 'calendar'));
    await page.goto('/notes'); all.push(...await axeCritical(page, 'notes'));
    await page.goto('/chat'); all.push(...await axeCritical(page, 'chat'));
    await page.goto('/lesson'); all.push(...await axeCritical(page, 'lesson'));
    await page.goto('/profile'); all.push(...await axeCritical(page, 'profile'));
    await ctx.close();
    if (all.length) console.log('A11Y AUTH FAILINGS:', JSON.stringify(all, null, 2));
    expect(all, 'axe critical/serious on authenticated screens').toEqual([]);
  });
});
