/**
 * Part 1(а) + 1(д) — how board pages behave, measured, and what the task asks them to do.
 *
 * Each test is SELF-CONTAINED (its own class, lesson and invite) — shared closure state across
 * tests made this file time out under load and the measurements became unreproducible.
 *
 * Two ground truths, because neither alone answers the questions:
 *  - the DB rows `whiteboards (session_id, page_no) → snapshot/title` — what the server saved;
 *  - pixels of Excalidraw's `canvas.excalidraw__canvas.static` (same-origin 2D context) — what a
 *    screen actually shows. The other canvas is the hit-test buffer.
 *
 * Drawing and the ink measurement live in boardFixtures.ts: `paint(page,'A'|'B'|'C')` puts a
 * rectangle in that board's own slot and `inkOf(page,'A')` counts the ink in the slot's window.
 * The windows are quadrant-sized on purpose: the canvas content sits ~70 px away from the
 * element box (measured), so a tight window would read the wrong board.
 */
import { test, expect, request as pw } from '@playwright/test';
import postgres from 'postgres';
import {
  BASE,
  inkOf,
  loginUi,
  m,
  makeLesson,
  openLesson,
  paint,
  registerStudent,
  stack,
  teacherToken,
  type Ctx,
  pinTeacherRussian,
} from './boardFixtures';

/*
 * Язык интерфейса закрепляется явно (pinTeacherRussian в beforeAll), а не «как получится»:
 * каталог Postgres e2e-стека переживает перезапуск (embedded-postgres persistent: true), а
 * скрипты съёмки скриншотов меняют язык сид-учителя (ru→uz→en) в той же базе — и делают его
 * locale_explicit, то есть профиль побеждает язык браузера. Без закрепленья «Доска 1» приезжает
 * как «Board 1», и тест падает из-за состояния чужого прогона (замерено 2026-10-11).
 */

const DB = `postgres://klass:klass@127.0.0.1:5455/klass`;

/** The board rows as the database sees them — element positions included, for independence. */
async function dbBoard(sessionId: string) {
  const sql = postgres(DB, { max: 1 });
  try {
    const rows = await sql`select page_no, title, snapshot from whiteboards where session_id = ${sessionId} order by page_no`;
    return rows.map((r) => ({
      pageNo: Number(r.page_no),
      title: String(r.title ?? ''),
      elements: ((r.snapshot as { elements: ({ id: string; x?: number; type?: string; isDeleted?: boolean })[] })
        .elements ?? []).filter((e) => !e.isDeleted && e.type !== 'lock'),
    }));
  } finally { await sql.end({ timeout: 5 }); }
}


test.describe('board pages: independence, names, rights (task 1)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    await pinTeacherRussian(api, token);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('teacher: three boards keep their own content across switching and a reload', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E Доски независимы');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await loginUi(p, stack.teacherEmail, stack.teacherPassword);
    await openLesson(p, classId);

    m('rows before any edit (a page row is created on the first persist)', await dbBoard(sessionId));
    await paint(p, 'A');
    m('on screen after drawing on board 1', { A: await inkOf(p, 'A'), B: await inkOf(p, 'B') });
    m('rows right after the stroke (autosave fires at 10 s; a switch flushes earlier)', await dbBoard(sessionId));

    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(1_200);
    const onPage2 = { A: await inkOf(p, 'A'), B: await inkOf(p, 'B') };
    m('the fresh board 2 must show nothing from board 1', onPage2);
    expect(onPage2.A, 'board 1 ink is gone when board 2 is open').toBeLessThan(20);

    await paint(p, 'B');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-3')).toBeVisible({ timeout: 15_000 });
    await p.getByTestId('board-tab-1').click();
    await p.waitForTimeout(1_500);
    const backOn1 = { A: await inkOf(p, 'A'), B: await inkOf(p, 'B') };
    m('back on board 1', backOn1);
    expect(backOn1.A, 'board 1 shows its own rectangle again').toBeGreaterThan(50);
    expect(backOn1.B, 'board 2 ink is NOT visible on board 1').toBeLessThan(20);

    const rows = await dbBoard(sessionId);
    m('rows after the round trip', rows.map((r) => ({ p: r.pageNo, n: r.elements.length, xs: r.elements.map((e) => e.x) })));
    const ids = new Set(rows[0]!.elements.map((e) => e.id));
    expect(rows[1]!.elements.filter((e) => ids.has(e.id)).length, 'no element is shared between boards').toBe(0);

    await p.reload();
    await openLesson(p, classId);
    const afterReload = { A: await inkOf(p, 'A'), B: await inkOf(p, 'B') };
    m('after a reload on board 1', afterReload);
    expect(afterReload.A, 'the saved board 1 survives a reload').toBeGreaterThan(50);
    await ctx.close();
  });

  test('teacher: tabs are named «Доска N», rename sticks, the menu renames/duplicates/deletes', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E Доски именованы');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await loginUi(p, stack.teacherEmail, stack.teacherPassword);
    await openLesson(p, classId);

    const labels = await p.locator('[data-testid=board] [data-testid=board-tabs] button').allTextContents();
    m('tab labels (task 1б wants «Доска 1», no «+ p.»)', labels);
    await expect(p.locator('[data-testid=board-tab-1] .board-tab-name'), 'the first tab reads «Доска 1»')
      .toHaveText('Доска 1');
    await paint(p, 'A');

    // add a board through the renamed button
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });

    // rename board 1 through the per-tab menu
    await p.getByTestId('board-tab-1').click();
    await p.getByTestId('board-menu-1').click();
    // `toBeVisible()` alone is not enough: a popover clipped by the scrolling strip, or hanging
    // off the edge of a phone, still has a box. The 2026-10-08 screenshot review found exactly that.
    const pop1 = await p.getByTestId('board-pop-1').boundingBox();
    m('menu popover box (1280)', pop1);
    expect(pop1, 'the tab menu is rendered').toBeTruthy();
    expect(pop1!.x, 'the menu is inside the left edge').toBeGreaterThanOrEqual(0);
    expect(pop1!.x + pop1!.width, 'the menu is inside the right edge')
      .toBeLessThanOrEqual(p.viewportSize()!.width + 1);
    expect(pop1!.y + pop1!.height, 'the menu is inside the bottom edge')
      .toBeLessThanOrEqual(p.viewportSize()!.height + 1);
    await p.getByTestId('board-rename').click();
    await p.getByTestId('board-rename-input').fill('Алгебра · ʻgʻ oʻ');
    await p.keyboard.press('Enter');
    await expect(p.getByTestId('board-tab-1')).toContainText('Алгебра', { timeout: 10_000 });

    // 40-character cap, plain text only
    await p.getByTestId('board-menu-1').click();
    await p.getByTestId('board-rename').click();
    await p.getByTestId('board-rename-input').fill('  <b>ож очень длинное название доски которое превысивает сорок символов</b>\nсо строкой  ');
    await p.keyboard.press('Enter');
    // wait for this rename (not the previous one) to reach the tab before reading it
    await expect(p.locator('[data-testid=board-tab-1] .board-tab-name')).toContainText('ож очень', { timeout: 10_000 });
    const shown = (await p.locator('[data-testid=board-tab-1] .board-tab-name').innerText()).trim();
    m('renamed tab after a markup + oversize input', shown);
    expect(shown.length, 'a tab label is capped at 40 characters').toBeLessThanOrEqual(40);
    expect(shown.includes('<b>'), 'the label keeps the typed characters as TEXT').toBe(true);
    // the decisive part: nothing of it became an element in the DOM
    const html = await p.locator('[data-testid=board-tab-1] .board-tab-name').innerHTML();
    expect(html, 'no markup is injected by a board name').not.toContain('<b>');
    expect(html, 'the browser got escaped text').toContain('&lt;b&gt;');

    const rows1 = await dbBoard(sessionId);
    m('rows with titles', rows1.map((r) => ({ p: r.pageNo, title: r.title, n: r.elements.length })));
    expect(rows1.find((r) => r.pageNo === 1)?.title, 'the server stored the sanitized title').toBeTruthy();

    // duplicate board 1 → its ink appears on a new board
    await p.getByTestId('board-menu-1').click();
    await p.getByTestId('board-duplicate').click();
    await expect(p.getByTestId('board-tab-3')).toBeVisible({ timeout: 15_000 });
    const dup = await dbBoard(sessionId);
    m('rows after duplicate', dup.map((r) => ({ p: r.pageNo, title: r.title, n: r.elements.length })));
    expect(dup.find((r) => r.pageNo === 3)?.elements.length, 'the copy carries the source content').toBeGreaterThan(0);

    // delete the copy with a confirmation, and the last board cannot be deleted
    await p.getByTestId('board-menu-3').click();
    await p.getByTestId('board-delete').click();
    await expect(p.getByTestId('board-delete-confirm')).toBeVisible({ timeout: 10_000 });
    await p.getByTestId('board-delete-yes').click();
    await expect(p.getByTestId('board-tab-3')).toHaveCount(0, { timeout: 15_000 });
    m('rows after delete', (await dbBoard(sessionId)).map((r) => ({ p: r.pageNo, n: r.elements.length })));

    // down to the last board, which can only be cleared — never deleted (task 1в)
    let left = (await dbBoard(sessionId)).map((r) => r.pageNo);
    while (left.length > 1) {
      const victim = Math.max(...left);
      await p.getByTestId(`board-menu-${victim}`).click();
      await p.getByTestId('board-delete').click();
      await expect(p.getByTestId('board-delete-confirm'), `confirm dialog for board ${victim}`)
        .toBeVisible({ timeout: 10_000 });
      await p.getByTestId('board-delete-yes').click();
      await expect(p.getByTestId(`board-tab-${victim}`)).toHaveCount(0, { timeout: 15_000 });
      left = (await dbBoard(sessionId)).map((r) => r.pageNo);
    }
    expect(left, 'one board is left').toHaveLength(1);
    await p.getByTestId(`board-menu-${left[0]}`).click();
    const lastDelete = p.getByTestId('board-delete');
    await expect(lastDelete, 'the last board offers no usable Delete').toBeDisabled();
    await expect(lastDelete).toHaveAttribute('title', /последн|last|oxir/i);
    await p.keyboard.press('Escape');
    expect((await dbBoard(sessionId)).map((r) => r.pageNo), 'the last board survives').toEqual(left);
    await ctx.close();
  });

  test('clearing the last board really wipes it: on disk, on screen and for the picker', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E Очистка доски');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    p.on('dialog', (d) => void d.accept());           // «Очистить доску?» is a confirm dialog
    await loginUi(p, stack.teacherEmail, stack.teacherPassword);
    await openLesson(p, classId);
    await paint(p, 'A');
    await p.waitForTimeout(11_000);                   // the 10 s autosave
    const before = await dbBoard(sessionId);
    m('rows before the clear', before.map((r) => ({ p: r.pageNo, n: r.elements.length })));
    expect(before.find((r) => r.pageNo === 1)?.elements.length, 'the board has ink on disk').toBeGreaterThan(0);

    await p.getByTestId('board-clear').click();
    await p.waitForTimeout(1_200);
    await p.getByTestId('board-new').click();         // switching pages flushes the cleared one
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(1_500);
    const after = await dbBoard(sessionId);
    m('rows after the clear', after.map((r) => ({ p: r.pageNo, n: r.elements.length })));
    expect(after.find((r) => r.pageNo === 1)?.elements.length ?? -1,
      'the cleared board is stored with nothing on it').toBe(0);

    await p.getByTestId('board-tab-1').click();
    await expect.poll(() => inkOf(p, 'A'), 'the cleared board shows no ink').toBeLessThan(20);
    await ctx.close();
  });

  test('the tab menu of a scrolled-into-view board still fits a 390 px screen', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId } = await makeLesson(api, token, 'E2E Меню на телефоне');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await loginUi(p, stack.teacherEmail, stack.teacherPassword);
    await openLesson(p, classId);

    // enough boards that the strip has to scroll at this width
    for (let i = 0; i < 4; i++) {
      await p.getByTestId('board-new').click();
      await expect(p.getByTestId(`board-tab-${i + 2}`)).toBeVisible({ timeout: 15_000 });
    }
    const strip = p.getByTestId('board-tabs');
    const geometry = await strip.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    m('strip at 390 px', geometry);
    expect(geometry.scrollWidth, 'the strip is wider than the viewport, so it scrolls').toBeGreaterThan(geometry.clientWidth);

    // the last tab is off the right edge until it is scrolled to; its menu must still land on screen
    await p.getByTestId('board-menu-5').click();
    const pop = await p.getByTestId('board-pop-5').boundingBox();
    m('menu popover box (390)', pop);
    expect(pop, 'the menu is open').toBeTruthy();
    expect(pop!.x, 'not past the left edge').toBeGreaterThanOrEqual(0);
    expect(pop!.x + pop!.width, 'not past the right edge').toBeLessThanOrEqual(391);
    expect(pop!.y + pop!.height, 'not past the bottom edge').toBeLessThanOrEqual(845);
    await expect(p.getByTestId('board-rename')).toBeVisible();
    await expect(p.getByTestId('board-duplicate')).toBeVisible();
    await ctx.close();
  });

  test('students: view-only, they follow the teacher between boards, a late joiner gets the scene', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, sessionId, linkUrl } = await makeLesson(api, token, 'E2E Доски ученик');

    // the teacher draws on board 1 and adds board 2 with its own ink
    const ctxT = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const t = await ctxT.newPage();
    await loginUi(t, stack.teacherEmail, stack.teacherPassword);
    await openLesson(t, classId);
    await paint(t, 'A');
    await t.getByTestId('board-new').click();
    await expect(t.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await paint(t, 'B');
    await t.getByTestId('board-tab-1').click();
    await t.waitForTimeout(1_000);

    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const s = await ctxS.newPage();
    await registerStudent(s, linkUrl, 'Наблюдатель', `e2board${Date.now()}@x.io`);
    await openLesson(s, classId);

    const studentUi = await s.evaluate(() => {
      const card = document.querySelector('[data-testid=board]')!;
      return {
        buttons: [...card.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 10),
        readonly: card.textContent?.includes('👁') ?? false,
        canRename: !!card.querySelector('[data-testid=board-menu-1]'),
        canNew: !!card.querySelector('[data-testid=board-new]'),
      };
    });
    m('student board surface', studentUi);
    expect(studentUi.readonly, 'the student sees the 👁 view-only hint').toBe(true);
    expect(studentUi.canNew, 'no «+ Доска» for students').toBe(false);
    expect(studentUi.canRename, 'no tab menu for students').toBe(false);

    const on1 = { A: await inkOf(s, 'A'), B: await inkOf(s, 'B') };
    m('student on board 1', on1);
    expect(on1.A, 'the student sees the teacher current board content').toBeGreaterThan(50);

    await t.getByTestId('board-tab-2').click();
    await expect(async () => {
      const now = await inkOf(s, 'B');
      expect(now, 'the student follows the teacher to board 2').toBeGreaterThan(50);
    }).toPass({ timeout: 20_000 });
    m('student after the teacher switched to board 2', { A: await inkOf(s, 'A'), B: await inkOf(s, 'B') });

    const ctxL = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const late = await ctxL.newPage();
    await loginUi(late, stack.teacherEmail, stack.teacherPassword);
    m('rows on disk when the late joiner opens', (await dbBoard(sessionId)).map((r) => ({ p: r.pageNo, ids: r.elements.map((e) => e.id) })));
    await openLesson(late, classId);
    const lateInk = { A: await inkOf(late, 'A'), B: await inkOf(late, 'B') };
    m('late joiner (teacher is on board 2)', lateInk);
    expect(lateInk.B, 'a late joiner gets the current board with its snapshot').toBeGreaterThan(50);
    expect(lateInk.A, 'and not the other board ink').toBeLessThan(20);

    await ctxS.close(); await ctxT.close(); await ctxL.close();
    await api.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  });

  test('rights: a student cannot create, rename, duplicate, delete or switch boards', async () => {
    test.setTimeout(180_000);
    const { sessionId, inviteToken } = await makeLesson(api, token, 'E2E Доски права');

    // the teacher creates a second board first, so "nothing changed" is a real observation
    const tTr = await api.post('/api/ws/ticket', { headers: { authorization: `Bearer ${token}` }, data: { sessionId } });
    const tWs = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(String((await tTr.json()).ticket))}`);
    await new Promise<void>((res, rej) => { tWs.onopen = () => res(); tWs.onerror = () => rej(new Error('teacher ws failed')); });
    await new Promise((r) => setTimeout(r, 600));
    tWs.send(JSON.stringify({ type: 'newpage' }));
    await new Promise((r) => setTimeout(r, 800));
    tWs.close();
    await new Promise((r) => setTimeout(r, 400));

    // ученик заводится одноразовой ССЫЛКОЙ: `/api/auth/register` с кодом класса выведен (410),
    // `/api/invitations/register` создаёт аккаунт, добавляет в класс и выдаёт токен сессии
    const reg = await api.post('/api/invitations/register', {
      data: { token: inviteToken, firstName: 'Права', lastName: 'Тест', email: `brdr${Date.now()}@x.io`, password: 'Secret1234' },
    });
    expect(reg.ok(), `student register ${reg.status()}`).toBe(true);
    const studentToken = String((await reg.json()).accessToken as string);
    expect(studentToken).toBeTruthy();

    const tr = await api.post('/api/ws/ticket', { headers: { authorization: `Bearer ${studentToken}` }, data: { sessionId } });
    expect(tr.status()).toBe(200);
    const ticket = String((await tr.json()).ticket as string);

    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
    const seen: Record<string, unknown>[] = [];
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws failed')); });
    ws.onmessage = (ev) => seen.push(JSON.parse(ev.data as string));
    await new Promise((r) => setTimeout(r, 800));
    expect(seen[0], 'the student connects as read-only').toMatchObject({ type: 'init', canEdit: false });
    const before = await dbBoard(sessionId);
    // the room state as the teacher left it, read through the student's own init
    const beforePages = ((seen[0] as { pages?: number[] }).pages ?? []).slice().sort((a, b) => a - b);
    expect(beforePages.length, 'the teacher created a second board').toBeGreaterThanOrEqual(1);
    for (const msg of [
      { type: 'newpage' },
      { type: 'rename', page: 1, title: 'взломанное имя' },
      { type: 'duplicate', page: 1 },
      { type: 'delpage', page: 1 },
      { type: 'switch', page: 2 },
    ]) ws.send(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 1_500));
    const after = await dbBoard(sessionId);
    m('student page-verb attempts: rows before/after', {
      before: before.map((r) => r.pageNo), after: after.map((r) => ({ p: r.pageNo, title: r.title })),
    });
    expect(after.map((r) => r.pageNo), 'a student cannot create or delete boards').toEqual(before.map((r) => r.pageNo));
    expect(after.every((r) => r.title !== 'взломанное имя'), 'a student cannot rename boards').toBe(true);
    expect(seen.filter((s) => s.type === 'pages' || s.type === 'current' || s.type === 'titles'),
      'no page change is broadcast to the room').toEqual([]);
    ws.close();

    // a fresh socket sees the room exactly as the teacher left it
    const tr2 = await api.post('/api/ws/ticket', { headers: { authorization: `Bearer ${studentToken}` }, data: { sessionId } });
    const ws2 = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(String((await tr2.json()).ticket))}`);
    const init2: Record<string, unknown>[] = [];
    await new Promise<void>((res, rej) => { ws2.onopen = () => res(); ws2.onerror = () => rej(new Error('ws2 failed')); });
    ws2.onmessage = (ev) => init2.push(JSON.parse(ev.data as string));
    await new Promise((r) => setTimeout(r, 800));
    m('a fresh socket after the attempts', { pages: (init2[0] as { pages?: number[] })?.pages, titles: (init2[0] as { titles?: object })?.titles });
    const afterPages = ((init2[0] as { pages?: number[] }).pages ?? []).slice().sort((a, b) => a - b);
    expect(afterPages, 'still the boards the teacher made, no more and no less').toEqual(beforePages);
    expect(Object.values((init2[0] as { titles: Record<string, string> }).titles ?? {}).every((v) => v !== 'взломанное имя'),
      'and no hacked title reached the room').toBe(true);
    ws2.close();
  });

  test('the 21st board is refused with a clear notice, and the server counts the limit', async () => {
    test.setTimeout(240_000);
    const { sessionId } = await makeLesson(api, token, 'E2E Доски лимит');
    const tr = await api.post('/api/ws/ticket', { headers: { authorization: `Bearer ${token}` }, data: { sessionId } });
    const ticket = String((await tr.json()).ticket as string);
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
    const got: Record<string, unknown>[] = [];
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws failed')); });
    ws.onmessage = (ev) => got.push(JSON.parse(ev.data as string));
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ type: 'newpage' }));
    await new Promise((r) => setTimeout(r, 2_500));
    const notices = got.filter((g) => g.type === 'notice' && g.code === 'boardLimit');
    const pages = got.filter((g) => g.type === 'pages') as { pages: number[] }[];
    m('limit probe: boards created and boardLimit notices', {
      pages: pages.at(-1)?.pages.length ?? 1, notices: notices.length, max: notices[0]?.max,
    });
    expect(pages.at(-1)?.pages.length ?? 1, 'at most 20 boards exist').toBeLessThanOrEqual(20);
    expect(notices.length, 'the teacher is told why the button stopped working').toBeGreaterThan(0);
    expect((await dbBoard(sessionId)).length, 'and the database agrees').toBeLessThanOrEqual(20);
    ws.close();
  });

  test('after the lesson ends: rows, REST snapshot, ticket, write path, and what the UI offers', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E Доски после урока');
    // draw two boards live, then end the lesson
    const ctxT = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const t = await ctxT.newPage();
    await loginUi(t, stack.teacherEmail, stack.teacherPassword);
    await openLesson(t, classId);
    await paint(t, 'A');
    await t.getByTestId('board-new').click();
    await expect(t.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await paint(t, 'B');
    await t.getByTestId('board-tab-1').click();
    await t.waitForTimeout(1_000);
    await t.getByTestId('board-menu-1').click();
    await t.getByTestId('board-rename').click();
    await t.getByTestId('board-rename-input').fill('Тема урока');
    await t.keyboard.press('Enter');
    await t.waitForTimeout(800);

    const before = await dbBoard(sessionId);
    m('rows before the lesson ends', before.map((r) => ({ p: r.pageNo, title: r.title, n: r.elements.length })));
    const end = await api.post(`/api/lessons/${sessionId}/end`, { headers: { authorization: `Bearer ${token}` }, data: {} });
    expect(end.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 2_500));
    const after = await dbBoard(sessionId);
    m('rows after the lesson ended', after.map((r) => ({ p: r.pageNo, title: r.title, n: r.elements.length })));
    expect(after.length, 'the boards survive the lesson end').toBeGreaterThan(0);

    const snap = await api.get(`/api/lessons/${sessionId}/board`, { headers: { authorization: `Bearer ${token}` } });
    m('GET /api/lessons/:id/board after end', snap.status() === 200
      ? ((await snap.json()) as { pages: { pageNo: number; title: string; elements: unknown[] }[] }).pages.map((p) => ({ p: p.pageNo, title: p.title, n: p.elements.length }))
      : { status: snap.status() });

    const ticket = await api.post('/api/ws/ticket', { headers: { authorization: `Bearer ${token}` }, data: { sessionId } });
    m('POST /api/ws/ticket after end (the live board socket needs one)', ticket.status());

    const put = await api.put(`/api/lessons/${sessionId}/board/page`, {
      headers: { authorization: `Bearer ${token}` },
      data: { pageNo: 1, elements: [{ id: 'after-end-probe', type: 'rectangle', x: 1, y: 1, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1 }] },
    });
    m('PUT /board/page after end (teacher edit path outside a lesson)', put.status());
    const rowsNow = await dbBoard(sessionId);
    m('board 1 after that PUT: title kept?', rowsNow.map((r) => ({ p: r.pageNo, title: r.title, ids: r.elements.map((e) => e.id).slice(0, 4) })));

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await loginUi(p, stack.teacherEmail, stack.teacherPassword);
    await p.goto(`/lesson?classId=${classId}`);
    await p.waitForTimeout(3_000);
    m('/lesson after the end: what the teacher can open', await p.evaluate(() => ({
      board: !!document.querySelector('[data-testid=board]'),
      start: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 6),
    })));
    await p.goto(`/classes/${classId}`);
    await p.waitForTimeout(2_000);
    m('class page after the end: any link to the boards?', await p.evaluate(() => ({
      board: !!document.querySelector('[data-testid=board]'),
      pdf: !!document.querySelector('[data-testid=board-pdf]'),
    })));
    await ctx.close(); await ctxT.close();
  });
});
