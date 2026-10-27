/**
 * Lesson-with-camera screenshots for docs/screenshots (camera task, stage 3).
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/lesson-shots.mjs
 * Runs the e2e stack (embedded PG + API on :3123 serving the built web bundle)
 * with REAL LiveKit credentials (fake camera/mic via chromium flags), teacher +
 * student in one room, then captures the student's in-room view:
 *   lesson-camera-<locale>-<width>-<theme>.png for ru/en × 390/1280 × light/dark.
 * ONE login per role (the /api/auth/login cap is 10/min/IP) — locale switches via
 * the profile, theme via localStorage, size via setViewportSize, room re-joined
 * per shot. Never prints secrets.
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
  console.error('lesson-shots: needs LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET in env (tiles must carry real video)');
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
let cls = classes.find((c) => c.name === '7B — camera shots');
if (!cls) cls = (await api(TT, 'POST', '/api/classes', { name: '7B — camera shots', description: '', color: '#0ea5a5' })).json;
const stuEmail = 'shotslesson@x.io';
const sPass = 'ShotPass123';
let ST = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: stuEmail, password: sPass }),
})).json().catch(() => ({})))?.accessToken;
// ученик заводится одноразовой ССЫЛКОЙ-приглашением: приём по коду класса выведен 2026-10-27,
// `POST /api/classes/:id/invites` и `/api/auth/register` отвечают 410. Ссылку просим только если
// аккаунта ещё нет — она расходуется первым удачным входом.
if (!ST) {
  const link = (await api(TT, 'POST', `/api/classes/${cls.id}/invites/link`, { ttlDays: 30 })).json;
  ST = (await (await fetch(`${BASE}/api/invitations/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: String(link?.url ?? '').split('#')[1] ?? '',
      firstName: 'Азиза', lastName: 'Каримова', email: stuEmail, password: sPass,
    }),
  })).json().catch(() => ({})))?.accessToken;
}

const session = (await api(TT, 'POST', '/api/lessons/start', { classId: cls.id })).json;

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
  await page.waitForTimeout(1_500); // StrictMode boot + /api/me
  return { ctx, page };
}
const T = await loginRole(creds.teacherEmail, creds.teacherPassword);
const S = await loginRole(stuEmail, sPass);

const JOINED = () => {
  const vids = [...document.querySelectorAll('.videos video')];
  const ok = (loc) => vids.some((v) => v.closest('[data-local]')?.dataset.local === loc && v.videoWidth > 0 && v.clientWidth > 0);
  return ok('1') && ok('0');
};

async function joinRole(page) {
  await page.getByTestId('check-devices').click();
  await page.getByTestId('join-lesson').click();
}

let shots = 0;
for (const locale of ['ru', 'en']) {
  await api(TT, 'PATCH', '/api/me/profile', { name: 'Teacher', locale, tz: 'Asia/Tashkent' });
  await api(ST, 'PATCH', '/api/me/profile', { name: 'Азиза', locale, tz: 'Asia/Tashkent' });
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1280]) {
      const height = width === 390 ? 844 : 900;
      for (const { page } of [T, S]) {
        await page.evaluate((th) => localStorage.setItem('klass_theme', th), theme);
        await page.setViewportSize({ width, height });
      }
      await T.page.goto(`${BASE}/lesson?classId=${cls.id}`);
      await joinRole(T.page);
      await T.page.waitForFunction(JOINED, null, { timeout: 30_000 }).catch(() => { /* teacher may only have own tile before the student joins */ });
      await S.page.goto(`${BASE}/lesson?classId=${cls.id}`);
      await joinRole(S.page);
      await S.page.waitForFunction(JOINED, null, { timeout: 40_000 });
      const out = path.join(outDir, `lesson-camera-${locale}-${width}-${theme}.png`);
      await S.page.screenshot({ path: out });
      console.log('shot', out.split(path.sep).pop());
      shots++;
    }
  }
}

await api(TT, 'POST', `/api/lessons/${session.id}/end`, {});
await browser.close();
console.log(`lesson-shots done (${shots} png)`);
await bye(0);
