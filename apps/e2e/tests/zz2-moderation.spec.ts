import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { barClick, openMore, openTab } from './controlBar';

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
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
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
  throw new Error('login failed after retries (rate limit?)');
}

test('moderation feedback: mute everyone → toast + student banner, unmute restores (real RTC)', async ({ browser }) => {
  test.setTimeout(300_000);
  const api = await pw.newContext({ baseURL: BASE });
  let token = '';
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    const l = await api.post('/api/auth/login', { data: { email: stack.teacherEmail, password: stack.teacherPassword } });
    if (l.status() === 429) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
    token = (await l.json()).accessToken as string;
  }
  const H = { authorization: `Bearer ${token}` };
  const cls = await (await api.post('/api/classes', { headers: H, data: { name: `E2E mute ${Date.now()}`, description: '', color: '#0ea5a5' } })).json();
  const session = await (await api.post('/api/lessons/start', { headers: H, data: { classId: cls.id } })).json();
  const join = await api.post(`/api/lessons/${session.id}/join`, { headers: H });
  const wsUrl = (await join.json()).wsUrl as string;
  if (!(await livekitReachable(wsUrl))) {
    await api.dispose();
    test.skip(true, 'LiveKit not reachable — moderation e2e needs real RTC (LIVEKIT_* env)');
    return;
  }
  const inv = await (await api.post(`/api/classes/${cls.id}/invites`, { headers: H, data: {} })).json();

  const ctxT = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pT = await ctxT.newPage();
  await loginUi(pT, stack.teacherEmail, stack.teacherPassword);
  await pT.goto(`/lesson?classId=${cls.id}`);
  await pT.getByTestId('check-devices').click();
  await pT.getByTestId('join-lesson').click();
  // alone: mute-all is disabled with the hint, and the waiting line is visible
  await expect(pT.getByTestId('waiting-peers')).toBeVisible({ timeout: 30_000 });
  // часть 1 (2026-10-10): модерация переехала в правую панель — её надо открыть
  await openTab(pT, 'people');
  await expect(pT.getByTestId('mute-all')).toBeDisabled();

  const ctxS = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const pS = await ctxS.newPage();
  await pS.goto('/register');
  await pS.getByTestId('reg-code').fill(inv.code as string);
  await pS.getByTestId('reg-email').fill(`e2emute${Date.now()}@x.io`);
  await pS.getByTestId('reg-password').fill('Secret1234');
  await pS.getByTestId('register-step1').click();
  await pS.getByTestId('reg-first').fill('Мут');
  await pS.getByTestId('reg-last').fill('Тест');
  await pS.getByTestId('reg-consent').check();
  await pS.getByTestId('register-submit').click();
  await expect(pS.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
  await pS.goto(`/lesson?classId=${cls.id}`);
  await pS.getByTestId('check-devices').click();
  await pS.getByTestId('join-lesson').click();
  await expect(pS.getByTestId('banner-muted')).toHaveCount(0); // not muted yet

  // teacher: the participant panel lists the student with mic+camera indicators
  await expect(async () => {
    const n = await pT.evaluate(() => document.querySelectorAll('[data-local="0"] video').length);
    expect(n).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  await openTab(pT, 'people');
  await expect(pT.locator('.peer-row')).toHaveCount(1);

  // mute everyone → toast on the teacher, banner + mic off on the student
  await expect(pT.getByTestId('mute-all')).toBeEnabled({ timeout: 20_000 });
  await barClick(pT, 'mute-all');
  await expect(pT.getByTestId('lesson-toast')).toBeVisible({ timeout: 15_000 });
  await expect(pS.getByTestId('banner-muted')).toBeVisible({ timeout: 15_000 });
  // часть 1: эмодзи ушло из текста кнопки в a11y-состояние, поэтому проверяется aria-pressed
  await expect(pS.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
  // a student cannot talk over the class while muted
  await barClick(pS, 'mic-toggle');
  await expect(pS.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'false');

  // unmute everyone → banner gone, mic back on
  await expect(pT.getByTestId('mute-all')).toHaveAttribute('aria-pressed', 'true');
  await barClick(pT, 'mute-all');
  await expect(pS.getByTestId('banner-muted')).toHaveCount(0, { timeout: 15_000 });
  await expect(pS.getByTestId('mic-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  // lecture mode: explicit active state on the control + student banner
  await openMore(pT);
  await pT.getByTestId('lecture-mode').click();
  // часть 1 (2026-10-13): включение лекции подтверждается диалогом — утверждения ниже те же,
  // добавлен только обязательный теперь клик
  await pT.getByTestId('lecture-confirm-ok').click();
  // диалог подтверждения вне меню «Ещё» закрывает его (панель ловит pointerdown), поэтому
  // состояние кнопки проверяется после повторного открытия меню
  await openMore(pT);
  await expect(pT.getByTestId('lecture-mode')).toHaveAttribute('aria-checked', 'true');
  await expect(pS.getByTestId('banner-lecture')).toBeVisible({ timeout: 15_000 });

  await api.post(`/api/lessons/${session.id}/end`, { headers: H, data: {} });
  await ctxT.close();
  await ctxS.close();
  await api.dispose();
});
