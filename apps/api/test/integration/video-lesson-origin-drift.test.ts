/**
 * Video Lesson production regression — end-to-end auth chain under deployment
 * origin drift (the shape production actually runs).
 *
 * Live evidence this test encodes (captured on https://blublu-api.onrender.com):
 *   POST /api/auth/refresh   → 403 {"error":"forbidden"}   (rejected by the Origin
 *                               gate BEFORE any cookie/token logic)
 *   GET  /api/me             → 401                          (token dropped by the SPA)
 *   → the SPA renders /login, /api/lessons/:id/join and LiveKit never run.
 * The 403 came from PUBLIC_URL/DOMAIN being configured to an address that is NOT
 * the address the UI is served from, so the page's own Origin was not in the
 * allowlist. Local dev / CI / e2e could not see it: they run with no PUBLIC_URL,
 * where the same-host fallback was still reachable.
 *
 * So: reproduce the deployed drift, prove the whole chain works anyway, and prove a
 * genuinely cross-site Origin is still refused (no security loosening).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

// The host the deployed page is actually served from, and the Host header a browser
// sends for it. PUBLIC_URL below is deliberately a DIFFERENT address = the drift.
const SERVED_HOST = 'blublu-api.onrender.com';
const SERVED_ORIGIN = `https://${SERVED_HOST}`;
const DRIFTED_PUBLIC_URL = 'https://stale-demo-tunnel.example';

suite('Video Lesson auth chain when the configured origin ≠ the served origin', () => {
  let t: TestDB;
  const prevPublicUrl = env.PUBLIC_URL;
  const prevDomain = env.DOMAIN;

  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); });
  afterAll(async () => {
    env.PUBLIC_URL = prevPublicUrl;
    env.DOMAIN = prevDomain;
    await t?.sql.end();
  });

  it('login → refresh → /api/me → /api/lessons/active all survive the drift; cross-site still 403', async () => {
    env.PUBLIC_URL = DRIFTED_PUBLIC_URL;
    env.DOMAIN = undefined;
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `drift${Date.now()}@x.io`);

    const asSite = { host: SERVED_HOST, origin: SERVED_ORIGIN };
    const cookieOf = (res: { headers: Record<string, unknown> }) =>
      String((res.headers['set-cookie'] as string[] | string)).split(';')[0]!;

    // 1) login (not origin-gated) issues the access token + rotating refresh cookie
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: asSite, payload: { email: teacher.email, password: teacher.password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login);
    let accessToken = String(login.json().accessToken);
    expect(accessToken).toMatch(/^[\w.-]+$/);

    // 2) the request that broke production: the page refreshing its own session
    const refresh = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { ...asSite, cookie },
    });
    expect(refresh.statusCode, 'same-origin refresh must never be 403 (this was the logout trigger)').not.toBe(403);
    expect(refresh.statusCode).toBe(200);
    accessToken = String(refresh.json().accessToken);

    // 3) /api/me with the refreshed token — the SPA's session-restoration call
    const me = await app.inject({
      method: 'GET', url: '/api/me',
      headers: { ...asSite, authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('teacher');

    // 4) the lesson page's first API calls
    const cls = await app.inject({
      method: 'POST', url: '/api/classes',
      headers: { ...asSite, authorization: `Bearer ${accessToken}` },
      payload: { name: 'Drift class', description: '', color: '#0ea5a5' },
    });
    expect(cls.statusCode).toBe(201);
    const classId = String(cls.json().id);

    const active = await app.inject({
      method: 'GET', url: `/api/lessons/active?classId=${classId}`,
      headers: { ...asSite, authorization: `Bearer ${accessToken}` },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().session).toBeNull();

    // 5) starting the lesson and joining the room — where the user actually lands
    const start = await app.inject({
      method: 'POST', url: '/api/lessons/start',
      headers: { ...asSite, authorization: `Bearer ${accessToken}` },
      payload: { classId },
    });
    expect(start.statusCode).toBe(201);
    const sessionId = String(start.json().session?.id ?? start.json().id);
    expect(sessionId).toMatch(/[\w-]{8,}/);

    const join = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionId}/join`,
      headers: { ...asSite, authorization: `Bearer ${accessToken}` },
    });
    expect(join.statusCode).toBe(200);
    expect(String(join.json().token ?? join.json().accessToken ?? '')).toMatch(/^[\w.-]{20,}/);

    // 6) SECURITY: the gate itself is unchanged for a real cross-site page
    const evil = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: SERVED_HOST, origin: 'https://evil.example', cookie },
    });
    expect(evil.statusCode).toBe(403);
    const evilLookalike = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      headers: { host: SERVED_HOST, origin: `https://${SERVED_HOST}.evil.example`, cookie },
    });
    expect(evilLookalike.statusCode).toBe(403);

    // 7) SECURITY: an unauthenticated session is still unauthenticated
    const anon = await app.inject({ method: 'GET', url: '/api/me', headers: asSite });
    expect(anon.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'GET', url: `/api/lessons/active?classId=${classId}`,
      headers: { ...asSite, authorization: 'Bearer not.a.jwt' },
    });
    expect(forged.statusCode).toBe(401);

    await app.close();
  });

  it('logout from the served origin works too (same gate) and kills the session', async () => {
    env.PUBLIC_URL = DRIFTED_PUBLIC_URL;
    env.DOMAIN = undefined;
    const app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `driftout${Date.now()}@x.io`);
    const asSite = { host: SERVED_HOST, origin: SERVED_ORIGIN };

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: asSite, payload: { email: teacher.email, password: teacher.password },
    });
    const cookie = String((login.headers['set-cookie'] as string[] | string)).split(';')[0]!;

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...asSite, cookie } });
    expect(out.statusCode, 'logout was also 403-gated by the same rule').toBe(200);

    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { ...asSite, cookie } });
    expect(reuse.statusCode).toBe(401); // the session really is gone
    await app.close();
  });
});
