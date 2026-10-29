/**
 * Лабораторный замер Core Web Vitals входных экранов (аудит 2026-10-28, пункты 21/22/24):
 *
 *   node apps/e2e/scripts/cwv-perf.mjs
 *
 * Зачем отдельный скрипт. `lesson-perf.mjs` измеряет комнату урока и требует LiveKit; здесь —
 * только то, что видит человек, входя в продукт: `/login`, `/register` и Главная после входа.
 * Стек тот же, что у e2e (встроенный Postgres, API, собранный фронт одним процессом), поэтому
 * числа воспроизводимы на любой машине без доступа к Render.
 *
 * Что измеряется и как: LCP и FCP — PerformanceObserver c `buffered: true` (наблюдатели ставятся
 * ДО навигации, через addInitScript), CLS — сумма layout-shift без недавнего ввода, TBT — сумма
 * длинных задач сверх 50 мс, TTFB/загрузка — из Navigation Timing, байты — сумма transferSize
 * ресурсов. Каждая страница прогоняется RUNS раз; в отчёт попадают все прогоны и медиана —
 * один прогон на общей машине ничего не доказывает.
 *
 * Чего здесь НЕТ и почему: INP в лаборатории не воспроизводится — он определён по полевым
 * данным реальных взаимодействий, а не по скриптованному клику; RUM/аналитика потребовали бы
 * согласия владельца и нового трекера (аудит §8). Порогов тоже нет: скрипт печатает числа,
 * а сравнивать их нужно с публичными ориентирами web.dev (LCP 2.5 s, CLS 0.1, INP 200 ms для
 * 75-го процентиля поля) и с предыдущим прогоном этого же скрипта — не с чужим железом.
 *
 * В консоль и в `cwv-perf.json` (в .gitignore) уходит один JSON-отчёт; секретов нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const PORT = process.env.CWV_PORT ? Number(process.env.CWV_PORT) : 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = Number(process.env.CWV_RUNS ?? 3);
const out = path.join(root, 'cwv-perf.json');

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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Наблюдатели ставятся до первого байта страницы — иначе LCP теряет ранние кандидаты. */
function installObservers() {
  window.__cwv = { lcp: null, lcpEl: '', fcp: null, cls: 0, shifts: 0, longTasks: 0, tbt: 0 };
  new PerformanceObserver((l) => {
    const e = l.getEntries().at(-1);
    if (e) { window.__cwv.lcp = e.startTime; window.__cwv.lcpEl = e.element?.tagName ?? ''; }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cwv.cls += e.value;
      window.__cwv.shifts += 1;
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__cwv.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__cwv.longTasks += 1;
      window.__cwv.tbt += Math.max(0, e.duration - 50);
    }
  }).observe({ type: 'longtask', buffered: true });
}

async function measure(page, url, name) {
  await page.goto(url, { waitUntil: 'load' });
  /*
   * Фиксированная пауза вместо `waitForLoadState('networkidle')`: на этой сборке сервис-воркер
   * держит собственные служебные запросы (`sw.js` кэширует оболочку), и «сеть пуста 500 мс» не
   * наступало ни разу за 30 с — первый прогон умер именно здесь, не записав отчёт. Для LCP/CLS
   * ожидание тишины в сети не нужно: наблюдатели стоят с первой миллисекунды, а 2.5 с дают
   * странице устояться после load.
   */
  await page.waitForTimeout(2_500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const bytes = res.reduce((n, e) => n + (e.transferSize || 0), 0);
    return {
      lcp: window.__cwv.lcp, lcpEl: window.__cwv.lcpEl, fcp: window.__cwv.fcp,
      cls: window.__cwv.cls, shifts: window.__cwv.shifts,
      longTasks: window.__cwv.longTasks, tbt: window.__cwv.tbt,
      ttfb: nav ? nav.responseStart : null,
      dcl: nav ? nav.domContentLoadedEventEnd : null,
      load: nav ? nav.loadEventEnd : null,
      requests: res.length, transferKB: bytes / 1024,
    };
  });
  return {
    page: name, url,
    lcpMs: Math.round(m.lcp ?? 0), lcpElement: m.lcpEl,
    fcpMs: Math.round(m.fcp ?? 0),
    cls: r3(m.cls), layoutShifts: m.shifts,
    tbtMs: Math.round(m.tbt), longTasks: m.longTasks,
    ttfbMs: Math.round(m.ttfb ?? 0), dclMs: Math.round(m.dcl ?? 0), loadMs: Math.round(m.load ?? 0),
    requests: m.requests, transferKB: Math.round(m.transferKB),
  };
}

function summarise(runs) {
  const keys = ['lcpMs', 'fcpMs', 'cls', 'tbtMs', 'ttfbMs', 'loadMs', 'requests', 'transferKB'];
  const med = {};
  for (const k of keys) med[k] = r3(median(runs.map((r) => r[k])));
  return med;
}

await waitHealth();
try {
  // стек пишет .stack.json чуть позже, чем становится здоровым
  let creds = null;
  for (let i = 0; i < 60 && !creds; i++) {
    try { creds = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8')); }
    catch { await new Promise((r) => setTimeout(r, 1_000)); }
  }
  if (!creds) throw new Error('.stack.json так и не появился');

  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'msedge' });

  const report = { at: new Date().toISOString(), stack: { api: BASE, webServedByApi: true }, runs: RUNS, pages: [] };

  // 1) публичные экраны — в контексте без сессии (/login вошедшему отдаёт редирект)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    for (const [name, url] of [['login', '/login'], ['register', '/register']]) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const page = await ctx.newPage();
        await page.addInitScript(installObservers);
        runs.push(await measure(page, `${BASE}${url}`, name));
        await page.close();
      }
      report.pages.push({ page: name, runs, median: summarise(runs) });
    }
    await ctx.close();
  }

  // 2) Главная после входа: тот же путь, каким ходит человек (токен живёт в памяти, refresh в cookie)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const login = await ctx.newPage();
    await login.goto(`${BASE}/login`);
    await login.getByTestId('email').fill(creds.teacherEmail);
    await login.getByTestId('password').fill(creds.teacherPassword);
    await login.getByTestId('login-submit').click();
    await login.getByTestId('home-title').waitFor({ timeout: 20_000 });
    await login.close();

    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await ctx.newPage();
      await page.addInitScript(installObservers);
      runs.push(await measure(page, `${BASE}/`, 'home'));
      await page.close();
    }
    report.pages.push({ page: 'home', runs, median: summarise(runs) });
    await ctx.close();
  }

  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await bye(0);
} catch (e) {
  console.error('cwv-perf:', String(e?.message ?? e));
  await bye(1);
}
