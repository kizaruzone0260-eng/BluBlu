/**
 * Замер страницы урока с несколькими участниками (задача 2026-10-10, часть 2, пункт «число
 * одновременных тайлов» и «перерисовки»).
 *
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/lesson-tiles.mjs [n]
 *
 * n — сколько УЧЕНИКОВ заходит в комнату (по умолчанию 5, плюс учитель). Смысл именно в этом:
 * lesson-perf.mjs меряет комнату из двух человек, и там перерисовок нет — значит правку «лимит
 * тайлов» нельзя ни подтвердить, ни опровергнуть. Здесь измеряется то же самое на N тайлах:
 *  • сколько <video> в сетке и сколько из них реально показывают кадры;
 *  • дельты CDP-метрик за 30 с покоя (ScriptDuration / LayoutDuration / RecalcStyleDuration /
 *    TaskDuration), куча, число long task'ов и сумма layout shift;
 *  • то же под 4× торможением CPU;
 *  • цена открытия правой панели при полном составе (это и есть «перерисовка при входе нового
 *    участника»: панель меняет список, сетка — нет).
 *
 * Секретов не печатает: в отчёте только числа и имена чанков.
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
const N = Math.max(1, Math.min(8, Number(process.argv[2] ?? 5)));
const out = path.join(root, 'lesson-tiles.json');

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('lesson-tiles: нужны LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
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
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try { if ((await fetch(`${BASE}/api/health/live`)).ok) return; } catch { /* ждём */ }
  }
  throw new Error('стек не поднялся');
}
async function readStack() {
  for (let i = 0; i < 60; i++) {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8'));
    } catch { await new Promise((r) => setTimeout(r, 1_000)); }
  }
  throw new Error('.stack.json не появился');
}

await waitHealth();
try {
  const creds = await readStack();
  const post = async (p, body, tok) => (await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { authorization: tok ? `Bearer ${tok}` : '', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
  const json = async (r) => r.json().catch(() => null);
  const TT = (await json(await post('/api/auth/login',
    { email: creds.teacherEmail, password: creds.teacherPassword })))?.accessToken;
  if (!TT) throw new Error('учитель не вошёл');

  const classes = await json(await fetch(`${BASE}/api/classes`, { headers: { authorization: `Bearer ${TT}` } }));
  let cls = classes.find((c) => c.name === '7B — camera shots');
  if (!cls) cls = await json(await post('/api/classes', { name: '7B — camera shots', description: '', color: '#0ea5a5' }, TT));
  const session = await json(await post('/api/lessons/start', { classId: cls.id }, TT));

  // N учеников: каждый со своей ССЫЛКОЙ-приглашением (ссылка одноразовая: её расходует первый
  // удачный вход). Приём по восьмизначному коду класса выведен из продукта 2026-10-27, и
  // `POST /api/classes/:id/invites` вместе с `/api/auth/register` отвечают 410.
  const students = [];
  for (let i = 0; i < N; i++) {
    const link = await json(await post(`/api/classes/${cls.id}/invites/link`, { ttlDays: 30 }, TT));
    const token = String(link?.url ?? '').split('#')[1] ?? '';
    if (!token) throw new Error(`учитель не выпустил ссылку для ученика ${i}: ${JSON.stringify(link)?.slice(0, 80)}`);
    const email = `tiles${i}${Date.now()}@x.io`;
    const reg = await json(await post('/api/invitations/register',
      { token, firstName: `Ученик${i}`, lastName: 'Тайл', email, password: 'Tiles12345' }));
    if (!reg?.accessToken) throw new Error(`ученик ${i} не зарегистрирован: ${JSON.stringify(reg)?.slice(0, 80)}`);
    students.push({ email, password: 'Tiles12345' });
  }

  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });
  async function join(email, password, who) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${BASE}/login`);
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForTimeout(1_500);
    // аккаунт, созданный через API, ещё не принимал юридические документы — между входом и
    // любой страницей стоит шлюз согласия (AcceptPolicies), его нужно пройти
    if (await page.getByTestId('policy-gate').isVisible().catch(() => false)) {
      await page.getByTestId('gate-accept').click();
      await page.getByTestId('policy-gate').waitFor({ state: 'detached', timeout: 30_000 });
    }
    await page.goto(`${BASE}/lesson?classId=${cls.id}`);
    try {
      await page.getByTestId('check-devices').click();
    } catch (e) {
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(`${who}: нет check-devices; url=${page.url()}; экран="${txt.replace(/\s+/g, ' ').slice(0, 160)}"`);
    }
    await page.getByTestId('join-lesson').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
      .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0), null, { timeout: 90_000 });
    return { ctx, page, cdp };
  }
  const T = await join(creds.teacherEmail, creds.teacherPassword, 'учитель');
  const S = [];
  for (const s of students) S.push(await join(s.email, s.password, s.email));
  // всем увидеть всех: ждём, пока у учителя в сетке появится N удалённых тайлов с кадрами
  try {
    await T.page.waitForFunction((n) => [...document.querySelectorAll('.videos video')]
      .filter((v) => v.closest('[data-local="0"]') && v.videoWidth > 0).length >= n, N, { timeout: 90_000 });
  } catch (e) {
    const seen = await T.page.evaluate(() => ({
      videos: document.querySelectorAll('.videos video').length,
      frames: [...document.querySelectorAll('.videos video')].filter((v) => v.videoWidth > 0).length,
      remote: [...document.querySelectorAll('.videos video')].filter((v) => v.closest('[data-local="0"]')).length,
      hidden: [...document.querySelectorAll('.videos video')].filter((v) => v.closest('[data-local="0"]') && v.videoWidth === 0).length,
      strip: document.querySelectorAll('.strip-cell video').length,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
    }));
    throw new Error(`${N} удалённых кадров не дождались: ${JSON.stringify(seen)}`);
  }

  async function metrics(cdp) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
  const obs = (page) => page.evaluate(() => {
    const p = window.__p;
    return p ? { shifts: p.shifts, longTasks: p.longTasks, longTaskMs: p.longTaskMs } : null;
  });
  await T.page.evaluate(() => {
    window.__p = { shifts: 0, longTasks: 0, longTaskMs: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__p.shifts += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__p.longTasks++; window.__p.longTaskMs += e.duration; } })
      .observe({ type: 'longtask', buffered: true });
  });

  const tiles = await T.page.evaluate(() => ({
    videoEls: document.querySelectorAll('.videos video').length,
    withFrames: [...document.querySelectorAll('.videos video')].filter((v) => v.videoWidth > 0).length,
    remote: [...document.querySelectorAll('.videos video')].filter((v) => v.closest('[data-local="0"]')).length,
    gridH: Math.round(document.querySelector('.videos')?.getBoundingClientRect().height ?? 0),
    docH: Math.round(document.documentElement.scrollHeight),
  }));

  const m0 = await metrics(T.cdp), o0 = await obs(T.page);
  await new Promise((r) => setTimeout(r, 30_000));
  const m1 = await metrics(T.cdp), o1 = await obs(T.page);
  const idle = {
    scriptS: +(m1.ScriptDuration - m0.ScriptDuration).toFixed(3),
    layoutS: +(m1.LayoutDuration - m0.LayoutDuration).toFixed(3),
    recalcStyleS: +(m1.RecalcStyleDuration - m0.RecalcStyleDuration).toFixed(3),
    taskS: +(m1.TaskDuration - m0.TaskDuration).toFixed(3),
    nodes: Math.round(m1.Nodes - m0.Nodes), heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    layoutShiftScore: +(o1.shifts - o0.shifts).toFixed(4),
    longTasks: o1.longTasks - o0.longTasks, longTaskMs: Math.round(o1.longTaskMs - o0.longTaskMs),
  };

  // панель при полном составе: открытие правой панели перерисовывает список участников
  const p0 = await metrics(T.cdp);
  await T.page.getByTestId('participants-toggle').click();
  await T.page.getByTestId('peers-panel').waitFor({ timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 3_000));
  const p1 = await metrics(T.cdp);
  const panel = {
    scriptS: +(p1.ScriptDuration - p0.ScriptDuration).toFixed(3),
    layoutS: +(p1.LayoutDuration - p0.LayoutDuration).toFixed(3),
    recalcStyleS: +(p1.RecalcStyleDuration - p0.RecalcStyleDuration).toFixed(3),
    taskS: +(p1.TaskDuration - p0.TaskDuration).toFixed(3),
    rows: await T.page.locator('.peer-row').count(),
  };
  await T.page.getByTestId('panel-close').click();

  // 4× торможение CPU: те же 10 с покоя
  await T.cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const c0 = await metrics(T.cdp);
  await new Promise((r) => setTimeout(r, 10_000));
  const c1 = await metrics(T.cdp);
  await T.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const throttled = {
    scriptS: +(c1.ScriptDuration - c0.ScriptDuration).toFixed(3),
    layoutS: +(c1.LayoutDuration - c0.LayoutDuration).toFixed(3),
    recalcStyleS: +(c1.RecalcStyleDuration - c0.RecalcStyleDuration).toFixed(3),
    taskS: +(c1.TaskDuration - c0.TaskDuration).toFixed(3),
  };

  const report = { at: new Date().toISOString(), wanted: N, tiles, idle30s: idle, panelOpen3s: panel, cpuThrottle4x10s: throttled };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await post(`/api/lessons/${session.id}/end`, {}, TT);
  await bye(0);
} catch (e) {
  console.error('lesson-tiles:', String(e?.message ?? e));
  await bye(1);
}
