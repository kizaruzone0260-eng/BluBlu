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

  // Task B (2026-10-23): the per-IP auth ceiling is now a generous shared-address budget
  // (120 requests / 10 min), and the strict window lives on the CREDENTIAL — one mailbox
  // signing in from one address. The bucket exercised below is therefore (IP + email): a
  // repeated failure on one mailbox is refused, while a class of distinct pupils behind one
  // IP is not. Each case uses its own mailbox, because a blocked pair stays blocked 15 minutes.
  const login = (app: FastifyInstance, mail: string, xff?: string) => app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: xff ? { 'x-forwarded-for': xff } : {},
    payload: { email: mail, password: 'WrongPass123' },
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
    const mail = `rl-off-${Date.now()}@x.io`;
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await login(app, mail, `10.0.0.${i}`)).statusCode;
    expect(last).toBeLessThan(500); // still inside the per-mailbox window (401s)
    expect((await login(app, mail, '10.0.9.9')).statusCode).toBe(429); // 11th — same socket IP
    expect((await login(app, mail, '8.8.8.8')).statusCode).toBe(429);  // header ignored → same bucket
  });

  it('TRUST_PROXY on: the header IP defines the bucket', async () => {
    const app = await appWith(true);
    const mail = `rl-on-${Date.now()}@x.io`;
    // the socket-IP bucket from the previous test is exhausted; a distinct proxied client IP
    // must get its own fresh bucket
    const r = await login(app, mail, '172.16.5.1');
    expect(r.statusCode).not.toBe(429);
    let saw429 = false;
    for (let i = 0; i < 12; i++) saw429 = (await login(app, mail, '172.16.5.1')).statusCode === 429 || saw429;
    expect(saw429).toBe(true);
    expect((await login(app, mail, '172.16.9.9')).statusCode).not.toBe(429); // other client unaffected
  });
});
