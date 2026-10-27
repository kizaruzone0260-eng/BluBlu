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

/** Any HTTP(S) answer from the media server = reachable (401/404 are fine). */
async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    const http = `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`;
    await fetch(http, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch {
    return false;
  }
}

async function loginUi(page: import('@playwright/test').Page, email: string, password: string) {
  // /api/auth/login is capped at 10/min/IP — the whole serial suite shares it,
  // so back off and retry like redesign.spec's loginAs does
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

/**
 * Ученик заходит по одноразовой ССЫЛКЕ-приглашению (2026-10-27: приём по коду класса выведен,
 * экран `/register` больше не форма, а `/api/auth/register` отвечает 410). Поле подтверждения
 * почты на этом экране не нажимается: в e2e-стеке транспорт почты выключен, и оно не рисуется.
 */
async function registerStudent(page: import('@playwright/test').Page, first: string, last: string, email: string, password: string, linkUrl: string) {
  await page.goto(`/join#${linkUrl.split('#')[1]}`);
  await expect(page.getByTestId('join-first')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('join-first').fill(first);
  await page.getByTestId('join-last').fill(last);
  await page.getByTestId('join-email').fill(email);
  await page.getByTestId('join-password').fill(password);
  await page.getByTestId('join-consent').check();
  await page.getByTestId('join-register').click();
  await expect(page.getByTestId('join-done-text')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/classes\//, { timeout: 20_000 });
  await page.goto('/');
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
}

/** a <video> of the given locality INSIDE THE GRID with real pixels */
async function expectVideo(page: import('@playwright/test').Page, local: '0' | '1') {
  await expect(async () => {
    const dims = await page.evaluate((loc) => [...document.querySelectorAll(`.videos [data-local="${loc}"] video`)]
      .map((v) => [v.videoWidth, v.videoHeight, v.clientWidth, v.clientHeight]), local);
    expect(dims.some((d) => d[0] > 0 && d[2] > 0 && d[3] > 0)).toBeTruthy();
  }).toPass({ timeout: 30_000 });
}

test('camera: both participants see each other with fake devices (real RTC)', async ({ browser }) => {
  test.setTimeout(240_000);
  const api = await pw.newContext({ baseURL: BASE });
  let token = '';
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    if (l.status() === 429) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
    token = (await l.json()).accessToken as string;
  }
  expect(token).toBeTruthy();
  const H = { authorization: `Bearer ${token}` };
  const cls = await (await api.post('/api/classes', { headers: H, data: { name: `E2E камера ${Date.now()}`, description: '', color: '#0ea5a5' } })).json();
  const start = await api.post('/api/lessons/start', { headers: H, data: { classId: cls.id } });
  expect(start.status()).toBe(201);
  const session = await start.json();
  const join = await api.post(`/api/lessons/${session.id}/join`, { headers: H });
  expect(join.status()).toBe(200);
  const wsUrl = (await join.json()).wsUrl as string;

  if (!(await livekitReachable(wsUrl))) {
    // CI runs without a media server (the stack points at ws://127.0.0.1:7880):
    // the token/join half above still executes everywhere, RTC needs LIVEKIT_* env.
    await api.dispose();
    test.skip(true, `LiveKit at ${wsUrl} is not reachable — RTC part needs LIVEKIT_URL/API_KEY/API_SECRET env`);
    return;
  }

  const link = await (await api.post(`/api/classes/${cls.id}/invites/link`, { headers: H, data: {} })).json();

  const ctxT = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pT = await ctxT.newPage();
  await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
  await pT.goto(`/lesson?classId=${cls.id}`);
  await pT.getByTestId('check-devices').click();
  await expect(pT.getByTestId('join-lesson')).toBeEnabled({ timeout: 20_000 });
  await pT.getByTestId('join-lesson').click();
  await expectVideo(pT, '1'); // own camera tile appears despite publishing pre-connect

  const ctxS = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pS = await ctxS.newPage();
  await registerStudent(pS, 'Камера', 'Тест', `e2ecam${Date.now()}@x.io`, 'Secret1234', link.url as string);
  await pS.goto(`/lesson?classId=${cls.id}`);
  await pS.getByTestId('check-devices').click();
  await expect(pS.getByTestId('join-lesson')).toBeEnabled({ timeout: 20_000 });
  await pS.getByTestId('join-lesson').click();
  await expectVideo(pS, '1');
  await expectVideo(pS, '0'); // teacher's camera reaches the student (old bug: never)
  await expectVideo(pT, '0'); // student's camera reaches the teacher

  // echo guard (г): a participant's OWN audio must never be attached for playback
  expect(await pS.locator('[data-local="1"] audio').count()).toBe(0);
  expect(await pT.locator('[data-local="1"] audio').count()).toBe(0);
  // and the camera button reflects the real published state
  await expect(pT.getByTestId('camera-toggle')).toContainText('📹');

  await api.post(`/api/lessons/${session.id}/end`, { headers: H, data: {} });
  await ctxT.close();
  await ctxS.close();
  await api.dispose();
});
