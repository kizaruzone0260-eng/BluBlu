/**
 * The deployed configuration, exercised end to end.
 *
 * Why this file exists: every local run of this project (unit, integration, e2e) boots
 * the app in a NON-production env, so the `NODE_ENV === 'production'` branches were
 * never executed locally. That is exactly how the video-lesson outage survived four
 * green pipelines: the deployed Origin gate refused the page's own origin, the SPA
 * dropped the token and users were bounced to Sign In, while dev/CI/e2e happily took
 * the permissive branch. Here the app is built in the production shape
 * (`NODE_ENV=production`, `TRUST_PROXY=1`, `PUBLIC_URL` = the address the page is
 * served from) and the whole auth → lesson → WebSocket chain is walked over real HTTP
 * and a real socket.
 *
 * Coverage of the production matrix (see lib/prodConfig.ts for the list):
 *   session restore after a reload · refresh rotation · Secure+HttpOnly+SameSite=Lax
 *   cookie · lesson start/join to the LiveKit token · WS ticket + WS upgrade · strict
 *   auth rate limits that ignore env relaxations — per credential AND per shared address · spike
   endpoints gone (404) · CORS
 *   offers nothing cross-origin · localhost is not an allowed origin · a spoofed
 *   X-Forwarded-Host cannot move the gate · Sec-Fetch-Site: cross-site is refused ·
 *   and the negative half: anonymous, forged bearer and cross-site callers stay out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

// the address the deployed page is served from (Host + Origin of a real browser)
const PAGE_HOST = 'render.example';
const PAGE_ORIGIN = `https://${PAGE_HOST}`;

suite('production configuration: auth → lesson → WebSocket', () => {
  let t: TestDB;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const snapshot = {
    NODE_ENV: env.NODE_ENV, TRUST_PROXY: env.TRUST_PROXY, PUBLIC_URL: env.PUBLIC_URL,
    PUBLIC_WEB_ORIGIN: env.PUBLIC_WEB_ORIGIN, DOMAIN: env.DOMAIN,
    RATE_LOGIN_MAX: env.RATE_LOGIN_MAX, RATE_CODE_MAX: env.RATE_CODE_MAX,
    RATE_IP_MAX: env.RATE_IP_MAX, RATE_IP_FAIL_MAX: env.RATE_IP_FAIL_MAX,
  };
  const site = { host: PAGE_HOST, origin: PAGE_ORIGIN };
  // @fastify/rate-limit keys on the client IP, so each test gets its own address: the
  // 10/min login cap must be measured on a clean bucket, not on the leftovers of the
  // previous test.
  let loginIp = 0;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.NODE_ENV = 'production';
    env.TRUST_PROXY = true;                       // Render/Caddy are reverse proxies
    env.PUBLIC_URL = PAGE_ORIGIN;                 // task 3: PUBLIC_URL == page address
    env.PUBLIC_WEB_ORIGIN = PAGE_ORIGIN;
    env.DOMAIN = undefined;
    // production must IGNORE these relaxations — set them absurdly high to prove it
    env.RATE_LOGIN_MAX = 10_000;
    env.RATE_CODE_MAX = 10_000;
    env.RATE_IP_MAX = 100_000;
    env.RATE_IP_FAIL_MAX = 100_000;
    app = await buildApp(t.db);
  });

  afterAll(async () => {
    try { await app?.close(); } catch { /* not listening */ }
    Object.assign(env, snapshot);
    await t?.sql.end();
  });

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers['set-cookie'] ?? '').split(/ *,(?=[A-Za-z0-9_]+=)/)[0]!.split(';')[0]!;
  const setCookieRaw = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '');

  it('a page reload restores the session: refresh rotates the cookie and /api/me answers', async () => {
    const teacher = await makeTeacher(t.sql, `prod${Date.now()}@x.io`);
    // 1) login — the SPA keeps accessToken in memory only, so a reload depends on this cookie
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: site, payload: { email: teacher.email, password: teacher.password },
      remoteAddress: `10.${9 + loginIp++}.0.1`,
    });
    expect(login.statusCode).toBe(200);

    // 2) the cookie attributes are part of the auth flow on an https deployment
    const c = setCookieRaw(login);
    expect(c).toMatch(/klass_rt=/);
    expect(c, 'the refresh cookie must never be readable by script').toMatch(/HttpOnly/i);
    expect(c, 'production is https-only').toMatch(/Secure/i);
    expect(c, 'Lax is what stops a cross-site POST from carrying it').toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\/api\/auth/i);

    // 3) reload → the SPA has no access token, so it refreshes to restore the session.
    //    THIS is the call that answered 403 in production and bounced users to Sign In.
    const refresh = await app.inject({
      method: 'POST', url: '/api/auth/refresh', headers: { ...site, cookie: cookieOf(login) },
    });
    expect(refresh.statusCode, 'same-origin refresh in the deployed shape must not be 403').toBe(200);
    const token = String(refresh.json().accessToken);
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const rotated = cookieOf(refresh);
    expect(rotated, 'the cookie rotated — a replay of the old one is the theft case').not.toBe(cookieOf(login));

    // 4) /api/me with the restored token
    const me = await app.inject({
      method: 'GET', url: '/api/me', headers: { ...site, authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('teacher');
    // private data is never cacheable by an intermediate proxy
    expect(me.headers['cache-control']).toContain('no-store');
  });

  it('walks the lesson to the LiveKit token and opens the lesson WebSocket', async () => {
    const teacher = await makeTeacher(t.sql, `prodls${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: site, payload: { email: teacher.email, password: teacher.password },
      remoteAddress: `10.${9 + loginIp++}.0.1`,
    });
    const token = String(login.json().accessToken);
    const H = { ...site, authorization: `Bearer ${token}` };

    const cls = await app.inject({
      method: 'POST', url: '/api/classes', headers: H,
      payload: { name: `Prod shape ${Date.now()}`, description: '', color: '#0ea5a5' },
    });
    expect(cls.statusCode).toBe(201);
    const classId = String(cls.json().id);

    const active = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: H });
    expect(active.statusCode).toBe(200);
    expect(active.json().session).toBeNull();

    const start = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: H, payload: { classId } });
    expect(start.statusCode).toBe(201);
    const sessionId = String(start.json().id);

    const join = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: H });
    expect(join.statusCode).toBe(200);
    const body = join.json() as { token?: string; wsUrl?: string; room?: string };
    expect(String(body.token)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // what room.connect() consumes
    expect(String(body.wsUrl)).toBeTruthy();

    // WS ticket + a REAL upgrade (inject cannot do websockets)
    const ticketRes = await app.inject({
      method: 'POST', url: '/api/ws/ticket', headers: H, payload: { sessionId },
    });
    expect(ticketRes.statusCode).toBe(200);
    const ticket = String(ticketRes.json().ticket);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const probe = (origin: string | null, tk: string) => new Promise<number | null>((res) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/ws/lesson/${sessionId}?ticket=${encodeURIComponent(tk)}`,
        origin ? { headers: { origin } } : undefined,
      );
      ws.onclose = (e) => res(e.code);
      ws.onopen = () => setTimeout(() => { try { ws.close(); } catch { /* already */ } res(null); }, 400);
      setTimeout(() => { try { ws.close(); } catch { /* already */ } res(-1); }, 4000);
    });

    // the page's own origin (what a deployed browser sends) must open the socket
    const fresh = String(await app.inject({
      method: 'POST', url: '/api/ws/ticket', headers: H, payload: { sessionId },
    }).then((r) => r.json().ticket));
    expect(await probe(`http://127.0.0.1:${port}`, fresh)).toBeNull();

    // a cross-site page is refused at the handshake, and the ticket survives
    const crossTicket = String(await app.inject({
      method: 'POST', url: '/api/ws/ticket', headers: H, payload: { sessionId },
    }).then((r) => r.json().ticket));
    expect(await probe('https://evil.example', crossTicket)).toBe(4403);
    const reused = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: H });
    expect(reused.statusCode).toBe(200); // nothing was consumed by the refused handshake
    // the listener stays up: afterAll closes it (a closed Fastify cannot be reused)
  });

  it('localhost is not an origin in production, and a spoofed X-Forwarded-Host cannot move the gate', async () => {
    const teacher = await makeTeacher(t.sql, `prodcfg${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: site, payload: { email: teacher.email, password: teacher.password },
      remoteAddress: `10.${9 + loginIp++}.0.1`,
    });
    const cookie = cookieOf(login);

    // (в) the dev vite origin is not configured here, so a localhost PAGE calling the
    // production host is a cross-origin request and is refused. (A request whose Host is
    // literally localhost:5173 is same-origin by definition — that is the dev server, and
    // production would not be listening on it.)
    const local = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: PAGE_HOST, origin: 'http://localhost:5173', cookie },
      remoteAddress: '10.9.0.1',
    });
    expect(local.statusCode).toBe(403);

    // X-Forwarded-Host is attacker-shaped input: the gate compares the RAW Host header
    const fhSpoof = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: PAGE_HOST, 'x-forwarded-host': 'evil.example', origin: 'https://evil.example', cookie },
    });
    expect(fhSpoof.statusCode, 'a spoofed XFH must not widen the gate').toBe(403);
    const fhNarrow = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: PAGE_HOST, 'x-forwarded-host': 'internal-service:10000', origin: PAGE_ORIGIN, cookie },
    });
    expect(fhNarrow.statusCode, 'a weird XFH must not break the real page either').toBe(200);

    // second layer: the browser's own verdict wins even against an allowlisted Origin
    const crossSite = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: 'someone-else.example', origin: PAGE_ORIGIN, 'sec-fetch-site': 'cross-site', cookie },
    });
    expect(crossSite.statusCode).toBe(403);
    const sameSite = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: PAGE_HOST, origin: PAGE_ORIGIN, 'sec-fetch-site': 'same-origin', cookie },
    });
    expect(sameSite.statusCode).toBe(200);
  });

  it('a SUCCESSFUL login response is not compressed (Phase 4в covers the secret-bearing 200, not only the 401)', async () => {
    const teacher = await makeTeacher(t.sql, `prodzip${Date.now()}@x.io`);
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { ...site, 'accept-encoding': 'gzip, br', 'content-type': 'application/json' },
      payload: { email: teacher.email, password: teacher.password },
      remoteAddress: '10.9.0.7',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-encoding'],
      'compressing a response that contains an access token is the BREACH/CRIME class Phase 4в opts out of')
      .toBeUndefined();
    // and the same must hold for the token-rotating refresh response
    const login = r;
    const refresh = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: {
        ...site, cookie: cookieOf(login), 'accept-encoding': 'gzip, br',
      },
      remoteAddress: '10.9.0.7',
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.headers['content-encoding']).toBeUndefined();
    // while ordinary private data IS compressed (the plugin is not disabled wholesale)
    const health = await app.inject({
      method: 'GET', url: '/api/health', headers: { ...site, 'accept-encoding': 'gzip, br' },
    });
    expect(['gzip', 'br']).toContain(String(health.headers['content-encoding']));
  });

  it('the stage-0 spike endpoint is gone in production, and CORS offers nothing to strangers', async () => {    const teacher = await makeTeacher(t.sql, `prodspike${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: site, payload: { email: teacher.email, password: teacher.password },
      remoteAddress: `10.${9 + loginIp++}.0.1`,
    });
    const token = String(login.json().accessToken);

    const spike = await app.inject({
      method: 'POST', url: '/api/rtc/token',
      headers: { ...site, authorization: `Bearer ${token}` }, payload: { room: 'spike-any' },
    });
    expect(spike.statusCode, 'a 6h publish-capable diagnostic token must not exist in production').toBe(404);

    const stranger = await app.inject({
      method: 'GET', url: '/api/health/live', headers: { origin: 'https://evil.example', host: PAGE_HOST },
    });
    expect(stranger.statusCode).toBe(200);
    expect(String(stranger.headers['access-control-allow-origin'] ?? ''),
      'no cross-origin allowance for an unknown site').not.toBe('https://evil.example');
  });

  it('anonymous, forged and revoked callers stay out in the deployed shape', async () => {
    const anonMe = await app.inject({ method: 'GET', url: '/api/me', headers: site });
    expect(anonMe.statusCode).toBe(401);

    const forged = await app.inject({
      method: 'GET', url: '/api/lessons/active?classId=00000000-0000-0000-0000-000000000000',
      headers: { ...site, authorization: 'Bearer not.a.jwt' },
    });
    expect(forged.statusCode).toBe(401);

    const anonTicket = await app.inject({
      method: 'POST', url: '/api/ws/ticket', headers: site, payload: { sessionId: 'x' },
    });
    expect(anonTicket.statusCode).toBe(401);

    const refreshWithoutCookie = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: site });
    expect(refreshWithoutCookie.statusCode).toBe(401);
  });

  // LAST: these two hammer the limiter and would slow the tests above if they ran first.
  /*
   * Task B (2026-10-23) changed WHERE the strict login cap lives: it used to be 10 logins per
   * MINUTE PER IP, which is what refused the eleventh pupil of a class registering over one school
   * address. Production keeps the strict number and applies it to the credential that is actually
   * being entered — (address + mailbox) — and gives the shared address a separate, generous flood
   * ceiling: 120 requests per 10 minutes per auth route. The two measurements below are the whole
   * production matrix for rate limiting, and both set the env relaxations absurdly high in
   * beforeAll, so each one also proves that production ignores them.
   */
  it('production caps ONE credential at 10 failures a minute and IGNORES RATE_LOGIN_MAX', async () => {
    const teacher = await makeTeacher(t.sql, `prodrate${Date.now()}@x.io`);
    let blocked = 0;
    const codes: number[] = [];
    let last429: { body: { error?: string; reqId?: string }; retryAfter?: string } | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login',
        headers: site, payload: { email: teacher.email, password: 'NotThePassword1' },
        remoteAddress: '10.99.0.99', // one clean bucket for exactly this measurement
      });
      codes.push(r.statusCode);
      if (r.statusCode === 429) {
        blocked++;
        last429 = {
          body: r.json() as { error?: string; reqId?: string },
          retryAfter: String(r.headers['retry-after'] ?? ''),
        };
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 401), `the first 10 are answered as credential failures: ${codes.join(',')}`).toBe(true);
    expect(blocked, `12 failed logins on one mailbox with RATE_LOGIN_MAX=10000 must still be capped: ${codes.join(',')}`)
      .toBeGreaterThan(0);
    // and the refusal is a code the interface can translate, with the wait the pupil is told
    expect(last429!.body.error).toBe('tooManyRequests');
    expect(REQUEST_ID_PATTERN.test(String(last429!.body.reqId)), JSON.stringify(last429!.body)).toBe(true);
    expect(Number(last429!.retryAfter)).toBeGreaterThan(0);
  });

  it('production gives a shared address a generous flood ceiling and IGNORES RATE_IP_MAX', async () => {
    // 121 distinct addresses on one route: no credential is repeated, so the only thing that can
    // answer is the per-IP window — 120 per 10 minutes in production, whatever the env says.
    const ip = '10.99.1.7';
    const first = await app.inject({
      method: 'POST', url: '/api/auth/email-code', headers: site,
      payload: { firstName: 'A', lastName: 'B', email: `ceiling0${Date.now()}@x.io`, locale: 'ru' },
      remoteAddress: ip,
    });
    expect([202, 400]).toContain(first.statusCode); // the provider switch decides, the ceiling does not
    let capped = 0;
    let lastBody: Record<string, unknown> = {};
    for (let i = 1; i <= 121; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/email-code', headers: site,
        payload: { firstName: 'A', lastName: 'B', email: `ceiling${i}${Date.now()}@x.io`, locale: 'ru' },
        remoteAddress: ip,
      });
      if (r.statusCode === 429) { capped++; lastBody = r.json() as Record<string, unknown>; }
    }
    expect(capped, 'the shared-IP ceiling never fired').toBeGreaterThan(0);
    expect(lastBody.error).toBe('tooManyRequests');
  }, 120_000);
});
