/**
 * Task 2 — downloading boards as one PDF, verified from the file itself.
 *
 * The download is captured by Playwright (`waitForEvent('download')`), read back from disk and
 * opened with pdf-lib (a devDependency of this package only), so the assertions are about the
 * artifact: page count = the number of picked boards, page size = A4 landscape or the content
 * box, metadata free of personal data, and the file name pattern `BluBlu-<class>-<date>.pdf`.
 *
 * The export must also be a purely local operation: every request the page makes while building
 * the file is recorded, and only our own origin may appear (task 2ж).
 *
 * The two font-check PNGs this spec takes go to `test-results/screenshots/` (see `shot()`);
 * `docs/screenshots/board-text-1280.png` and `-390.png` are the copies committed on 2026-10-08 as
 * review evidence and are no longer rewritten by a run — before that change every e2e suite left
 * the working tree dirty.
 */
import { test, expect, request as pw } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  BASE,
  dbBoard,
  drawText,
  inkOf,
  loginUi,
  m,
  makeLesson,
  openLesson,
  paint,
  registerStudent,
  stack,
  teacherLessonPage,
  teacherToken,
  urlHost,
  TEXT,
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

const MM_PT = 72 / 25.4;                 // 1 mm in PostScript points (PDFs are 72 pt per inch)
const A4 = { width: 297 * MM_PT, height: 210 * MM_PT };

/**
 * Evidence a test writes goes under `test-results/` (already gitignored), not into `docs/`.
 * This spec used to save two PNGs straight into docs/screenshots, so every suite left the working
 * tree dirty and a committed review artifact silently drifted. The pictures in docs/screenshots
 * come from the `*-shots.mjs` scripts, which are run on purpose and can be reviewed on purpose.
 */
function shot(name: string): string {
  const dir = join(process.cwd(), 'test-results', 'screenshots');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

test.describe('board → PDF (task 2)', () => {
  let api: Ctx = null as unknown as Ctx;
  let token = '';

  test.beforeAll(async () => {
    api = await pw.newContext({ baseURL: BASE });
    token = await teacherToken(api);
    await pinTeacherRussian(api, token);
  });
  test.afterAll(async () => { await api?.dispose(); });

  test('the teacher picks 2 of 4 boards and gets one PDF with exactly those pages', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, className, sessionId } = await makeLesson(api, token, 'E2E PDF доски');
    const p = await teacherLessonPage(browser, classId);

    // three boards with content, one board left empty on purpose
    await paint(p, 'A');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await paint(p, 'B');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-3')).toBeVisible({ timeout: 15_000 });
    await paint(p, 'C');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-4')).toBeVisible({ timeout: 15_000 });
    // give the autosave a chance to land, then switch back so page 4 persists as empty
    await p.getByTestId('board-tab-1').click();
    await p.waitForTimeout(11_000);
    m('rows on disk before the export', await dbBoard(sessionId));

    // a foreign request during the export would be a privacy bug — record every one of them
    const hosts = new Set<string>();
    const consoleErrors: string[] = [];
    p.on('request', (r) => hosts.add(urlHost(r.url())));
    p.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await p.getByTestId('board-pdf').click();
    const dialog = p.getByTestId('pdf-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // four rows in tab order, each with a name; the empty one is marked and NOT preselected
    await expect(p.getByTestId('pdf-name-1')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('pdf-name-4')).toContainText('Доска 4');
    await expect(p.getByTestId('pdf-name-4')).toContainText('пусто');
    await expect(p.getByTestId('pdf-pick-1')).toBeChecked();
    await expect(p.getByTestId('pdf-pick-2')).toBeChecked();
    await expect(p.getByTestId('pdf-pick-3')).toBeChecked();
    await expect(p.getByTestId('pdf-pick-4'), 'an empty board is off by default').not.toBeChecked();
    await expect(p.getByTestId('pdf-count')).toContainText('3');
    await expect(p.getByTestId('pdf-thumb-1')).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId('pdf-thumb-2')).toBeVisible({ timeout: 30_000 });

    // pick boards 1 and 3
    await p.getByTestId('pdf-pick-2').setChecked(false);
    await p.getByTestId('pdf-pick-3').setChecked(true);
    await expect(p.getByTestId('pdf-count')).toContainText('2');

    const dl = p.waitForEvent('download');
    await p.getByTestId('pdf-download').click();
    await expect(p.getByTestId('pdf-progress')).toBeVisible({ timeout: 5_000 }).catch(() => undefined);
    const download = await dl;

    const name = download.suggestedFilename();
    m('download name', name);
    expect(/^BluBlu-.*-\d{4}-\d{2}-\d{2}\.pdf$/.test(name), `file name is ${name}`).toBe(true);
    expect(name, 'the class name is in the file name').toContain(className.slice(0, 8));
    expect(/[\\/:*?"<>|]/.test(name), 'no character illegal in a file name').toBe(false);

    const file = await download.path();
    expect(file, 'playwright saved the download').toBeTruthy();
    const bytes = readFileSync(file!);
    m('pdf size', bytes.length);
    expect(bytes.length, 'a real PDF, not an empty stub').toBeGreaterThan(3_000);

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount(), 'one page per selected board').toBe(2);
    for (const pg of doc.getPages()) {
      const s = pg.getSize();
      m('pdf page size', { w: Math.round(s.width), h: Math.round(s.height) });
      expect(Math.abs(s.width - A4.width), 'A4 landscape width').toBeLessThan(1);
      expect(Math.abs(s.height - A4.height), 'A4 landscape height').toBeLessThan(1);
    }
    // task 2г: the metadata carries no personal data — no class name, no people, no ids
    const meta = [doc.getTitle(), doc.getAuthor(), doc.getCreator(), doc.getProducer(), doc.getSubject(), doc.getKeywords()]
      .map((v) => String(v ?? '')).join(' ');
    m('pdf metadata', meta);
    expect(meta.toLowerCase().includes(className.toLowerCase()), 'no class name in the metadata').toBe(false);
    expect(meta.toLowerCase().includes(stack.teacherEmail.toLowerCase()), 'no e-mail in the metadata').toBe(false);
    expect(meta.toLowerCase().includes(sessionId), 'no lesson id in the metadata').toBe(false);

    // task 2ж: nothing left the page for the export, and CSP stayed quiet. `blob:`/`data:` URLs
    // have no host at all — those are our own object URLs, not another origin.
    const foreign = [...hosts].filter((h) => h && h !== `127.0.0.1:${stack.port}`);
    m('hosts contacted during the export', [...hosts]);
    expect(foreign, 'only our own origin (and our own blob: URLs)').toEqual([]);
    expect(consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)), 'no CSP complaints').toEqual([]);
    await p.context().close();
  });

  test('«по размеру содержимого» sizes the page to the drawing instead of A4', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId } = await makeLesson(api, token, 'E2E PDF размер');
    const p = await teacherLessonPage(browser, classId);
    await paint(p, 'A');
    await p.waitForTimeout(11_000); // let the autosave persist the page

    await p.getByTestId('board-pdf').click();
    await expect(p.getByTestId('pdf-pick-1')).toBeVisible({ timeout: 20_000 });
    await p.getByTestId('pdf-page-size').selectOption('content');
    const dl = p.waitForEvent('download');
    await p.getByTestId('pdf-download').click();
    const file = await (await dl).path();
    expect(file, 'playwright saved the download').toBeTruthy();
    const doc = await PDFDocument.load(readFileSync(file!), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const s = doc.getPages()[0]!.getSize();
    m('content-size page', { w: Math.round(s.width), h: Math.round(s.height) });
    expect(Math.abs(s.width - A4.width) > 2, 'the page follows the drawing, not A4').toBe(true);
    // 10 mm margins on each side of the picture
    expect(s.width % 1, 'a whole-point box with the margins').toBeLessThan(1);
    await p.context().close();
  });

  test('«Выбрать все» toggles every board including the empty ones', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId } = await makeLesson(api, token, 'E2E PDF выбрать все');
    const p = await teacherLessonPage(browser, classId);
    await paint(p, 'A');
    await p.getByTestId('board-new').click();
    await expect(p.getByTestId('board-tab-2')).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(11_000);

    await p.getByTestId('board-pdf').click();
    await expect(p.getByTestId('pdf-pick-2')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('pdf-pick-1')).toBeChecked();
    await expect(p.getByTestId('pdf-pick-2')).not.toBeChecked();
    await p.getByTestId('pdf-select-all').click();
    await expect(p.getByTestId('pdf-pick-2')).toBeChecked();
    await expect(p.getByTestId('pdf-count')).toContainText('2');
    await p.getByTestId('pdf-select-all').click();
    await expect(p.getByTestId('pdf-pick-1')).not.toBeChecked();
    await expect(p.getByTestId('pdf-download')).toBeDisabled();
    await p.getByTestId('pdf-cancel-close').click();
    await expect(p.getByTestId('pdf-dialog')).toHaveCount(0);
    await p.context().close();
  });

  test('students get no PDF button at all (task 2д)', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId, linkUrl } = await makeLesson(api, token, 'E2E PDF ученик');
    const ctxS = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const s = await ctxS.newPage();
    // ученик регистрируется сам по одноразовой ссылке (приём по коду класса выведен 2026-10-27)
    await registerStudent(s, linkUrl, 'Смотритель', `e2pdf${Date.now()}@x.io`);
    await openLesson(s, classId);
    await expect(s.getByTestId('board-pdf')).toHaveCount(0);
    await expect(s.getByTestId('board-publish-png')).toHaveCount(0);
    await expect(s.getByTestId('board-publish-svg')).toHaveCount(0);
    await expect(s.getByTestId('board-new')).toHaveCount(0);
    await ctxS.close();
  });

  test('a huge board is scaled down to a safe canvas instead of killing the tab (task 2в)', async ({ browser }) => {
    test.setTimeout(300_000);
    const { classId, sessionId } = await makeLesson(api, token, 'E2E PDF огромная доска');
    const p = await teacherLessonPage(browser, classId);
    const errs: string[] = [];
    p.on('pageerror', (e) => errs.push(String(e.message)));
    await paint(p, 'A');

    /**
     * The huge drawing is put on the board through the board socket rather than the mouse: a
     * 20 000 × 15 000 px rectangle is exactly what a teacher gets by drawing far away from the
     * origin (the Excalidraw canvas is unbounded), and no drag can reproduce it reliably.
     * It still enters the page over the ordinary `edits` path, so the export sees a real scene.
     */
    const tr = await api.post('/api/ws/ticket', {
      headers: { authorization: `Bearer ${token}` }, data: { sessionId },
    });
    const ticket = String((await tr.json()).ticket as string);
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/api/ws/board/${sessionId}?ticket=${encodeURIComponent(ticket)}`);
    const seen: Record<string, unknown>[] = [];
    ws.onmessage = (ev) => seen.push(JSON.parse(ev.data as string));
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws failed')); });
    // WAIT FOR `init` before writing: the server registers the socket and attaches its message
    // handler only after an async handshake (ticket → class → room), so a frame sent straight
    // from `onopen` can arrive with no listener on the other end and disappear. Measured: the
    // first version of this test lost its rectangle exactly that way.
    const init = await Promise.race([
      new Promise<Record<string, unknown>>((res) => {
        const t = setInterval(() => { if (seen[0]) { clearInterval(t); res(seen[0]); } }, 50);
      }),
      new Promise<null>((res) => setTimeout(() => res(null), 5_000)),
    ]);
    m('injecting socket init', { canEdit: init?.canEdit, page: init?.page, elements: (init?.elements as unknown[])?.length });
    expect(init?.canEdit, 'the export test writes to the room as the teacher').toBe(true);
    ws.send(JSON.stringify({
      type: 'edits', page: 1,
      elements: [{
        id: 'huge-rect-1', type: 'rectangle', x: 0, y: 0, width: 20_000, height: 15_000, angle: 0,
        strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'hachure', strokeWidth: 2,
        strokeStyle: 'solid', roughness: 1, opacity: 1, groupIds: [], frameId: null, index: 'a1',
        roundPoints: { type: 3 }, seed: 12345, version: 1, versionNonce: 1, isDeleted: false,
        boundElements: null, updated: Date.now(), link: null, locked: false,
      }],
    }));
    await p.waitForTimeout(2_000);                       // the room broadcasts it to the page
    await p.waitForTimeout(11_000);                      // and the autosave persists the page
    m('rows with the huge rectangle', await dbBoard(sessionId));

    await p.getByTestId('board-pdf').click();
    await expect(p.getByTestId('pdf-pick-1')).toBeVisible({ timeout: 30_000 });
    await p.getByTestId('pdf-page-size').selectOption('content');
    const dl = p.waitForEvent('download');
    await p.getByTestId('pdf-download').click();
    const file = await (await dl).path();
    expect(file, 'the export produced a file').toBeTruthy();
    const bytes = readFileSync(file!);
    expect(bytes.length, 'a real PDF').toBeGreaterThan(3_000);

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const s = doc.getPages()[0]!.getSize();
    // "content size" pages are picture × 0.75 + 10 mm margins, so the page tells us the pixel
    // size the board was rasterized at. fitDimensions caps that at 6 000 px per side, and the
    // drawing is 20 000 px wide — without the cap the page would be 15 000 pt across.
    const capPt = 6_000 * 0.75 + 2 * 10 * MM_PT;
    m('huge board page size', { w: Math.round(s.width), h: Math.round(s.height), capPt: Math.round(capPt) });
    expect(s.width, 'the drawing is far bigger than an A4 page').toBeGreaterThan(A4.width);
    expect(Math.round(s.width), 'and it hit the safe-canvas ceiling exactly').toBeCloseTo(capPt, -1);
    expect(s.width, 'never bigger than the safe canvas allows').toBeLessThanOrEqual(capPt + 1);
    expect(s.height, 'same for the height').toBeLessThanOrEqual(capPt + 1);
    m('page errors during the huge export', errs);
    expect(errs, 'the tab survived it').toEqual([]);
    ws.close();
    await p.context().close();
  });

  test('cyrillic and Uzbek ʻgʻ text on a board really renders (task 3)', async ({ browser }) => {
    test.setTimeout(240_000);
    const { classId } = await makeLesson(api, token, 'E2E PDF шрифты');
    const p = await teacherLessonPage(browser, classId);
    const fonts = await p.evaluate(() => ({ status: document.fonts.status, ready: navigator.userAgent.slice(0, 20) }));
    m('font state before typing', fonts);
    expect(fonts.status, 'the document fonts are loaded before the board paints text').toBe('loaded');

    await drawText(p, TEXT.at, 'Привет, oʻzbek gʻoya');
    const inText = await inkOf(p, 'text');
    m('ink in the text line', inText);
    expect(inText, 'something is painted where the text sits').toBeGreaterThan(200);
    await p.getByTestId('board').screenshot({ path: shot('board-text-1280.png') });
    await p.context().close();

    // the same at phone width, for the screenshot review
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const phone = await ctx.newPage();
    await loginUi(phone, stack.teacherEmail, stack.teacherPassword);
    await openLesson(phone, classId);
    await phone.getByTestId('board').screenshot({ path: shot('board-text-390.png') });
    await ctx.close();
  });
});
