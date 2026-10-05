/**
 * Task 2 — the name screen flag (users.profile_completed_at):
 * /api/me answers with it, registration sets it, the profile PATCH flips it
 * exactly once (both names non-empty) and never takes it back. Access rights
 * of every other endpoint are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, inviteCodes } from '../../src/db/schema.js';
import { hashInviteCode } from '../../src/lib/invite.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('profile completed flag (name screen, task 2)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let classId = '';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `gateT${Date.now()}@x.io`);
    teacherId = teacher.id;
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Gate' }).returning();
    classId = c!.id;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  async function newInvite(): Promise<string> {
    const code = Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    await t.db.insert(inviteCodes).values({
      classId, codeHash: hashInviteCode(code, process.env.JWT_SECRET!), createdBy: teacherId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return code;
  }
  const me = (token: string) => app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  const patch = (token: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { authorization: `Bearer ${token}` }, payload: body });

  it('a teacher account without a family name is NOT complete (seed-teacher rule)', async () => {
    const teacher = await makeTeacher(t.sql, `gateT2${Date.now()}@x.io`); // last_name default ''
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const m = await me(l.json().accessToken);
    expect(m.json().profileCompleted).toBe(false);
  });

  it('finishing the name pair completes the profile exactly once and irreversibly', async () => {
    const teacher = await makeTeacher(t.sql, `gateT3${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken;
    const r1 = await patch(tk, { name: 'Иван', lastName: 'Петров', locale: 'ru', tz: 'Asia/Tashkent' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().profileCompleted).toBe(true);
    expect((await me(tk)).json().profileCompleted).toBe(true);
    // a later PATCH that empties the family name must NOT re-open the gate
    await patch(tk, { name: 'Иван', lastName: '', locale: 'ru', tz: 'Asia/Tashkent' });
    expect((await me(tk)).json().profileCompleted).toBe(true);
  });

  it('a PATCH with only one name filled keeps the profile incomplete', async () => {
    const teacher = await makeTeacher(t.sql, `gateT4${Date.now()}@x.io`);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const tk = l.json().accessToken;
    await patch(tk, { name: 'ТолькоИмя', locale: 'ru', tz: 'Asia/Tashkent' });
    expect((await me(tk)).json().profileCompleted).toBe(false);
  });

  it('two-step registration collects both names → the student is complete at once', async () => {
    const code = await newInvite();
    const r = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Гретхен', lastName: 'Мюллер', email: `gateS${Date.now()}@x.io`, password: 'Secret1234', code },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.profileCompleted).toBe(true);
    expect((await me(r.json().accessToken)).json().profileCompleted).toBe(true);
  });
});
