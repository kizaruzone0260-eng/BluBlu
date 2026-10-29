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

/**
 * Collect CRITICAL/SERIOUS axe violations on the current page (no throw).
 *
 * `color-contrast` is no longer excluded (2026-10-28, audit item 13): the note said
 * contrast was handled elsewhere and it was not, so two token pairs sat at 4.48/4.41
 * while these screens stayed green. The light tokens were darkened to 6.00/5.32 and
 * the rule now runs with the rest — a new theme colour cannot pass unnoticed.
 */
async function axeCritical(page: import('@playwright/test').Page, name: string) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
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
  test('register screen: the explainer and the invitation screen without a token', async ({ page }) => {
    /*
     * This audit used to point at the two-step "register with a class code" form. That form is
     * gone (2026-10-27: joining by code was retired), and `/register` is now the static
     * "how to get into a class" explainer — it stays audited because school browsers still hold
     * bookmarks to it. Registration itself lives on `/join`, and `/join` without a token is the
     * refusal screen: a visitor who arrives there must get an accessible answer too.
     */
    await page.goto('/register');
    await expect(page.getByTestId('register-explainer')).toBeVisible({ timeout: 20_000 });
    await expectAccessible(page, 'register');
    // none of the retired code form may survive here
    await expect(page.getByTestId('reg-code')).toHaveCount(0);

    await page.goto('/join');
    await expect(page.getByTestId('join-broken')).toBeVisible({ timeout: 20_000 });
    await expectAccessible(page, 'join-no-token');
  });

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

  /**
   * Audit item 13: the bottom-left block used to be a `<div role="button">` with no keyboard
   * at all, and the profile/theme/logout menu it opened could not be closed with Escape.
   * It is a real `<button>` now; this checks the parts a screen reader and a keyboard user need:
   * a name (collapsed rail hides the visible name, so the aria-label is the only name there),
   * aria-expanded telling the truth, Enter to open and Escape to close with focus coming back.
   */
  test('the sidebar user menu is operable and named from the keyboard', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginOwner(page);
    const btn = page.getByTestId('side-user');
    const menu = page.getByTestId('side-user-menu');

    await expect(btn).toHaveAccessibleName(/E2E Teacher/);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toBeFocused();

    await ctx.close();
  });
});
