/**
 * Part 2 of the rate-limit task:
 *  - the 300/min/IP cap covers /api and /webhook only — static asset requests
 *    are not limited at all;
 *  - with TRUST_PROXY off (default) the X-Forwarded-For header must NOT move
 *    the bucket — a forged header cannot dodge the per-IP auth limits;
 *  - with TRUST_PROXY on the IP from the header IS used (real client behind
 *    Caddy/cloudflared gets its own bucket).
 *
 * Fastify bakes trustProxy into the Request at build time (no runtime setter),
 * so each case builds its own app with env.TRUST_PROXY toggled.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import type { FastifyInstance } from 'fastify';

const suite = process.env.DATABASE_URL_TEST ? describe : describe.skip;

suite('rate limit: static excluded + trustProxy semantics', () => {
  let t: TestDB;
  const apps: FastifyInstance[] = [];

  async function appWith(trustProxy: boolean): Promise<FastifyInstance> {
    if (!t) {
      t = await preparedDb(process.env.DATABASE_URL_TEST!);
    }
    env.TRUST_PROXY = trustProxy;
    const app = await buildApp(t.db);
    apps.push(app);
    return app;
  }
  afterAll(async () => {
    env.TRUST_PROXY = false;
    for (const a of apps) await a.close();
    await t?.sql.end();
  });

  // The per-IP HTTP limiter is what this suite exercises. Give every attempt a
  // DISTINCT email so the per-ACCOUNT brute-force lockout (part 2) never arms
  // (each address sees a single failure) — the IP-bucket assertions below are
  // unchanged. All addresses are wrong-password/non-existent → identical 401.
  let attempt = 0;
  const login = (app: FastifyInstance, xff?: string) => app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: xff ? { 'x-forwarded-for': xff } : {},
    payload: { email: `rl-${Date.now()}-${attempt++}@x.io`, password: 'WrongPass123' },
  });

  it('static (non-/api) requests are not limited', async () => {
    const app = await appWith(false);
    for (let i = 0; i < 320; i++) {
      const r = await app.inject({ method: 'GET', url: '/assets/definitely-not-here.js' });
      expect(r.statusCode, `request #${i}`).not.toBe(429);
    }
  });

  it('TRUST_PROXY off: XFF is ignored — forged IPs do not dodge the bucket', async () => {
    const app = await appWith(false);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await login(app, `10.0.0.${i}`)).statusCode;
    expect(last).toBeLessThan(500); // still inside the 10/min window (401s)
    expect((await login(app, '10.0.9.9')).statusCode).toBe(429); // 11th — same socket IP
    expect((await login(app, '8.8.8.8')).statusCode).toBe(429);  // header ignored → same bucket
  });

  it('TRUST_PROXY on: the header IP defines the bucket', async () => {
    const app = await appWith(true);
    // the socket-IP bucket from the previous test is exhausted; a distinct
    // proxied client IP must get its own fresh bucket
    const r = await login(app, '172.16.5.1');
    expect(r.statusCode).not.toBe(429);
    let saw429 = false;
    for (let i = 0; i < 12; i++) saw429 = (await login(app, '172.16.5.1')).statusCode === 429 || saw429;
    expect(saw429).toBe(true);
    expect((await login(app, '172.16.9.9')).statusCode).not.toBe(429); // other client unaffected
  });
});
