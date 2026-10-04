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
  const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json().catch(() => null);
};
const classes = await api('GET', '/api/classes');
let cls = classes.find((c) => c.name === 'Демо-класс 7B (showcase)');
if (!cls) {
  cls = await api('POST', '/api/classes', { name: 'Демо-класс 7B (showcase)', description: 'Демонстрационный класс для скриншотов интерфейса.', color: '#4f46e5' });
}
// announcement (+ event + note) created only once (idempotent by presence check)
const feed = await api('GET', `/api/classes/${cls.id}/feed`);
if (!feed.length) {
  await fetch(`${BASE}/api/classes/${cls.id}/announcements`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: 'Добро пожаловать!', body: '<p>План на неделю: дроби, сравнение, доска. Домашка — листок №4.</p>' }),
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
if (!notes.some((n) => n.title === 'Заметка для скринов')) {
  await api('POST', '/api/notes', { title: 'Заметка для скринов', body: '<p>План урока: разминка 5 мин, доска, листки. Закрепить после звонка.</p>', pinned: true });
}

// ── capture ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge' });
const pages = [
  { key: 'home', path: '/' },
  { key: 'class', path: `/classes/${cls.id}` },
  { key: 'calendar', path: '/calendar' },
  { key: 'notes', path: '/notes' },
  { key: 'profile', path: '/profile' },
  { key: 'login', path: '/login' },
];
const widths = [390, 768, 1280];
const themes = ['light', 'dark'];
const locales = ['ru', 'uz', 'en'];

let count = 0;
for (const locale of locales) {
  const me = await api('GET', '/api/me');
  await api('PATCH', '/api/me/profile', { name: me.name, locale, tz: me.tz });
  for (const theme of themes) {
    for (const width of widths) {
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
      for (const p of pages) {
        if (p.key === 'login') {
          await page.goto(`${BASE}/login`);
        } else {
          await page.goto(`${BASE}/login`);
          await page.getByTestId('email').fill(creds.teacherEmail);
          await page.getByTestId('password').fill(creds.teacherPassword);
          await page.getByTestId('login-submit').click();
          await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
          if (p.path !== '/') await page.goto(`${BASE}${p.path}`);
        }
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(600);
        const file = path.join(outDir, `${p.key}-${locale}-${width}-${theme}.png`);
        await page.screenshot({ path: file });
        count++;
        fs.writeFileSync(path.join(outDir, 'LAST.txt'), file);
      }
      await ctx.close();
    }
  }
}
console.log(`[screenshots] ${count} files → docs/screenshots/`);
await browser.close();
await bye(0);
