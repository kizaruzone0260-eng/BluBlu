/**
 * Screenshot matrix for docs/screenshots (task E.2):
 *   pages: Home, Class, Calendar, Notes, Profile, Login
 *   locales: ru / uz / en
 *   widths: 390 / 768 / 1280
 *   themes: light / dark
 *
 * Usage: node apps/e2e/scripts/screenshots.mjs   (from repo root; builds first
 * if apps/web/dist is missing). Launches the same e2e stack (API on :3123 +
 * embedded PG on :5455), creates a small SHOWCASE class through the API, then
 * captures PNGs to docs/screenshots/.
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
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stack = spawn('node', ['scripts/e2e-stack.mjs'], { cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'] });
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

// ── fixtures via the real API ───────────────────────────────────────────────
const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: creds.teacherEmail, password: creds.teacherPassword }),
})).json();
const H = { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    // fastify rejects an empty body when content-type is json — send {} for writes
    headers: method === 'GET' ? { authorization: H.authorization } : H,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return r.json().catch(() => null);
};
const classes = await api('GET', '/api/classes');
let cls = classes.find((c) => c.name === 'Демо-класс 7B (showcase)');
if (!cls) {
  cls = await api('POST', '/api/classes', { name: 'Демо-класс 7B (showcase)', description: 'Демонстрационный класс для скриншотов интерфейса.', color: '#4f46e5' });
}
// announcement (+ event + note) created only once (idempotent by presence check)
const feed = await api('GET', `/api/classes/${cls.id}/feed`);
// cleanup of older-style fixtures (HTML shown as raw text was v1 of this script)
for (const p of feed.filter((x) => x.body?.includes('<p>'))) {
  await api('DELETE', `/api/posts/${p.id}`);
}
const feed2 = await api('GET', `/api/classes/${cls.id}/feed`);
if (!feed2.some((x) => x.title === 'Добро пожаловать!')) {
  await fetch(`${BASE}/api/classes/${cls.id}/announcements`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: 'Добро пожаловать!', body: 'План на неделю: дроби, сравнение, доска. Домашка — листок №4.' }),
  });
}
const evFrom = new Date().toISOString();
const evTo = new Date(Date.now() + 6 * 864e5).toISOString();
const evs = await api('GET', `/api/events?from=${evFrom}&to=${evTo}`);
if (!evs.some((e) => e.title === 'Урок: дроби (showcase)')) {
  const d = new Date(Date.now() + 864e5);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T16:00`;
  await api('POST', `/api/classes/${cls.id}/events`, {
    kind: 'lesson', title: 'Урок: дроби (showcase)', description: 'Демонстрационное событие календаря.',
    startLocal: iso, durationMin: 45, tz: 'Asia/Tashkent', repeat: null,
  });
}
const notes = await api('GET', '/api/notes');
const showcase = notes.find((n) => n.title === 'Заметка для скринов');
if (!showcase) {
  const created = await api('POST', '/api/notes', { title: 'Заметка для скринов', body: '<p>План урока: разминка 5 мин, доска, листки. Закрепить после звонка.</p>' });
  if (created?.id) await api('PATCH', `/api/notes/${created.id}`, { pinned: true });
} else if (!showcase.pinned) {
  await api('PATCH', `/api/notes/${showcase.id}`, { pinned: true });
}

// ── capture ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge' });
const widths = process.env.SHOT_WIDTHS ? process.env.SHOT_WIDTHS.split(',').map(Number) : [390, 768, 1280];
const themes = ['light', 'dark'];
const allLocales = ['ru', 'uz', 'en'];
const locales = process.env.SHOT_LOCALE ? [process.env.SHOT_LOCALE] : allLocales;
const only = process.env.SHOT_ONLY ? process.env.SHOT_ONLY.split(',') : null; // e.g. SHOT_ONLY=login

let count = 0;
for (const locale of locales) {
  const me = await api('GET', '/api/me');
  await api('PATCH', '/api/me/profile', { name: me.name, locale, tz: me.tz });
  for (const theme of themes) {
    for (const width of widths) {
      // unauthenticated login shot
      if (!only || only.includes('login')) {
        const lctx = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: theme === 'dark' ? 'dark' : 'light',
        });
        await lctx.addInitScript(([lng, th]) => {
          localStorage.setItem('klass_locale', lng);
          localStorage.setItem('klass_theme', th);
        }, [locale, theme]);
        const lp = await lctx.newPage();
        await lp.goto(`${BASE}/login`);
        await lp.waitForLoadState('networkidle').catch(() => undefined);
        await lp.waitForTimeout(400);
        await lp.screenshot({ path: path.join(outDir, `login-${locale}-${width}-${theme}.png`) });
        count++;
        await lctx.close();
      }
      // authenticated shots: ONE login per context; subsequent full loads reuse
      // the rotating refresh cookie inside the same jar (sequential — safe).
      if (!only || only.some((k) => k !== 'login')) {
      const ctx = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        locale: locale === 'ru' ? 'ru-RU' : locale === 'uz' ? 'uz-UZ' : 'en-GB',
      });
      await ctx.addInitScript(([lng, th]) => {
        localStorage.setItem('klass_locale', lng);
        localStorage.setItem('klass_theme', th);
      }, [locale, theme]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      await page.getByTestId('email').fill(creds.teacherEmail);
      await page.getByTestId('password').fill(creds.teacherPassword);
      await page.getByTestId('login-submit').click();
      await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
      const shot = async (key, pathName) => {
        if (only && !only.includes(key)) return;
        if (pathName !== undefined) await page.goto(`${BASE}${pathName}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(outDir, `${key}-${locale}-${width}-${theme}.png`) });
        count++;
        fs.writeFileSync(path.join(outDir, 'LAST.txt'), `${key}-${locale}-${width}-${theme}.png`);
      };
      await shot('home');
      await shot('class', `/classes/${cls.id}`);
      await shot('calendar', '/calendar');
      await shot('notes', '/notes');
      await shot('profile', '/profile');
      await ctx.close();
      }
    }
  }
}
console.log(`[screenshots] ${count} files → docs/screenshots/`);
await browser.close();
await bye(0);
