/**
 * Замер п.6 задачи 2026-10-11: сколько длится ПЕРВОЕ открытие доски, и что даёт её предзагрузка
 * в простое после входа в комнату.
 *
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/board-open-time.mjs [--preload]
 *
 * Метод: настоящий стек e2e (встроенный Postgres, API, собранный фронт одним процессом), вход
 * учителем в комнату LiveKit Cloud, затем троттлинг сети CDP-профилем (задержка + пропускная
 * способность), затем клик по кнопке «Доска» и секундомер до момента, когда вкладка доски
 * появилась в DOM. Замер делается дважды в одном прогоне:
 *   · «первый клик» — сразу, когда чанк доски ещё не скачан;
 *   · «после простоя» — через 20 с, в которых страница сидит без дел: если предзагрузка есть,
 *     чанк уже должен быть в кешe модулей, и клик станет мгновенным.
 * Размер самого чанка берётся из network-тайминга страницы (encodedBodySize), а не на глаз.
 *
 * Флаг --preload нужен для замера «после»: он включает предзагрузку в Lesson.tsx, поэтому перед
 * прогоном должна быть собрана версия с нею. В репозитории флаг не остаётся, если правка не
 * подтверждена числом.
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
const out = path.join(root, 'board-open-time.json');
const profile = { latencyMs: 100, downloadKbps: 1600, uploadKbps: 768, label: '100 мс RTT, 1.6 Мбит/с' };

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('board-open-time: нужны LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  process.exit(1);
}

const stack = spawn('node', ['scripts/e2e-stack.mjs'], {
  cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
});
let browser = null, closing = false;
async function bye(code = 0) {
  if (closing) return; closing = true;
  try { await browser?.close(); } catch { /* нет */ }
  try { stack.kill(); } catch { /* нет */ }
  process.exitCode = code;
}
process.on('SIGINT', () => void bye(0));
const r = (n) => Math.round(n);

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    await new Promise((rr) => setTimeout(rr, 1_000));
    try { if ((await fetch(`${BASE}/api/health/live`)).ok) return; } catch { /* ждём */ }
  }
  throw new Error('стек не поднялся');
}

await waitHealth();
try {
  let creds = null;
  for (let i = 0; i < 60 && !creds; i++) {
    try { creds = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8')); }
    catch { await new Promise((rr) => setTimeout(rr, 1_000)); }
  }
  if (!creds) throw new Error('.stack.json так и не появился');
  const post = async (p, body, tok) => (await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { authorization: tok ? `Bearer ${tok}` : '', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json();
  const TT = await post('/api/auth/login', { email: creds.teacherEmail, password: creds.teacherPassword }).then((x) => x.accessToken);
  const classes = await (await fetch(`${BASE}/api/classes`, { headers: { authorization: `Bearer ${TT}` } })).json();
  let cls = classes.find((c) => c.name === '7B — board preload');
  if (!cls) cls = await post('/api/classes', { name: '7B — board preload', description: '', color: '#0ea5a5' }, TT);
  const session = await post('/api/lessons/start', { classId: cls.id }, TT);
  if (session?.session?.id) session.id = session.session.id;

  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const seen = [];
  page.on('requestfinished', async (rq) => {
    try {
      const e = await page.evaluate((u) => {
        const x = performance.getEntriesByName(u, 'resource')[0];
        return x ? { dur: x.duration, encoded: x.encodedBodySize, decoded: x.decodedBodySize } : null;
      }, rq.url());
      if (e) seen.push({ url: rq.url(), ...e });
    } catch { /* гонка */ }
  });

  await page.goto(`${BASE}/login`);
  await page.getByTestId('email').fill(creds.teacherEmail);
  await page.getByTestId('password').fill(creds.teacherPassword);
  await page.getByTestId('login-submit').click();
  await page.waitForTimeout(2_000);
  await page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await page.getByTestId('check-devices').click();
  await page.getByTestId('join-lesson').click();
  await page.waitForSelector('[data-testid=lesson-bar]', { timeout: 60_000 });

  // сеть режем ПОСЛЕ входа: вход остаётся обычным, а вот клик по «Доска» едет уже по троттлингу
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: profile.latencyMs,
    downloadThroughput: (profile.downloadKbps * 1024) / 8, uploadThroughput: (profile.uploadKbps * 1024) / 8,
  });
  await page.waitForTimeout(2_000);

  const boardChunkBefore = seen.filter((x) => /assets\/(percentages|Board)/.test(x.url)).length;
  const first = await (async () => {
    const t = Date.now();
    await page.getByTestId('board-toggle').click();
    await page.waitForSelector('[data-testid=board-tabs]', { timeout: 120_000 });
    return Date.now() - t;
  })();

  // закрыли — и даём странице 20 с простоя (предзагрузка, если она есть, уже должна всё скачать)
  await page.getByTestId('board-toggle').click();
  await page.waitForTimeout(20_000);
  const second = await (async () => {
    const t = Date.now();
    await page.getByTestId('board-toggle').click();
    await page.waitForSelector('[data-testid=board-tabs]', { timeout: 120_000 });
    return Date.now() - t;
  })();

  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const chunks = seen.filter((x) => /assets\//.test(x.url) && x.decoded > 200_000)
    .map((x) => ({ name: x.url.split('/assets/')[1], encodedKB: +(x.encoded / 1024).toFixed(1), decodedKB: +(x.decoded / 1024).toFixed(1), ms: r(x.dur) }))
    .sort((a, b) => b.decodedKB - a.decodedKB);

  const report = {
    at: new Date().toISOString(),
    preloadFlag: process.argv.includes('--preload'),
    network: profile,
    boardChunkSeenBeforeClick: boardChunkBefore,
    firstOpenMs: r(first), secondOpenAfterIdleMs: r(second),
    bigChunks: chunks.slice(0, 6),
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await post(`/api/lessons/${session.id}/end`, {}, TT);
  await ctx.close();
  await bye(0);
} catch (e) {
  console.error('board-open-time:', String(e?.message ?? e));
  await bye(1);
}
