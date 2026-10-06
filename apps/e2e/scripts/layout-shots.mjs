/**
 * Lesson layout (task B) screenshots for docs/screenshots.
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/layout-shots.mjs
 * Teacher + student join with fake cameras, the teacher OPENS THE BOARD, and
 * both stage views are captured: lesson-stage-<role>-<locale>-<width>-<theme>.png
 * (3 locales × 390/1280 × light/dark) plus one plain-grid pair per run.
 * ONE login per role; locale via profile PATCH + reload; never prints secrets.
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

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('layout-shots: needs LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET (the stage needs real video)');
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
});
let shuttingDown = false;
async function bye(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stack.kill(); } catch { /* gone */ }
  process.exit(code);
}
process.on('SIGINT', () => void bye(0));

async function waitHealth() {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { if ((await fetch(`${BASE}/api/health/live`)).ok) return; } catch { /* up… */ }
  }
  throw new Error('stack did not come up');
}
await waitHealth();
const creds = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8'));

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

const classes = (await api(TT, 'GET', '/api/classes')).json;
let cls = classes.find((c) => c.name === '7B — layout shots');
if (!cls) cls = (await api(TT, 'POST', '/api/classes', { name: '7B — layout shots', description: '', color: '#0ea5a5' })).json;
const inv = (await api(TT, 'POST', `/api/classes/${cls.id}/invites`, { ttlDays: 30 })).json;
const stuEmail = 'shotslayout@x.io';
const sPass = 'ShotPass123';
let ST = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: stuEmail, password: sPass }),
})).json().catch(() => ({})))?.accessToken;
if (!ST) ST = (await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstName: 'Раскладка', lastName: 'Тест', email: stuEmail, password: sPass, code: inv.code }),
})).json()).accessToken;
// the lesson must be RUNNING, or /lesson shows the «не начат» card
await api(TT, 'POST', '/api/lessons/start', { classId: cls.id });

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
async function loginRole(email, password) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('home-title').waitFor({ timeout: 20_000 });
  return { ctx, page };
}
const T = await loginRole(creds.teacherEmail, creds.teacherPassword);
const S = await loginRole(stuEmail, sPass);

/** any <video> with real pixels for the given locality (grid, strip or pip) */
async function hasVideo(page, loc) {
  return page.evaluate((l) => [...document.querySelectorAll('video')].some((v) => v.closest('[data-local]')?.dataset.local === l && v.videoWidth > 0 && v.clientWidth > 0), loc);
}
async function waitVideo(page, loc, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await hasVideo(page, loc)) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`no real video for data-local=${loc} within ${ms}ms`);
}
async function joinRole(page, clsId) {
  await page.goto(`${BASE}/lesson?classId=${clsId}`);
  await page.getByTestId('check-devices').click();
  await page.getByTestId('join-lesson').click();
}

let shots = 0;
async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('shot', name);
  shots++;
}

for (const locale of ['ru', 'uz', 'en']) {
  await api(TT, 'PATCH', '/api/me/profile', { name: 'Teacher', locale, tz: 'Asia/Tashkent' });
  await api(ST, 'PATCH', '/api/me/profile', { name: 'Раскладка', locale, tz: 'Asia/Tashkent' });
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1280]) {
      const height = width === 390 ? 844 : 900;
      for (const { page } of [T, S]) {
        await page.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
        await page.setViewportSize({ width, height });
      }
      // fresh join per combo (a reload drops the room)
      await joinRole(T.page, cls.id);
      await waitVideo(T.page, '1');
      await joinRole(S.page, cls.id);
      await waitVideo(S.page, '0'); // teacher's camera reached the student
      if (locale === 'ru' && theme === 'light' && width === 1280) {
        await shot(T.page, `lesson-grid-teacher-${locale}-${width}-${theme}.png`);
        await shot(S.page, `lesson-grid-student-${locale}-${width}-${theme}.png`);
      }
      // the teacher opens the board → stage for everyone
      await T.page.getByTestId('board-toggle').click();
      await T.page.getByTestId('lesson-stage').waitFor({ timeout: 15_000 });
      await S.page.getByTestId('lesson-stage').waitFor({ timeout: 15_000 });
      await S.page.getByTestId('pip-teacher').waitFor({ timeout: 15_000 });
      await T.page.waitForTimeout(900); // let Excalidraw paint
      await S.page.waitForTimeout(900);
      await shot(T.page, `lesson-stage-teacher-${locale}-${width}-${theme}.png`);
      await shot(S.page, `lesson-stage-student-${locale}-${width}-${theme}.png`);
      // close the board again for the next combo
      await T.page.getByTestId('board-toggle').click();
      await T.page.waitForTimeout(400);
    }
  }
}

const active = (await api(TT, 'GET', `/api/lessons/active?classId=${cls.id}`)).json?.session;
if (active) await api(TT, 'POST', `/api/lessons/${active.id}/end`, {});
await browser.close();
console.log(`layout-shots done (${shots} png)`);
await bye(0);
