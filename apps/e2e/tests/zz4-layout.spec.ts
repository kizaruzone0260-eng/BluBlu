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
const BASE = `http://127.0.0.1:${stack.port}`;

async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    const http = `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`;
    await fetch(http, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

async function loginUi(page: import('@playwright/test').Page, email: string, password: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    const ok = await page.getByTestId('home-title').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error('login failed after retries');
}

async function joinWithCam(page: import('@playwright/test').Page, classId: string) {
  await page.goto(`/lesson?classId=${classId}`);
  await page.getByTestId('check-devices').click();
  await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('join-lesson').click();
  await expect(async () => {
    const dims = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => [v.videoWidth, v.clientWidth]));
    expect(dims.some((d) => d[0] > 0 && d[1] > 0)).toBeTruthy();
  }).toPass({ timeout: 30_000 });
}

/**
 * Task B (real RTC, two participants): opening the board promotes it to the
 * main stage (>60 % of the lesson area), cameras shrink to the strip, the own
 * camera floats and drags, the student sees board + teacher camera, closing
 * restores the grid.
 */
test('lesson layout B: board as the main stage with a floating camera (real RTC)', async ({ browser }) => {
  test.setTimeout(300_000);
  const api = await pw.newContext({ baseURL: BASE });
  let token = '';
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    if (l.status() === 429) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
    token = (await l.json()).accessToken as string;
  }
  expect(token).toBeTruthy();
  const H = { authorization: `Bearer ${token}` };
  const cls = await (await api.post('/api/classes', { headers: H, data: { name: `E2E раскладка ${Date.now()}`, description: '', color: '#0ea5a5' } })).json();
  const start = await api.post('/api/lessons/start', { headers: H, data: { classId: cls.id } });
  expect(start.status()).toBe(201);
  const session = await start.json();
  const joinR = await api.post(`/api/lessons/${session.id}/join`, { headers: H });
  const wsUrl = (await joinR.json()).wsUrl as string;
  if (!(await livekitReachable(wsUrl))) {
    await api.dispose();
    test.skip(true, 'LiveKit not reachable — layout RTC test needs LIVEKIT_* env');
    return;
  }
  const inv = await (await api.post(`/api/classes/${cls.id}/invites`, { headers: H, data: {} })).json();

  const ctxT = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const pT = await ctxT.newPage();
  await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
  await joinWithCam(pT, cls.id);

  const ctxS = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const pS = await ctxS.newPage();
  await pS.goto('/register');
  await pS.getByTestId('reg-code').fill(inv.code as string);
  await pS.getByTestId('reg-email').fill(`e2elay${Date.now()}@x.io`);
  await pS.getByTestId('reg-password').fill('Secret1234');
  await pS.getByTestId('register-step1').click();
  await pS.getByTestId('reg-first').fill('Раскладка');
  await pS.getByTestId('reg-last').fill('Тест');
  await pS.getByTestId('register-submit').click();
  await expect(pS.getByTestId('home-title')).toBeVisible({ timeout: 20_000 }); // logged in + token set
  await joinWithCam(pS, cls.id);
  // grid first: both cameras visible as tiles
  await expect(pS.locator('.videos [data-local="0"] video')).not.toHaveCount(0, { timeout: 20_000 });

  // ── teacher opens the board ──
  await pT.getByTestId('board-toggle').click();
  await expect(pT.getByTestId('lesson-stage')).toBeVisible();
  const board = pT.getByTestId('board');
  await expect(board).toBeVisible();
  // the board takes MORE THAN 60 % of the lesson stage area
  const ratios = async (page: import('@playwright/test').Page) => page.evaluate(() => {
    const stage = document.querySelector('[data-testid=lesson-stage]')?.getBoundingClientRect();
    const boardEl = document.querySelector('[data-testid=board]')?.getBoundingClientRect();
    if (!stage || !boardEl) return 0;
    return (boardEl.width * boardEl.height) / (stage.width * stage.height);
  });
  await expect.poll(() => ratios(pT), { timeout: 15_000 }).toBeGreaterThan(0.6);

  // own camera = a small floating window
  const pip = pT.getByTestId('pip-local');
  await expect(pip).toBeVisible();
  const pipBox = await pip.boundingBox();
  expect(pipBox && pipBox.width <= 200).toBeTruthy();

  // drag the floating window far to the top-left → it snaps to another corner
  const before = await pip.boundingBox();
  const bar = await pT.getByTestId('pip-bar').boundingBox();
  await pT.mouse.move(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2);
  await pT.mouse.down();
  await pT.mouse.move(bar!.x - 400, bar!.y - 300, { steps: 10 });
  await pT.mouse.up();
  await pT.waitForTimeout(400);
  const after = await pip.boundingBox();
  expect(after && before && (Math.abs(after.y - before.y) > 40 || Math.abs(after.x - before.x) > 40)).toBeTruthy();

  // minimize then hide → restore button
  await pT.getByTestId('pip-min').click();
  await expect(pip).toHaveClass(/pip-min/);
  await pT.getByTestId('pip-min').click();
  await pT.getByTestId('pip-hide').click();
  await expect(pip).toHaveCount(0);
  await pT.getByTestId('pip-restore').click();
  await expect(pip).toBeVisible();

  // ── the student sees the board as the stage AND the teacher's camera ──
  await expect(pS.getByTestId('lesson-stage')).toBeVisible({ timeout: 15_000 });
  await expect(pS.getByTestId('board')).toBeVisible();
  await expect.poll(() => ratios(pS), { timeout: 15_000 }).toBeGreaterThan(0.6);
  await expect(pS.getByTestId('pip-teacher')).toBeVisible();
  await expect(async () => {
    const dims = await pS.evaluate(() => {
      const v = document.querySelector('[data-testid=pip-teacher] video');
      return v ? [v.videoWidth, v.clientWidth] : [0, 0];
    });
    expect(dims[0] > 0 && dims[1] > 0).toBeTruthy();
  }).toPass({ timeout: 20_000 });
  // the student's own camera is the small hideable PiP, not a grid tile
  await expect(pS.getByTestId('pip-local')).toBeVisible();

  // ── closing the board restores the plain grid ──
  await pT.getByTestId('board-toggle').click();
  await expect(pT.getByTestId('lesson-stage')).toHaveCount(0);
  await expect(pT.locator('.videos')).toBeVisible();
  await expect(pS.getByTestId('lesson-stage')).toHaveCount(0, { timeout: 15_000 });

  await api.post(`/api/lessons/${session.id}/end`, { headers: H, data: {} });
  await ctxT.close(); await ctxS.close(); await api.dispose();
});
