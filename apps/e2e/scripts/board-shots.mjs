/**
 * Board screenshots for docs/screenshots (task 4 of the boards/PDF work):
 *   board-tabs-<locale>-<width>-<theme>.png   the «Доска N» strip
 *   board-menu-<locale>-<width>-<theme>.png   a tab's «⋯» menu (rename / duplicate / delete)
 *   pdf-picker-<locale>-<width>-<theme>.png   the «Скачать PDF» dialog with thumbnails
 *   pdf-progress-<locale>-<width>-<theme>.png the same dialog while it works
 * for ru/uz/en × 390/1280 × light/dark = 24 png.
 *
 * Runs the same e2e stack (embedded PG + API on :3123 serving apps/web/dist), ONE teacher login
 * (the /api/auth/login cap is 10/min/IP), locale through the profile + a reload, theme through
 * localStorage, width through setViewportSize. The boards and their ink are created once and
 * survive reloads (they live in the whiteboards table), so every shot shows real content.
 * Never prints secrets.
 *
 *   node apps/e2e/scripts/board-shots.mjs      (from the repo root)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.join(root, 'docs', 'screenshots');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const BOARDS = 6; // one of them stays empty on purpose — the picker must mark it and leave it off

if (!fs.existsSync(path.join(root, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('board-shots: apps/web/dist is missing — run `pnpm --filter @klass/web build` first');
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'),
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
let shuttingDown = false;
async function bye(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stack.kill(); } catch { /* gone */ }
  process.exit(code);
}
process.on('SIGINT', () => void bye(0));

const credsFile = path.join(root, 'apps/e2e/.stack.json');
// The old check returned as soon as `.stack.json` existed — but that file survives a previous run,
// so a fresh script said «стек готов» and immediately got ECONNREFUSED on :3123 (замерено
// 2026-10-11). Health first, file second (the stack writes it a moment after it becomes healthy),
// and a stack child that already died is reported as died, not waited on for 120 seconds.
let stackExited = null;
stack.on('exit', (code, signal) => { stackExited = signal ? `сигнал ${signal}` : `код ${code}`; });
async function waitStack() {
  let healthy = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (stackExited) throw new Error(`e2e-stack завершился (${stackExited}), стек не поднялся`);
    if (!healthy) {
      try { healthy = (await fetch(`${BASE}/api/health/live`)).ok; } catch { /* поднимается */ }
      if (!healthy) continue;
    }
    if (fs.existsSync(credsFile)) return;
  }
  throw new Error(`stack did not come up in 120 s (healthy=${healthy})`);
}
await waitStack();
const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));

const api = async (tok, method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const TT = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: creds.teacherEmail, password: creds.teacherPassword }),
})).json()).accessToken;

// язык и имя сид-учителя до съёмки: скрипт меняет их в той же базе, что и тесты, и обязан
// вернуть обратно — иначе следующий прогон zz11/zz12 проснётся с «Board 1» вместо «Доска 1».
// Не прочитали профиль — останавливаемся: продолжать и оставить чужое состояние хуже, чем не снять кадры.
const profileRes = await api(TT, 'GET', '/api/me');
if (profileRes.status !== 200 || !profileRes.json?.locale) {
  console.error(`board-shots: /api/me вернул ${profileRes.status}, профиль до съёмки не прочитан — нечего возвращать`);
  await bye(1);
}
const profileBefore = profileRes.json;

const classes = (await api(TT, 'GET', '/api/classes')).json;
let cls = classes.find((c) => c.name === '7B — board shots');
if (!cls) cls = (await api(TT, 'POST', '/api/classes', { name: '7B — board shots', description: '', color: '#0ea5a5' })).json;
// /api/lessons/start is idempotent per class, so a lesson left live by an earlier (killed) run
// would hand this run its boards. End it first: every shot set starts from one empty board.
const live = (await api(TT, 'GET', `/api/lessons/active?classId=${cls.id}`)).json?.session;
if (live?.id) await api(TT, 'POST', `/api/lessons/${live.id}/end`, {});
const session = (await api(TT, 'POST', '/api/lessons/start', { classId: cls.id })).json;

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(45_000);
page.on('pageerror', (e) => console.log('pageerror', String(e.message).slice(0, 160)));
// «Очистить» and the delete confirmation are window.confirm dialogs — accept them here
page.on('dialog', (d) => void d.accept());

async function login() {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('email').fill(creds.teacherEmail);
  await page.getByTestId('password').fill(creds.teacherPassword);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('home-title').waitFor({ timeout: 25_000 });
}
await login();

const canvas = () => page.locator('[data-testid=board] canvas.excalidraw__canvas').first();

async function openLesson() {
  await page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await canvas().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_800); // board WS init: canEdit, pages, titles, elements
}

/** Excalidraw starts on the selection tool — one click focuses the canvas, `r` picks the rectangle. */
async function drawRect(from, to) {
  const box = (await canvas().boundingBox());
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down(); await page.mouse.up();
  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);
}

// two rectangles per board: enough ink for a thumbnail, and heavy enough that the progress bar
// is on screen for longer than one frame.
const INK = [
  [[40, 30], [230, 150]], [[420, 170], [640, 300]],
];

await openLesson();
for (let b = 1; b <= BOARDS; b++) {
  if (b > 1) {
    await page.getByTestId('board-new').click();
    await page.waitForTimeout(900);
  }
  for (const [from, to] of INK) await drawRect(from, to);
  await page.waitForTimeout(1_200);
}
/** The board numbers the strip actually holds — the shots use these, not the BOARDS constant. */
async function tabPages() {
  const ids = await page.locator('[data-testid=board-tabs] [data-testid^=board-tab-]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((s) => Number(s.replace('board-tab-', ''))).filter(Number.isFinite);
}
// The last board is drawn and then cleared: a page nobody ever drew on has no row in the
// database at all, while a cleared one is stored empty — which is what the picker has to mark
// «пустая» and leave unchecked.
await page.getByTestId('board-clear').click();
await page.waitForTimeout(1_500);
// a teacher-given name on the second board, through the tab menu: the strip must show it
// instead of «Доска 2»
await page.getByTestId('board-tab-2').click();
await page.waitForTimeout(800);
await page.getByTestId('board-menu-2').click();
await page.getByTestId('board-rename').click();
await page.getByTestId('board-rename-input').fill('Формулы');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
// what the server actually kept, per board
const onDisk = await api(TT, 'GET', `/api/lessons/${session.id}/board`);
console.log('boards on disk:', JSON.stringify((onDisk.json?.pages ?? []).map((r) => ({
  p: r.pageNo, title: r.title, live: (r.elements ?? []).filter((e) => !e.isDeleted).length,
}))));
// and back to the first board so the strip starts at the left
await page.getByTestId('board-tab-1').click();
await page.waitForTimeout(1_200);
const pages = await tabPages();
const lastPage = Math.max(...pages);
console.log('boards on the strip:', JSON.stringify(pages), '— the menu shots use', lastPage);
if (pages.length !== BOARDS) console.log(`WARNING expected ${BOARDS} boards, the strip has ${pages.length}`);

async function shot(name, locale, width, theme) {
  const file = path.join(outDir, `${name}-${locale}-${width}-${theme}.png`);
  await page.screenshot({ path: file });
  console.log('shot', path.basename(file));
  return file;
}

let count = 0;
// комбинация, которая упала, не должна превращать прогон в успех: её записываем и в конце выходим с кодом 1
const failedCombinations = [];
/** первая строка сообщения об ошибке — без дампа стека в консоль и без переносов внутри записи */
const firstLine = (e) => String((e && e.message) || e).split(/[\r\n]+/)[0].slice(0, 200);
/** One (locale, width, theme) combination: tabs, the tab menu, the picker, the progress bar. */
async function capture(locale, width, theme) {
  await shot('board-tabs', locale, width, theme); count++;

  // the «⋯» menu of the last board: at 390 the strip scrolls, so this also shows what the
  // popover does near the edge.
  await page.getByTestId(`board-menu-${lastPage}`).click();
  await page.getByTestId(`board-pop-${lastPage}`).waitFor({ state: 'visible', timeout: 10_000 });
  await shot('board-menu', locale, width, theme); count++;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.getByTestId('board-pdf').click();
  await page.getByTestId('pdf-dialog').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByTestId('pdf-boards').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(1_500);       // let a few thumbnails render first
  await shot('pdf-picker', locale, width, theme); count++;

  await page.getByTestId('pdf-download').click();
  const progress = page.getByTestId('pdf-progress');
  const seen = await progress.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (seen) {
    // shoot on the spot: a small room finishes the file in a few hundred ms, and waiting for the
    // bar's width transition to settle means waiting past the moment the dialog closes
    await shot('pdf-progress', locale, width, theme); count++;
  }
  else console.log('progress bar was too fast to catch');

  // A finished download closes the dialog by itself; only if it is still open (cancelled, or a
  // failure) does anything need clicking — and with a short timeout, because the buttons vanish
  // the moment the export lands.
  await page.getByTestId('pdf-dialog').waitFor({ state: 'hidden', timeout: 25_000 }).catch(async () => {
    await page.getByTestId('pdf-cancel').click({ timeout: 2_000 }).catch(() => {});
    await page.getByTestId('pdf-cancel-close').click({ timeout: 2_000 }).catch(() => {});
    await page.getByTestId('pdf-close').click({ timeout: 2_000 }).catch(() => {});
    await page.getByTestId('pdf-dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  });
  await page.waitForTimeout(400);
}

for (const locale of ['ru', 'uz', 'en']) {
  // App.tsx syncs the UI language from the profile after boot, so the profile has to change —
  // and profileUpdateSchema wants a name and a time zone along with it (a bare {locale} is a 400).
  await page.evaluate((lng) => localStorage.setItem('klass_locale', lng), locale);
  const patched = await api(TT, 'PATCH', '/api/me/profile', {
    name: 'Teacher', locale, tz: 'Asia/Tashkent',
  });
  if (patched.status !== 200) console.log('WARNING profile locale patch', patched.status);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
    await openLesson();          // reload: the new locale and theme are read on boot
    // proof the shots are in the language their file name claims
    console.log('locale', locale, 'board heading:',
      await page.locator('[data-testid=board] h2').first().innerText());
    // the names the teacher gave are stored as-is; the localized default labels come from i18n
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(500);
      try {
        await capture(locale, width, theme);
      } catch (e) {
        // комбинация, которая упала, не должна превращать прогон в успех: её записываем,
        // остальные снимаем, а в конце выходим с кодом 1
        failedCombinations.push(`${locale}/${theme}/${width}: ${firstLine(e)}`);
        console.log('FAILED', locale, theme, width, firstLine(e));
        console.log('  url', await page.url(), '| board cards', await page.locator('[data-testid=board]').count(),
          '| tabs', await page.locator('[data-testid=board-tabs] [data-testid^=board-tab-]').count(),
          '| dialog', await page.locator('[data-testid=pdf-dialog]').count());
        await page.screenshot({ path: path.join(outDir, `board-shot-fail-${locale}-${width}-${theme}.png`) });
        // get back to the lesson for the next combination (a bare /login goto would bounce to Home)
        await openLesson().catch(() => {});
      }
    }
  }
}

await api(TT, 'POST', `/api/lessons/${session.id}/end`, {});
await browser.close();
// возвращаем то, что было: съёмка не должна оставлять после себя чужое состояние
if (profileBefore.locale) {
  const back = await api(TT, 'PATCH', '/api/me/profile', {
    name: profileBefore.name, lastName: profileBefore.lastName, locale: profileBefore.locale, tz: profileBefore.tz,
  });
  if (back.status !== 200) failedCombinations.push(`не удалось вернуть язык профиля (${back.status})`);
  else console.log('язык и имя сид-учителя возвращены:', profileBefore.locale);
}
console.log(`board-shots done (${count} png, упавших комбинаций: ${failedCombinations.length})`);
if (failedCombinations.length) {
  for (const f of failedCombinations) console.error('  FAILED', f);
  console.error('board-shots: часть кадров не снята — это не «готово»');
  await bye(1);
}
await bye(0);
