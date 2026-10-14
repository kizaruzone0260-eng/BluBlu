/**
 * Часть 8 (2026-10-14), пункт про новые данные: присутствие и архив должны умирать так же честно,
 * как живут.
 *
 * Три вещи, которые здесь доказывается, и каждая — про конкретную дыру:
 *  1. удаление аккаунта стирает строки присутствия. Каскад по FK тут НЕ работает: `users` не
 *     удаляется физически (его держат NOT-NULL ссылки), а значит время прихода и ухода умершего
 *     аккаунта жило бы вечно, если бы `eraseAccount` не знал про эту таблицу;
 *  2. удаление класса уносит за собой уроки, доски, комментарии и присутствие (каскад в базе —
 *     это то, что обещает политика);
 *  3. ученик не получает чужие записи прихода и ухода: список присутствовавших сервер отдаёт
 *     только учителю, и в ответе ученика нет ни имени, ни почты другого человека.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import {
  classMembers, classes, lessonAttendance, lessonComments, lessonSessions, users, whiteboards,
} from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

suite('присутствие и архив: стирание и доступ (часть 8)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let aTok = '';
  let bTok = '';
  let classId = '';
  let sessionId = '';
  let aId = '';
  let bId = '';

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const patch = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: auth(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });

  const att = (userId: string) => t.db.select().from(lessonAttendance)
    .where(and(eq(lessonAttendance.sessionId, sessionId), eq(lessonAttendance.userId, userId)));

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'Er Teacher', email: 'er8@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [a] = await t.db.insert(users).values({
      role: 'student', name: 'Ann', lastName: 'Student', email: 'era@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [b] = await t.db.insert(users).values({
      role: 'student', name: 'Bob', lastName: 'Other', email: 'erb@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [cls] = await t.db.insert(classes).values({ name: '7ER', teacherId: teacher.id }).returning();
    await t.db.insert(classMembers).values([
      { classId: cls.id, userId: a.id }, { classId: cls.id, userId: b.id },
    ]);
    aId = a.id!; bId = b.id!; classId = cls.id;
    const login = async (email: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } }))
        .json().accessToken as string;
    teacherTok = await login('er8@x.io'); aTok = await login('era@x.io'); bTok = await login('erb@x.io');

    // настоящий поток: урок начат, оба зашли, доска сохранена, комментарий написан, урок завершён
    const started = await post(teacherTok, '/api/lessons/start', { classId });
    sessionId = started.json().id as string;
    expect(started.statusCode).toBe(201);
    expect((await post(teacherTok, `/api/lessons/${sessionId}/join`)).statusCode).toBe(200);
    expect((await post(aTok, `/api/lessons/${sessionId}/join`)).statusCode).toBe(200);
    expect((await post(bTok, `/api/lessons/${sessionId}/join`)).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`, headers: auth(teacherTok),
      payload: { pageNo: 1, title: 'Дроби', elements: [{ id: 'e1', version: 1, versionNonce: 1, type: 'draw' }] } as object,
    })).statusCode).toBe(200);
    expect((await post(aTok, `/api/lessons/${sessionId}/comments`, { text: 'а можно ещё пример?' })).statusCode).toBe(201);
    expect((await post(teacherTok, `/api/lessons/${sessionId}/end`)).statusCode).toBe(200);
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('приход записан на каждого, кто заходил, и закрыт завершением урока', async () => {
    expect((await att(aId))).toHaveLength(1);
    expect((await att(bId))).toHaveLength(1);
    const rows = await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, sessionId));
    expect(rows).toHaveLength(3); // учитель тоже заходил, и это тоже факт присутствия
    expect(rows.every((r) => r.leftAt !== null), 'завершение урока закрыло все приходы').toBe(true);
  });

  it('ученик не получает чужие записи прихода и ухода — ни именем, ни почтой', async () => {
    const off = await get(bTok, `/api/lessons/${sessionId}/archive`);
    expect(off.statusCode, 'без переключателя архив закрыт').toBe(404);
    expect((await patch(teacherTok, `/api/classes/${classId}`, { boardArchivePublic: true })).statusCode).toBe(200);

    const d = await get(bTok, `/api/lessons/${sessionId}/archive`);
    expect(d.statusCode).toBe(200);
    const body = d.json();
    expect(body).not.toHaveProperty('attendance');
    expect(body).not.toHaveProperty('comments');
    expect(body.canManage).toBe(false);
    // не «ключей нет», а в теле нет ни чужого имени, ни чужой почты, ни чужого id
    const raw = d.body;
    expect(raw.includes('Ann'), 'имя другого ученика не утекает').toBe(false);
    expect(raw.includes('era@x.io'), 'почта не утекает').toBe(false);
    expect(raw.includes(aId), 'id другого ученика не утекает').toBe(false);
    expect(raw.includes('Bob'), 'и своё имя тоже не нужно: список присутствовавших — учительский').toBe(false);

    const list = (await get(bTok, `/api/classes/${classId}/lessons/archive`)).json();
    expect(list.items[0]).not.toHaveProperty('participants');
    expect((await get(bTok, `/api/lessons/${sessionId}/board/authors`)).statusCode,
      'и карта авторов доски — учительская route (403 не-учителю)').toBe(403);
  });

  it('удаление аккаунта стирает строки присутствия этого человека, не трогая чужие', async () => {
    expect((await att(aId))).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: auth(aTok) });
    expect(del.statusCode, `удаление аккаунта ответило ${del.statusCode}`).toBe(200);
    expect((await att(aId)), 'присутствие удалённого аккаунта стёрто').toHaveLength(0);
    expect((await att(bId)), 'чужая строка осталась').toHaveLength(1);
    const left = await t.db.select().from(lessonComments).where(eq(lessonComments.sessionId, sessionId));
    expect(left, 'комментарий умершего тоже стёрт').toHaveLength(0);
    const u = await t.db.select().from(users).where(eq(users.id, aId));
    expect(u).toHaveLength(1); // аккаунт анонимизируется, а не стирается физически
    expect(u[0]!.email).not.toBe('era@x.io');
    // урок и его доски остаются: это содержимое класса, а не персональные данные ученика
    expect((await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, sessionId)))).toHaveLength(1);
    expect((await t.db.select().from(whiteboards).where(eq(whiteboards.sessionId, sessionId)))).toHaveLength(1);
  });

  it('удаление класса каскадом уносит уроки, доски, комментарии и присутствие', async () => {
    expect((await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, sessionId))).length)
      .toBeGreaterThan(0);
    await t.db.delete(classes).where(eq(classes.id, classId));
    expect((await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, sessionId)))).toHaveLength(0);
    expect((await t.db.select().from(whiteboards).where(eq(whiteboards.sessionId, sessionId)))).toHaveLength(0);
    expect((await t.db.select().from(lessonComments).where(eq(lessonComments.sessionId, sessionId)))).toHaveLength(0);
    expect((await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, sessionId)))).toHaveLength(0);
  });
});
