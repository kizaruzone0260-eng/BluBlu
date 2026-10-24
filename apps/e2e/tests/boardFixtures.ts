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

/**
 * Геометрия полотна в координатах ДОКУМЕНТА.
 *
 * `boundingBox()` Playwright отдаёт относительно вьюпорта, то есть прокрутка страницы попала бы
 * в сравнение «до/после» и показала бы сдвиг там, где его нет. Здесь к rect прибавляется скролл,
 * поэтому сравнивать можно ровно положение и размер холста.
 */
export function boardGeom(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid=board] canvas.excalidraw__canvas');
    if (!c) return { x: -1, y: -1, w: 0, h: 0 };
    const r = c.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  });
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
 * `page.mouse` ходит «в пустоту»: он не ждёт, что элемент виден, не перекрыт и неподвижен, и
 * молча рисует по устаревшему rect. Здесь фокус и начало перетаскивания берутся через
 * `click`/`hover` с `position` — их Playwright выполняет только после проверки actionability.
 * Целься по `interactive`-полотну: у `.excalidraw__canvas.static` `pointer-events: none` (index.css
 * Excalidraw), и проверка попадания на статичном холсте падала бы всегда.
 *
 * Это нужно, но недостаточно: прогон `38721441896` нарисовал элемент (инструмент вернулся на
 * «выделение»), а `drawRect`-ово окно в 300×240 пикселя его не увидело — см. `inkSeen`.
 */
export async function paintStable(page: Page, slot: keyof typeof SLOTS): Promise<void> {
  const surface = page.locator('[data-testid=board] canvas.excalidraw__canvas:not(.static)').first();
  const { from, to } = SLOTS[slot];
  const stroke = async () => {
    await surface.scrollIntoViewIfNeeded();
    await surface.click({ position: { x: from[0], y: from[1] } });   // фокус на полотне
    await page.keyboard.press('r');                                   // инструмент «прямоугольник»
    await surface.hover({ position: { x: from[0], y: from[1] } });     // полотно стоит на месте
    let box = (await surface.boundingBox())!;
    const vh = page.viewportSize()?.height ?? 800;
    const lowest = Math.max(from[1], to[1]);
    /*
     * Конец штриха обязан быть В ОКНЕ. `page.mouse` работает в координатах вьюпорта и страницу не
     * прокручивает: если полотно лежит ниже сгиба (ученическая карточка доски на 1280×800 — это
     * y≈646 при высоте окна 800), то `box.y + to[1]` уходит за нижний край, перетаскивание
     * происходит мимо холста, и элемент не создаётся вовсе. Прогон 38962787990 упал именно так:
     * счётчик пикселей не сдвинулся (2032 → 2032), а `MEASURE paintStable: штрих не лёг с трёх
     * попыток` появился в логе дважды — то есть все три попытки того же штриха рисовали в одно и то
     * же мёртвое место, и повтор без прокрутки помочь не мог.
     */
    if (box.y + lowest > vh - 4) {
      await page.evaluate((dy) => window.scrollBy(0, dy), Math.ceil(box.y + lowest - vh / 2));
      await surface.hover({ position: { x: from[0], y: from[1] } });
      box = (await surface.boundingBox())!;
    }
    await page.mouse.down();
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
    await page.mouse.up();
  };
  /*
   * Штрих повторяется, пока полотно не изменится. Причина не в продукте, а в инструменте: `r`
   * уходит тому, кто в фокусе, а фокус после прокрутки колеса, тоста или клика по чужой плитке
   * иногда остаётся не на холсте — тогда перетаскивание становится рамкой выделения и на полотне
   * НЕ ПОЯВЛЯЕТСЯ НИЧЕГО. Прогон 38956155368 упал именно так («третий штрих виден самой Анне»,
   * счётчик пикселей 1706 → 1706), а тест под `@unstable` в zz20 не рисовал у учителя два прогона
   * подряд. Это страховка инструмента, а не утверждения: проверяющий тест по-прежнему требует,
   * чтобы чернила появились, и если с трёх попыток их нет — так и пишет, с числом до/после.
   */
  const ink0 = await inkAll(page);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await stroke();
    for (let tick = 0; tick < 10; tick++) {
      if (await inkAll(page) > ink0) return;
      await page.waitForTimeout(250);
    }
  }
  // сюда приходит только по-настоящему не удавшийся штрих: что именно не так — говорит inkFault
  m('paintStable: штрих не лёг с трёх попыток', { slot, ink0, inkNow: await inkAll(page), fault: await inkFault(page, ink0) });
}

/**
 * Вернёмся к началу §4: «красный обязан называть ветку». `inkAll` измеряет холст честно, но по
 * одному числу нельзя отличить «штриха нет» от «штрих есть, но не там». Поэтому здесь читаются
 * ТРИ независимых источника: настоящий кадр Excalidraw, счётчик тёмных пикселей и рамки сокета
 * доски.
 */

/** Что видно из экземпляра Excalidraw: сцена, viewport, инструмент, выделение. */
export interface SceneView {
  err?: string;
  tool: string | null;
  scrollX: number; scrollY: number; zoom: number;
  /** видимая область сцены: [x0, y0, x1, y1] */
  view: [number, number, number, number];
  els: { id: string; type: string; x: number; y: number; w: number; h: number; version: number; deleted: boolean; inView: boolean; locked: boolean }[];
  newElement: { type: string; x: number; y: number; w: number; h: number } | null;
  selected: string[];
}

/**
 * Состояние полотна изнутри компонента.
 *
 * Продукт ради тестов отлаживать нельзя, а `ExcalidrawImperativeAPI` наружу не торчит, поэтому
 * читается тот же самый экземпляр App, что рисует: от DOM-узла `.excalidraw` вверх по
 * react-fiber до первого `stateNode` с `state.scrollX`. Это НЕ «элемент существует в памяти»
 * вместо проверки на экране — `inkAll` остаётся обязательным, здесь он только объясняет причину.
 */
export function boardScene(page: Page): Promise<SceneView> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid=board] .excalidraw') as
      unknown as { [k: string]: unknown } | null;
    if (!host) return { err: 'нет .excalidraw' } as never;
    const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return { err: 'нет react-fiber' } as never;
    type Fiberish = { return?: Fiberish; stateNode?: { state?: Record<string, unknown> } };
    type AppLike = { state: Record<string, any>; scene?: Record<string, any> };
    let node = host[key] as Fiberish | undefined;
    let app: AppLike | null = null;
    for (let hop = 0; node && hop < 80; hop++, node = node.return) {
      const sn = node.stateNode;
      if (sn && typeof sn.state?.scrollX === 'number') { app = sn as unknown as AppLike; break; }
    }
    if (!app) return { err: 'нет экземпляра App' } as never;
    const st = app.state;
    const sc = app.scene;
    const read = sc?.getNonDeletedElements ?? sc?.getSceneElements;
    const raw = (typeof read === 'function' ? read.call(sc) : st.elements) as any[] | undefined;
    const els = raw ?? [];
    const zoom = st.zoom?.value ?? 1;
    const x0 = -st.scrollX, y0 = -st.scrollY;
    const x1 = st.width / zoom + x0, y1 = st.height / zoom + y0;
    return {
      tool: st.activeTool?.type ?? null,
      scrollX: Math.round(st.scrollX), scrollY: Math.round(st.scrollY), zoom,
      view: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
      els: els.map((e) => ({
        id: String(e.id), type: String(e.type),
        x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height),
        version: Number(e.version), deleted: !!e.isDeleted, locked: e.locked === true,
        inView: e.x < x1 && e.x + e.width > x0 && e.y < y1 && e.y + e.height > y0,
      })),
      newElement: st.newElement
        ? {
          type: String(st.newElement.type), x: Math.round(st.newElement.x), y: Math.round(st.newElement.y),
          w: Math.round(st.newElement.width), h: Math.round(st.newElement.height),
        } : null,
      selected: Object.keys(st.selectedElementIds ?? {}).filter((k) => st.selectedElementIds[k]),
    };
  });
}

/** Тёмные пиксели каждого холста доски: `static=1598 interactive=212`. */
export function inkLayers(page: Page): Promise<string> {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('[data-testid=board] canvas')] as HTMLCanvasElement[];
    return list.map((c) => {
      const g = c.getContext('2d', { willReadFrequently: true });
      let dark = -1;
      if (g && c.width) {
        try {
          const d = g.getImageData(0, 0, c.width, c.height).data;
          dark = 0;
          for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 0 && (d[k] < 240 || d[k + 1] < 240 || d[k + 2] < 240)) dark++;
        } catch { dark = -9; }
      }
      return `${c.className.replace('excalidraw__canvas', '').trim() || 'canvas'}=${dark}`;
    }).join(' ');
  });
}

/**
 * Живой журнал сокета доски: сколько кадров `edits` ушло, какие `notice` вернулись.
 *
 * Вешается на страницу сразу после создания (`watchBoardSocket`), иначе отказ сервера
 * `boardForeign`/`boardStudentLimit` в красном тесте нечем отличить от «правку не приняли».
 * Читается только то, что и так проходит через сокет: тип, страница и число элементов.
 */
export interface SocketLog { sent: number; codes: string[]; received: string[] }
const socketLogs = new WeakMap<Page, SocketLog>();

export function watchBoardSocket(page: Page): SocketLog {
  const log: SocketLog = { sent: 0, codes: [], received: [] };
  socketLogs.set(page, log);
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/ws/board')) return;
    ws.on('framesent', (f) => {
      try { if ((JSON.parse(String(f.payload)).type) === 'edits') log.sent++; } catch { /* не наш кадр */ }
    });
    ws.on('framereceived', (f) => {
      try {
        const o = JSON.parse(String(f.payload));
        if (o.type === 'notice') log.codes.push(String(o.code));
        else log.received.push(String(o.type));
      } catch { /* не наш кадр */ }
    });
  });
  return log;
}

export const boardSocket = (page: Page): SocketLog => socketLogs.get(page) ?? { sent: 0, codes: [], received: [] };

/**
 * Именованная причина, по которой чернил не видно. Ветки — ровно те, что требует разбор:
 * ввод не создал элемент / нулевой размер / элемент вне поля зрения / сцена есть, холста нет /
 * сервер отверг / наружу ничего не ушло.
 */
export async function inkFault(page: Page, before: number): Promise<string> {
  const [scene, layers, sock] = [await boardScene(page), await inkLayers(page), boardSocket(page)];
  if (scene.err) return `сцена не читается (${scene.err}); холсты: ${layers}; отправлено edits: ${sock.sent}`;
  const last = scene.els[scene.els.length - 1];
  const base = `холсты: ${layers}; чернил до/после: ${before}/${await inkAll(page)}; edits отправлено: ${sock.sent}; ответы сервера: ${sock.codes.join(',') || 'нет'}`;
  if (sock.codes.length) return `СЕРВЕР ОТВЕРГ ПРАВКУ: ${sock.codes[sock.codes.length - 1]} — ${base}`;
  if (!last) return `ВВОД НЕ СОЗДАЛ ЭЛЕМЕНТА (сцена пуста, инструмент ${scene.tool}) — ${base}`;
  if (scene.newElement) {
    return `ПЕРЕТАСКИВАНИЕ НЕ ЗАВЕРШЕНО: элемент всё ещё в ` +
      `newElement ${scene.newElement.type} ${scene.newElement.w}×${scene.newElement.h} — ${base}`;
  }
  if (last.w < 3 || last.h < 3) {
    return `ВВОД ДАЛ ПУСТОЙ ШТРИХ: ${last.type} ${last.w}×${last.h} в (${last.x},${last.y}) — ` +
      `курсор двигали, перетаскивание не зарегистрировано — ${base}`;
  }
  if (!last.inView) {
    return `ЭЛЕМЕНТ ВНЕ ПОЛЯ ЗРЕНИЯ: ${last.type} (${last.x},${last.y}) ${last.w}×${last.h}, ` +
      `видно ${JSON.stringify(scene.view)}, scroll=(${scene.scrollX},${scene.scrollY}), zoom=${scene.zoom} — ` +
      `полотно знает о своём положении другое — ${base}`;
  }
  return `СЦЕНА ОБНОВИЛАСЬ, ХОЛСТ НЕТ: ${last.type} (${last.x},${last.y}) ${last.w}×${last.h} в поле зрения ` +
    `(версия ${last.version}), но тёмных пикселей не прибавилось — ${base}`;
}

/**
 * Чернила обязаны ПОЯВИТЬСЯ на холсте; если нет — красный с именем ветки.
 *
 * Заменяет голые `expect.poll(() => inkAll(...))`: проверка ровно та же (тёмные пиксели
 * отрисованного canvas), но падение теперь говорит, где именно оборвалась цепочка.
 *
 * `reveal: true` (по умолчанию) считает полотно после «вернуться к содержимому» — так измеряется
 * «человек увидел свои чернила, если захочет». `reveal: false` — как именно они видны СЕЙЧАС,
 * без подсказки: так устроен тест на метку «рисунок ушёл из вида».
 */
export async function expectInk(page: Page, opts: {
  before: number; label: string; timeout?: number; reveal?: boolean;
}): Promise<void> {
  const { before, label, timeout = 20_000, reveal = true } = opts;
  const measure = reveal ? inkSeen : inkAll;
  try {
    await expect.poll(() => measure(page), { timeout, message: label }).toBeGreaterThan(before);
  } catch (e) {
    throw new Error(`${label}\n  ${await inkFault(page, before)}`, { cause: e });
  }
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

/**
 * Максимальное расхождение двух геометрий по любой из четырёх координат, и сами разносы.
 *
 * Допуск нужен: субпиксельная прокрутка (`scrollIntoViewIfNeeded` даёт y вроде 302.5625) и
 * округление `calc(100dvh - 420px)` дают разницу в доли пикселя, которая не имеет отношения к
 * «полотно сдвинуло». 2 px — потолок этого шума; реальный сдвиг строки шапки был 5–8 px.
 */
export function geomShift(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): { max: number; d: { x: number; y: number; w: number; h: number } } {
  const d = { x: b.x - a.x, y: b.y - a.y, w: b.w - a.w, h: b.h - a.h };
  return { max: Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.w), Math.abs(d.h)), d };
}

/**
 * Всё тёмное на полотне, без окна.
 *
 * `inkIn` смотрит в фиксированный прямоугольник — он различает слоты A/B/C, и в статичной
 * вёрстке zz11/zz12 это работает. В живом уроке полотно может показать содержимое в другом месте
 * сцены (у Excalidraw свой viewport: `scrollX/scrollY` не привязаны к верхнему левому углу
 * элемента), и тогда «штриха нет» на самом деле значит «штрих не здесь». Для проверок
 * «доехал / не доехал» это не аргумент: считается любой тёмный пиксель холста.
 */
export function inkAll(page: Page): Promise<number> {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('[data-testid=board] canvas')] as HTMLCanvasElement[];
    const c = list.find((el) => el.className.includes('static')) ?? list[0];
    if (!c || !c.width || !c.height) return 0;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return 0;
    let d: Uint8ClampedArray;
    try { d = g.getImageData(0, 0, c.width, c.height).data; } catch { return 0; }
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! > 0 && (d[i]! < 240 || d[i + 1]! < 240 || d[i + 2]! < 240)) dark++;
    }
    return dark;
  });
}

/**
 * Вернуть вид к содержимому — той же кнопкой Excalidraw, которой пользуется живой человек
 * («Scroll back to content»). Делается только когда полотно уехало от содержимого; если всё
 * видно, на холме нажимать нечего.
 */
export async function revealInk(page: Page): Promise<void> {
  const back = page.locator('[data-testid=board] .scroll-back-to-content');
  if (await back.isVisible()) await back.click();
}

/** Штрих на полотне: сначала вернуть вид к содержимому, потом считать. */
export async function inkSeen(page: Page): Promise<number> {
  await revealInk(page);
  return inkAll(page);
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
