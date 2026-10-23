/**
 * Part 2 — per-account brute-force lockout (Postgres-backed). Proves: repeated
 * failures on ONE address lock it out even when the source IP changes; a
 * different account is unaffected; the response never reveals whether the
 * account exists; a successful login clears the counter; the lock delay grows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { loginAttempts } from '../../src/db/schema.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Part 2: account brute-force lockout', () => {
  let t: TestDB; let app: FastifyInstance;
  const PW = 'Passw0rd123';

  async function teacher(tag: string) { return makeTeacher(t.sql, `${tag}${Date.now()}@x.io`); }
  const attempt = (email: string, password: string, xff?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login',
      headers: xff ? { 'x-forwarded-for': xff } : {},
      payload: { email, password } });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    // This file stresses the per-ACCOUNT lockout; relax the per-IP login cap so
    // the many intentional failures don't trip the HTTP limiter (mirrors the
    // e2e-stack). The rate-limit behaviour is covered by rate-limit.test.ts.
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('locks one account after 5 failures even across different IPs; success clears it', async () => {
    const te = await teacher('lock');
    // 5 wrong passwords, each from a different IP → the per-IP limiter never
    // trips, but the per-ACCOUNT counter must arm the lock.
    for (let i = 0; i < 5; i++) {
      const r = await attempt(te.email, 'WrongPass123', `10.1.1.${i}`);
      expect(r.statusCode).toBe(401);
    }
    // now the CORRECT password is refused too — the account is locked, not the IP
    const locked = await attempt(te.email, PW, '10.9.9.9');
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error).toBe('invalidCredentials');

    const [row] = await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, te.email));
    expect(row).toBeTruthy();
    expect(row!.failCount).toBeGreaterThanOrEqual(5);
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('a different account is NOT affected by another account’s lock', async () => {
    const victim = await teacher('vict');
    for (let i = 0; i < 6; i++) await attempt(victim.email, 'WrongPass123');
    const other = await teacher('othr');
    const ok = await attempt(other.email, PW);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
  });

  it('no enumeration: a locked real account and a never-seen email give identical 401 bodies', async () => {
    const real = await teacher('enum');
    for (let i = 0; i < 6; i++) await attempt(real.email, 'WrongPass123');
    const lockedResp = await attempt(real.email, PW);
    const ghostResp = await attempt(`ghost${Date.now()}@x.io`, PW);
    expect(lockedResp.statusCode).toBe(ghostResp.statusCode);
    /*
     * Task B (2026-10-23): both bodies now carry a request id, and it is a fresh random id per
     * request — so comparing the raw bytes would compare the ids, not the disclosure. The claim
     * stays exactly as strong: apart from that id the two answers are the same object, and an
     * attacker reading the response cannot tell a locked account from an absent one.
     */
    const shape = (r: typeof lockedResp) => {
      const { reqId, ...rest } = r.json() as { reqId?: string } & Record<string, unknown>;
      expect(REQUEST_ID_PATTERN.test(String(reqId)), JSON.stringify(r.json())).toBe(true);
      return JSON.stringify(rest);
    };
    expect(shape(ghostResp)).toBe(shape(lockedResp));
    expect(lockedResp.json().reqId).not.toBe(ghostResp.json().reqId);
  });

  it('a successful login clears the counter (below threshold)', async () => {
    const te = await teacher('clear');
    for (let i = 0; i < 3; i++) await attempt(te.email, 'WrongPass123'); // 3 < 5 → not locked
    const ok = await attempt(te.email, PW);
    expect(ok.statusCode).toBe(200);
    const rows = await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, te.email));
    expect(rows.length).toBe(0);
  });

  it('the lock delay grows with further failures', async () => {
    const te = await teacher('grow');
    for (let i = 0; i < 5; i++) await attempt(te.email, 'WrongPass123');
    const [r5] = await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, te.email));
    const d5 = r5!.lockedUntil!.getTime() - Date.now();
    // push past the 5th so the window recomputes larger
    await attempt(te.email, 'WrongPass123');
    const [r6] = await t.db.select().from(loginAttempts).where(eq(loginAttempts.email, te.email));
    const d6 = r6!.lockedUntil!.getTime() - Date.now();
    expect(d6).toBeGreaterThan(d5);
    expect(d6).toBeLessThanOrEqual(15 * 60_000 + 2000); // capped at 15 min
  });
});
