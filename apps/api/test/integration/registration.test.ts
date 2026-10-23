/**
 * Item 9 — two-step student registration: check-code never consumes, one
 * generic error for every bad code state, code spent atomically at step 2,
 * concurrent step-2s cannot create two accounts, names stored separately.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes, users } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('two-step registration (item 9)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let classId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `reg9t${Date.now()}@x.io`);
    teacherId = teacher.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Reg9' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const genCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  async function newInvite(ttlMs = 3_600_000): Promise<string> {
    const code = genCode();
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return code;
  }
  const check = (code: string) => app.inject({ method: 'POST', url: '/api/auth/check-code', payload: { code } });
  const reg = (firstName: string, lastName: string, email: string, code: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName, lastName, email, password: 'Secret1234', code } });

  it('check-code validates without consuming (twice), step 2 then succeeds', async () => {
    const code = await newInvite();
    const a = await check(code);
    expect(a.statusCode).toBe(200);
    const b = await check(code); // still valid — nothing burned
    expect(b.statusCode).toBe(200);
    const r = await reg('Ханс', 'Мюller', `r9a${Date.now()}@x.io`, code);
    expect(r.statusCode).toBe(200);
    const u = r.json().user;
    expect(u.name).toBe('Ханс');
    expect(u.lastName).toBe('Мюller');
  });

  it('abandoned midway costs the class nothing: code still usable by the next student', async () => {
    const code = await newInvite();
    expect((await check(code)).statusCode).toBe(200); // «ушёл посреди регистрации» — no register call
    const r = await reg('Второй', 'Ученик', `r9b${Date.now()}@x.io`, code);
    expect(r.statusCode).toBe(200);
  });

  it('wrong, used and expired codes give the SAME response (no enumeration)', async () => {
    const code = await newInvite();
    await reg('Первый', 'Раз', `r9c${Date.now()}@x.io`, code); // consume it
    const wrong = await check('Q9Q9Q9Q9');
    const used = await check(code);
    const expiredCode = await newInvite(-1000);
    const expired = await check(expiredCode);
    const shapes: string[] = [];
    for (const res of [wrong, used, expired]) {
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; reqId: string };
      expect(body.error).toBe('invalidCode');
      /*
       * Task B (2026-10-23): a refusal now also carries the short id the pupil can dictate, and
       * that id is different for every request on purpose. So the no-enumeration rule is asserted
       * on the whole body MINUS the id — which is exactly what a caller can tell apart.
       */
      expect(REQUEST_ID_PATTERN.test(body.reqId), JSON.stringify(body)).toBe(true);
      shapes.push(JSON.stringify({ ...body, reqId: '' }));
    }
    expect(new Set(shapes).size, 'the three code states differ beyond the request id').toBe(1);
  });

  it('check-code cannot be used to probe emails — endpoint ignores email entirely', async () => {
    const code = await newInvite();
    const r = await app.inject({ method: 'POST', url: '/api/auth/check-code', payload: { code, email: 'someone@x.io' } });
    expect(r.statusCode).toBe(200); // email not part of step 1 validation
  });

  it('race: two concurrent step-2 registrations with one code → exactly one account', async () => {
    const code = await newInvite();
    const both = await Promise.all([
      reg('Гонка', 'Один', `r9d${Date.now()}@x.io`, code),
      reg('Гонка', 'Два', `r9e${Date.now()}@x.io`, code),
    ]);
    const okCount = both.filter((r) => r.statusCode === 200).length;
    expect(okCount).toBe(1);
    const members = await t.db.select().from(users).where(eq(users.name, 'Гонка'));
    expect(members.length).toBe(1);
  });

  it('step 2 without firstName/lastName → invalidInput (both parts required)', async () => {
    const code = await newInvite();
    const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { firstName: 'Без', email: `r9f${Date.now()}@x.io`, password: 'Secret1234', code } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalidInput');
  });

  it('pre-existing accounts keep working: lastName defaults to empty and is optional on profile update', async () => {
    // makeTeacher inserts without last_name → default ''
    const teacher = await makeTeacher(t.sql, `r9old${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tok = `Bearer ${l.json().accessToken}`;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: tok } });
    expect(me.json().lastName).toBe('');
    const p = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { authorization: tok }, payload: { name: 'Tch', lastName: '', locale: 'en', tz: 'Asia/Tashkent' } });
    expect(p.statusCode).toBe(200);
    expect(p.json().lastName).toBe('');
  });
});
