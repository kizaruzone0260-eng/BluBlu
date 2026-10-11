/**
 * Замер времени входа в урок по шагам + что именно показывает WebRTC (задача 2026-10-11, п.4).
 *
 *   LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… node scripts/lesson-join-timing.mjs
 *
 * Снимается только то, что реально измеряется:
 *  1) шаги от клика «Войти» до первого кадра — всё в одном часовом поясе страницы
 *     (performance.now()), чтобы не сравнивать часы Node и браузера:
 *     POST /api/lessons/:id/join, GET /api/ws/ticket, WebSocket до медиа-сервера (открытие),
 *     создание RTCPeerConnection, сигнальный обмен, ICE gathering, connectionState=connected,
 *     первый кадр своего видео, первый кадр собеседника;
 *  2) RTCPeerConnection.getStats(): currentRoundTripTime выбранной пары кандидатов и типы
 *     локального/удалённого кандидата (host / srflx / relay), то есть прямой путь или TURN;
 *  3) регионы, которые сервер этого проекта отдаёт клиенту: GET https://<host>/settings/regions
 *     с токеном, выданным нашим же API (значения токена и секреты не печатаются нигде);
 *  4) DNS-адреса медиа-хоста и TCP-ход до них.
 *
 * Печатаются: имена шагов, миллисекунды, имена регионов, типы кандидатов, IP инфраструктуры
 * Cloud/LiveKit (это не секрет: они публично резолвятся). Не печатаются: токены, query-строки
 * WebSocket-URL, TURN-пароли, значения переменных окружения.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const out = path.join(root, 'lesson-join-timing.json');

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.error('lesson-join-timing: нужны LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  process.exit(1);
}
const lkHost = new URL(process.env.LIVEKIT_URL).host;

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
const r = (n) => Math.round(n);

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
  const login = async (email, password) => (await post('/api/auth/login', { email, password }))?.accessToken ?? '';

  const TT = await login(creds.teacherEmail, creds.teacherPassword);
  const classes = await (await fetch(`${BASE}/api/classes`, { headers: { authorization: `Bearer ${TT}` } })).json();
  let cls = classes.find((c) => c.name === '7B — camera shots');
  if (!cls) cls = await post('/api/classes', { name: '7B — camera shots', description: '', color: '#0ea5a5' }, TT);
  const inv = await post(`/api/classes/${cls.id}/invites`, { ttlDays: 30 }, TT);
  const stuEmail = 'timinglesson@x.io', sPass = 'TimingPass123';
  let ST = await login(stuEmail, sPass);
  if (!ST) ST = (await post('/api/auth/register',
    { firstName: 'Тим', lastName: 'Инг', email: stuEmail, password: sPass, code: inv.code }))?.accessToken;
  const session = await post('/api/lessons/start', { classId: cls.id }, TT);

  // ── 3: регионы, которые сервер проекта отдаёт клиенту (токен из /join, не печатается) ──
  const join = await post(`/api/lessons/${session.id}/join`, {}, TT);
  let regions = null;
  if (join?.token) {
    const res = await fetch(`https://${lkHost}/settings/regions`, { headers: { authorization: `Bearer ${join.token}` } });
    regions = { status: res.status, body: await res.json().catch(() => null) };
  }
  // ── 4: DNS и TCP до медиа-хоста ──
  // Точка, откуда ведётся замер: ближайший edge Cloudflare (город/страна по его коду).
  // IP в отчёт не кладём — он не нужен для вывода, а адрес клиента лишняя деталь в файле.
  const trace = await fetch('https://cloudflare.com/cdn-cgi/trace').then((x) => x.text()).catch(() => '');
  const vantage = Object.fromEntries(trace.split('\n').filter(Boolean)
    .filter((l) => /^(colo|country|region|city|http|tls)=/.test(l)).map((l) => [l.split('=')[0], l.split('=')[1]]));
  const ips = (await dns.lookup(lkHost, { all: true })).map((a) => a.address).sort();
  const tcp = [];
  for (const ip of ips) {
    const one = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await new Promise((resolve) => {
        const s = net.connect({ host: ip, port: 443 });
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', () => { s.destroy(); resolve(); });
      });
      one.push(Date.now() - t);
    }
    tcp.push({ ip, ms: one });
  }

  browser = await chromium.launch({
    channel: process.env.CI ? undefined : 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],
  });

  // Обёртки ставятся ДО загрузки страницы: SDK ещё не успел создать свои объекты.
  const INIT = () => {
    const t = window.performance;
    window.__m = { click: 0, pc: [], ws: [], frames: [], api: [], iceCandidates: [], initAt: Math.round(t.now()), initError: null };
    try {
    const P = window.RTCPeerConnection;
    function Wrapped(cfg, opt) {
      const pc = new P(cfg, opt);
      // из конфигурации берём только схемы и хосты ICE-серверов — без имён и паролей TURN
      const ice = (cfg?.iceServers ?? []).map((s) => ({
        urls: [].concat(s.urls || []).map((u) => { try { const x = new URL(u); return x.protocol + '//' + x.host; } catch { return '?'; } }),
        hasCredential: Boolean(s.credential),
      }));
      const rec = { created: t.now(), ice, states: [], pc };
      window.__m.pc.push(rec);
      // имена событий в WebRTC — с суффиксом change; без него слушатель никогда не срабатывал
      const KEYS = { signalingstate: 'signalingState', icegatheringstate: 'iceGatheringState', iceconnectionstate: 'iceConnectionState', connectionstate: 'connectionState' };
      for (const evt of Object.keys(KEYS)) {
        const prop = KEYS[evt];
        pc.addEventListener(evt + 'change', () => rec.states.push({ k: prop, v: pc[prop], at: Math.round(t.now()) }));
      }
      pc.addEventListener('icecandidate', (e) => {
        const c = e.candidate;
        if (!c) { rec.gatheringDoneAt = Math.round(t.now()); return; }
        // candidateType есть в e.candidate.type; адрес/порт не сохраняем
        window.__m.iceCandidates.push({ type: c.type, protocol: c.protocol });
      });
      return pc;
    }
    Wrapped.prototype = P.prototype;
    window.RTCPeerConnection = Wrapped;

    const W = window.WebSocket;
    function WrappedWs(url, protocols) {
      const ws = new W(url, protocols);
      // только хост: в query LiveKit-токен, его печатать нельзя
      let h = '?'; try { h = new URL(url).host; } catch { /* data: и т.п. */ }
      const rec = { host: h, created: Math.round(t.now()), openedAt: null, closedAt: null };
      window.__m.ws.push(rec);
      ws.addEventListener('open', () => { rec.openedAt = Math.round(t.now()); });
      ws.addEventListener('close', () => { rec.closedAt = Math.round(t.now()); });
      return ws;
    }
    WrappedWs.prototype = W.prototype;
    // статические константы состояния обязаны переехать: livekit-client сверяет readyState с
    // WebSocket.OPEN, и без них соединение никогда не считается открытым
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { Object.defineProperty(WrappedWs, k, { value: W[k], writable: false, configurable: true }); } catch { /* нет */ }
    }
    window.WebSocket = WrappedWs;

    // первый настоящий кадр каждого <video>: requestVideoFrameCallback + опрос-страховка
    // (без страховки прогон дал пустой список кадров: rVFC не срабатывает на элементе,
    // который в момент вставки ещё не выводился)
    const scan = () => {
      window.__m.scans = (window.__m.scans ?? 0) + 1;
      window.__m.videoEls = document.querySelectorAll('video').length;
      for (const v of document.querySelectorAll('video')) {
        if (v.__seen) continue;
        const own = !!v.closest('[data-local="1"]');
        const peer = !!v.closest('[data-local="0"]');
        v.__kind = own ? 'self' : peer ? 'peer' : 'other';
        if (v.videoWidth > 0) { v.__seen = true; window.__m.frames.push({ kind: v.__kind, at: Math.round(t.now()), via: 'poll' }); continue; }
        if (typeof v.requestVideoFrameCallback === 'function') {
          v.requestVideoFrameCallback(() => {
            if (v.__seen) return; v.__seen = true;
            window.__m.frames.push({ kind: v.__kind, at: Math.round(t.now()), via: 'rVFC' });
          });
        }
      }
    };
      // в момент init-скрипта document.documentElement ещё нет (первый прогон дал именно эту
      // ошибку и пустой список кадров), поэтому наблюдатель ставится только когда DOM есть,
      // а опрос каждые 100 мс работает в любом случае
      if (document.documentElement) new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
      const sampler = setInterval(scan, 100);
      window.addEventListener('beforeunload', () => clearInterval(sampler));
      scan();
    } catch (e) { window.__m.initError = String(e && e.message || e); }
  };

  async function role(email, password) {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForTimeout(2_000);
    // свежезарегистрированный аккаунт сначала проходит экран согласия (так же, как в lesson-tiles.mjs)
    if (await page.getByTestId('policy-gate').isVisible().catch(() => false)) {
      await page.getByTestId('gate-accept').click();
      await page.getByTestId('policy-gate').waitFor({ state: 'detached', timeout: 30_000 });
    }
    return { ctx, page };
  }

  // собеседник заходит первым, чтобы у учителя был реальный удалённый трек
  const dismissGate = async (page) => {
    if (await page.getByTestId('policy-gate').isVisible().catch(() => false)) {
      await page.getByTestId('gate-accept').click();
      await page.getByTestId('policy-gate').waitFor({ state: 'detached', timeout: 30_000 });
    }
  };
  const S = await role(stuEmail, sPass);
  await S.page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await dismissGate(S.page);
  await S.page.getByTestId('check-devices').click();
  await S.page.getByTestId('join-lesson').click();
  await S.page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="1"]') && v.videoWidth > 0), null, { timeout: 60_000 });

  const T = await role(creds.teacherEmail, creds.teacherPassword);
  await T.page.goto(`${BASE}/lesson?classId=${cls.id}`);
  await T.page.getByTestId('check-devices').click();

  const T0 = await T.page.evaluate(() => { window.__m.click = Math.round(performance.now()); return window.__m.click; });
  await T.page.getByTestId('join-lesson').click();
  await T.page.waitForFunction(() => [...document.querySelectorAll('.videos video')]
    .some((v) => v.closest('[data-local="0"]') && v.videoWidth > 0), null, { timeout: 60_000 });

  // даём соединению устояться: выбранная пара кандидатов появляется не в первую секунду
  await T.page.waitForTimeout(6_000);

  const stats = await T.page.evaluate(async () => {
    const m = window.__m;
    if (!m.pc.length) return { error: 'RTCPeerConnection так и не был создан' };
    const rel = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x - m.click));
    const probe = async (rec) => {
      const o = {
        createdMs: rel(rec.created),
        gatheringDoneMs: rec.gatheringDoneAt === undefined ? null : rel(rec.gatheringDoneAt),
        states: rec.states.map((s) => ({ k: s.k, v: s.v, at: rel(s.at) })),
        iceServers: rec.ice,
        pairs: [], selected: null,
      };
      try {
        const s = await rec.pc.getStats();
        const cands = new Map();
        s.forEach((e) => { if (e.type === 'local-candidate' || e.type === 'remote-candidate') cands.set(e.id, e); });
        const pairs = [];
        s.forEach((e) => { if (e.type === 'candidate-pair') pairs.push(e); });
        o.pairs = pairs.map((p) => ({
          selected: !!p.selected, state: p.state ?? null,
          local: cands.get(p.localCandidateId)?.candidateType ?? null,
          remote: cands.get(p.remoteCandidateId)?.candidateType ?? null,
          rttMs: p.currentRoundTripTime === undefined ? null : Math.round(p.currentRoundTripTime * 1000),
        }));
        const ok = pairs.filter((p) => p.state === 'succeeded');
        const chosen = (ok.find((p) => p.selected) ?? ok.sort((a, b) => (b.bytesReceived ?? 0) - (a.bytesReceived ?? 0))[0]
          ?? pairs.find((p) => p.selected) ?? pairs[0]);
        o.chosenWas = ok.find((p) => p.selected) ? 'selected+succeeded'
          : (ok.length ? 'succeeded по максимуму байт (выбранной в момент замера не было)' : 'никакой не завершилась');
        o.selected = chosen ? {
          rttMs: chosen.currentRoundTripTime === undefined ? null : Math.round(chosen.currentRoundTripTime * 1000),
          availableOutgoingBitrateBps: chosen.availableOutgoingBitrate ?? null,
          bytesReceived: chosen.bytesReceived ?? null,
          bytesSent: chosen.bytesSent ?? null,
          local: (() => { const c = cands.get(chosen.localCandidateId); return c ? { type: c.candidateType, protocol: c.protocol, relay: !!c.relay } : null; })(),
          remote: (() => { const c = cands.get(chosen.remoteCandidateId); return c ? { type: c.candidateType, protocol: c.protocol } : null; })(),
        } : { error: 'ни одна пара не выбрана', total: pairs.length };
        o.relayPairs = pairs.filter((p) => cands.get(p.localCandidateId)?.candidateType === 'relay').length;
      } catch (e) { o.statsError = String(e); }
      return o;
    };
    const pcs = [];
    for (const rec of m.pc) pcs.push(await probe(rec));
    return {
      pcCount: m.pc.length, pcs,
      iceCandidateTypes: m.iceCandidates.reduce((a, c) => { a[`${c.type}/${c.protocol ?? '?'}`] = (a[`${c.type}/${c.protocol ?? '?'}`] ?? 0) + 1; return a; }, {}),
      ws: m.ws.map((w) => ({ host: w.host, createdMs: rel(w.created), openedMs: rel(w.openedAt ?? NaN) })),
      frames: m.frames.map((f) => ({ kind: f.kind, via: f.via, ms: rel(f.at) })),
      frameScan: { scans: m.scans ?? 0, videoElsAtRead: m.videoEls ?? 0, initAt: m.initAt ?? null, initError: m.initError ?? null },
      api: performance.getEntriesByType('resource')
        .filter((e) => /\/api\//.test(e.name))
        .map((e) => ({ path: new URL(e.name).pathname.replace(/[0-9a-f-]{36}/g, ':id'), startMs: Math.round(e.startTime - m.click), durMs: Math.round(e.duration) }))
        .filter((x) => /lessons|ws\/ticket|me$/.test(x.path)),
    };
  });

  const report = {
    at: new Date().toISOString(),
    measuredFrom: {
      apiStack: 'локально (встроенный Postgres + API + собранный фронт одним процессом)',
      mediaServerHost: lkHost,
      nearestEdge: vantage,
    },
    regionsEndpoint: {
      url: `https://${lkHost}/settings/regions`, httpStatus: regions?.status,
      // только имена регионов и расстояние в км; полные URL с токеном не пишем
      regions: (regions?.body?.regions ?? []).map((x) => ({ region: x.region, distanceKm: x.distance ? Math.round(Number(x.distance) / 1000) : null })),
    },
    mediaHostResolution: { host: lkHost, ips, tcpHandshakeMs: tcp },
    joinSteps: stats,
    note: 'отсчёт всех шагов — от клика «Войти» в часах страницы; значения токенов и TURN-учётные данные не сохранялись',
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await post(`/api/lessons/${session.id}/end`, {}, TT);
  await S.ctx.close(); await T.ctx.close();
  await bye(0);
} catch (e) {
  console.error('lesson-join-timing:', String(e?.message ?? e));
  await bye(1);
}
