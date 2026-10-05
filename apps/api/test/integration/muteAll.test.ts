/**
 * Task 3 — «mute everyone» state lives on the lesson session:
 * serialized in every session payload, only the teacher route can flip it,
 * and without a reachable media server the flag is NOT silently set (502).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classes, classMembers, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('mute-everyone session state (task 3)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let classId = '';

  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `mut3${Date.now()}@x.io`);
    const [c] = await t.db.insert(classes).values({ teacherId: teacher.id, name: 'Mute3' }).returning();
    classId = c!.id;
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: teacher.email, password: teacher.password } });
    teacherTok = l.json().accessToken as string;
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('start + active serialize muteAll:false', async () => {
    const st = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: auth(teacherTok), payload: { classId } });
    expect(st.statusCode).toBe(201);
    expect(st.json().muteAll).toBe(false);
    const act = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(teacherTok) });
    expect(act.json().session.muteAll).toBe(false);
  });

  it('mute all without a reachable media server → 502 and the flag stays false', async () => {
    const act0 = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(teacherTok) });
    const id = act0.json().session.id as string;
    const m = await app.inject({ method: 'POST', url: `/api/lessons/${id}/mute`, headers: auth(teacherTok), payload: { all: true, kind: 'audio', muted: true } });
    expect(m.statusCode).toBe(502); // LIVEKIT_INTERNAL_URL points at nothing in tests
    const act = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(teacherTok) });
    expect(act.json().session.muteAll).toBe(false);
  });

  it('a student cannot flip the mute state (teacher-only route)', async () => {
    const act = await app.inject({ method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(teacherTok) });
    const id = act.json().session.id as string;
    const [c] = await t.db.select().from(classes).where(eq(classes.id, classId)).limit(1);
    const [stu] = await t.db.insert(users).values({
      role: 'student', name: 'Pupil', email: `mut3s${Date.now()}@x.io`,
      passwordHash: await hashPassword('Secret1234'),
    }).returning();
    await t.db.insert(classMembers).values({ classId: c!.id, userId: stu!.id });
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: stu!.email, password: 'Secret1234' } });
    const m = await app.inject({ method: 'POST', url: `/api/lessons/${id}/mute`, headers: auth(l.json().accessToken as string), payload: { all: true, muted: true } });
    expect(m.statusCode).toBe(403);
  });
});
