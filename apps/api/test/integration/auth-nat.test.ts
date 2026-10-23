/**
 * Task B (2026-10-23) — a whole class behind one address, and failures that explain themselves.
 *
 * The live symptom: pupils «cannot get in», and step 2 of registration answers
 * «Something went wrong. Please try again.». Two separate causes, both proven here:
 *
 *  1. the auth limiter counted per IP with a budget of 10 logins / 8 code attempts a MINUTE, so
 *     from one school Wi-Fi address the eleventh pupil was refused — and @fastify/rate-limit
 *     answered with `{error: "Too Many Requests"}`, a string the interface has no key for, so
 *     the refusal was indistinguishable from a server crash;
 *  2. a pupil who had already registered met the bare statement «this email is already
 *     registered» with no way forward.
 *
 * What the suite now requires instead: a shared address is generous (120 requests per 10 minutes
 * per auth route), the strict windows live on the CREDENTIAL (one mailbox, one class code) and on
 * failures only, every refusal carries a code the interface can translate plus a `reqId` that
 * matches the access log, and a failed step 2 leaves nothing behind — no half-created account,
 * no burned invitation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classMembers, classes, inviteCodes, users } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

/**
 * `set-cookie` is a string when Fastify set one cookie and an array when it set several, so
 * taking `[0]` and cutting at `;` yields either the whole pair or the single letter `k`. The
 * refresh cookie is found by name in both shapes.
 */
function refreshCookie(raw: unknown): string | undefined {
  const list = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
  return list.find((entry) => entry.startsWith('klass_rt='))?.split(';')[0];
}

suite('auth behind a shared school IP', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let classId = '';
  let seq = 0;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `nat-teacher@x.io`);
    teacherId = teacher.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'NAT class' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  async function newInvite(): Promise<string> {
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return code;
  }
  const email = () => `nat${Date.now()}-${seq++}@x.io`;
  /*
   * Each scenario gets its OWN client address. The whole point of the suite is that an address
   * carries a budget, so a test that floods one IP must not decide the next test's answer — and
   * `trustProxy` is off here, which makes `remoteAddress` the IP the limiter sees.
   */
  let ipOctet = 0;
  const cleanIp = () => `10.77.${Math.floor(++ipOctet / 254)}.${ipOctet % 254}`;
  const loginWith = (mail: string, password = 'WrongPass123', ip: string) => app.inject({
    method: 'POST', url: '/api/auth/login', remoteAddress: ip,
    payload: { email: mail, password },
  });
  const registerWith = (mail: string, code: string, ip: string) => app.inject({
    method: 'POST', url: '/api/auth/register', remoteAddress: ip,
    payload: { firstName: 'Pupil', lastName: 'One', email: mail, password: 'Secret1234', code },
  });
  /** `error` and `reqId` are the two fields every auth failure must now carry. */
  function expectRejected(res: { statusCode: number; payload: string }, status: number, code: string) {
    expect(res.statusCode).toBe(status);
    const body = res.json() as { error?: string; reqId?: string };
    expect(body.error).toBe(code);
    expect(REQUEST_ID_PATTERN.test(String(body.reqId)), `reqId of ${JSON.stringify(body)}`).toBe(true);
    return body;
  }

  it('lets 25 pupils from ONE address sign in inside a minute, none refused', async () => {
    // every address here is unknown, so each is a single failure on its own account: the
    // per-account lockout stays asleep and only the shared-IP ceiling could block them.
    const ip = cleanIp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await loginWith(`class-of-25-${i}@x.io`, 'WrongPass123', ip)).statusCode);
    expect(statuses.includes(429), `a class of 25 was throttled: ${statuses.join(',')}`).toBe(false);
    expect(statuses.every((s) => s === 401)).toBe(true);
  });

  it('answers a throttled credential with a translatable code, a retry window and a reqId', async () => {
    const ip = cleanIp();
    const mail = email();
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) seen.push((await loginWith(mail, 'WrongPass123', ip)).statusCode);
    expect(seen.filter((s) => s === 429).length, `no throttle for repeated hammering: ${seen.join(',')}`).toBeGreaterThan(0);
    const last = await loginWith(mail, 'WrongPass123', ip);
    // the account lockout (5 consecutive failures) answers first with a plain 401; the
    // credential window (10/min for one mailbox) answers with 429 and a wait the pupil can read
    expect([401, 429]).toContain(last.statusCode);
    if (last.statusCode === 429) {
      expectRejected(last, 429, 'tooManyRequests');
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('caps ONE address at a generous shared ceiling and normalises that 429 too', async () => {
    // 120 distinct mailboxes in ten minutes is ~1 request every five seconds sustained: no
    // school needs more, and the request that exceeds it still gets a code, not a stack trace.
    const ip = cleanIp();
    let saw429 = 0;
    const bodies: string[] = [];
    for (let i = 0; i < 124; i++) {
      const res = await loginWith(`flood-${Date.now()}-${i}@x.io`, 'WrongPass123', ip);
      if (res.statusCode === 429) { saw429 += 1; bodies.push(res.payload); }
    }
    expect(saw429, 'the shared-IP ceiling never fired').toBeGreaterThan(0);
    expect(JSON.parse(bodies[bodies.length - 1]!).error).toBe('tooManyRequests');
  }, 120_000);

  it('registers twelve pupils from one address in one minute, all successfully', async () => {
    const ip = cleanIp();
    const codes = await Promise.all(Array.from({ length: 12 }, () => newInvite()));
    for (let i = 0; i < 12; i++) {
      const res = await registerWith(`pupil-${Date.now()}-${i}@x.io`, codes[i]!, ip);
      expect(res.statusCode, `pupil ${i}: ${res.payload}`).toBe(200);
      expect(typeof res.json().accessToken).toBe('string');
    }
    const members = await t.db.select({ id: classMembers.userId }).from(classMembers)
      .where(eq(classMembers.classId, classId));
    expect(members.length).toBeGreaterThanOrEqual(12);
  }, 120_000);

  it('a taken address is refused without burning the invitation or half-creating the pupil', async () => {
    const ip = cleanIp();
    const mail = email();
    const first = await newInvite();
    expect((await registerWith(mail, first, ip)).statusCode).toBe(200);

    const second = await newInvite();
    const taken = await registerWith(mail, second, ip);
    expectRejected(taken, 409, 'emailTaken');

    // nothing was consumed and nothing was left behind
    const [row] = await t.db.select({ usedAt: inviteCodes.usedAt }).from(inviteCodes)
      .where(eq(inviteCodes.codeHash, hashInviteCode(second, process.env.JWT_SECRET!)));
    expect(row?.usedAt, 'the second code was spent by a failed registration').toBeNull();
    const created = await t.db.select({ id: users.id }).from(users).where(and(
      eq(users.email, mail), isNull(users.deletedAt),
    ));
    expect(created).toHaveLength(1); // still exactly one account for that address
  });

  it('a wrong password and an unknown address answer identically, and the log id differs', async () => {
    const ip = cleanIp();
    const known = email();
    const code = await newInvite();
    expect((await registerWith(known, code, ip)).statusCode).toBe(200);
    const badPassword = await loginWith(known, 'NotThePassword1', ip);
    const noAccount = await loginWith(`nobody-${Date.now()}@x.io`, 'NotThePassword1', ip);
    const strip = (payload: string) => JSON.stringify({ ...(JSON.parse(payload) as object), reqId: '' });
    expect(strip(noAccount.payload)).toBe(strip(badPassword.payload));
    expect(badPassword.json().reqId).not.toBe(noAccount.json().reqId);
  });

  it('an in-app browser with no Origin keeps working; a cross-site one is still refused', async () => {
    const ip = cleanIp();
    const mail = email();
    const code = await newInvite();
    const registered = await registerWith(mail, code, ip);
    expect(registered.statusCode).toBe(200);
    const cookie = refreshCookie(registered.headers['set-cookie']);
    expect(cookie, `no refresh cookie was issued: ${JSON.stringify(registered.headers['set-cookie'])}`).toBeTruthy();

    const post = (headers: Record<string, string>) => app.inject({
      method: 'POST', url: '/api/auth/refresh', remoteAddress: ip,
      headers: { cookie: cookie!, ...headers },
    });
    // a WebView that sends no Origin at all (Telegram iOS does) is a same-origin call
    expect((await post({})).statusCode).toBe(200);
    // a browser that says the request came from another site is refused even with a good cookie
    expectRejected(await post({ origin: 'https://blublu.example', 'sec-fetch-site': 'cross-site' }), 403, 'forbidden');
    // `Origin: null` (sandboxed frame / data: URL) is not a deployment origin
    expectRejected(await post({ origin: 'null' }), 403, 'forbidden');
  });
});
