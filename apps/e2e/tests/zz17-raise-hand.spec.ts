/**
 * Task 2Б (2026-10-10) — «поднять руку» and «дать слово», in two browsers.
 *
 * The rights matrix, the queue lifetime and the posture of the new table live on the server
 * (`apps/api/test/integration/lesson-hands.test.ts`); the LiveKit permission arithmetic lives in
 * `apps/api/test/unit/floor-permission.test.ts`. What only a browser proves is the point of the
 * feature: a student asks, the teacher answers, and a microphone that lecture mode had locked
 * really does come on — and really goes silent when the word is taken back.
 *
 * Two things this file has to respect about its own fixtures:
 *  - the teacher account of the stack EXPLICITLY chose Russian and a student registered through
 *    the UI has never chosen anything, so the two sides of the same lesson speak different
 *    languages (that is task 1 working as designed). Every label here is therefore matched against
 *    all three bundles instead of assuming one;
 *  - one RTC test needs a media server. It probes the LiveKit URL the API hands out on `/join` (the
 *    same probe `zz-camera`, `zz2-moderation`, `zz4-layout`, `zz13`, `zz16` use) and skips when
 *    unreachable; CI has run a LiveKit container since 6b6a1a3, so in practice it runs there.
 */
import { test, expect, request as pw, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginUi, makeLesson, m, registerStudent, stack, teacherToken, type Ctx } from './boardFixtures';
import { openTab } from './controlBar';

const BASE = `http://127.0.0.1:${stack.port}`;
const STUDENT_PW = 'Secret1234';
type Lesson = { lesson: Record<string, string> };
const BUNDLES = (['ru', 'uz', 'en'] as const).map((lng) => JSON.parse(
  readFileSync(new URL(`../../../packages/shared/src/locales/${lng}.json`, import.meta.url), 'utf8'),
) as Lesson);
/** a label as any of the three shipped languages would write it */
function anyLoc(key: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(BUNDLES.map((b) => esc(b.lesson[key] ?? '')).filter(Boolean).join('|'));
}

async function livekitReachable(ws: string): Promise<boolean> {
  if (!ws) return false;
  try {
    const u = new URL(ws);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test.describe('raise hand and the floor (task 2Б)', () => {
  let api: Ctx;
  let token = '';
  let classId = '';
  let sessionId = '';
  let s1 = '';

  test.beforeAll(async ({ browser }) => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    const lesson = await makeLesson(api, token, 'Рука');
    classId = lesson.classId; sessionId = lesson.sessionId;
    s1 = `hand1${Date.now()}@x.io`;
    const p1 = await (await browser.newContext()).newPage();
    await registerStudent(p1, lesson.inviteCode, 'Ручной', s1);
    await p1.context().close();
  });

  test.afterAll(async () => { await api?.dispose(); });

  /** the queue is REST + socket: it needs no media, so these tests never join a room */
  async function openLesson(browser: Browser, email: string, password: string, viewport = { width: 1280, height: 800 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await loginUi(page, email, password);
    await page.goto(`/lesson?classId=${classId}`);
    await expect(page.getByTestId('hands-panel').or(page.getByTestId('raise-hand'))).toBeVisible({ timeout: 25_000 });
    return { ctx, page };
  }
  const teacherView = (browser: Browser) => openLesson(browser, stack.teacherEmail, stack.teacherPassword);
  const studentView = (browser: Browser) => openLesson(browser, s1, STUDENT_PW, { width: 390, height: 844 });

  /** a student who really joins: fake devices, the device check, then the room */
  async function joinRoom(browser: Browser, email: string, password: string) {
    const view = await openLesson(browser, email, password);
    const join = await api.post(`/api/lessons/${sessionId}/join`, { headers: { authorization: `Bearer ${token}` } });
    expect(join.status(), 'the lesson of this class must be joinable by its teacher').toBe(200);
    const wsUrl = String((await join.json()).wsUrl as string);
    test.skip(!(await livekitReachable(wsUrl)),
      `LiveKit at ${wsUrl} is not reachable — a floor needs a real participant in a real room`);
    await view.page.getByTestId('check-devices').click();
    await expect(view.page.getByTestId('join-lesson')).toBeEnabled({ timeout: 30_000 });
    await view.page.getByTestId('join-lesson').click();
    await expect(view.page.getByTestId('mic-toggle')).toBeVisible({ timeout: 30_000 });
    return view;
  }

  const lectureMode = async (on: boolean) => {
    const r = await api.post(`/api/lessons/${sessionId}/lecture-mode`, {
      headers: { authorization: `Bearer ${token}` }, data: { on },
    });
    expect(r.status(), `lecture-mode ${on}`).toBe(200);
  };
  /*
   * A row is identified by the person, not by an id the test would have to fetch first: every
   * locator below is a prefix match inside the row, so nothing here depends on when `beforeAll`
   * managed to learn the student's id — the first version of this file read `studentId.slice(0, 8)`
   * at collection time, found an empty string, and looked for `hand-row-` forever.
   */
  const row = (page: Page) => page.locator('[data-testid^="hand-row-"]').filter({ hasText: 'Ручной' });
  const grantBtn = (page: Page) => row(page).locator('[data-testid^="hand-grant-"]');
  const revokeBtn = (page: Page) => row(page).locator('[data-testid^="hand-revoke-"]');
  // часть 1 (2026-10-10): очередь поднятых рук живёт во вкладке «Участники» правой панели
  const openQueue = async (page: Page) => {
    await openTab(page, 'people');
    const panel = page.getByTestId('hands-panel');
    await expect(panel).toBeVisible({ timeout: 25_000 });
    return panel;
  };

  test('a raised hand is visible to the teacher, and the student can put it back down', async ({ browser }) => {
    const t = await teacherView(browser);
    const s = await studentView(browser);
    await expect(s.page.getByTestId('raise-hand')).toHaveAccessibleName(anyLoc('raiseHand'));
    await s.page.getByTestId('raise-hand').click();
    await expect(s.page.getByTestId('raise-hand')).toHaveAttribute('aria-pressed', 'true');
    const panel = await openQueue(t.page);
    await expect(panel).toContainText('Ручной');
    m('teacher queue after the student raised', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 120));
    // giving the word is a real control with a real accessible name, not a bare emoji
    await expect(grantBtn(t.page)).toHaveText('🎙+');
    await expect(grantBtn(t.page)).toHaveAttribute('aria-label', anyLoc('giveFloor'));

    await s.page.getByTestId('raise-hand').click();
    await expect(s.page.getByTestId('raise-hand')).toHaveAttribute('aria-pressed', 'false');
    await expect(t.page.getByTestId('hands-empty')).toBeVisible({ timeout: 15_000 });
    await s.ctx.close(); await t.ctx.close();
  });

  test('an empty queue says so instead of showing nothing at all', async ({ browser }) => {
    const t = await teacherView(browser);
    await openQueue(t.page);
    await expect(t.page.getByTestId('hands-empty')).toHaveText(anyLoc('handsNone'));
    await t.ctx.close();
  });

  test('the floor unlocks a lecture-mode microphone, and taking it back silences it', async ({ browser }) => {
    test.setTimeout(240_000);
    // lecture mode through the API: the teacher's own toolbar only exists once THEY have joined,
    // and the queue does not need that — the point of the test is the student's microphone
    await lectureMode(true);
    const t = await teacherView(browser);
    const s = await joinRoom(browser, s1, STUDENT_PW);
    await openQueue(t.page);
    await s.page.getByTestId('raise-hand').click();
    await expect(row(t.page)).toBeVisible({ timeout: 15_000 });
    // the lock this feature exists for: a lecture-mode student cannot publish, and the UI says so
    await expect(s.page.getByTestId('mic-toggle')).toContainText('🔇');
    await expect(row(t.page)).toContainText('🔇');

    await grantBtn(t.page).click();
    await expect(s.page.getByTestId('floor-banner')).toBeVisible({ timeout: 20_000 });
    // the student's OWN browser turned the microphone on — LiveKit refuses to do it remotely
    await expect(s.page.getByTestId('mic-toggle')).toContainText('🎙', { timeout: 20_000 });
    await expect(row(t.page)).toContainText('🎙');
    await expect(revokeBtn(t.page)).toBeVisible({ timeout: 15_000 });

    await revokeBtn(t.page).click();
    await expect(s.page.getByTestId('floor-taken')).toBeVisible({ timeout: 20_000 });
    await expect(s.page.getByTestId('mic-toggle')).toContainText('🔇', { timeout: 20_000 });
    await expect(s.page.getByTestId('floor-banner')).toHaveCount(0);
    // the hand itself stays up: taking the word back is not the same act as lowering it
    await expect(row(t.page)).toBeVisible({ timeout: 15_000 });

    /*
     * The other way a floor ends: the student puts their own hand down. The row and the widened
     * permission must disappear TOGETHER — if they lived in different places, «he stopped talking»
     * and «he can still publish» could disagree forever.
     */
    await grantBtn(t.page).click();
    await expect(s.page.getByTestId('floor-banner')).toBeVisible({ timeout: 20_000 });
    await expect(s.page.getByTestId('mic-toggle')).toContainText('🎙', { timeout: 20_000 });
    await s.page.getByTestId('raise-hand').click();
    await expect(t.page.getByTestId('hands-empty')).toBeVisible({ timeout: 15_000 });
    await expect(s.page.getByTestId('mic-toggle')).toContainText('🔇', { timeout: 20_000 });
    await s.ctx.close(); await t.ctx.close();
    await lectureMode(false);
  });

  test('the queue is server state: it survives a reload on both sides', async ({ browser }) => {
    const t = await teacherView(browser);
    const s = await studentView(browser);
    await s.page.getByTestId('raise-hand').click();
    await openQueue(t.page);
    await expect(row(t.page)).toBeVisible({ timeout: 15_000 });
    await t.page.reload();
    await openQueue(t.page);
    await expect(row(t.page)).toBeVisible({ timeout: 25_000 });
    await s.page.reload();
    await expect(s.page.getByTestId('raise-hand')).toHaveAttribute('aria-pressed', 'true', { timeout: 25_000 });
    await s.page.getByTestId('raise-hand').click();
    await expect(t.page.getByTestId('hands-empty')).toBeVisible({ timeout: 15_000 });
    await s.ctx.close(); await t.ctx.close();
  });
});
