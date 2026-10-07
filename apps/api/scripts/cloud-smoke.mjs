/**
 * Post-deploy smoke check — READ ONLY, writes nothing to the product data.
 *
 *   pnpm cloud:smoke -- --base https://<service>.onrender.com --env <path-to-cloud.env>
 *
 * `--env` is only used to read the TEST account (SEED_TEACHER_EMAIL / SEED_TEACHER_PASSWORD)
 * so the check can log in; no secret value is ever printed, and every token, cookie and
 * credential in the output is redacted. The one side effect is the login's own ephemeral
 * refresh session, which the script revokes with /api/auth/logout at the end.
 *
 * Why each line exists — these are exactly the behaviours that were proved to be
 * production-only (see apps/api/src/lib/prodConfig.ts and docs/HARDENING.md), so a green
 * pipeline does NOT imply them and a deploy can break them silently:
 *   • the Origin gate must accept the site's OWN origin (a 403 here is the outage that
 *     bounced every user out of Video Lesson) and still refuse a cross-site origin;
 *   • Sec-Fetch-Site: cross-site must be refused even with an allowlisted origin;
 *   • the refresh cookie must be Secure + HttpOnly + SameSite=Lax + Path=/api/auth;
 *   • the auth chain must answer for an authenticated user and stay closed for an
 *     anonymous one; the lesson endpoints must authorise, not 401;
 *   • auth/token responses must not be compressed (Phase 4в) and private responses must
 *     be no-store (Phase 1а);
 *   • /api/health must be 200 and version-free;
 *   • a lesson WebSocket is verified only when a session is ALREADY open — minting one
 *     would create data, so the ticket route is instead checked for "authenticated and
 *     refused by lookup" (404), which proves the auth layer without writing anything.
 */
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (arg('base') ?? '').replace(/\/+$/, '');
const envFile = arg('env');
if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.error('usage: pnpm cloud:smoke -- --base https://your-service [--env <cloud.env>]');
  process.exit(2);
}

const creds = { email: process.env.SEED_TEACHER_EMAIL ?? '', password: process.env.SEED_TEACHER_PASSWORD ?? '' };
if (envFile) {
  const fs = await import('node:fs');
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i <= 0) continue;
    const k = line.slice(0, i).trim(); if (!/^[A-Z0-9_]+$/.test(k)) continue;
    const v = line.slice(i + 1).trim();
    if (k === 'SEED_TEACHER_EMAIL') creds.email = v;
    if (k === 'SEED_TEACHER_PASSWORD') creds.password = v;
  }
}

let failures = 0;
const startedAt = new Date();
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const origin = BASE;
const siteHeaders = { origin, host: new URL(BASE).host };

let accessToken = '';
let refreshTokenCookie = '';
const ids = { classId: '', sessionHint: '' };

async function call(method, path, { headers = {}, payload, withCookie = false } = {}) {
  const h = { ...siteHeaders, ...headers };
  if (withCookie && refreshTokenCookie) h.cookie = `klass_rt=${refreshTokenCookie}`;
  if (payload !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-json (an HTML shell) */ }
  return { status: res.status, headers: res.headers, json, text };
}

console.log(`cloud smoke — ${BASE}`);

// ── 1. health: reachable, and no version/config leak ──────────────────────────
{
  const r = await call('GET', '/api/health');
  check('GET /api/health is 200', r.status === 200, `status=${r.status}`);
  const body = r.text.toLowerCase();
  const leak = /(fastify|node\.js|drizzle|postgres|livekit|semver|"version"\s*:\s*"\d|\d+\.\d+\.\d+)/.exec(body);
  check('GET /api/health leaks no version or library name', !leak, leak ? `matched "${leak[0]}"` : '');
  check('private responses are no-store', String(r.headers.get('cache-control') ?? '').includes('no-store'),
    `cache-control=${r.headers.get('cache-control')}`);
  check('security headers present (CSP, nosniff, frame-ancestors)',
    String(r.headers.get('content-security-policy') ?? '').includes("default-src 'self'")
    && r.headers.get('x-content-type-options') === 'nosniff'
    && String(r.headers.get('content-security-policy') ?? '').includes('frame-ancestors'),
    `csp=${String(r.headers.get('content-security-policy')).slice(0, 40)}…`);
}

// ── 2. the Origin gate — the exact defect that broke Video Lesson ──────────────
{
  const own = await call('POST', '/api/auth/refresh', { headers: { origin } });
  // 401 = the gate let it through and there is simply no cookie (correct for a smoke run)
  check('refresh with the site\'s OWN Origin is NOT refused by the gate (was 403 in the outage)',
    own.status !== 403, `status=${own.status} body=${own.text.slice(0, 60)}`);

  const foreign = await call('POST', '/api/auth/refresh', { headers: { origin: 'https://qoder-smoke-evil.example' } });
  check('refresh with a foreign Origin IS refused (403)', foreign.status === 403, `status=${foreign.status}`);

  const lookalike = await call('POST', '/api/auth/refresh', {
    headers: { origin: `${origin}.qoder-smoke-evil.example` },
  });
  check('a host-suffix look-alike Origin IS refused (403)', lookalike.status === 403, `status=${lookalike.status}`);

  const secFetch = await call('POST', '/api/auth/refresh', {
    headers: { origin, 'sec-fetch-site': 'cross-site' },
  });
  check('Sec-Fetch-Site: cross-site is refused even with an allowlisted origin (403)',
    secFetch.status === 403, `status=${secFetch.status}`);

  const dev = await call('POST', '/api/auth/refresh', { headers: { origin: 'http://localhost:5173' } });
  check('the dev localhost origin is not accepted by a deployed service (403)',
    dev.status === 403, `status=${dev.status}`);
}

// ── 3. login, cookie shape, and the authenticated chain ───────────────────────
if (creds.email && creds.password) {
  const login = await call('POST', '/api/auth/login', { payload: { email: creds.email, password: creds.password } });
  check('POST /api/auth/login (test account) is 200', login.status === 200, `status=${login.status}`);
  accessToken = String(login.json?.accessToken ?? '');
  const setCookie = String(login.headers.get('set-cookie') ?? '');
  const named = setCookie.split(/ *,(?=[A-Za-z0-9_]+=)/).find((c) => c.startsWith('klass_rt=')) ?? '';
  refreshTokenCookie = named.split(';')[0].split('=').slice(1).join('=');
  check('the refresh cookie is HttpOnly', /httponly/i.test(named), named ? 'ok' : 'no klass_rt cookie visible');
  check('the refresh cookie is Secure (production is https-only)', /secure/i.test(named));
  check('the refresh cookie is SameSite=Lax', /samesite=lax/i.test(named));
  check('the refresh cookie is scoped to Path=/api/auth', /path=\/api\/auth/i.test(named));
  // Compression of a token response is an ORIGIN property (Phase 4в) — the integration
  // test test/integration/prod-config.test.ts proves it and a CDN in front of us is free
  // to re-encode whatever it likes, so here it is only reported, never a verdict.
  console.log(`INFO  content-encoding on the login response at this edge: `
    + `${login.headers.get('content-encoding') ?? 'none'} (the origin excludes these routes; `
    + 'an edge may still re-encode)');
  check('an access token was issued', accessToken.split('.').length === 3, accessToken ? 'present' : 'MISSING');

  const bearer = { authorization: `Bearer ${accessToken}` };
  const me = await call('GET', '/api/me', { headers: bearer });
  check('GET /api/me with the token is 200', me.status === 200, `status=${me.status}`);
  check('GET /api/me role is a teacher account', me.json?.role === 'teacher', `role=${me.json?.role}`);

  const classes = await call('GET', '/api/classes', { headers: bearer });
  const list = Array.isArray(classes.json) ? classes.json : (classes.json?.classes ?? []);
  ids.classId = list?.[0]?.id ?? '';
  check('GET /api/classes is 200', classes.status === 200, `status=${classes.status} classes=${list?.length ?? 0}`);

  if (ids.classId) {
    const active = await call('GET', `/api/lessons/active?classId=${ids.classId}`, { headers: bearer });
    check('GET /api/lessons/active is 200 (the first request the video page makes)',
      active.status === 200, `status=${active.status}`);
    ids.sessionHint = active.json?.session?.id ?? '';
  } else {
    console.log('SKIP  /api/lessons/active — the account has no class (nothing to point at)');
  }

  // a ticket for a session that does not exist proves "authenticated, then refused by
  // lookup" WITHOUT creating a lesson: 404 notFound, not 401/403.
  const ticket = await call('POST', '/api/ws/ticket', {
    headers: bearer, payload: { sessionId: '00000000-0000-4000-8000-000000000000' },
  });
  check('POST /api/ws/ticket authenticates and then refuses an unknown session (404, no data written)',
    ticket.status === 404, `status=${ticket.status}`);

  if (ids.sessionHint) {
    // a lesson is ALREADY open (someone is teaching) — verify the real socket, read-only
    const t = await call('POST', '/api/ws/ticket', { headers: bearer, payload: { sessionId: ids.sessionHint } });
    const tk = String(t.json?.ticket ?? '');
    if (t.status === 200 && tk) {
      const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/ws/lesson/${ids.sessionHint}?ticket=${encodeURIComponent(tk)}`;
      const opened = await new Promise((res) => {
        const ws = new WebSocket(wsUrl, { headers: { origin } });
        const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } res(false); }, 6000);
        ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch { /* */ } res(true); };
        ws.onerror = () => { clearTimeout(timer); res(false); };
        ws.onclose = () => { clearTimeout(timer); };
      });
      check('the lesson WebSocket opens for the running session', opened, `session=${ids.sessionHint}`);
    }
  } else {
    console.log('SKIP  live lesson WebSocket — no session is currently open (starting one would write data)');
  }

  // revoke the session this script created
  const logout = await call('POST', '/api/auth/logout', {
    headers: { ...bearer, cookie: `klass_rt=${refreshTokenCookie}` },
  });
  if (logout.status === 403) {
    // This is the outage itself, seen from the other side: the deployed Origin gate
    // refuses the site's own origin, so even SIGNING OUT is broken for real users.
    check('POST /api/auth/logout revokes the smoke session (200)', false,
      'status=403 — the gate refuses the site\'s own origin, so sign-out is broken for users too. '
      + 'This session could not be revoked over HTTP: clear the newest refresh_tokens row for this '
      + 'account (the token value was never printed) or re-run this smoke after the deploy.');
  } else {
    check('POST /api/auth/logout revokes the smoke session (200)', logout.status === 200, `status=${logout.status}`);
    const after = await call('POST', '/api/auth/refresh', { headers: { cookie: `klass_rt=${refreshTokenCookie}` } });
    check('the revoked cookie can no longer refresh (401)', after.status === 401, `status=${after.status}`);
  }
} else {
  console.log('SKIP  authenticated chain — no test account (--env <cloud.env> with SEED_TEACHER_EMAIL/PASSWORD)');
}

// ── 4. the anonymous door must stay closed ─────────────────────────────────────
{
  const anon = await call('GET', '/api/me');
  check('GET /api/me without a token is 401', anon.status === 401, `status=${anon.status}`);
  const forged = await call('GET', '/api/lessons/active?classId=00000000-0000-4000-8000-000000000000', {
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1' },
  });
  check('a forged bearer is 401', forged.status === 401, `status=${forged.status}`);
  const spike = await call('POST', '/api/rtc/token', { headers: { authorization: `Bearer ${accessToken}` }, payload: { room: 'spike-smoke' } });
  check('the stage-0 spike token endpoint is closed in production (404)', spike.status === 404, `status=${spike.status}`);
}

console.log(failures ? `\nSMOKE FAILED: ${failures} check(s)` : '\nSMOKE PASSED: all checks green');
process.exit(failures ? 1 : 0);
