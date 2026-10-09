/**
 * Task 2 (2026-10-09) — comments during a lesson, in two browsers.
 *
 * What only a browser can prove: the panel next to «Участники», the unread counter, the lecture
 * banner with the input still working, the compact button that survives the board becoming the
 * main window, a mute that takes the keyboard away from a student, pins that reorder the list, and
 * a transcript that is read-only after the lesson ends. The rights matrix, the limits and the XSS
 * contract are asserted on the server (apps/api/test/integration/lesson-comments.test.ts) and are
 * deliberately not re-proved here.
 *
 * Pacing: the comment limiter is 5 messages per 10 s PER USER and the suite runs with one worker,
 * so the two students alternate and the deliberate double post in test 3 is the only burst.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginUi, makeLesson, m, registerStudent, stack, teacherToken, type Ctx } from './boardFixtures';

const BASE = `http://127.0.0.1:${stack.port}`;
const STUDENT_PW = 'Secret1234';
/**
 * The shipped strings, read from the same JSON the app bundles: a student registered through the
 * UI without ever picking a language is English (task 1), so this is deterministic — and it fails
 * if the wording is renamed in one place only.
 */
const en = JSON.parse(readFileSync(new URL('../../../packages/shared/src/locales/en.json', import.meta.url), 'utf8')) as
  { lesson: Record<string, string> };

/** the same probe the other RTC specs use: the URL the API hands to the client on join */
async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test.describe('lesson comments (task 2)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let s1 = '';
  let s2 = '';
  let invite2 = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Комментарии');
    classId = lesson.classId; sessionId = lesson.sessionId;
    s1 = `cmt1${Date.now()}@x.io`; s2 = `cmt2${Date.now()}@x.io`;
    // a second one-time code for the second student
    invite2 = String((await (await api.post(`/api/classes/${classId}/invites`, {
      headers: { authorization: `Bearer ${token}` }, data: {},
    })).json()).code as string);
    // both accounts go through the real registration form (it also accepts the policy)
    const p1 = await (await browser.newContext()).newPage();
    await registerStudent(p1, lesson.inviteCode, 'Коммент', s1);
    await p1.context().close();
    const p2 = await (await browser.newContext()).newPage();
    await registerStudent(p2, invite2, 'Изоль', s2);
    await p2.context().close();
  });

  test.afterAll(async () => { await api?.dispose(); });

  /** open the lesson and the comments panel; the panel needs no RTC, so nobody joins a room */
  async function inLesson(browser: Browser, email: string, password: string, viewport = { width: 1280, height: 800 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    await expect(page.getByTestId('comments-open')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('comments-open').click();
    await expect(page.getByTestId('comments-panel')).toBeVisible({ timeout: 15_000 });
    return { ctx, page };
  }
  const teacher = (browser: Browser, viewport?: { width: number; height: number }) =>
    inLesson(browser, stack.teacherEmail, stack.teacherPassword, viewport);
  const student = (browser: Browser, email: string) =>
    inLesson(browser, email, STUDENT_PW, { width: 390, height: 844 });

  async function say(page: Page, text: string) {
    await page.getByTestId('comments-input').fill(text);
    await page.getByTestId('comments-send').click();
    await expect(page.locator('.lc-text', { hasText: text })).toBeVisible({ timeout: 15_000 });
  }
  const mode = (page: Page, value: 'on' | 'off' | 'slow') => page.getByTestId('comments-mode').selectOption(value);
  const item = (page: Page, text: string) => page.locator('.lc-item', { hasText: text });

  test('a student writes in lecture mode and the teacher sees it without reloading', async ({ browser }) => {
    // lecture mode through the API: the UI switch sits behind the RTC toolbar
    expect((await api.post(`/api/lessons/${sessionId}/lecture-mode`, {
      headers: { authorization: `Bearer ${token}` }, data: { on: true },
    })).status()).toBe(200);

    const t = await teacher(browser);
    const s = await student(browser, s1);
    await expect(s.page.getByTestId('comments-lecture-banner')).toBeVisible();
    await expect(s.page.getByTestId('comments-input')).toBeEnabled();
    await say(s.page, 'а можно пример из жизни?');
    await expect(t.page.locator('.lc-text', { hasText: 'а можно пример из жизни?' })).toBeVisible({ timeout: 15_000 });
    m('lecture-mode comment reached the teacher over the socket', 'ok');
    await api.post(`/api/lessons/${sessionId}/lecture-mode`, { headers: { authorization: `Bearer ${token}` }, data: { on: false } });
    await t.ctx.close(); await s.ctx.close();
  });

  test('the teacher mutes a student for this lesson and lifts it again', async ({ browser }) => {
    const t = await teacher(browser);
    const s = await student(browser, s2);
    await say(s.page, 'меня заглушат?');
    const muteBtn = item(t.page, 'меня заглушат?').locator('[data-testid^=comment-mute-btn-]');
    await expect(muteBtn).toBeVisible({ timeout: 15_000 });
    await muteBtn.click();
    // the student's own panel is told: the keyboard goes away and the placeholder explains
    await expect(s.page.getByTestId('comments-input')).toBeDisabled({ timeout: 15_000 });
    await expect(s.page.getByTestId('comments-input')).toHaveAttribute('placeholder', en.lesson.commentsMutedPlaceholder);
    await item(t.page, 'меня заглушат?').locator('[data-testid^=comment-mute-btn-]').click();
    await expect(s.page.getByTestId('comments-input')).toBeEnabled({ timeout: 15_000 });
    await t.ctx.close(); await s.ctx.close();
  });

  test('slow mode holds a student to one message per 10 seconds', async ({ browser }) => {
    const t = await teacher(browser);
    await mode(t.page, 'slow');
    const s = await student(browser, s1);
    await say(s.page, 'первый в медленном режиме');
    await s.page.getByTestId('comments-input').fill('второй сразу');
    await s.page.getByTestId('comments-send').click();
    await expect(s.page.getByTestId('comments-error')).toBeVisible({ timeout: 15_000 });
    await expect(s.page.locator('.lc-text', { hasText: 'второй сразу' })).toHaveCount(0);
    await mode(t.page, 'on');
    await t.ctx.close(); await s.ctx.close();
  });

  test('off stops writing but keeps the panel readable', async ({ browser }) => {
    const t = await teacher(browser);
    await mode(t.page, 'off');
    const s = await student(browser, s2);
    await expect(s.page.getByTestId('comments-input')).toBeDisabled();
    await expect(s.page.locator('.lc-text', { hasText: 'первый в медленном режиме' })).toBeVisible();
    await expect(t.page.getByTestId('comments-off-banner')).toBeVisible();
    await mode(t.page, 'on');
    await t.ctx.close(); await s.ctx.close();
  });

  test('three pins sit on top and a fourth is refused; the answer flag is the teacher\'s', async ({ browser }) => {
    const t = await teacher(browser);
    for (const text of ['важно 1', 'важно 2', 'важно 3']) await say(t.page, text);
    for (const text of ['важно 1', 'важно 2', 'важно 3']) {
      await item(t.page, text).locator('[data-testid^=comment-pin-btn-]').click();
      await expect(t.page.locator(`.lc-item:has-text("${text}")`)).toHaveClass(/lc-pinned/, { timeout: 15_000 });
    }
    await say(t.page, 'важно 4');
    await item(t.page, 'важно 4').locator('[data-testid^=comment-pin-btn-]').click();
    await expect(t.page.getByTestId('comments-error')).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      const first3 = await t.page.locator('.lc-item').evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent ?? ''));
      expect(['важно 1', 'важно 2', 'важно 3'].every((x) => first3.some((f) => f.includes(x)))).toBe(true);
    }).toPass({ timeout: 15_000 });
    await item(t.page, 'важно 1').locator('[data-testid^=comment-answer-btn-]').click();
    await expect(item(t.page, 'важно 1').locator('[data-testid^=comment-answered-]')).toBeVisible({ timeout: 15_000 });
    await t.ctx.close();
  });

  test('a student deletes their own comment and it vanishes for the teacher', async ({ browser }) => {
    const t = await teacher(browser);
    await mode(t.page, 'on');
    const s = await student(browser, s1);
    await say(s.page, 'удалю это');
    await expect(t.page.locator('.lc-text', { hasText: 'удалю это' })).toBeVisible({ timeout: 15_000 });
    await item(s.page, 'удалю это').locator('[data-testid^=comment-delete-btn-]').click();
    await expect(s.page.locator('.lc-text', { hasText: 'удалю это' })).toHaveCount(0, { timeout: 15_000 });
    await expect(t.page.locator('.lc-text', { hasText: 'удалю это' })).toHaveCount(0, { timeout: 15_000 });
    await t.ctx.close(); await s.ctx.close();
  });

  test('markup stays a string, and a reload brings the transcript back', async ({ browser }) => {
    const tw = await teacher(browser);
    await mode(tw.page, 'on');
    await tw.ctx.close();
    const s = await student(browser, s2);
    let dialog = false;
    s.page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });
    const payload = '<img src=x onerror=alert(1)>';
    await s.page.getByTestId('comments-input').fill(payload);
    await s.page.getByTestId('comments-send').click();
    await expect(s.page.locator('.lc-text', { hasText: payload })).toBeVisible({ timeout: 15_000 });
    expect(dialog).toBe(false);
    await s.page.reload();
    await expect(s.page.getByTestId('comments-open')).toBeVisible({ timeout: 25_000 });
    await s.page.getByTestId('comments-open').click();
    await expect(s.page.locator('.lc-text', { hasText: payload })).toBeVisible({ timeout: 15_000 });
    await expect(s.page.locator('.lc-text', { hasText: 'первый в медленном режиме' })).toBeVisible();
    await s.ctx.close();
  });

  test('the unread counter counts the other side and clears on read', async ({ browser }) => {
    const pre = await teacher(browser);
    await mode(pre.page, 'on');
    await pre.ctx.close();
    const s = await student(browser, s1);
    await s.page.getByTestId('comments-close').click();
    const t = await teacher(browser);
    await say(t.page, 'это вы не прочитали');
    await s.page.getByTestId('comments-open').click();
    await expect(s.page.getByTestId('comments-unread')).toBeVisible({ timeout: 15_000 });
    // reading the panel clears it, and it stays cleared across a reopen
    await s.page.getByTestId('comments-close').click();
    await expect(async () => {
      await s.page.getByTestId('comments-open').click();
      await expect(s.page.getByTestId('comments-unread')).toHaveCount(0, { timeout: 4_000 });
    }).toPass({ timeout: 30_000 });
    await t.ctx.close(); await s.ctx.close();
  });

  test('the compact button stays reachable when the board is the main window', async ({ browser }) => {
    const join = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(join.status()).toBe(200);
    const wsUrl = String((await join.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)), `LiveKit at ${wsUrl} is not reachable — the board-as-main-window view needs a joined room (LIVEKIT_* env; CI skips it, the panel itself is covered by the tests above)`);
    const t = await teacher(browser);
    // joining media needs the device preview first (the button is disabled until it ran), and a
    // real LiveKit round-trip on a loaded machine needs more than the default budget
    test.setTimeout(240_000);
    await t.page.getByTestId('check-devices').click();
    await expect(t.page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await t.page.getByTestId('join-lesson').click();
    await expect(t.page.getByTestId('board-toggle')).toBeVisible({ timeout: 30_000 });
    // diagnostic for this RTC-only path: what the board endpoint actually answered
    t.page.on('response', (r) => {
      if (!r.url().includes('/board')) return;
      void r.text().then((b) => m('board response', { status: r.status(), body: b.slice(0, 80) }));
    });
    // the compact button replaces the tab while the board owns the window, and it steps aside
    // for the panel it opens — so the panel has to be closed before the button is expected
    await t.page.getByTestId('comments-close').click();
    await t.page.getByTestId('board-toggle').click();
    await expect(t.page.getByTestId('lesson-stage')).toBeVisible({ timeout: 15_000 });
    await expect(t.page.getByTestId('comments-fab')).toBeVisible({ timeout: 25_000 });
    await t.page.getByTestId('comments-fab').click();
    await expect(t.page.getByTestId('comments-panel')).toBeVisible();
    await t.ctx.close();
  });

  test('after the lesson ends the transcript stays readable for the teacher, without a keyboard', async ({ browser }) => {
    const t = await teacher(browser);          // present while the lesson is live
    await mode(t.page, 'on');
    await say(t.page, 'последнее перед концом');
    expect((await api.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` }, data: {} })).status()).toBe(200);
    await expect(t.page.locator('.lc-text', { hasText: 'последнее перед концом' })).toBeVisible({ timeout: 15_000 });
    await expect(t.page.getByTestId('comments-input')).toHaveCount(0);
    // and a student who opens the same page after the end gets no panel at all
    const s = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const sp = await s.newPage();
    await loginUi(sp, s2, STUDENT_PW);
    await sp.goto(`/lesson?classId=${classId}`);
    await expect(sp.getByTestId('comments-open')).toHaveCount(0);
    await s.close();
    await t.ctx.close();
  });
});
