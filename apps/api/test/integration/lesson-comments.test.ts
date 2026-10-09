/**
 * Task 2 (2026-10-09) — comments during a lesson: rights, limits, moderation, realtime,
 * the read-only transcript of a finished lesson, and the RLS posture of the three new tables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { and, eq, inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { auditLog, classMembers, classes, lessonComments, lessonSessions, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { lessonCommentRateReset } from '../../src/services/lessonComments.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

/** poll a read until it satisfies `ok` (up to ~3 s), then return the last value seen */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 30; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last as T;
}

suite('lesson comments (task 2)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let port = 0;
  let teacherTok = '';
  let aTok = '';
  let bTok = '';
  let outsiderTok = '';
  let classId = '';
  let foreignClassId = '';
  let sessionId = '';
  let secondSessionId = '';
  let foreignSessionId = '';
  let studentAId = '';
  let studentBId = '';
  let outsiderId = '';
  let teacherId = '';

  const auth = (tok: string) => ({ authorization: tok });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });
  const send = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const put = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'PUT', url, headers: auth(tok), payload: body as object });
  const del = (tok: string, url: string) => app.inject({ method: 'DELETE', url, headers: auth(tok) });

  /** write one comment with the rate limiter out of the way (its own tests reset it back) */
  async function say(tok: string, who: string, text: string, into = sessionId) {
    lessonCommentRateReset(who);
    const r = await send(tok, `/api/lessons/${into}/comments`, { text });
    lessonCommentRateReset(who);
    return r;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({ role: 'teacher', name: 'LC Teacher', email: 'lct@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [sa] = await t.db.insert(users).values({ role: 'student', name: 'LC А', email: 'lca@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [sb] = await t.db.insert(users).values({ role: 'student', name: 'LC Б', email: 'lcb@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    const [out] = await t.db.insert(users).values({ role: 'student', name: 'Чужой', email: 'lcout@x.io', passwordHash: pw, tz: 'UTC' }).returning();
    studentAId = sa!.id; studentBId = sb!.id; teacherId = teacher!.id; outsiderId = out!.id;
    const [c1] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'LC класс' }).returning();
    const [c2] = await t.db.insert(classes).values({ teacherId: teacher!.id, name: 'LC чужой класс' }).returning();
    classId = c1!.id; foreignClassId = c2!.id;
    await t.db.insert(classMembers).values([
      { classId, userId: sa!.id }, { classId, userId: sb!.id }, { classId: foreignClassId, userId: out!.id },
    ]);
    const login = async (email: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
      // fail here with the server's own answer rather than 401-ing every later request
      expect(r.statusCode, `login ${email}: ${r.body.slice(0, 200)}`).toBe(200);
      return `Bearer ${r.json().accessToken as string}`;
    };
    teacherTok = await login('lct@x.io');
    aTok = await login('lca@x.io');
    bTok = await login('lcb@x.io');
    outsiderTok = await login('lcout@x.io');

    sessionId = (await send(teacherTok, '/api/lessons/start', { classId })).json().id as string;
    foreignSessionId = (await send(teacherTok, '/api/lessons/start', { classId: foreignClassId })).json().id as string;
    // a second LIVE session of the same class, inserted directly (`startLesson` is idempotent per
    // class by design): it is what proves a mute belongs to one lesson and not to the class
    const [second] = await t.db.insert(lessonSessions).values({
      classId, roomName: `lc-second-${Date.now()}`, createdBy: teacherId,
    }).returning({ id: lessonSessions.id });
    secondSessionId = second!.id;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('members write and read while the lesson runs; text stays plain', async () => {
    const first = await say(aTok, studentAId, 'а можно пример?');
    expect(first.statusCode).toBe(201);
    expect(first.json().authorName).toBe('LC А');
    const xss = await say(bTok, studentBId, '<script>alert(1)</script> & <img src=x onerror=bad()>');
    expect(xss.statusCode).toBe(201);
    const list = await get(teacherTok, `/api/lessons/${sessionId}/comments`);
    expect(list.statusCode).toBe(200);
    const texts = (list.json().comments as { text: string }[]).map((c) => c.text);
    expect(texts).toContain('а можно пример?');
    expect(texts).toContain('<script>alert(1)</script> & <img src=x onerror=bad()>');
  });

  it('a foreign class and a nonexistent session answer identically (404, same body)', async () => {
    const foreign = await get(aTok, `/api/lessons/${foreignSessionId}/comments`);
    const missing = await get(aTok, '/api/lessons/00000000-0000-4000-8000-000000000000/comments');
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
    // and an outsider cannot post into the real session either
    expect((await send(outsiderTok, `/api/lessons/${sessionId}/comments`, { text: 'я тут?' })).statusCode).toBe(404);
  });

  it('empty, whitespace and >500 are refused; 500 is accepted', async () => {
    lessonCommentRateReset(studentAId);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: '' })).statusCode).toBe(400);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: '  \t\n ' })).statusCode).toBe(400);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'x'.repeat(500) })).statusCode).toBe(201);
    lessonCommentRateReset(studentAId);
  });

  it('5 messages per 10 s, then 429 with retry-after', async () => {
    lessonCommentRateReset(studentBId);
    for (let i = 0; i < 5; i++) {
      expect((await send(bTok, `/api/lessons/${sessionId}/comments`, { text: `поток ${i}` })).statusCode).toBe(201);
    }
    const sixth = await send(bTok, `/api/lessons/${sessionId}/comments`, { text: 'шестой' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('commentRateLimited');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    lessonCommentRateReset(studentBId);
  });

  it('the teacher can mute a student for this lesson, and lift it again (audited)', async () => {
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/mutes`, { userId: studentAId })).statusCode).toBe(200);
    const blocked = await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'меня не слышно' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('commentMuted');
    // the mute belongs to THIS lesson: the second session of the same class is unaffected
    expect((await say(aTok, studentAId, 'в другом уроке можно', secondSessionId)).statusCode).toBe(201);
    // a moderation act is written down (same fire-and-forget audit, so polled)
    const rows = await until(
      () => t.db.select({ action: auditLog.action }).from(auditLog)
        .where(and(eq(auditLog.actorId, teacherId), eq(auditLog.action, 'lesson_comment_mute'))),
      (r) => r.length === 1,
    );
    expect(rows.length).toBe(1);
    expect((await del(teacherTok, `/api/lessons/${sessionId}/comments/mutes/${studentAId}`)).statusCode).toBe(200);
    expect((await say(aTok, studentAId, 'снова могу')).statusCode).toBe(201);
    // a student cannot mute anyone, and the teacher cannot mute herself
    expect((await send(bTok, `/api/lessons/${sessionId}/comments/mutes`, { userId: studentAId })).statusCode).toBe(403);
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/mutes`, { userId: teacherId })).statusCode).toBe(400);
  });

  it('mode off stops everyone; slow holds a student to one per 10 s but not the teacher', async () => {
    expect((await put(teacherTok, `/api/lessons/${sessionId}/comments/mode`, { mode: 'off' })).statusCode).toBe(200);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'можно?' })).json().error).toBe('commentsDisabled');
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments`, { text: 'и я тоже не могу' })).statusCode).toBe(403);
    // reading stays possible — the panel must explain why it is closed, not disappear
    const offRead = await get(aTok, `/api/lessons/${sessionId}/comments`);
    expect(offRead.json().mode, `${offRead.statusCode} ${offRead.body.slice(0, 200)}`).toBe('off');

    expect((await put(teacherTok, `/api/lessons/${sessionId}/comments/mode`, { mode: 'slow' })).statusCode).toBe(200);
    lessonCommentRateReset(studentAId);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'первый в медленном режиме' })).statusCode).toBe(201);
    const second = await send(aTok, `/api/lessons/${sessionId}/comments`, { text: 'второй сразу' });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe('commentRateLimited');
    const teacherTwice = [
      await send(teacherTok, `/api/lessons/${sessionId}/comments`, { text: 'учитель 1' }),
      await send(teacherTok, `/api/lessons/${sessionId}/comments`, { text: 'учитель 2' }),
    ];
    expect(teacherTwice.map((r) => r.statusCode)).toEqual([201, 201]);
    lessonCommentRateReset(studentAId);
    expect((await put(teacherTok, `/api/lessons/${sessionId}/comments/mode`, { mode: 'on' })).statusCode).toBe(200);
  });

  it('comments work in lecture mode, with the microphone off', async () => {
    const lecture = await send(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: true });
    expect(lecture.statusCode).toBe(200);
    expect((await say(bTok, studentBId, 'спасибо, что объясняете')).statusCode).toBe(201);
    expect((await send(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: false })).statusCode).toBe(200);
  });

  it('the teacher pins up to three; a fourth is refused; pinned come first', async () => {
    const ids: string[] = [];
    for (const text of ['пин 1', 'пин 2', 'пин 3', 'пин 4']) {
      const r = await say(teacherTok, teacherId, text);
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id as string);
    }
    for (const id of ids.slice(0, 3)) {
      expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/${id}/pin`, { on: true })).statusCode).toBe(200);
    }
    const fourth = await send(teacherTok, `/api/lessons/${sessionId}/comments/${ids[3]!}/pin`, { on: true });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toBe('commentPinLimit');
    const list = (await get(aTok, `/api/lessons/${sessionId}/comments`)).json().comments as { id: string; pinned: boolean }[];
    expect(list.slice(0, 3).every((c) => c.pinned)).toBe(true);
    // a student cannot pin, and unpinning frees a slot
    expect((await send(aTok, `/api/lessons/${sessionId}/comments/${ids[0]!}/pin`, { on: true })).statusCode).toBe(403);
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/${ids[0]!}/pin`, { on: false })).statusCode).toBe(200);
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/${ids[3]!}/pin`, { on: true })).statusCode).toBe(200);
  });

  it('«answered» is the teacher\'s flag on any comment', async () => {
    const mine = (await say(aTok, studentAId, 'ответьте пожалуйста')).json();
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments/${mine.id as string}/answered`, { on: true })).statusCode).toBe(200);
    const list = (await get(aTok, `/api/lessons/${sessionId}/comments`)).json().comments as
      { id: string; answered: boolean }[];
    expect(list.find((c) => c.id === mine.id)?.answered).toBe(true);
    expect((await send(aTok, `/api/lessons/${sessionId}/comments/${mine.id as string}/answered`, { on: false })).statusCode).toBe(403);
  });

  it('a student deletes only their own; the teacher deletes any — both audited', async () => {
    const byA = (await say(aTok, studentAId, 'удалю сам')).json();
    const byB = (await say(bTok, studentBId, 'чужое не тронешь')).json();
    expect((await del(aTok, `/api/lessons/${sessionId}/comments/${byB.id as string}`)).statusCode).toBe(404);
    expect((await del(aTok, `/api/lessons/${sessionId}/comments/${byA.id as string}`)).statusCode).toBe(200);
    const afterOwn = (await get(aTok, `/api/lessons/${sessionId}/comments`)).json().comments as { id: string }[];
    expect(afterOwn.some((c) => c.id === byA.id)).toBe(false);
    expect((await del(teacherTok, `/api/lessons/${sessionId}/comments/${byB.id as string}`)).statusCode).toBe(200);
    // `audit()` is fire-and-forget by design (a logging failure must never break a request), so
    // the trail is polled rather than assumed to be written inside the same tick
    const actions = await until(
      async () => (await t.db.select({ action: auditLog.action }).from(auditLog)
        .where(inArray(auditLog.action, ['lesson_comment_delete_own', 'lesson_comment_delete_teacher']))).map((r) => r.action),
      (a) => a.includes('lesson_comment_delete_own') && a.includes('lesson_comment_delete_teacher'),
    );
    expect(actions).toContain('lesson_comment_delete_own');
    expect(actions).toContain('lesson_comment_delete_teacher');
    // the row is soft-deleted: the text is gone from every read, the fact stays in the table
    const [row] = await t.db.select({ deletedAt: lessonComments.deletedAt }).from(lessonComments)
      .where(eq(lessonComments.id, byB.id as string));
    expect(row?.deletedAt).toBeTruthy();
  });

  it('a reconnecting client gets the last 50, and an ended lesson is a read-only transcript for the teacher', async () => {
    lessonCommentRateReset(studentAId);
    for (let i = 0; i < 55; i++) {
      const r = await send(aTok, `/api/lessons/${sessionId}/comments`, { text: `поток ${i}` });
      if (r.statusCode === 429) { lessonCommentRateReset(studentAId); i--; }
    }
    lessonCommentRateReset(studentAId);
    const list = (await get(bTok, `/api/lessons/${sessionId}/comments`)).json().comments as unknown[];
    expect(list.length).toBe(50);

    expect((await send(teacherTok, `/api/lessons/${sessionId}/end`)).statusCode).toBe(200);
    expect((await get(teacherTok, `/api/lessons/${sessionId}/comments`)).json().ended).toBe(true);
    expect((await send(teacherTok, `/api/lessons/${sessionId}/comments`, { text: 'после конца' })).statusCode).toBe(404);
    // a student loses the transcript with the lesson: "over" and "never yours" answer the same way
    const studentGet = await get(aTok, `/api/lessons/${sessionId}/comments`);
    const foreign = await get(aTok, `/api/lessons/${foreignSessionId}/comments`);
    expect(studentGet.statusCode).toBe(404);
    expect(studentGet.json()).toEqual(foreign.json());
  });

  it('realtime: the lesson socket carries comments, pins and mode changes', async () => {
    const tr = await send(teacherTok, '/api/ws/ticket', { sessionId: foreignSessionId });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/lesson/${foreignSessionId}?ticket=${encodeURIComponent(tr.json().ticket as string)}`);
    const msgs: { type: string; comment?: { text?: string }; mode?: string }[] = [];
    ws.addEventListener('message', (ev) => msgs.push(JSON.parse(String(ev.data)) as typeof msgs[number]));
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
    await new Promise((r) => setTimeout(r, 150));
    expect(msgs[0]?.type).toBe('started');

    lessonCommentRateReset(outsiderId);
    const posted = await send(outsiderTok, `/api/lessons/${foreignSessionId}/comments`, { text: 'живой комментарий' });
    expect(posted.statusCode).toBe(201);
    const pinned = await send(teacherTok, `/api/lessons/${foreignSessionId}/comments/${posted.json().id as string}/pin`, { on: true });
    expect(pinned.statusCode).toBe(200);
    await put(teacherTok, `/api/lessons/${foreignSessionId}/comments/mode`, { mode: 'slow' });
    await new Promise((r) => setTimeout(r, 250));
    expect(msgs.map((m) => m.type)).toEqual(expect.arrayContaining(['comment', 'commentPinned', 'commentsMode']));
    expect(msgs.find((m) => m.type === 'comment')?.comment?.text).toBe('живой комментарий');
    expect(msgs.find((m) => m.type === 'commentsMode')?.mode).toBe('slow');
    ws.close();
    lessonCommentRateReset(outsiderId);
  });

  it('the unread counter counts other people\'s comments and resets on read', async () => {
    // a second live session of the SAME class: teacher, А and Б are all in it
    await get(bTok, `/api/lessons/${secondSessionId}/comments`);
    expect((await say(aTok, studentAId, 'новое для Б', secondSessionId)).statusCode).toBe(201);
    const first = (await get(bTok, `/api/lessons/${secondSessionId}/comments`)).json() as { unread: number };
    expect(first.unread).toBe(1);
    const second = (await get(bTok, `/api/lessons/${secondSessionId}/comments`)).json() as { unread: number };
    expect(second.unread).toBe(0);
    // their own comment is never unread for them
    expect((await say(bTok, studentBId, 'своё не считается', secondSessionId)).statusCode).toBe(201);
    expect(((await get(bTok, `/api/lessons/${secondSessionId}/comments`)).json() as { unread: number }).unread).toBe(0);
  });

  it('RLS posture of the new tables: enabled, no policies, nothing to anon/authenticated', async () => {
    const tables = ['lesson_comments', 'lesson_comment_mutes', 'lesson_comment_reads'];
    const rows = await t.sql`
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policies p where p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('lesson_comments', 'lesson_comment_mutes', 'lesson_comment_reads')`;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true);
      expect(Number(r.policies), `${r.relname} policies`).toBe(0);
    }
    const roles = await t.sql`select rolname from pg_roles where rolname in ('anon','authenticated')`;
    const names = roles.map((r) => String(r.rolname));
    for (const table of tables) {
      for (const role of names.length ? names : []) {
        const priv = await t.sql`select has_table_privilege(${role}, ${table}, 'select,insert,update,delete') as ok`;
        expect(String(priv[0]?.ok), `${role} on ${table}`).toBe('false');
      }
    }
    // the owner path is what the API uses, and it must still see rows
    const counted = await t.sql`select count(*)::int as n from lesson_comments`;
    expect(Number(counted[0]?.n)).toBeGreaterThan(0);
  });
});
