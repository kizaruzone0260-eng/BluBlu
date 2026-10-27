/**
 * Скриншоты новой панели управления уроком (задача 2026-10-10, часть 1).
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/lesson-bar-shots.mjs
 *
 * Что снимается и почему именно так:
 *  • ученик в комнате (тот же кадр, что и в lesson-shots.mjs: живой LiveKit, фейковые камера и
 *    микрофон), потому что панель управления видна именно в этом состоянии;
 *  • 390 / 768 / 1280 px × ru / uz / en × light / dark = 18 кадров — ровно те границы, которые
 *    названы в списке дел (5 кнопок на телефоне, подписи от 1024 px, три языка, две темы);
 *  • плюс два кадра с открытой правой панелью (1280 и 390, ru, light) — на них видны вкладки
 *    «Участники» / «Комментарии» и очередь поднятых рук.
 *
 * Файлы пишутся в docs/screenshots/lesson-bar-<locale>-<width>-<theme>.png (и …-panel.png).
 * Секретов не печатает: токены только в памяти, в консоль идут имена файлов.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.join(root, 'docs', 'screenshots');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('lesson-bar-shots: нужны LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET в окружении');
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
});
let closing = false;
async function bye(code = 0) {
  if (closing) return; closing = true;
  try { stack.kill(); } catch { /* уже нет */ }
  process.exitCode = code;
}
process.on('SIGINT', () => void bye(0));

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try { if ((await fetch(`${BASE}/api/health/live`)).ok) return; } catch { /* поднимается */ }
  }
  throw new Error('стек не стал здоровым');
}

let browser = null;
await waitHealth();
try {
  // стек пишет .stack.json чуть позже, чем становится здоровым, поэтому ждём именно файл
  const stackFile = path.join(root, 'apps/e2e/.stack.json');
  let creds = null;
  for (let i = 0; i < 60 && !creds; i++) {
    try { creds = JSON.parse(fs.readFileSync(stackFile, 'utf8')); }
    catch { await new Promise((r) => setTimeout(r, 1_000)); }
  }
  if (!creds) throw new Error('.stack.json так и не появился');
  const api = async (tok, method, p, body) => {
    const r = await fetch(`${BASE}${p}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const tok = async (email, password) => {
    try {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return (await r.json().catch(() => ({})))?.accessToken ?? '';
    } catch { return ''; }
  };

  let TT = await tok(creds.teacherEmail, creds.teacherPassword);
  if (!TT) throw new Error('учитель не вошёл в стек — проверьте, что e2e-стек поднялся');

  const classes = (await api(TT, 'GET', '/api/classes')).json ?? [];
  let cls = classes.find((c) => c.name === '7B — camera shots');
  if (!cls) cls = (await api(TT, 'POST', '/api/classes', { name: '7B — camera shots', description: '', color: '#0ea5a5' })).json;
  const stuEmail = 'shotslesson-bar@x.io';
  const sPass = 'ShotPass123';
  let ST = await tok(stuEmail, sPass);
  if (!ST) {
    // аккаунт ученика заводится ОДНОРАЗОВОЙ ССЫЛКОЙ: приём по коду класса выведен из продукта
    // 2026-10-27, и `POST /api/classes/:id/invites` вместе с `/api/auth/register` отвечают 410
    const link = (await api(TT, 'POST', `/api/classes/${cls.id}/invites/link`, { ttlDays: 30 })).json;
    const reg = await fetch(`${BASE}/api/invitations/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: String(link?.url ?? '').split('#')[1] ?? '',
        firstName: 'Азиза', lastName: 'Каримова', email: stuEmail, password: sPass,
      }),
    });
    ST = (await reg.json().catch(() => ({})))?.accessToken ?? '';
  }
  if (!ST) throw new Error('ученик не зарегистрирован/не вошёл — кадр снимать не с чего');

  const session = (await api(TT, 'POST', '/api/lessons/start', { classId: cls.id })).json;

  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  async function loginRole(email, password) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForTimeout(1_500);
    return { ctx, page };
  }
  const T = await loginRole(creds.teacherEmail, creds.teacherPassword);
  const S = await loginRole(stuEmail, sPass);

  const JOINED = () => {
    const vids = [...document.querySelectorAll('.videos video')];
    const ok = (loc) => vids.some((v) => v.closest('[data-local]')?.dataset.local === loc && v.videoWidth > 0 && v.clientWidth > 0);
    return ok('1') && ok('0');
  };
  async function join(page) {
    await page.getByTestId('check-devices').click();
    await page.getByTestId('join-lesson').click();
  }
  async function room(teacherFirst) {
    const order = teacherFirst ? [T, S] : [S, T];
    for (const r of order) { await r.page.goto(`${BASE}/lesson?classId=${cls.id}`); await join(r.page); }
    await S.page.waitForFunction(JOINED, null, { timeout: 45_000 });
  }

  let shots = 0;
  for (const locale of ['ru', 'uz', 'en']) {
    await api(TT, 'PATCH', '/api/me/profile', { name: 'Teacher', locale, tz: 'Asia/Tashkent' });
    await api(ST, 'PATCH', '/api/me/profile', { name: 'Азиза', locale, tz: 'Asia/Tashkent' });
    for (const theme of ['light', 'dark']) {
      for (const width of [390, 768, 1280]) {
        const height = width === 390 ? 844 : width === 768 ? 1024 : 900;
        for (const { page } of [T, S]) {
          await page.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
          await page.setViewportSize({ width, height });
        }
        await room(true);
        const out = path.join(outDir, `lesson-bar-${locale}-${width}-${theme}.png`);
        await S.page.screenshot({ path: out });
        console.log('shot', out.split(path.sep).pop());
        shots++;
      }
    }
  }

  // два кадра с открытой панелью: правая панель на десктопе и нижний лист на телефоне
  await api(TT, 'PATCH', '/api/me/profile', { name: 'Teacher', locale: 'ru', tz: 'Asia/Tashkent' });
  await api(ST, 'PATCH', '/api/me/profile', { name: 'Азиза', locale: 'ru', tz: 'Asia/Tashkent' });
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    for (const { page } of [T, S]) {
      await page.evaluate(() => localStorage.setItem('klass_theme', 'light'));
      await page.setViewportSize({ width, height });
    }
    await room(true);
    await S.page.getByTestId('comments-open').click();
    await S.page.waitForTimeout(600);
    const out = path.join(outDir, `lesson-bar-ru-${width}-light-panel.png`);
    await S.page.screenshot({ path: out });
    console.log('shot', out.split(path.sep).pop());
    shots++;
  }

  await api(TT, 'POST', `/api/lessons/${session.id}/end`, {});
  await browser.close();
  console.log(`готово: ${shots} кадров в docs/screenshots`);
  await bye(0);
} catch (e) {
  console.error('lesson-bar-shots:', String(e && e.message ? e.message : e));
  // что на экране в момент падения — иначе причина только угадывается
  for (const [who, r] of [['teacher', typeof T !== 'undefined' ? T : null], ['student', typeof S !== 'undefined' ? S : null]]) {
    if (!r?.page) continue;
    try {
      const txt = await r.page.evaluate(() => document.body.innerText);
      console.error(`dump ${who}: url=${r.page.url()} text=${txt.replace(/\s+/g, ' ').slice(0, 300)}`);
    } catch { /* страница уже закрыта */ }
  }
  await browser?.close?.().catch(() => undefined);
  await bye(1);
}
