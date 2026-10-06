/**
 * Phase 1 — security hardening proofs (HTTP surface, sessions, CSRF, passwords,
 * Telegram, LiveKit). Complements the §7 rights matrix and the adversarial
 * two-tenant suite. Uses the real Fastify app via app.inject; DATABASE_URL_TEST
 * drives the Postgres-backed cases.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { signCb, verifyCb } from '../../src/services/botApi.js';
import { createHmac } from 'node:crypto';
import { hashPassword } from '../../src/lib/password.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Save/restore an env field so mutating the singleton never leaks across files. */
async function withEnv<K extends keyof typeof env>(key: K, value: (typeof env)[K], fn: () => void | Promise<void>) {
  const bag = env as unknown as Record<string, unknown>;
  const prev = bag[key as string];
  try { bag[key as string] = value; await fn(); } finally { bag[key as string] = prev; }
}

suite('Phase 1а: security response headers', () => {
  let t: TestDB; let app: FastifyInstance; let tok = '';
  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    // a route that throws an unexpected error carrying a secret-looking message
    app.get('/__boom', () => { throw new Error('postgres://secret:secret@host/db leaked-detail'); });
    const te = await makeTeacher(t.sql, `hdr${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password } });
    tok = l.json().accessToken;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('private API replies set no-store on every /api response', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tok}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['pragma']).toBe('no-cache');
  });

  it('helmet headers present (CSP, nosniff, frame-ancestors none, referrer, HSTS, X-Frame, permissions-policy)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    const h = r.headers as Record<string, string>;
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).not.toContain('unsafe-eval');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('same-origin');
    expect(h['strict-transport-security']).toBeDefined();
    expect(h['x-frame-options']).toBeDefined();
    expect(h['permissions-policy']).toContain('camera=(self)');
  });

  it('5xx never leaks an internal message (generic, version-free body)', async () => {
    // force an unhandled error by hitting a route that reads a deleted session
    const r = await app.inject({ method: 'GET', url: '/__boom' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/postgres|secret|leaked-detail|stack|Error:/i);
    expect(r.json().error).toBe('serverError');
  });
});

suite('Phase 1в: refresh CSRF must trust the configured Origin, not Host', () => {
  let t: TestDB; let app: FastifyInstance;
  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); app = await buildApp(t.db); });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const refresh = (origin: string, host: string) =>
    app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { origin, host, cookie: 'klass_rt=nope' } });

  it('when PUBLIC_URL is set: a foreign Origin is refused even if Host matches it', async () => {
    await withEnv('PUBLIC_URL', 'https://app.example', async () => {
      const r = await refresh('https://evil.example', 'app.example'); // Host = ours, Origin = evil
      expect(r.statusCode).toBe(403);
    });
  });
  it('when PUBLIC_URL is set: the exact allowed Origin passes (reaches the token check)', async () => {
    await withEnv('PUBLIC_URL', 'https://app.example', async () => {
      const r = await refresh('https://app.example', 'elsewhere.test');
      expect(r.statusCode).toBe(401); // not 403 — origin OK, bad token
    });
  });
  it('dev (no PUBLIC_URL/DOMAIN): same-Host Origin still allowed', async () => {
    await withEnv('PUBLIC_URL', '', async () => {
      const r = await refresh('http://127.0.0.1:3123', '127.0.0.1:3123');
      expect(r.statusCode).toBe(401);
    });
  });
});

suite('Phase 1д: password policy on set, lax on login', () => {
  let t: TestDB; let app: FastifyInstance;
  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); app = await buildApp(t.db); });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('register rejects <10 with a translated code', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'A', lastName: 'B', email: 'pw1@x.io', password: 'Short12', code: 'ABCDEFGH' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('passwordTooShort');
  });
  it('register rejects a common password', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'A', lastName: 'B', email: 'pw2@x.io', password: 'Password123', code: 'ABCDEFGH' } });
    expect(r.json().error).toBe('passwordTooCommon');
  });
  it('a legacy 8-char password can still LOG IN (login schema is lax)', async () => {
    const id = crypto.randomUUID();
    const h = await hashPassword('Abcdef12');
    await t.sql`insert into users (id, role, name, email, password_hash, locale, tz, created_at)
                values (${id}, 'teacher', 'Legacy', ${`lg${Date.now()}@x.io`.toLowerCase()}, ${h}, 'ru', 'UTC', now())`;
    const email = (await t.sql`select email from users where id = ${id}`)[0].email as string;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Abcdef12' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBeTruthy();
  });
});

suite('Phase 1и: Telegram webhook secret + HKDF callback key', () => {
  let t: TestDB; let app: FastifyInstance;
  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); app = await buildApp(t.db); });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('webhook: 403 when secret unset, matches only on exact secret', async () => {
    await withEnv('TELEGRAM_WEBHOOK_SECRET', '', async () => {
      const r = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': '' }, payload: { update_id: 1 } });
      expect(r.statusCode).toBe(403);
    });
    await withEnv('TELEGRAM_WEBHOOK_SECRET', 'topsecret123', async () => {
      const bad = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, payload: { update_id: 1 } });
      expect(bad.statusCode).toBe(403);
      const good = await app.inject({ method: 'POST', url: '/webhook/telegram', headers: { 'x-telegram-bot-api-secret-token': 'topsecret123' }, payload: { update_id: 1 } });
      expect(good.statusCode).toBe(200);
    });
  });

  it('signCb→verifyCb round-trips; tamper is refused', () => {
    const cb = signCb({ u: 'user-1', a: 'approve', c: 'class-1' });
    expect(cb.startsWith('c2.')).toBe(true);
    expect(verifyCb(cb)).toEqual({ u: 'user-1', a: 'approve', c: 'class-1' });
    const [head, body] = cb.split('.');
    expect(verifyCb(`${head}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
    expect(verifyCb(`${head}.${Buffer.from('{"a":"x"}').toString('base64url')}.zz`)).toBeNull();
  });

  it('new callbacks use a key SEPARATE from JWT_SECRET (JWT-signed c2 is refused)', () => {
    const body = Buffer.from(JSON.stringify({ a: 'x', u: '1' }), 'utf8').toString('base64url');
    const forged = createHmac('sha256', env.JWT_SECRET).update(`cb2:${body}`).digest('base64url').slice(0, 22);
    expect(verifyCb(`c2.${body}.${forged}`)).toBeNull(); // proves the signing key is NOT JWT_SECRET
  });

  it('legacy c1 callbacks still verify during the migration window', () => {
    const body = Buffer.from(JSON.stringify({ a: 'x', u: '1' }), 'utf8').toString('base64url');
    const sig1 = createHmac('sha256', env.JWT_SECRET).update(`cb1:${body}`).digest('base64url').slice(0, 22);
    expect(verifyCb(`c1.${body}.${sig1}`)).toEqual({ a: 'x', u: '1' });
  });
});

suite('Phase 1к: LiveKit spike room disabled in production', () => {
  let t: TestDB; let app: FastifyInstance; let tok = '';
  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL); app = await buildApp(t.db);
    const te = await makeTeacher(t.sql, `spk${Date.now()}@x.io`);
    tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: te.email, password: te.password } })).json().accessToken;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('dev/test: spike token still issuable (diagnostics)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: { authorization: `Bearer ${tok}` }, payload: { room: 'spike-x' } });
    expect(r.statusCode).toBe(200);
  });
  it('production: spike endpoint is gone (404)', async () => {
    await withEnv('NODE_ENV', 'production', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: { authorization: `Bearer ${tok}` }, payload: { room: 'spike-x' } });
      expect(r.statusCode).toBe(404);
    });
  });
});
