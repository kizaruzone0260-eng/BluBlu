import { test, expect } from '@playwright/test';
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

/**
 * Hardening Phase 3: crawl the app's own navigation + legal links and assert
 * none of them lands on the 404 error screen (a broken internal link), and that
 * the SPA shell carries the noindex meta, a favicon and a manifest on every
 * route. Also checks each screen has a translated, non-default tab title.
 */
test.describe.serial('internal link crawl (Phase 3)', () => {
  test('every nav/legal link resolves; shell exposes robots meta + icons', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('email').fill(stack.teacherEmail);
    await page.getByTestId('password').fill(stack.teacherPassword);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });

    const links = await page.locator('nav a[href^="/"], .side-nav a[href^="/"]').evaluateAll(
      (els) => Array.from(new Set(els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''))).filter(Boolean),
    );
    // fixed app routes + everything the sidebar exposes; skip query-string links
    // (e.g. /lesson?classId=…) which are covered by the plain /lesson route.
    const routes = ['/calendar', '/notes', '/chat', '/classes', '/profile', '/privacy', '/terms', '/lesson', ...links]
      .filter((h) => h && !h.includes('?'));

    const seen = new Set<string>();
    for (const href of routes) {
      if (seen.has(href)) continue;
      seen.add(href);
      await page.goto(href);
      await page.waitForLoadState('networkidle');
      // not the "page not found" alert
      await expect(page.getByRole('alert').filter({ hasText: /404/ })).toHaveCount(0);
      // shell chrome present everywhere
      await expect(page.locator('meta[name="robots"]')).toHaveCount(1);
      await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
      // a real translated title (never the bare "BluBlu" on a content screen)
      const title = await page.title();
      expect(title.length, `title for ${href}`).toBeGreaterThan('BluBlu'.length - 1);
    }
  });

  test('a truly unknown route is a 404 in both senses', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('email').fill(stack.teacherEmail);
    await page.getByTestId('password').fill(stack.teacherPassword);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    /*
     * До 2026-10-28 сервер отдавал на неизвестный путь HTML-оболочку со статусом 200
     * (soft 404), хотя SPA рисовала «страница не найдена». Теперь статус честный, и
     * проверка держит обе половины: код ответа для машин и экран для человека.
     */
    const res = await page.goto('/this-page-does-not-exist-xyz');
    expect(res?.status(), 'unknown route HTTP status').toBe(404);
    expect(res?.headers()['content-type'] ?? '').toContain('text/html');
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 5_000 });
  });

  test('the class-entry explainer is a page for a signed-in user, not a redirect', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('email').fill(stack.teacherEmail);
    await page.getByTestId('password').fill(stack.teacherPassword);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    /*
     * Ссылки «Как попасть в класс» живут на Home и Classes и ведут на /register. Пока
     * /register перенаправлял вошедшего домой, ссылка возвращала туда, откуда пришли
     * (аудит 2026-10-28, пункт 11). Страница статическая — ей незачем быть закрытой.
     */
    await page.goto('/register');
    await expect(page.getByTestId('register-explainer')).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/register$/);
    // «Войти» вошедшему не показываем: эта ссылка вела бы на перенаправление
    await expect(page.getByTestId('register-login')).toHaveCount(0);
  });
});
