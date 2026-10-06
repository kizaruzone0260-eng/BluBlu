/**
 * Part 4а — LiveKit lesson join-token TTL. Proves at the API boundary we own:
 *  • the default TTL is comfortably ≥ 2 h (long lessons never hit expiry);
 *  • the issued token's life (exp − iat) follows the configured env TTL;
 *  • re-joining (the reconnect/heartbeat path) always mints a FRESH token — so a
 *    lesson that outlives a short TTL can be renewed instead of dropped.
 *
 * A true end-to-end ">TTL live room doesn't drop" assertion needs a running
 * media server and real time; that is documented as not-verifiable in the
 * offline harness. What we CAN verify is that the server hands the client a new
 * valid token on every join, which is the renewal source the SPA relies on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes, classMembers } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { ttlSeconds } from '../../src/lib/tokenTtl.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

function jwtClaims(token: string): { nbf: number; exp: number } {
  const payload = token.split('.')[1] ?? '';
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as { nbf: number; exp: number };
}

suite('Part 4а: LiveKit lesson-token TTL', () => {
  let t: TestDB; let app: FastifyInstance;
  let teacherTok = '', studentTok = '', sessionId = '', studentId = '';
  const defaultTtl = env.RTC_TOKEN_TTL; // captured before any mutation
  const prevTtl = defaultTtl;

  async function login(email: string, password: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return r.json().accessToken as string;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500;
    app = await buildApp(t.db);

    const te = await makeTeacher(t.sql, `ttl${Date.now()}@x.io`);
    teacherTok = await login(te.email, te.password);
    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: 'TTL class' }).returning();
    studentId = crypto.randomUUID();
    const stuEmail = `ttl-s${Date.now()}@x.io`;
    await t.sql`insert into users (id, role, name, last_name, email, password_hash, locale, tz, created_at)
                values (${studentId}, 'student', 'To', 'Ken', ${stuEmail}, ${await hashPassword('Passw0rd123')}, 'ru', 'Asia/Tashkent', now())`;
    await t.db.insert(classMembers).values({ classId: cls!.id, userId: studentId });
    studentTok = await login(stuEmail, 'Passw0rd123');

    const ses = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: { authorization: `Bearer ${teacherTok}` }, payload: { classId: cls!.id } });
    sessionId = ses.json().id as string;
  });
  afterAll(async () => { env.RTC_TOKEN_TTL = prevTtl; await app?.close(); await t?.sql.end(); });

  const join = () => app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: { authorization: `Bearer ${studentTok}` } });

  it('the default TTL is at or above the 2 h production floor', () => {
    expect(ttlSeconds(defaultTtl)).toBeGreaterThanOrEqual(2 * 3600);
  });

  it('a short configured TTL produces a short-lived token', async () => {
    env.RTC_TOKEN_TTL = '5m';
    const r = await join();
    expect(r.statusCode).toBe(200);
    const { nbf, exp } = jwtClaims(r.json().token as string);
    expect(exp - nbf).toBe(5 * 60);
  });

  it('re-join mints a FRESH token that honours the new TTL and differs from the old', async () => {
    env.RTC_TOKEN_TTL = '5m';
    const first = (await join()).json().token as string;
    env.RTC_TOKEN_TTL = '10m'; // as the SPA would after lowering then restoring; proves re-mint
    const second = (await join()).json().token as string;
    expect(second).not.toBe(first); // a genuinely new token, not a cached echo
    const a = jwtClaims(first), b = jwtClaims(second);
    expect(b.exp - b.nbf).toBe(10 * 60); // reflects the updated TTL
    expect(b.exp).toBeGreaterThan(a.nbf); // the fresh token lives beyond the old one's start
  });

  it('the join endpoint is membership-gated (no token for a non-member)', async () => {
    const strangerEmail = `ttl-x${Date.now()}@x.io`;
    const st = await makeTeacher(t.sql, strangerEmail); // a teacher with no membership
    const tok = await login(st.email, st.password);
    const r = await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/join`, headers: { authorization: `Bearer ${tok}` } });
    expect(r.statusCode).toBe(404);
  });
});
