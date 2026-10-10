/**
 * Task 2Б (2026-10-10) — «поднять руку» and «дать слово»: rights, the queue's lifetime, and the
 * posture of the new table.
 *
 * What this file can prove without a media server, and what it deliberately does not pretend:
 *  - the queue (raise / re-raise / lower / lower-all), access through the session's class, the
 *    identical 404 for a foreign and a nonexistent lesson, teacher-only moderation (403), and the
 *    audit trail — all DB + HTTP, no LiveKit needed;
 *  - «give the floor» CANNOT be completed here: applying it means a LiveKit permission update, and
 *    this environment has no media server. That is exactly the case the route must get right, so it
 *    is asserted as such — 502, and the queue records no floor. The real permission change is
 *    covered by `test/unit/floor-permission.test.ts` (the arithmetic) and by
 *    `apps/e2e/tests/zz17-raise-hand.spec.ts`, which runs against a LiveKit server (CI has one
 *    since 6b6a1a3) and watches the student's microphone actually come on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { auditLog, classMembers, classes, lessonHands, lessonSessions, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
const NIL = '00000000-0000-4000-8000-000000000000';

suite('raise hand and the floor (task 2Б)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let aTok = '';
  let bTok = '';
  let outsiderTok = '';
  let classId = '';
  let foreignClassId = '';
  let sessionId = '';
  let foreignSessionId = '';
  let studentAId = '';
  let studentBId = '';
  let teacherId = '';

  const auth = (tok: string) => ({ authorization: tok });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const del = (tok: string, url: string) => app.inject({ method: 'DELETE', url, headers: auth(tok) });
  const queue = async (tok: string, into = sessionId) =>
    (await get(tok, `/api/lessons/${into}/hands`)).json() as {
      hands: { userId: string; name: string; grantedAt: string | null }[];
      lectureMode: boolean;
      mine: { userId: string; grantedAt: string | null } | null;
    };

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);

    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({ role: 'teacher', name: 'RH Teacher', email: 'rht@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [sa] = await t.db.insert(users).values({ role: 'student', name: 'RH А', email: 'rha@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [sb] = await t.db.insert(users).values({ role: 'student', name: 'RH Б', email: 'rhb@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [out] = await t.db.insert(users).values({ role: 'student', name: 'RH Чужой', email: 'rhou@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    teacherId = teacher!.id; studentAId = sa!.id; studentBId = sb!.id;
    const [c1] = await t.db.insert(classes).values({ teacherId, name: 'RH класс' }).returning();
    const [c2] = await t.db.insert(classes).values({ teacherId, name: 'RH чужой класс' }).returning();
    classId = c1!.id; foreignClassId = c2!.id;
    await t.db.insert(classMembers).values([
      { classId, userId: sa!.id }, { classId, userId: sb!.id }, { classId: foreignClassId, userId: out!.id },
    ]);
    const login = async (email: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
      expect(r.statusCode, `login ${email}: ${r.body.slice(0, 200)}`).toBe(200);
      return `Bearer ${r.json().accessToken as string}`;
    };
    teacherTok = await login('rht@x.io');
    aTok = await login('rha@x.io');
    bTok = await login('rhb@x.io');
    outsiderTok = await login('rhou@x.io');
    sessionId = (await post(teacherTok, '/api/lessons/start', { classId })).json().id as string;
    foreignSessionId = (await post(teacherTok, '/api/lessons/start', { classId: foreignClassId })).json().id as string;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('a raised hand appears in the queue once, and lowering it takes it away', async () => {
    const up = await post(aTok, `/api/lessons/${sessionId}/hand`);
    expect(up.statusCode, up.body.slice(0, 200)).toBe(200);
    expect(up.json().hand.name).toBe('RH А');
    // re-raising is an update of the same entry: no second row, no duplicate in the list
    const again = await post(aTok, `/api/lessons/${sessionId}/hand`);
    expect(again.statusCode).toBe(200);
    const view = await queue(teacherTok);
    expect(view.hands.filter((h) => h.userId === studentAId)).toHaveLength(1);
    expect(view.mine?.userId, 'the teacher is not the one whose hand is reported').toBeUndefined();

    const down = await del(aTok, `/api/lessons/${sessionId}/hand`);
    expect(down.statusCode).toBe(200);
    expect((await queue(teacherTok)).hands.find((h) => h.userId === studentAId), 'gone from the queue').toBeUndefined();
    // and lowering twice is a 404, not a silent success — the client learns the state is not what it thought
    expect((await del(aTok, `/api/lessons/${sessionId}/hand`)).statusCode).toBe(404);
  });

  it('a student sees their own hand, and so does a reload on another device', async () => {
    await post(aTok, `/api/lessons/${sessionId}/hand`);
    await post(bTok, `/api/lessons/${sessionId}/hand`);
    const asA = await queue(aTok);
    expect(asA.hands.map((h) => h.userId).sort()).toEqual([studentAId, studentBId].sort());
    expect(asA.mine?.userId, 'the student side knows its own hand without guessing').toBe(studentAId);
    const asB = await queue(bTok);
    expect(asB.mine?.userId).toBe(studentBId);
    expect(asB.hands.length, 'the queue is the same room-wide list').toBe(asA.hands.length);
    await del(aTok, `/api/lessons/${sessionId}/hand`);
    await del(bTok, `/api/lessons/${sessionId}/hand`);
  });

  it('a foreign class and a nonexistent lesson answer identically (404, same body)', async () => {
    const foreign = await get(outsiderTok, `/api/lessons/${sessionId}/hands`);
    const missing = await get(outsiderTok, `/api/lessons/${NIL}/hands`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(missing.body, 'no probing which of the two existed').toBe(foreign.body);
    const foreignPost = await post(outsiderTok, `/api/lessons/${sessionId}/hand`);
    expect(foreignPost.statusCode, 'an outsider cannot raise a hand in this lesson either').toBe(404);
  });

  it('the floor is teacher-only, and the teacher does not raise a hand at all', async () => {
    await post(aTok, `/api/lessons/${sessionId}/hand`);
    const grant = await post(aTok, `/api/lessons/${sessionId}/hands/${studentAId}/grant`);
    expect(grant.statusCode).toBe(403);
    const revoke = await post(bTok, `/api/lessons/${sessionId}/hands/${studentAId}/revoke`);
    expect(revoke.statusCode).toBe(403);
    const clear = await post(bTok, `/api/lessons/${sessionId}/hands/lower-all`);
    expect(clear.statusCode).toBe(403);
    const teacherHand = await post(teacherTok, `/api/lessons/${sessionId}/hand`);
    expect(teacherHand.statusCode, 'the teacher has the floor by definition').toBe(403);
    expect(teacherHand.json().error).toBe('teacherHasTheFloor');
    await del(aTok, `/api/lessons/${sessionId}/hand`);
  });

  /**
   * The one thing this environment CAN prove about giving the floor: with no media server the
   * route must refuse and must not record a floor. A queue that claims «you have the word» while
   * LiveKit never let the student publish would be worse than an error.
   */
  it('giving the floor without a reachable media server records nothing (502)', async () => {
    await post(aTok, `/api/lessons/${sessionId}/hand`);
    const grant = await post(teacherTok, `/api/lessons/${sessionId}/hands/${studentAId}/grant`);
    expect(grant.statusCode, `expected a media refusal, got: ${grant.body.slice(0, 160)}`).toBe(502);
    expect(grant.json().error).toBe('mediaServerUnavailable');
    const view = await queue(teacherTok);
    expect(view.hands.find((h) => h.userId === studentAId)?.grantedAt, 'no floor recorded').toBeNull();
    await del(aTok, `/api/lessons/${sessionId}/hand`);
  });

  it('granting to an id that never raised a hand is a 404, not a permission change', async () => {
    const grant = await post(teacherTok, `/api/lessons/${sessionId}/hands/${studentBId}/grant`);
    expect(grant.statusCode).toBe(404);
    const rows = await t.db.select({ userId: lessonHands.userId }).from(lessonHands)
      .where(eq(lessonHands.sessionId, sessionId));
    expect(rows.find((r) => r.userId === studentBId), 'nothing was queued for them').toBeUndefined();
  });

  it('taking the word back clears the fact first and says whether LiveKit could be told', async () => {
    await post(aTok, `/api/lessons/${sessionId}/hand`);
    const revoke = await post(teacherTok, `/api/lessons/${sessionId}/hands/${studentAId}/revoke`);
    expect(revoke.statusCode, revoke.body.slice(0, 160)).toBe(200);
    expect(revoke.json().mediaApplied, 'no media server here, so the honest answer is false').toBe(false);
    const view = await queue(teacherTok);
    expect(view.hands.find((h) => h.userId === studentAId)?.grantedAt).toBeNull();
    expect(view.hands.find((h) => h.userId === studentAId), 'the hand itself stays up').toBeTruthy();
    const audited = await untilAudit();
    expect(audited, 'the moderation action is in audit_log').toBe(true);
    await del(aTok, `/api/lessons/${sessionId}/hand`);
  });

  it('lower-all empties the queue and counts what it cleared', async () => {
    await post(aTok, `/api/lessons/${sessionId}/hand`);
    await post(bTok, `/api/lessons/${sessionId}/hand`);
    const cleared = await post(teacherTok, `/api/lessons/${sessionId}/hands/lower-all`);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().cleared).toBe(2);
    expect((await queue(teacherTok)).hands).toHaveLength(0);
    const nothing = await post(teacherTok, `/api/lessons/${sessionId}/hands/lower-all`);
    expect(nothing.json().cleared, 'an empty queue is a no-op, not an error').toBe(0);
  });

  it('a finished lesson has no hands: the queue is live-lesson state', async () => {
    const [ended] = await t.db.insert(lessonSessions).values({
      classId, roomName: `rh-ended-${Date.now()}`, createdBy: teacherId,
    }).returning({ id: lessonSessions.id });
    const sid = ended!.id;
    await t.db.insert(lessonHands).values({ sessionId: sid, userId: studentAId });
    // endLesson clears it; a hand cannot outlive the lesson it was raised in
    const end = await post(teacherTok, `/api/lessons/${sid}/end`);
    expect(end.statusCode, end.body.slice(0, 160)).toBe(200);
    const left = await t.db.select({ id: lessonHands.id }).from(lessonHands).where(eq(lessonHands.sessionId, sid));
    expect(left, 'no rows survive the lesson').toHaveLength(0);
    const read = await get(aTok, `/api/lessons/${sid}/hands`);
    expect(read.statusCode, 'and nobody can read a finished queue').toBe(404);
    const raise = await post(aTok, `/api/lessons/${sid}/hand`);
    expect(raise.statusCode, 'nor start a new one').toBe(404);
  });

  it('deleting an account removes their hands (the queue is personal data too)', async () => {
    await post(bTok, `/api/lessons/${sessionId}/hand`);
    const before = await t.db.select({ id: lessonHands.id }).from(lessonHands)
      .where(and(eq(lessonHands.sessionId, sessionId), eq(lessonHands.userId, studentBId)));
    expect(before.length).toBe(1);
    const gone = await del(bTok, '/api/me');
    expect(gone.statusCode).toBe(200);
    const after = await t.db.select({ id: lessonHands.id }).from(lessonHands)
      .where(inArray(lessonHands.userId, [studentBId]));
    expect(after, 'eraseAccount must not leave «this person wanted to speak» behind').toHaveLength(0);
  });

  it('the new table is RLS-on, policy-less, and holds nothing for anon/authenticated', async () => {
    const rows = await t.sql`
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policies p where p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'lesson_hands'`;
    expect(rows.length, 'the table exists').toBe(1);
    expect(Boolean((rows[0] as { relrowsecurity: boolean }).relrowsecurity), 'RLS enabled').toBe(true);
    expect(Number((rows[0] as { policies: number }).policies), 'no policies — the app is the owner').toBe(0);
    const roles = await t.sql`select rolname from pg_roles where rolname in ('anon','authenticated')`;
    for (const raw of roles) {
      const r = { rolname: String((raw as { rolname: string }).rolname) };
      const priv = await t.sql`select has_table_privilege(${r.rolname}, 'lesson_hands', 'select,insert,update,delete') as ok`;
      expect(String((priv[0] as { ok: boolean } | undefined)?.ok), `${r.rolname} on lesson_hands`).toBe('false');
    }
  });

  async function untilAudit(): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      const rows = await t.db.select({ action: auditLog.action }).from(auditLog)
        .where(and(eq(auditLog.actorId, teacherId), eq(auditLog.action, 'lesson_hand_revoke')));
      if (rows.length) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
});
