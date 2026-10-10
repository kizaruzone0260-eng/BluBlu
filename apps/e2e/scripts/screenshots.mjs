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
// .stack.json is written only after the migrations + seeding, while /api/health/live already
// answers — reading it once made this script die with ENOENT (measured again on 2026-10-09)
const credsFile = path.join(root, 'apps/e2e/.stack.json');
let creds = null;
for (let i = 0; i < 120 && !creds; i++) {
  try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!creds) { console.error('screenshots: .stack.json never appeared'); await bye(1); }

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
// archive stale e2e-run classes so the «Для кого»/filter lists stay readable
for (const c of classes.filter((x) => /^E2E (Чат|mute|камера|события|Материал|раскладка) \d{10,}/.test(x.name) && !x.archived)) {
  await api('POST', `/api/classes/${c.id}/archive`);
}
// task 2 — the «Имя и фамилия» gate shots use a NEVER-completed account
const gateLogin = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'shot@e2e.io', password: 'Passw0rd123' }),
})).json();
const apiGate = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${gateLogin.accessToken}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return r.json().catch(() => null);
};
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
// drop leftovers from ink/name e2e runs so the shot list stays presentable
for (const n of notes.filter((x) => /^(Зум-тест|probe\d*|wheel probe)/.test(x.title))) {
  await api('DELETE', `/api/notes/${n.id}`);
}
// a small hand-made curve so the notes screenshots show the drawing feature (item 3)
const inkStrokes = {
  strokes: [
    { c: '#0f766e', w: 4, pts: [[60, 300], [160, 140], [260, 300], [360, 120], [470, 300], [560, 160], [650, 280]] },
    { c: '#c0392f', w: 5, pts: [[700, 150], [740, 230], [780, 150], [820, 230], [860, 150]] },
    { c: '#17211d', w: 3, pts: [[60, 360], [300, 360]] },
  ],
};
const inkHtml = `<div class="note-drawing" data-note-drawing="${encodeURIComponent(JSON.stringify(inkStrokes))}"></div>`;
const showcaseBody = `<p>План урока: разминка 5 мин, доска, листки. Закрепить после звонка.</p>${inkHtml}`;
const showcase = notes.find((n) => n.title === 'Заметка для скринов');
if (!showcase) {
  const created = await api('POST', '/api/notes', { title: 'Заметка для скринов', body: showcaseBody });
  if (created?.id) await api('PATCH', `/api/notes/${created.id}`, { pinned: true });
} else {
  if (!showcase.pinned) await api('PATCH', `/api/notes/${showcase.id}`, { pinned: true });
  if (!showcase.body?.includes('note-drawing')) await api('PATCH', `/api/notes/${showcase.id}`, { title: 'Заметка для скринов', body: showcaseBody });
}

// ── chat fixtures (item 8): a student + a few exchanged messages ─────────────
const inv = await api('POST', `/api/classes/${cls.id}/invites`, { ttlDays: 30 });
const chatStuEmail = `shots${cls.id.slice(0, 6)}@x.io`;
let stuToken = null;
const existing = await api('GET', '/api/classes/' + cls.id + '/members');
if (!existing?.some?.((m) => m.email === chatStuEmail)) {
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'Азиза', lastName: 'Каримова', email: chatStuEmail, password: 'ShotPass123', code: inv.code }),
  })).json().catch(() => null);
  stuToken = reg?.accessToken ?? null;
} else {
  const l = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: chatStuEmail, password: 'ShotPass123' }),
  })).json().catch(() => null);
  stuToken = l?.accessToken ?? null;
}
const chatMsgs = await (await fetch(`${BASE}/api/classes/${cls.id}/chat/messages?limit=50`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json().catch(() => ({ messages: [] }));
if (!(chatMsgs.messages?.length >= 3)) {
  const say = async (tok, text) => { await fetch(`${BASE}/api/classes/${cls.id}/chat/messages`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); };
  await say(login.accessToken, 'Всем привет! В четверг повторяем дроби — доска будет открыта за 5 минут до старта.');
  if (stuToken) { await say(stuToken, 'Хорошо, подготовлю листок №4 📄'); await say(stuToken, 'А домашку можно сдавать до пятницы?'); await say(login.accessToken, 'Да, до 23:59 пятницы.'); }
}
// reply fixture (task 2, 2026-10-08): one answer that QUOTES a question, for chat-quote/chat-reply
const withReplies = await (await fetch(`${BASE}/api/classes/${cls.id}/chat/messages?limit=50`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json().catch(() => ({ messages: [] }));
if (!(withReplies.messages ?? []).some((m) => m.replyTo)) {
  const asked = (withReplies.messages ?? []).find((m) => m.text.includes('домашку'))
    ?? (withReplies.messages ?? [])[0];
  if (asked) {
    await fetch(`${BASE}/api/classes/${cls.id}/chat/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Да, до 23:59 пятницы — успеем проверить.', replyToId: asked.id }),
    });
  }
}

// ── material fixture (task A): topic + file/link/youtube/drive attachments ──
const feedAll = await api('GET', `/api/classes/${cls.id}/feed`);
if (!feedAll.some((x) => x.title === 'Дроби: конспект')) {
  const topic = await api('POST', `/api/classes/${cls.id}/topics`, { name: 'Сложение дробей' });
  const fd = new FormData();
  fd.set('title', 'Дроби: конспект');
  fd.set('description', '<p><b>Сложение</b> и вычитание дробей. <i>Домашка</i> — листок №4.</p>');
  if (topic?.id) fd.set('topicId', topic.id);
  fd.set('attachments', JSON.stringify([
    { url: 'https://example.com/konspekt.pdf', title: 'Конспект (сайт школы)' },
    { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Разбор на YouTube' },
    { url: 'https://drive.google.com/file/d/1abc/view', title: 'Рабочий лист на Диске' },
  ]));
  fd.set('file', new Blob([new TextEncoder().encode('%PDF-1.4 material fixture body').buffer], { type: 'application/pdf' }), 'лист-4.pdf');
  await fetch(`${BASE}/api/classes/${cls.id}/materials`, { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}` }, body: fd });
}

// ── lesson comments fixture (task 2): a live session with a pinned and an answered note ──
let lessonSession = (await api('GET', `/api/lessons/active?classId=${cls.id}`))?.session;
if (!lessonSession) lessonSession = await api('POST', '/api/lessons/start', { classId: cls.id });
if (lessonSession) {
  const say = async (text) => (await api('POST', `/api/lessons/${lessonSession.id}/comments`, { text }))?.id;
  const FIXTURES = ['А дробь 2/4 надо сокращать?', 'У меня не видно, что на доске'];
  const seen = (await api('GET', `/api/lessons/${lessonSession.id}/comments`))?.comments ?? [];
  // the e2e database survives between runs, so the fixture set is rebuilt from scratch each time:
  // without this the panel fills up with duplicates of the same two lines
  for (const c of seen.filter((x) => FIXTURES.includes(x.text))) {
    await api('DELETE', `/api/lessons/${lessonSession.id}/comments/${c.id}`);
  }
  const q1 = await say(FIXTURES[0]);
  await say(FIXTURES[1]);
  if (q1) {
    await api('POST', `/api/lessons/${lessonSession.id}/comments/${q1}/pin`, { on: true });
    await api('POST', `/api/lessons/${lessonSession.id}/comments/${q1}/answered`, { on: true });
  }
}

// ── raise-hand fixture (task 2Б): one hand is up, so the queue has something to show ──
if (lessonSession && stuToken) {
  const hand = async (method) => fetch(`${BASE}/api/lessons/${lessonSession.id}/hand`, {
    method, headers: method === 'POST'
      ? { authorization: `Bearer ${stuToken}`, 'content-type': 'application/json' }
      : { authorization: `Bearer ${stuToken}` },
    body: method === 'POST' ? '{}' : undefined,
  });
  // lowered first: the row survives from a previous run with an old timestamp, and the picture
  // should read «кто-то только что поднял руку»
  await hand('DELETE').catch(() => undefined);
  await hand('POST').catch(() => undefined);
}

// ── capture ───────────────────────────────────────────────────────────────────
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
  // the name-gate account (task 2) must answer in the same language: a PATCH
  // with an EMPTY family name never completes the profile → the gate stays
  await apiGate('PATCH', '/api/me/profile', { name: 'Shot', lastName: '', locale, tz: 'Asia/Tashkent' });
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
        // item 9 — registration step 1 (fresh code; check-code never burns it)
        if (!only || only.includes('register') || only.includes('register2')) {
          const regInvite = await api('POST', `/api/classes/${cls.id}/invites`, { ttlDays: 30 });
          await lp.goto(`${BASE}/register`);
          await lp.waitForTimeout(300);
          await lp.getByTestId('reg-code').fill(regInvite.code);
          await lp.getByTestId('reg-email').fill('demo.student@example.com');
          await lp.getByTestId('reg-password').fill('DemoPass123');
          if (!only || only.includes('register')) {
            await lp.screenshot({ path: path.join(outDir, `register-${locale}-${width}-${theme}.png`) });
            count++;
          }
          if (!only || only.includes('register2')) {
            await lp.getByTestId('register-step1').click();
            await lp.getByTestId('reg-first').waitFor({ timeout: 8000 }).catch(() => undefined);
            await lp.getByTestId('reg-first').fill('Азиза');
            await lp.getByTestId('reg-last').fill('Каримова');
            await lp.waitForTimeout(300);
            await lp.screenshot({ path: path.join(outDir, `register2-${locale}-${width}-${theme}.png`) });
            count++;
          }
        }
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
      // task 2: the comments panel open, with a pinned and an answered comment
      if (!only || only.includes('lesson-comments')) {
        await page.goto(`${BASE}/lesson?classId=${cls.id}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const openBtn = page.getByTestId('comments-open');
        if (await openBtn.count()) {
          await openBtn.click();
          await page.waitForTimeout(1_000);
          await page.screenshot({ path: path.join(outDir, `lesson-comments-${locale}-${width}-${theme}.png`) });
          count++;
          fs.writeFileSync(path.join(outDir, 'LAST.txt'), `lesson-comments-${locale}-${width}-${theme}.png`);
        }
      }
      // task 2Б: the teacher's queue with a student's hand up. «Дать слово» is not shown here on
      // purpose — the grant needs that person to be a real participant in a live room, and this
      // script never joins media; the picture documents the ask and the queue, not the answer.
      if (!only || only.includes('hands')) {
        await page.goto(`${BASE}/lesson?classId=${cls.id}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const queue = page.getByTestId('hands-panel');
        if (await queue.count()) {
          await queue.locator('summary').click();
          await page.waitForTimeout(900);
          /*
           * The queue sits under the board, so a plain viewport shot showed the summary and cut off
           * the very row this picture is about (measured on the first run), and `fullPage: true`
           * painted the sticky header and the mobile tab bar ON TOP of the list. Scrolling the open
           * panel into view and shooting the viewport is the only version that shows the row.
           */
          await queue.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(outDir, `hands-${locale}-${width}-${theme}.png`) });
          count++;
          fs.writeFileSync(path.join(outDir, 'LAST.txt'), `hands-${locale}-${width}-${theme}.png`);
        }
      }
      // task A: the «Создать материал» page (form + right panel)
      await shot('material', `/classes/${cls.id}/material/new`);
      await shot('calendar', '/calendar');
      // item 5: per-event actions — teacher's edit form footer carries the
      // «Add to Google» and «.ics» buttons
      if (!only || only.includes('calendar')) {
        await page.goto(`${BASE}/calendar`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const ev = page.locator('.fc-event', { hasText: 'Урок: дроби (showcase)' }).first();
        if (await ev.count()) {
          await ev.click();
          await page.waitForTimeout(700);
          await page.screenshot({ path: path.join(outDir, `calendar-event-${locale}-${width}-${theme}.png`) });
          count++;
        }
      }
      // notes: OPEN the showcase note so the editor + drawing (item 3) are visible
      await shot('notes', '/notes');
      // guarded: with SHOT_ONLY=chatroom this block used to click a note that was never shot and
      // crash the whole run (measured 2026-10-09: locator.click timeout on note-item)
      if (!only || only.includes('notes')) {
        await page.getByTestId('note-item').first().click();
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(outDir, `notes-${locale}-${width}-${theme}.png`) });
        count++;
        // item 6: the drawing editor itself — toolbar row with hand/zoom/fit/fullscreen
        if (!only || only.includes('notes')) {
          await page.getByTestId('ink-mode').click();
          await page.waitForTimeout(400);
          await page.getByTestId('ink-zoom-in').click();
          await page.getByTestId('ink-fit').click(); // «Show all»: the drawing fits the canvas in every shot
          await page.getByTestId('ink-canvas').scrollIntoViewIfNeeded().catch(() => undefined);
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(outDir, `notes-ink-${locale}-${width}-${theme}.png`) });
          count++;
          await page.getByTestId('ink-mode').click(); // off again for later shots
        }
      }
      await shot('chat', '/chat');
      await shot('chatroom', `/chat/${cls.id}`);
      // item 7: the «⋯» action menu open on one of the teacher's own messages
      if (!only || only.includes('chatroom')) {
        await page.goto(`${BASE}/chat/${cls.id}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(900);
        const mine = page.locator('.chat-msg.mine').first();
        if (await mine.count()) {
          await mine.hover();
          const more = mine.getByTestId('chat-more');
          if (await more.count()) {
            await more.click().catch(() => undefined);
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(outDir, `chat-menu-${locale}-${width}-${theme}.png`) });
            count++;
            await page.keyboard.press('Escape');
            await page.getByTestId('chat-menu-backdrop').click({ position: { x: 2, y: 2 } }).catch(() => undefined);
          }
        }
      }
      // task 2 (2026-10-08): the quote inside a bubble, and the «Ответить» bar above the composer
      if (!only || only.includes('chatroom')) {
        await page.goto(`${BASE}/chat/${cls.id}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(900);
        const quote = page.getByTestId('chat-quote').first();
        if (await quote.count()) {
          await quote.scrollIntoViewIfNeeded().catch(() => undefined);
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(outDir, `chat-quote-${locale}-${width}-${theme}.png`) });
          count++;
        }
        const anyMsg = page.locator('[data-testid=chat-msg]').first();
        if (await anyMsg.count()) {
          await anyMsg.hover();
          await anyMsg.getByTestId('chat-more').click().catch(() => undefined);
          await page.waitForTimeout(250);
          await page.getByTestId('chat-act-reply').click().catch(() => undefined);
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(outDir, `chat-reply-${locale}-${width}-${theme}.png`) });
          count++;
          // Esc must cancel the pending answer — the same key the tests assert on
          await page.keyboard.press('Escape');
          await page.waitForTimeout(250);
        }
      }
      await shot('profile', '/profile');
      await ctx.close();
      // name-gate screen (task 2): fresh context, incomplete account, no save
      if (!only || only.includes('name')) {
        const gctx = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: theme === 'dark' ? 'dark' : 'light',
          locale: locale === 'ru' ? 'ru-RU' : locale === 'uz' ? 'uz-UZ' : 'en-GB',
        });
        await gctx.addInitScript(([lng, th]) => {
          localStorage.setItem('klass_locale', lng);
          localStorage.setItem('klass_theme', th);
        }, [locale, theme]);
        const gp = await gctx.newPage();
        await gp.goto(`${BASE}/login`);
        await gp.getByTestId('email').fill('shot@e2e.io');
        await gp.getByTestId('password').fill('Passw0rd123');
        await gp.getByTestId('login-submit').click();
        await gp.getByTestId('name-gate').waitFor({ timeout: 20_000 });
        await gp.waitForTimeout(400);
        await gp.screenshot({ path: path.join(outDir, `name-${locale}-${width}-${theme}.png`) });
        count++;
        await gctx.close();
      }
      }
    }
  }
}
console.log(`[screenshots] ${count} files → docs/screenshots/`);
await browser.close();
await bye(0);
