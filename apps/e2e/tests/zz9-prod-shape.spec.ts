/**
 * Task 3 — the real browser flow against the DEPLOYED configuration.
 *
 * scripts/prod-shape-api.mjs starts a dedicated API process with
 * NODE_ENV=production, TRUST_PROXY=1 and PUBLIC_URL equal to the address the page is
 * served from — the exact shape of the Render deploy. This spec is the regression test
 * for the outage: the video-lesson page was reachable, but the first token refresh from
 * the deployed page was refused (403 by the Origin gate), the SPA dropped the access
 * token, /api/me answered 401 and the user landed back on Sign In a few seconds after
 * clicking Video Lesson. Every local suite was green because it ran the non-production
 * branch of that gate.
 *
 * What is asserted, in the order a user experiences it:
 *   1. the login cookie carries the production attributes (Secure · HttpOnly ·
 *      SameSite=Lax · Path=/api/auth);
 *   2. a FULL page reload restores the session — the refresh call succeeds and the app
 *      stays inside, no Sign In (the outage was exactly this step);
 *   3. the lesson WS ticket is issued, and the status socket opens over the proxy-aware
 *      server;
 *   4. joining the lesson reaches `room.connect()` and publishes the camera (real RTC
 *      when a media server is reachable — the same guard the other RTC specs use);
 *   5. a cross-site Origin is still refused by this same production-shaped server.
 */
import { test, expect, request as pw } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startProdShapeApi } from '../scripts/prod-shape-api.mjs';

function readStack() {
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(readFileSync(path.join(process.cwd(), '.stack.json'), 'utf8')) as {
        port: number; teacherEmail: string; teacherPassword: string;
      };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error('.stack.json never appeared');
}
const stack = readStack();

// The deployed shape is started for THIS spec only (scripts/prod-shape-api.mjs) — see the
// comment there for why it is not part of the shared stack.
let BASE = '';
let prodApi: { stop: () => Promise<void> } | null = null;

test.beforeAll(async () => {
  prodApi = await startProdShapeApi(stack.teacherPassword);
  BASE = prodApi.base;
});
test.afterAll(async () => { await prodApi?.stop(); prodApi = null; });

/** Any HTTP(S) answer from the media server = reachable. */
async function livekitReachable(wsUrl: string): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    await fetch(`${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/rtc/v1`, { signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

test('deployed configuration: reload keeps the session, the lesson joins, cross-site is refused', async ({ browser }) => {
  test.setTimeout(240_000);

  // ── 1. login over the production-shaped API and inspect the cookie it sets ──────
  const api = await pw.newContext({ baseURL: BASE });
  const login = await api.post('/api/auth/login', {
    data: { email: stack.teacherEmail, password: stack.teacherPassword },
    headers: { origin: BASE, host: new URL(BASE).host },
  });
  expect(login.status(), 'login must work in the deployed shape').toBe(200);
  const setCookie = String(login.headers()['set-cookie'] ?? '');
  expect(setCookie).toContain('klass_rt=');
  expect(setCookie, 'production is https-only: the refresh cookie must be Secure').toMatch(/Secure/i);
  expect(setCookie, 'the refresh token must never be script-readable').toMatch(/HttpOnly/i);
  expect(setCookie, 'Lax blocks a cross-site POST from carrying it').toMatch(/SameSite=Lax/i);
  expect(setCookie).toMatch(/Path=\/api\/auth/i);
  const token = String((await login.json()).accessToken);
  const H = { authorization: `Bearer ${token}`, origin: BASE, host: new URL(BASE).host };

  // a cross-site Origin is refused by THIS server (the negative half of the gate)
  const cross = await api.post('/api/auth/refresh', {
    headers: { cookie: `klass_rt=${setCookie.split(';')[0].split('=')[1]}`, origin: 'https://evil.example' },
  });
  expect(cross.status()).toBe(403);

  // ── 2. class + lesson, created the way the teacher would ────────────────────────
  const clsRes = await api.post('/api/classes', {
    headers: H, data: { name: `Прод-проверка ${Date.now()}`, description: '', color: '#0ea5a5' },
  });
  expect(clsRes.status()).toBe(201);
  const cls = await clsRes.json();
  const active = await api.get(`/api/lessons/active?classId=${cls.id}`, { headers: H });
  expect(active.status(), 'the lesson page request must not 401/403 in the deployed shape').toBe(200);
  const start = await api.post('/api/lessons/start', { headers: H, data: { classId: cls.id } });
  expect(start.status()).toBe(201);
  const session = await start.json();
  const join = await api.post(`/api/lessons/${session.id}/join`, { headers: H });
  expect(join.status()).toBe(200);
  const joinBody = await join.json();
  const wsUrl = String(joinBody.wsUrl);
  expect(String(joinBody.token)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // what room.connect() consumes

  // ── 3. a real browser: login, then a FULL reload (the outage step) ──────────────
  const ctx = await browser.newContext({ baseURL: BASE, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const apiLog: Array<{ s: number; m: string; u: string }> = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/')) {
      apiLog.push({ s: res.status(), m: res.request().method(), u: u.replace(BASE, '') });
    }
  });

  await page.goto('/login');
  await page.getByTestId('email').fill(stack.teacherEmail);
  await page.getByTestId('password').fill(stack.teacherPassword);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('home-title')).toBeVisible({ timeout: 20_000 });
  const afterLogin = apiLog.length; // everything from here belongs to an authenticated session
  const afterReloadStart = afterLogin;

  // the browser must actually hold the Secure cookie over loopback, otherwise session
  // restore cannot work at all
  const held = (await ctx.cookies()).find((c) => c.name === 'klass_rt');
  expect(held, 'the deployed-shape refresh cookie must be stored').toBeTruthy();
  expect(held!.secure, 'Secure is required in production').toBe(true);
  expect(held!.httpOnly).toBe(true);
  expect(held!.sameSite, 'SameSite must stay Lax').toBe('Lax');
  expect(held!.path).toBe('/api/auth');

  // FULL reload: the access token lives in memory only, so this is the refresh path
  // that returned 403 in production and bounced every user to Sign In.
  const beforeReload = apiLog.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-title'), 'a reload must restore the session, not the login page')
    .toBeVisible({ timeout: 20_000 });
  expect(page.url(), 'no bounce back to Sign In').not.toContain('/login');

  // Only what happened AFTER the reload counts: the pre-login page load legitimately
  // probes /api/auth/refresh and gets 401 (there is no cookie yet) — that is not a bug,
  // and 403 (the outage) never is.
  const afterReload = apiLog.slice(beforeReload);
  const refreshAfterReload = afterReload.filter((r) => r.u.startsWith('/api/auth/refresh'));
  expect(refreshAfterReload.length, 'the reload must exercise the refresh endpoint').toBeGreaterThan(0);
  expect(refreshAfterReload.every((r) => r.s === 200),
    `refresh after reload must rotate the session, never 403: ${JSON.stringify(refreshAfterReload)}`).toBe(true);
  expect(afterReload.filter((r) => r.u === '/api/me').every((r) => r.s === 200),
    `/api/me after reload: ${JSON.stringify(afterReload.filter((r) => r.u === '/api/me'))}`).toBe(true);
  expect(afterReload.some((r) => r.u === '/api/me' && r.s === 200), 'session restore needs /api/me 200').toBe(true);

  // ── 4. the lesson WebSocket upgrade on this proxy-aware, production-shaped server ─
  // A Node-side probe with a real ticket gives a deterministic open/close verdict; the
  // page's own sockets are watched at the same time (Playwright can report a socket
  // after it already opened, so only the refusal codes are read from that list).
  const sockets: Array<{ url: string; closeCode: number | null }> = [];
  page.on('websocket', (ws) => {
    const rec = { url: ws.url(), closeCode: null as number | null };
    sockets.push(rec);
    ws.on('close', (code) => { rec.closeCode = code; });
  });

  const ticketRes = await api.post('/api/ws/ticket', { headers: H, data: { sessionId: session.id } });
  expect(ticketRes.status()).toBe(200);
  const ticket = String((await ticketRes.json()).ticket);
  const upgraded: { opened: boolean; closeCode: number | null; error: string | null } =
    await new Promise((res) => {
      const ws = new WebSocket(
        `${BASE.replace(/^http/,'ws')}/api/ws/lesson/${session.id}?ticket=${encodeURIComponent(ticket)}`,
        { headers: { origin: BASE } },
      );
      const out = { opened: false, closeCode: null as number | null, error: null as string | null };
      const done = () => { try { ws.close(); } catch { /* already closed */ } res(out); };
      const timer = setTimeout(done, 5_000);
      ws.onopen = () => { out.opened = true; clearTimeout(timer); done(); };
      ws.onerror = (e) => { out.error = String((e as Error)?.message ?? e).slice(0, 120); };
      ws.onclose = (e) => { out.closeCode = e.code; clearTimeout(timer); done(); };
    });
  expect(upgraded.opened, `lesson WS must upgrade in the deployed shape: ${JSON.stringify(upgraded)}`).toBe(true);
  expect([4401, 4403, 4404]).not.toContain(upgraded.closeCode as number);

  // ── 5. join the lesson through the UI and reach room.connect() ──────────────────
  await page.goto(`/lesson?classId=${cls.id}`);
  await page.getByTestId('check-devices').click();
  await expect(page.getByTestId('join-lesson')).toBeEnabled({ timeout: 25_000 });
  await page.getByTestId('join-lesson').click();

  // the click must have reached the join endpoint through the deployed shape (this is
  // the call production never got to make while the Origin gate was rejecting refresh)
  await expect
    .poll(() => apiLog.some((r) => /\/api\/lessons\/[\w-]+\/join$/.test(r.u) && r.m === 'POST' && r.s === 200),
      { timeout: 20_000, message: `join call missing: ${JSON.stringify(apiLog.slice(-12))}` })
    .toBe(true);

  if (await livekitReachable(wsUrl)) {
    // own camera tile with real pixels — proof room.connect() + publish happened
    await expect(async () => {
      const dims = await page.evaluate(() => [...document.querySelectorAll('.videos [data-local="1"] video')]
        .map((v) => [v.videoWidth, v.clientWidth, v.clientHeight]));
      expect(dims.some((d) => d[0] > 0 && d[1] > 0 && d[2] > 0)).toBeTruthy();
    }).toPass({ timeout: 30_000 });
  } else {
    // no media server reachable (CI without LIVEKIT_* env): the deployed-shape auth,
    // lesson and signalling chain above still executed in full
    test.info().annotations.push({
      type: 'note',
      description: `RTC media half skipped: LiveKit at ${wsUrl} unreachable (needs LIVEKIT_URL/API_KEY/API_SECRET env)`,
    });
  }

  // the app must have opened its own lesson socket on this origin, and nothing may have
  // been refused by the Origin gate (4403) or by a dead session (4401/4404)
  await expect
    .poll(() => sockets.some((s) => s.url.includes('/api/ws/lesson/')),
      { timeout: 20_000, message: `sockets seen: ${JSON.stringify(sockets)}` })
    .toBe(true);
  expect(sockets.filter((s) => s.url.includes('/api/ws/')).every((s) => ![4401, 4403, 4404].includes(s.closeCode ?? -1)),
    `no socket may be refused by the Origin gate: ${JSON.stringify(sockets)}`).toBe(true);

  // the whole authenticated part of the flow must never have produced a 401/403. (The
  // pre-login page load legitimately probes /api/auth/refresh and /api/me without a
  // cookie and gets 401 — that is the anonymous answer, not the outage.)
  const postLogin = apiLog.slice(afterReloadStart);
  const authFailures = postLogin.filter((r) => r.s === 401 || r.s === 403);
  expect(authFailures, `unexpected auth failures: ${JSON.stringify(authFailures)}`).toEqual([]);

  // cleanup: end the session, archive the class, close the browser
  await api.post(`/api/lessons/${session.id}/end`, { headers: H, data: {} });
  await api.post(`/api/classes/${cls.id}/archive`, { headers: H, data: {} });
  await ctx.close();
  await api.dispose();
});
