/**
 * Shared helpers for the board specs (zz11-board-pages, zz12-board-pdf).
 *
 * Why a module: the two specs need the same physical interactions, and a duplicated copy of a
 * workaround is a bug waiting to diverge.
 *
 * Drawing: Excalidraw's default tool is the SELECTION marquee, so a plain drag paints nothing.
 * A mouse down/up gives the canvas focus, `r`/`t` select the rectangle/text tool, then the drag
 * or the typed characters produce real elements. The visible canvas is
 * `canvas.excalidraw__canvas.static`; the second canvas (`interactive`) is the hit-test buffer.
 *
 * The DB is read directly because a canvas exposes no element count to the DOM.
 */
import { expect, request as pw, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * `.stack.json` is written by scripts/e2e-stack.mjs AFTER the API answers /api/health/live —
 * migrations and seeding come in between, and Playwright starts importing spec files the moment
 * the health check passes. Reading it straight away loses a race that shows up as
 * "ENOENT … .stack.json" with "No tests found", so the file is waited for here.
 * SharedArrayBuffer + Atomics.wait is the only synchronous sleep available at import time.
 */
const credsFile = path.join(process.cwd(), '.stack.json');
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 90 && !existsSync(credsFile); i++) nap(1_000);
if (!existsSync(credsFile)) throw new Error(`${credsFile} never appeared — is scripts/e2e-stack.mjs running?`);

export const stack = JSON.parse(readFileSync(credsFile, 'utf8')) as {
  port: number; teacherEmail: string; teacherPassword: string;
};
export const BASE = `http://127.0.0.1:${stack.port}`;
const DB = `postgres://klass:klass@127.0.0.1:5455/klass`;

export type Ctx = ReturnType<typeof pw.newContext> extends Promise<infer T> ? T : never;

/**
 * Three well-separated painting slots, each with the window its ink is looked for in.
 *
 * The canvas content is not in the same coordinate space as the element box: a drag from
 * CSS y=40..180 lands around canvas y=109..240 (a stable ≈70 px offset, probably the editor's
 * scroll origin), so the windows are whole QUADRANT-sized areas rather than the dragged box —
 * an offset of 70 px cannot move ink out of a 240 px window, and a "this board is empty" check
 * stays meaningful.
 */
export const SLOTS = {
  A: { window: { x: 0, y: 0, w: 300, h: 240 }, from: [30, 20] as [number, number], to: [190, 130] as [number, number] },
  B: { window: { x: 500, y: 280, w: 380, h: 200 }, from: [560, 210] as [number, number], to: [760, 330] as [number, number] },
  C: { window: { x: 0, y: 280, w: 300, h: 200 }, from: [30, 250] as [number, number], to: [190, 360] as [number, number] },
};
/** where a typed text element lands, and the window that must contain its glyphs */
export const TEXT = { window: { x: 0, y: 0, w: 620, h: 260 }, at: [30, 30] as [number, number] };

/** the window of a slot, for `inkIn` */
export const winOf = (slot: keyof typeof SLOTS) => SLOTS[slot].window;

export const m = (label: string, value: unknown) => console.log(`MEASURE ${label} ${JSON.stringify(value)}`);

/** The host:port of a URL — used to prove an export never reaches another origin. */
export function urlHost(url: string): string {
  try { return new URL(url).host; } catch { return url.slice(0, 40); }
}

export async function teacherToken(api: Ctx): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const l = await api.post('/api/auth/login', {
      data: { email: stack.teacherEmail, password: stack.teacherPassword },
    });
    if (l.status() === 429) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
    expect(l.status(), `teacher login ${l.status()}`).toBe(200);
    return String((await l.json()).accessToken as string);
  }
  throw new Error('teacher login failed');
}

/** class + live lesson + a fresh invite code, all through the API */
export async function makeLesson(api: Ctx, token: string, name: string) {
  const cls = await (await api.post('/api/classes', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: `${name} ${Date.now()}`, description: '', color: '#0ea5a5' },
  })).json();
  const classId = String((cls as { id: string }).id);
  const start = await api.post('/api/lessons/start', {
    headers: { authorization: `Bearer ${token}` }, data: { classId },
  });
  expect(start.status()).toBe(201);
  const sessionId = String((await start.json()).id as string);
  const inv = await (await api.post(`/api/classes/${classId}/invites`, {
    headers: { authorization: `Bearer ${token}` }, data: {},
  })).json();
  return { classId, className: String((cls as { name: string }).name), sessionId, inviteCode: String((inv as { code: string }).code) };
}

/**
 * Закрепить за сид-учителем русский язык интерфейса: эти спеки утверждают русские подписи
 * («Доска 1», «пусто»). Язык берётся из профиля, а скрипты съёмки скриншотов ставят его же
 * explicit-выбором (ru→uz→en) в той же сохранённой базе, поэтому «как получится» здесь не
 * работает. Код ответа проверяется: незакреплённый язык должен валить тест, а не молча
 * превращать «Доска 1» в «Board 1».
 */
export async function pinTeacherRussian(api: Ctx, token: string): Promise<void> {
  const me = await api.get('/api/me', { headers: { authorization: `Bearer ${token}` } });
  expect(me.status(), `pinTeacherRussian: /api/me вернул ${me.status()}`).toBe(200);
  const p = await me.json();
  const r = await api.patch('/api/me/profile', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: p.name, lastName: p.lastName ?? '', tz: p.tz, locale: 'ru' },
  });
  expect(r.status(), `pinTeacherRussian: PATCH /api/me/profile вернул ${r.status()}`).toBe(200);
}

export async function loginUi(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/login');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    const ok = await page.getByTestId('home-title').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    if (ok) return;
    await page.waitForTimeout(20_000);
  }
  throw new Error('login failed after retries');
}

export async function registerStudent(page: Page, code: string, first: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('reg-code').fill(code);
  await page.getByTestId('reg-email').fill(email);
  await page.getByTestId('reg-password').fill('Secret1234');
  await page.getByTestId('register-step1').click();
  await expect(page.getByTestId('reg-first')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('reg-first').fill(first);
  await page.getByTestId('reg-last').fill('Тест');
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 25_000 });
}

export async function openLesson(page: Page, classId: string): Promise<void> {
  await page.goto(`/lesson?classId=${classId}`);
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('[data-testid=board] canvas.excalidraw__canvas').first()).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(1_500); // the board WS init: canEdit, pages, titles, elements
}

/**
 * Доска готова — БЕЗ перехода на страницу урока.
 *
 * `goto` рвёт комнату: LiveKit SDK сам вешает «Page leave detected, disconnecting» на выгрузку
 * страницы, а после перезагрузки в урок никто не входит автоматически (нужен предпросмотр
 * устройств). zz20 вызывал `openLesson` уже ПОСЛЕ входа в комнату и затем искал строку ученика в
 * панели, где участников 0, — трасса прогона 38541787520 это показала дословно. Здесь ожидаются
 * те же состояния, что в `openLesson`, но без перехода и без слепого ожидания: инициализация
 * доски видна по следующим же проверкам (значок права приходит по WS).
 *
 * Полотно ещё и ставится в область видимости: под сеткой участников карточка доски бывает ниже
 * окна, а `page.mouse` работает в координатах вьюпорта и страницу не прокручивает — штрих ушёл бы
 * в пустоту, и проверка «штрих доехал до учителя» покраснела бы без всякой связи с доской.
 */
export async function waitBoard(page: Page): Promise<void> {
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 25_000 });
  const canvas = page.locator('[data-testid=board] canvas.excalidraw__canvas').first();
  await expect(canvas).toBeVisible({ timeout: 25_000 });
  await canvas.scrollIntoViewIfNeeded();
}

const canvas = (page: Page) => page.locator('[data-testid=board] canvas.excalidraw__canvas').first();

export async function drawRect(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('r');
  await page.waitForTimeout(250);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

/**
 * Тот же штрих, что `drawRect`, но с координатами, которые Playwright проверил сам.
 *
 * Причина отдельной функции — прогон `38715507790`: ученик рисует сразу после того, как учитель
 * выдал право, а вместе с правом у полотна уходит `zenModeEnabled`/`viewModeEnabled`
 * (`Board.tsx:483`), Excalidraw пересобирает свои панели и размер `<canvas>` меняется. Rect,
 * снятый до этого переезда, оказывается не там: элемент создаётся, но вне видимой области, и на
 * экране ученика остаётся «Scroll back to content» при пустом холсте — это ровно
 * `scrolledOutside: !atLeastOneVisibleElement && elements.size > 0`. Проверка полотна в
 * `drawRect` не могла этого увидеть: `page.mouse` ходит «в пустоту» и ничего не проверяет.
 *
 * `hover`/`click` с `position` Playwright выполняет только когда элемент виден, не перекрыт и
 * НЕ сдвинулся между двумя кадрами, то есть переезд полотна уже закончен. Целься по
 * `interactive`-полотну: `.excalidraw__canvas.static` с `pointer-events: none` (см. index.css
 * Excalidraw) никогда не бывает целью указателя, и проверка попадания на нём падала бы всегда.
 */
export async function paintStable(page: Page, slot: keyof typeof SLOTS): Promise<void> {
  const surface = page.locator('[data-testid=board] canvas.excalidraw__canvas:not(.static)').first();
  const { from, to } = SLOTS[slot];
  await surface.click({ position: { x: from[0], y: from[1] } });   // фокус на полотне
  await page.keyboard.press('r');                                   // инструмент «прямоугольник»
  await surface.hover({ position: { x: from[0], y: from[1] } });     // полотно стоит на месте
  const box = (await surface.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

/** A text element typed on the canvas — used by the font/rendering test (task 3). */
export async function drawText(page: Page, at: [number, number], text: string): Promise<void> {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + at[0], box.y + at[1]);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('t');            // the text tool
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + at[0], box.y + at[1]);   // opens the editor here
  await page.waitForTimeout(400);
  await page.keyboard.type(text, { delay: 14 });
  await page.waitForTimeout(300);
  // commit with a click on an empty far corner: Escape on a still-empty draft DELETES the
  // element, and a click on the canvas is what a real user does anyway
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
  await page.waitForTimeout(600);
  await page.keyboard.press('r');            // back to a neutral tool, no dangling selection
  await page.waitForTimeout(400);
}

/** Non-transparent dark pixels of the visible canvas inside a region. */
export async function inkIn(page: Page, r: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate((reg) => {
    const list = [...document.querySelectorAll('[data-testid=board] canvas')] as HTMLCanvasElement[];
    const c = list.find((el) => el.className.includes('static')) ?? list[0];
    if (!c) return -1;
    const dpr = c.width / (c.clientWidth || 1);
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return -2;
    let d: Uint8ClampedArray;
    try { d = g.getImageData(reg.x * dpr, reg.y * dpr, reg.w * dpr, reg.h * dpr).data; }
    catch { return -3; }
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! > 0 && (d[i]! < 240 || d[i + 1]! < 240 || d[i + 2]! < 240)) dark++;
    }
    return dark;
  }, r);
}

export interface BoardRow { pageNo: number; title: string; ids: string[] }

export async function dbBoard(sessionId: string): Promise<BoardRow[]> {
  const sql = postgres(DB, { max: 1 });
  try {
    const rows = await sql`select page_no, title, snapshot from whiteboards where session_id = ${sessionId} order by page_no`;
    return rows.map((r) => ({
      pageNo: Number(r.page_no),
      title: String(r.title ?? ''),
      ids: ((r.snapshot as { elements: { id: string; isDeleted?: boolean }[] }).elements ?? [])
        .filter((e) => !e.isDeleted).map((e) => e.id),
    }));
  } finally { await sql.end({ timeout: 5 }); }
}

/** A teacher page already logged in and standing in the lesson with its board open. */
export async function teacherLessonPage(browser: Browser, classId: string, viewport = { width: 1280, height: 800 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  await loginUi(p, stack.teacherEmail, stack.teacherPassword);
  await openLesson(p, classId);
  return p;
}

/** Draw this board's own rectangle in its own slot. */
export async function paint(page: Page, slot: keyof typeof SLOTS): Promise<void> {
  await drawRect(page, SLOTS[slot].from, SLOTS[slot].to);
}

/** How much ink a slot's window holds right now (0 = the slot's board is not on screen). */
export function inkOf(page: Page, slot: keyof typeof SLOTS | 'text'): Promise<number> {
  return inkIn(page, slot === 'text' ? TEXT.window : SLOTS[slot].window);
}

/**
 * Часть 4/5 (2026-10-14): ждать состояния, а не времени.
 *
 * Доска сохраняется на сервер автосейвом раз в 10 с. В zz12 это закрыто слепо «подождать
 * 11 секунд», и приём работал, пока набор не стал длиннее таймера джобы (прогон
 * 38506706395 был снят таймаутом на 25m21s). Здесь опрашивается обычный REST доски: сколько
 * страниц с чернилами уже реально лежат в базе. Возвращает число, чтобы спека могла сверить его.
 */
export async function waitInkPages(api: Ctx, token: string, sessionId: string, want: number): Promise<number> {
  let seen = 0;
  await expect.poll(async () => {
    const r = await api.get(`/api/lessons/${sessionId}/board`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status() !== 200) return 0;
    const pages = ((await r.json()).pages ?? []) as { elements?: { isDeleted?: boolean }[] }[];
    seen = pages.filter((p) => (p.elements ?? []).some((e) => !e.isDeleted)).length;
    return seen;
  }, { timeout: 45_000, intervals: [1_000], message: `pages with ink: want ${want}` }).toBeGreaterThanOrEqual(want);
  return seen;
}
