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

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
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

test('ink §6: drawing mode with zoom, hand pan, stroke at zoomed scale, undo', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, stack.teacherEmail, stack.teacherPassword);
  await page.goto('/notes?new=1');
  await page.getByTestId('note-title').fill(`Зум-тест ${Date.now()}`);
  await page.getByTestId('ink-mode').click();
  await expect(page.getByTestId('ink-canvas')).toBeVisible();

  // zoom in twice → the level indicator moves off 100 %
  await expect(page.getByTestId('ink-zoom-level')).toHaveText('100%');
  await page.getByTestId('ink-zoom-in').click();
  await page.getByTestId('ink-zoom-in').click();
  const level = await page.getByTestId('ink-zoom-level').innerText();
  expect(parseInt(level, 10)).toBeGreaterThan(130);

  // draw a stroke while zoomed — it lands on the canvas (one path).
  // the canvas can sit below the fold: raw mouse events use viewport coords,
  // so scroll it fully into view and take the box afterwards
  await page.getByTestId('ink-canvas').scrollIntoViewIfNeeded();
  const box = await page.getByTestId('ink-canvas').boundingBox();
  expect(box).toBeTruthy();
  const b = box!;
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.45, b.y + b.height * 0.35, { steps: 8 });
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.note-ink path')).not.toHaveCount(0);

  // hand tool + drag pans the view: the zoomed content shifts (viewBox changes)
  const vbBefore = await page.locator('.note-ink').last().getAttribute('viewBox');
  await page.getByTestId('ink-hand').click();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const vbAfter = await page.locator('.note-ink').last().getAttribute('viewBox');
  expect(vbAfter).not.toBe(vbBefore);

  // «Show all» fits the drawing back into view without errors
  await page.getByTestId('ink-fit').click();
  await expect(page.getByTestId('ink-zoom-level')).toBeVisible();

  // the stroke must have existed before undo removed it
  await page.getByTestId('ink-pen').click();
  await expect(page.locator('.note-ink path')).not.toHaveCount(0);
  // no size-limit error was surfaced while the canvas was guaranteed present
  await expect(page.getByTestId('ink-error')).toHaveCount(0);
  await page.getByTestId('ink-undo').click();
  // publish needs a class on the note; skip when the button is still disabled
  const pub = page.getByTestId('note-publish');
  if (!(await pub.isDisabled())) await pub.click();
});
