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

async function apiLogin(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: stack.teacherEmail, password: stack.teacherPassword }),
  });
  if (!r.ok) throw new Error(`teacher api login ${r.status}`);
  return (await r.json()).accessToken as string;
}

test.describe.serial('chat (item 8): teacher and student exchange in realtime', () => {
  const stamp = Date.now();
  let classId = '';
  let code = '';
  const stuEmail = `e2echat${stamp}@x.io`;

  test('setup: class + invite via API', async () => {
    const tok = await apiLogin();
    const cls = await (await fetch(`${BASE}/api/classes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: `E2E Чат ${stamp}`, description: '', color: '#0ea5a5' }),
    })).json();
    classId = cls.id as string;
    const inv = await (await fetch(`${BASE}/api/classes/${classId}/invites`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}',
    })).json();
    code = inv.code as string;
    expect(classId && code).toBeTruthy();
  });

  test('student joins via UI and sees the chat tab', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/register');
    await page.getByTestId('reg-code').fill(code);
    await page.getByTestId('reg-email').fill(stuEmail);
    await page.getByTestId('reg-password').fill('Secret1234');
    await page.getByTestId('register-step1').click();
    await expect(page.getByTestId('reg-first')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('reg-first').fill('Чатист');
    await page.getByTestId('reg-last').fill('Е2Е');
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await page.goto('/chat');
    await expect(page.getByTestId('chat-item').filter({ hasText: `E2E Чат ${stamp}` })).toBeVisible();
    await ctx.close();
  });

  test('exchange: teacher writes → student sees live; student replies → teacher sees live', async ({ browser }) => {
    const tCtx = await browser.newContext();
    const sCtx = await browser.newContext();
    const tp = await tCtx.newPage();
    await tp.goto('/login');
    await tp.getByTestId('email').fill(stack.teacherEmail);
    await tp.getByTestId('password').fill(stack.teacherPassword);
    await tp.getByTestId('login-submit').click();
    await expect(tp.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });

    const sp = await sCtx.newPage();
    await sp.goto('/login');
    await sp.getByTestId('email').fill(stuEmail);
    await sp.getByTestId('password').fill('Secret1234');
    await sp.getByTestId('login-submit').click();
    await expect(sp.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });

    await tp.goto(`/chat/${classId}`);
    await sp.goto(`/chat/${classId}`);
    // BOTH sockets must be in the room before the first send, else the push is
    // missed and we'd wait on the 30 s poll fallback (past the 25 s assertion)
    await expect(tp.getByTestId('chat-conn')).toContainText(/в сети|online|onlayn/, { timeout: 15_000 });
    await expect(sp.getByTestId('chat-conn')).toContainText(/в сети|online|onlayn/, { timeout: 15_000 });

    // teacher → student WITHOUT reload on the student side (realtime push)
    await tp.getByTestId('chat-input').fill('Проверка realtime ✅');
    await tp.getByTestId('chat-send').click();
    await expect(sp.getByTestId('chat-msg').filter({ hasText: 'Проверка realtime ✅' }))
      .toBeVisible({ timeout: 25_000 });

    // student replies; teacher receives live; XSS payload stays plain text
    await sp.getByTestId('chat-input').fill('<b>жирный?</b> & <script>alert(1)</script>');
    await sp.getByTestId('chat-send').click();
    const mine = tp.getByTestId('chat-msg').filter({ hasText: 'жирный?' });
    await expect(mine).toBeVisible({ timeout: 25_000 });
    // the reply must be shown as literal text — no <b> element rendered inside it
    await expect(mine.locator('b')).toHaveCount(0);
    await expect(mine.locator('script')).toHaveCount(0);

    await tCtx.close(); await sCtx.close();
  });

  test('menu item 7: edit own message → «изменено» live on the peer; copy toast; delete via menu', async ({ browser }) => {
    const tCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const sCtx = await browser.newContext();
    const tp = await tCtx.newPage();
    await tp.goto('/login');
    await tp.getByTestId('email').fill(stack.teacherEmail);
    await tp.getByTestId('password').fill(stack.teacherPassword);
    await tp.getByTestId('login-submit').click();
    await expect(tp.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    const sp = await sCtx.newPage();
    await sp.goto('/login');
    await sp.getByTestId('email').fill(stuEmail);
    await sp.getByTestId('password').fill('Secret1234');
    await sp.getByTestId('login-submit').click();
    await expect(sp.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await tp.goto(`/chat/${classId}`);
    await sp.goto(`/chat/${classId}`);
    await expect(tp.getByTestId('chat-conn')).toContainText(/в сети|online|onlayn/, { timeout: 15_000 });
    await expect(sp.getByTestId('chat-conn')).toContainText(/в сети|online|onlayn/, { timeout: 15_000 });

    const marker = `Точка ${stamp}`;
    await tp.getByTestId('chat-input').fill(marker);
    await tp.getByTestId('chat-send').click();
    const bubble = tp.getByTestId('chat-msg').filter({ hasText: marker });
    await expect(sp.getByTestId('chat-msg').filter({ hasText: marker })).toBeVisible({ timeout: 25_000 });

    // the old in-bubble «×» is gone — actions live behind «⋯»
    await expect(tp.getByTestId('chat-del')).toHaveCount(0);
    await bubble.getByTestId('chat-more').click();
    await expect(bubble.getByTestId('chat-menu')).toBeVisible();
    await bubble.getByTestId('chat-act-edit').click();
    await bubble.getByTestId('chat-edit-input').fill(`${marker} — правка`);
    await bubble.getByTestId('chat-edit-save').click();
    // author sees the «изменено» tag; the peer gets the new text over the socket, no reload
    await expect(bubble.getByTestId('chat-edited')).toBeVisible();
    const peer = sp.getByTestId('chat-msg').filter({ hasText: 'правка' });
    await expect(peer).toBeVisible({ timeout: 25_000 });
    await expect(peer.getByTestId('chat-edited')).toBeVisible({ timeout: 25_000 });

    // copy → toast «Скопировано»
    await bubble.getByTestId('chat-more').click();
    await bubble.getByTestId('chat-act-copy').click();
    await expect(tp.getByTestId('chat-toast')).toBeVisible();

    // delete asks for a confirm, then the message is gone on both sides
    tp.once('dialog', (d) => void d.accept());
    await bubble.getByTestId('chat-more').click();
    await bubble.getByTestId('chat-act-del').click();
    await expect(tp.getByTestId('chat-msg').filter({ hasText: marker })).toHaveCount(0, { timeout: 25_000 });
    await expect(sp.getByTestId('chat-msg').filter({ hasText: marker })).toHaveCount(0, { timeout: 25_000 });

    await tCtx.close(); await sCtx.close();
  });

  test('teacher mode announce blocks student post in UI', async ({ browser }) => {
    const tok = await apiLogin();
    await fetch(`${BASE}/api/classes/${classId}/chat/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ mode: 'announce' }),
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByTestId('email').fill(stuEmail);
    await page.getByTestId('password').fill('Secret1234');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
    await page.goto(`/chat/${classId}`);
    await expect(page.getByTestId('chat-locked')).toBeVisible();
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await ctx.close();
    // back to on for cleanliness
    await fetch(`${BASE}/api/classes/${classId}/chat/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ mode: 'on' }),
    });
  });
});
