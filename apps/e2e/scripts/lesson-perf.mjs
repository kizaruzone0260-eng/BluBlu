/**
 * Замер страницы урока (задача 2026-10-10, часть 2, пункт «измерить») — локально, на том же
 * проде-формате, что и e2e: стек поднимает встроенный Postgres, API и собранный фронт.
 *
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/lesson-perf.mjs
 *
 * Что снимается (только то, что действительно измеряется, без выводов «на глаз»):
 *  1) ресурсы страницы урока: размер и длительность каждой загрузки (/api/* и чанки), включая
 *     чанк страницы и начальный бандл;
 *  2) шаги входа в комнату по wall-clock: клик «Войти» → ответ active-запроса → join → билет WS
 *     → connect LiveKit → первые кадры собственного видео;
 *  3) опросы: сколько /api-запросов уходит за 60 с сидения в комнате (частота polling'а);
 *  4) работа браузера: дельты CDP-метрик ScriptDuration / LayoutDuration / RecalcStyleDuration /
 *     TaskDuration за 30 с покоя и за 30 с под 4× торможением CPU, плюс число layout shift и
 *     длинных задач;
 *  5) количество одновременно подписанных тайлов.
 *
 * В консоль печатается один JSON-отчёт. Секретов нет: токены не выводятся, URL только с хостом.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const out = path.join(root, 'lesson-perf.json');

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('lesson-perf: нужны LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  process.exit(1);
}

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
});
let browser = null;
let closing = false;
async function bye(code = 0) {
  if (closing) return; closing = true;
  try { await browser?.close(); } catch { /* нет */ }
  try { stack.kill(); } catch { /* нет */ }
  process.exitCode = code;
}
process.on('SIGINT', () => void bye(0));

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try { if ((await fetch(`${BASE}/api/health/live`)).ok) return; } catch { /* ждём */ }
  }
  throw new Error('стек не поднялся');
}

const host = (u) => { try { const x = new URL(u); return x.host; } catch { return ''; } };
const r = (n) => Math.round(n);

await waitHealth();
try {
  // стек пишет .stack.json чуть позже, чем становится здоровым
  let creds = null;
  for (let i = 0; i < 60 && !creds; i++) {
    try { creds = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8')); }
    catch { await new Promise((r) => setTimeout(r, 1_000)); }
  }
  if (!creds) throw new Error('.stack.json так и не появился');
  const post = async (p, body, tok) => (await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { authorization: tok ? `Bearer ${tok}` : '', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json();
  const login = async (email, password) => (await post('/api/auth/login', { email, password }))?.accessToken ?? '';

  const TT = await login(creds.teacherEmail, creds.teacherPassword);
  if (!TT) throw new Error('учитель не вошёл');
  const classes = await (await fetch(`${BASE}/api/classes`, { headers: { authorization: `Bearer ${TT}` } })).json();
  let cls = classes.find((c) => c.name === '7B — camera shots');
  if (!cls) cls = await post('/api/classes', { name: '7B — camera shots', description: '', color: '#0ea5a5' }, TT);
  const stuEmail = 'perflesson@x.io', sPass = 'PerfPass123';
  let ST = await login(stuEmail, sPass);
  // ученик заводится одноразовой ССЫЛКОЙ: приём по коду класса выведен 2026-10-27, и
  // `POST /api/classes/:id/invites` с `/api/auth/register` отвечают 410
  if (!ST) {
    const link = await post(`/api/classes/${cls.id}/invites/link`, { ttlDays: 30 }, TT);
    ST = (await post('/api/invitations/register', {
      token: String(link?.url ?? '').split('#')[1] ?? '',
      firstName: 'Пётр', lastName: 'Перф', email: stuEmail, password: sPass,
    }))?.accessToken;
  }
  if (!ST) throw new Error('ученик не готов');
  const session = await post('/api/lessons/start', { classId: cls.id }, TT);

  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });

  // доступный токен живёт в памяти страницы, а в cookie — refresh: вход только через форму
  async function role(email, password) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    // без этого Performance.getMetrics отдаёт пустой список (первый промер дал null на всех полях)
    await cdp.send('Performance.enable');
    await page.goto(`${BASE}/login`);
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    // как в lesson-bar-shots: не ждём конкретного экрана — между входом и главной может стоять
    // экран имени
    await page.waitForTimeout(2_000);
    return { ctx, page, cdp, res: [] };
  }
  const T = await role(creds.teacherEmail, creds.teacherPassword);
  T.page.on('requestfinished', async (req) => {
    try {
      const e = await T.page.evaluate((u) => {
        const en = performance.getEntriesByName(u, 'resource')[0];
        return en ? { duration: en.duration, transferSize: en.transferSize, encoded: en.encodedBodySize, decoded: en.decodedBodySize } : null;
      }, req.url());
      if (e) T.res.push({ url: req.url(), initiator: req.resourceType(), ...e });
    } catch { /* гонка — не важно */ }
  });

  // учитываем метрики браузера окнами
  async function metrics(cdp) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
  async function observers(page) {
    await page.evaluate(() => {
      window.__p = { shifts: 0, longTasks: 0, longTaskMs: 0 };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__p.shifts += e.value; }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__p.longTasks++; window.__p.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: true });
    });
  }
  const readObs = (page) => page.evaluate(() => window.__p);

  await T.page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await T.page.waitForLoadState('networkidle');
  await observers(T.page);

  // S заходит первым, чтобы у T был реальный второй участник (влияние на тайлы и ре-рендеры)
  const S = await role(stuEmail, sPass);
  await S.page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await S.page.getByTestId('check-devices').click();
  await S.page.getByTestId('join-lesson').click();
  await S.page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0), null, { timeout: 60_000 });

  // ── 2: шаги входа T по wall-clock + ресурсы ────────────────────────────────
  const steps = {};
  const t0 = Date.now();
  await T.page.getByTestId('check-devices').click();
  steps.deviceCheckMs = Date.now() - t0;
  const tJoin = Date.now();
  await T.page.getByTestId('join-lesson').click();
  await T.page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0), null, { timeout: 60_000 });
  steps.joinToFirstFrameMs = Date.now() - tJoin;
  steps.peerTileMs = await T.page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="0"]') && v.videoWidth > 0), null, { timeout: 60_000 })
    .then(() => Date.now() - tJoin).catch(() => null);

  const tiles = await T.page.evaluate(() => ({
    videoEls: document.querySelectorAll('.videos video').length,
    withFrames: [...document.querySelectorAll('.videos video')].filter((v) => v.videoWidth > 0).length,
    remote: [...document.querySelectorAll('.videos video')].filter((v) => v.closest('[data-local="0"]')).length,
  }));

  // ── 4а: 30 с покоя ─────────────────────────────────────────────────────────
  const m0 = await metrics(T.cdp), o0 = await readObs(T.page);
  await new Promise((r2) => setTimeout(r2, 30_000));
  const m1 = await metrics(T.cdp), o1 = await readObs(T.page);
  const idle = {
    scriptS: +(m1.ScriptDuration - m0.ScriptDuration).toFixed(3),
    layoutS: +(m1.LayoutDuration - m0.LayoutDuration).toFixed(3),
    recalcStyleS: +(m1.RecalcStyleDuration - m0.RecalcStyleDuration).toFixed(3),
    taskS: +(m1.TaskDuration - m0.TaskDuration).toFixed(3),
    nodes: r(m1.Nodes - m0.Nodes), listeners: r(m1.JSEventListeners - m0.JSEventListeners),
    heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    layoutShiftScore: +(o1.shifts - o0.shifts).toFixed(4),
    longTasks: o1.longTasks - o0.longTasks, longTaskMs: r(o1.longTaskMs - o0.longTaskMs),
  };

  // ── 3: опросы за 60 с в комнате ────────────────────────────────────────────
  // Страница за это время не трогается: переключение фокуса между двумя контекстами
  // сама вызывает refetch (refetchOnWindowFocus), и замер стал бы артефактом теста.
  const before = T.res.length;
  await new Promise((r2) => setTimeout(r2, 60_000));
  const window60 = T.res.slice(before).filter((x) => x.url.includes('/api/'))
    .reduce((acc, x) => { const k = x.url.replace(BASE, '').split('?')[0]; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const tilesAfter = await T.page.evaluate(() => document.querySelectorAll('.videos video').length);

  // ── 4б: то же под 4× торможением CPU ──────────────────────────────────────
  await T.cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const c0 = await metrics(T.cdp);
  await T.page.getByTestId('comments-open').click().catch(() => undefined);
  await new Promise((r2) => setTimeout(r2, 10_000));
  const c1 = await metrics(T.cdp);
  await T.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const throttled = {
    scriptS: +(c1.ScriptDuration - c0.ScriptDuration).toFixed(3),
    layoutS: +(c1.LayoutDuration - c0.LayoutDuration).toFixed(3),
    recalcStyleS: +(c1.RecalcStyleDuration - c0.RecalcStyleDuration).toFixed(3),
    taskS: +(c1.TaskDuration - c0.TaskDuration).toFixed(3),
  };

  // ── 1: ресурсы страницы урока ──────────────────────────────────────────────
  const assets = T.res.filter((x) => x.url.includes('/assets/')).map((x) => ({
    name: x.url.split('/assets/')[1], transferKB: +(x.transferSize / 1024).toFixed(1),
    wireKB: +(x.encoded / 1024).toFixed(1), decodedKB: +(x.decoded / 1024).toFixed(1), ms: r(x.duration),
  })).sort((a, b) => b.decodedKB - a.decodedKB);
  const apiCalls = T.res.filter((x) => x.url.includes('/api/')).map((x) => ({
    path: x.url.replace(BASE, '').split('?')[0], ms: r(x.duration), hostHost: host(x.url),
  }));

  const report = {
    at: new Date().toISOString(),
    livekitHost: host(process.env.LIVEKIT_URL),
    stack: { api: BASE, webServedByApi: true },
    joinSteps: steps,
    tiles: { ...tiles, tilesAfterIdle: tilesAfter },
    polling60s: window60,
    polling60sTotal: T.res.slice(before).filter((x) => x.url.includes('/api/')).length,
    idle30s: idle,
    cpuThrottle4x10s: throttled,
    lessonAssets: assets.slice(0, 12),
    apiTimingsMs: apiCalls,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await post(`/api/lessons/${session.id}/end`, {}, TT);
  await bye(0);
} catch (e) {
  console.error('lesson-perf:', String(e?.message ?? e));
  await bye(1);
}
