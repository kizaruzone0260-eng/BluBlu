import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util';
import { buildApp } from '../../src/app';
import { env } from '../../src/env';
import type { FastifyInstance } from 'fastify';

/**
 * Full stage-1 API behaviour against real Postgres.
 * Requires DATABASE_URL_TEST (docker compose -f test compose), else skipped.
 */
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('stage 1: accounts, classes, codes, members', () => {
  let t: TestDB;

  beforeAll(async () => { t = await preparedDb(TEST_DATABASE_URL); });
  afterAll(async () => { await t?.sql.end(); });

  async function freshApp(): Promise<FastifyInstance> {
    return buildApp(t.db);
  }

  it('teacher creates class + code; student registers by code once; reuse fails', async () => {
    const app = await freshApp();
    const teacher = await makeTeacher(t.sql, `t${Date.now()}@x.io`);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: teacher.email, password: teacher.password },
    });
    expect(login.statusCode).toBe(200);
    const at = login.json().accessToken as string;
    const auth = { authorization: `Bearer ${at}` };

    const cls = await app.inject({ method: 'POST', url: '/api/classes', headers: auth, payload: { name: 'Math 7A' } });
    expect(cls.statusCode).toBe(201);
    const classId = cls.json().id as string;

    const inv = await app.inject({ method: 'POST', url: `/api/classes/${classId}/invites`, headers: auth, payload: {} });
    expect(inv.statusCode).toBe(201);
    const code = inv.json().code as string;

    const reg = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Alice', lastName: 'Test', email: 'alice@x.io', password: 'Secret1234', code },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().user.role).toBe('student');
    expect(reg.headers['set-cookie']).toContain('klass_rt');

    // same code again → identical generic error (invalidCode), never a different message
    const reg2 = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Bob', lastName: 'Test', email: 'bob@x.io', password: 'Secret1234', code },
    });
    expect(reg2.statusCode).toBe(400);
    expect(reg2.json().error).toBe('invalidCode');

    // wrong code → same error string
    const reg3 = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Eve', lastName: 'Test', email: 'eve@x.io', password: 'Secret1234', code: 'ZZZZZZZZ' },
    });
    expect(reg3.statusCode).toBe(400);
    expect(reg3.json().error).toBe('invalidCode');

    // student sees the class
    const studentList = await app.inject({
      method: 'GET', url: '/api/classes',
      headers: { authorization: `Bearer ${reg.json().accessToken}` },
    });
    expect(studentList.json().some((c: { id: string }) => c.id === classId)).toBe(true);

    // teacher sees the member
    const members = await app.inject({ method: 'GET', url: `/api/classes/${classId}/members`, headers: auth });
    expect(members.json()).toHaveLength(1);

    await app.close();
  });

  it('access rules (§7): outsider gets 404, student gets 403 on teacher routes, anon 401', async () => {
    const app = await freshApp();
    const teacher = await makeTeacher(t.sql, `t2${Date.now()}@x.io`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const auth = { authorization: `Bearer ${login.json().accessToken}` };
    const cls = await app.inject({ method: 'POST', url: '/api/classes', headers: auth, payload: { name: 'Phys' } });
    const classId = cls.json().id as string;

    // second teacher (different account) → 404, not 403
    const teacher2 = await makeTeacher(t.sql, `t3${Date.now()}@x.io`);
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher2.email, password: teacher2.password } });
    const foreign = await app.inject({
      method: 'GET', url: `/api/classes/${classId}/members`,
      headers: { authorization: `Bearer ${login2.json().accessToken}` },
    });
    expect(foreign.statusCode).toBe(404);

    // student tries to create a class → 403
    const reg = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'S1', lastName: 'Test', email: `s1${Date.now()}@x.io`, password: 'Secret1234', code: 'A2CDEF3H' },
    });
    // (code unknown → invalidCode; use join-by-code path below with a real code)
    expect(reg.statusCode).toBe(400);
    const inv = await app.inject({ method: 'POST', url: `/api/classes/${classId}/invites`, headers: auth, payload: {} });
    const reg2 = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'S2', lastName: 'Test', email: `s2${Date.now()}@x.io`, password: 'Secret1234', code: inv.json().code },
    });
    expect(reg2.statusCode).toBe(200);
    const sa = { authorization: `Bearer ${reg2.json().accessToken}` };
    const studCreate = await app.inject({ method: 'POST', url: '/api/classes', headers: sa, payload: { name: 'No' } });
    expect(studCreate.statusCode).toBe(403);

    // anonymous → 401
    const anon = await app.inject({ method: 'GET', url: `/api/classes/${classId}/members` });
    expect(anon.statusCode).toBe(401);

    await app.close();
  });

  it('code entry throttle: >5 attempts in a minute → 429, uniform message', async () => {
    const app = await freshApp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { firstName: 'Test Pupil', lastName: 'Test', email: `x${i}${Date.now()}@x.io`, password: 'Secret1234', code: 'ABCDEFGH' },
      });
      codes.push(r.statusCode);
    }
    const limited = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Test Pupil', lastName: 'Test', email: 'y@x.io', password: 'Secret1234', code: 'ABCDEFGH' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('codeRateLimited');
    expect(codes.every((c) => c === 400)).toBe(true);
    await app.close();
  });

  it('refresh rotation: old token reuse kills the family', async () => {
    const app = await freshApp();
    const prevGrace = env.REFRESH_REUSE_GRACE_MS;
    env.REFRESH_REUSE_GRACE_MS = 0; // strict §4 behaviour (no lost-response grace)
    const teacher = await makeTeacher(t.sql, `t4${Date.now()}@x.io`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const cookie1 = (login.headers['set-cookie'] as string).split(';')[0]!;

    const refresh1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } });
    expect(refresh1.statusCode).toBe(200);
    const cookie2 = (refresh1.headers['set-cookie'] as string).split(';')[0]!;

    // reuse of the OLD cookie → 401 and family revoked → new cookie is dead too
    const reuse = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } });
    expect(reuse.statusCode).toBe(401);
    const after = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie2 } });
    expect(after.statusCode).toBe(401);
    env.REFRESH_REUSE_GRACE_MS = prevGrace;
    await app.close();
  });

  it('lost rotation response (instant reload): stale replay inside the grace heals the session', async () => {
    const app = await freshApp();
    const prevGrace = env.REFRESH_REUSE_GRACE_MS;
    env.REFRESH_REUSE_GRACE_MS = 5000;
    const teacher = await makeTeacher(t.sql, `t5${Date.now()}@x.io`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    const cookie1 = (login.headers['set-cookie'] as string).split(';')[0]!;
    // rotation happens but the client "never sees" the response (aborted reload)
    await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } });
    // client boots again and replays the stale cookie → grace: fresh session issued
    const heal = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } });
    expect(heal.statusCode).toBe(200);
    const cookie3 = (heal.headers['set-cookie'] as string).split(';')[0]!;
    // once the grace window is over (simulated by tightening it), a late replay
    // of the stale token is treated as theft: family killed, good cookie dies too
    env.REFRESH_REUSE_GRACE_MS = 0;
    const late = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } });
    expect(late.statusCode).toBe(401);
    const dead = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie3 } });
    expect(dead.statusCode).toBe(401);
    env.REFRESH_REUSE_GRACE_MS = prevGrace;
    await app.close();
  });
});
