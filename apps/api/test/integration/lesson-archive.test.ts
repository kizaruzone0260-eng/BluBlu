/**
 * Часть 4 (2026-10-14): архив завершённых уроков.
 *
 * Главное, что здесь доказывается, — доступ. Архив отдаёт то, чего ученик не видел бы иначе:
 * расшифровку урока (комментарии) и присутствие людей. Поэтому «выключенный архив» и «чужой
 * класс» обязаны быть НЕОТЛИЧИМЫ (одинаковый 404 с одинаковым телом), а включённый архив для
 * ученика — доски и больше ничего.
 *
 * Второе, что проверяется: удаление записи действительно уносит за собой вложения (каскад в БД,
 * а не «плюс одна осиротевшая строка»), и срок хранения по умолчанию НЕ удаляет ничего.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import {
  classMembers, classes, events, lessonAttendance, lessonComments, lessonSessions, users, whiteboards,
} from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { sweepArchive } from '../../src/services/lessonArchive.js';
import { MAX_SCENE_BYTES } from '../../src/services/board.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
const MADE_UP = '00000000-0000-4000-8000-000000000000';

suite('lesson archive (part 4)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let outsiderTok = '';
  let studentTok = '';
  let classId = '';
  let foreignClassId = '';
  let studentId = '';
  const sessionIds: string[] = [];

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const patch = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: auth(tok), payload: body as object });
  const put = (tok: string, url: string, body: unknown) =>
    app.inject({ method: 'PUT', url, headers: auth(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });
  const del = (tok: string, url: string) => app.inject({ method: 'DELETE', url, headers: auth(tok) });

  /** Новый завершённый урок с одной доской и одним комментарием — то, что архив и показывает. */
  async function makeEndedLesson(title: string, opts: { comment?: string } = {}) {
    const started = await post(teacherTok, '/api/lessons/start', { classId });
    const id = started.json().id as string;
    expect(started.statusCode).toBe(201);
    // учитель заходит в комнату тем же запросом, что и клиент страницы урока, — иначе «кто был
    // на уроке» показывал бы половину участников
    await post(teacherTok, `/api/lessons/${id}/join`);
    await post(studentTok, `/api/lessons/${id}/join`);
    const saved = await put(teacherTok, `/api/lessons/${id}/board/page`, {
      pageNo: 1, title, elements: [{ id: 'e1', version: 1, versionNonce: 1, type: 'draw' }],
    });
    expect(saved.statusCode, 'страница сохранена').toBe(200);
    if (opts.comment) {
      const c = await post(studentTok, `/api/lessons/${id}/comments`, { text: opts.comment });
      expect(c.statusCode, 'комментарий пишется во время урока').toBe(201);
    }
    const ended = await post(teacherTok, `/api/lessons/${id}/end`);
    expect(ended.statusCode).toBe(200);
    sessionIds.push(id);
    return id;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'AR Teacher', email: 'ar@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [outsider] = await t.db.insert(users).values({
      role: 'teacher', name: 'AR Other', email: 'aro@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [student] = await t.db.insert(users).values({
      role: 'student', name: 'AR Student', email: 'ars@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [cls] = await t.db.insert(classes).values({ name: '7AR', teacherId: teacher.id }).returning();
    const [foreign] = await t.db.insert(classes).values({ name: '9AR', teacherId: outsider.id }).returning();
    await t.db.insert(classMembers).values([{ classId: cls.id, userId: student.id }]);
    const login = async (email: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } }))
        .json().accessToken as string;
    teacherTok = await login('ar@x.io');
    outsiderTok = await login('aro@x.io');
    studentTok = await login('ars@x.io');
    classId = cls.id; foreignClassId = foreign.id; studentId = student.id;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('the teacher sees ended lessons with duration and counts', async () => {
    const first = await makeEndedLesson('Доска про дроби', { comment: 'а можно ещё пример?' });
    const r = await get(teacherTok, `/api/classes/${classId}/lessons/archive`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.canManage).toBe(true);
    const row = body.items.find((x: { id: string }) => x.id === first);
    expect(row, 'завершённый урок попал в архив').toBeTruthy();
    expect(row.boards).toBe(1);
    expect(row.comments).toBe(1);
    expect(row.participants, 'учитель и ученик были на уроке').toBeGreaterThanOrEqual(2);
    expect(row.durationMin).toBeGreaterThanOrEqual(0);
    expect(new Date(row.startedAt).toString()).not.toBe('Invalid Date');

    const detail = await get(teacherTok, `/api/lessons/${first}/archive`);
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.boards[0].title).toBe('Доска про дроби');
    expect(d.boards[0].elements.map((e: { id: string }) => e.id)).toEqual(['e1']);
    expect(d.boards[0].bytes, 'размер сцены отдаётся: по нему клиент решает, что грузить').toBeGreaterThan(0);
    expect(d.comments[0].text).toBe('а можно ещё пример?');
    expect(d.attendance.map((a: { role: string }) => a.role)).toEqual(expect.arrayContaining(['student']));
  });

  it('an unfinished lesson is not in the archive, and its detail answers 404', async () => {
    const started = await post(teacherTok, '/api/lessons/start', { classId });
    const live = started.json().id as string;
    const list = (await get(teacherTok, `/api/classes/${classId}/lessons/archive`)).json();
    expect(list.items.some((x: { id: string }) => x.id === live), 'идущий урок — не история').toBe(false);
    expect((await get(teacherTok, `/api/lessons/${live}/archive`)).statusCode).toBe(404);
    await post(teacherTok, `/api/lessons/${live}/end`);
  });

  it('a student sees nothing while the class switch is off — and the answer matches a foreign class', async () => {
    const closed = await get(studentTok, `/api/classes/${classId}/lessons/archive`);
    const foreign = await get(studentTok, `/api/classes/${foreignClassId}/lessons/archive`);
    const madeUp = await get(studentTok, `/api/classes/${MADE_UP}/lessons/archive`);
    expect([closed.statusCode, foreign.statusCode, madeUp.statusCode]).toEqual([404, 404, 404]);
    expect(closed.body).toBe(foreign.body);
    expect(closed.body).toBe(madeUp.body);
    const target = sessionIds[0]!;
    expect((await get(studentTok, `/api/lessons/${target}/archive`)).statusCode).toBe(404);
    expect((await get(studentTok, `/api/lessons/${target}/board`)).statusCode,
      'и обычные доски завершённого урока закрыты тем же переключателем').toBe(404);
  });

  it('with the switch on a student gets boards only — no comments, no participants', async () => {
    const on = await patch(teacherTok, `/api/classes/${classId}`, { boardArchivePublic: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().boardArchivePublic).toBe(true);

    const target = sessionIds[0]!;
    const list = (await get(studentTok, `/api/classes/${classId}/lessons/archive`)).json();
    expect(list.canManage, 'ученик не управляет архивом').toBe(false);
    expect(list.items[0]).not.toHaveProperty('comments');
    expect(list.items[0]).not.toHaveProperty('participants');

    const d = (await get(studentTok, `/api/lessons/${target}/archive`)).json();
    expect(d.boards.length).toBeGreaterThan(0);
    expect(d).not.toHaveProperty('comments');
    expect(d).not.toHaveProperty('attendance');
    expect(d.canManage).toBe(false);
    expect((await get(studentTok, `/api/lessons/${target}/board`)).statusCode,
      'доски завершённого урока ученик теперь читает').toBe(200);
    expect((await del(studentTok, `/api/lessons/${target}/archive`)).statusCode,
      'но не удаляет').toBe(403);
  });

  it('a foreign teacher cannot read or delete, and the answers do not leak which id exists', async () => {
    const target = sessionIds[0]!;
    const foreign = await get(outsiderTok, `/api/lessons/${target}/archive`);
    const madeUp = await get(outsiderTok, `/api/lessons/${MADE_UP}/archive`);
    expect([foreign.statusCode, madeUp.statusCode]).toEqual([404, 404]);
    expect(foreign.body).toBe(madeUp.body);
    const delForeign = await del(outsiderTok, `/api/lessons/${target}/archive`);
    const delMadeUp = await del(outsiderTok, `/api/lessons/${MADE_UP}/archive`);
    expect([delForeign.statusCode, delMadeUp.statusCode]).toEqual([404, 404]);
    expect(delForeign.body).toBe(delMadeUp.body);
    expect((await get(teacherTok, `/api/classes/${classId}/lessons/archive`)).json().items.length,
      'ничего не удалилось').toBeGreaterThan(0);
  });

  it('the list pages by time and the cursor does not repeat or skip', async () => {
    await makeEndedLesson('Вторая');
    await makeEndedLesson('Третья');
    const p1 = (await get(teacherTok, `/api/classes/${classId}/lessons/archive?limit=2`)).json();
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor, 'курсор есть, пока впереди ещё страницы').toBeTruthy();
    const p2 = (await get(teacherTok,
      `/api/classes/${classId}/lessons/archive?limit=2&before=${encodeURIComponent(p1.nextCursor)}`)).json();
    const ids1 = p1.items.map((x: { id: string }) => x.id);
    const ids2 = p2.items.map((x: { id: string }) => x.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);
    const all = (await get(teacherTok, `/api/classes/${classId}/lessons/archive?limit=50`)).json();
    expect(all.items.length).toBe(ids1.length + ids2.length);
    expect(all.nextCursor).toBeNull();
    // порядок: от новых к старым
    const times = all.items.map((x: { startedAt: string }) => +new Date(x.startedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // мусорный курсор трактуется как «первая страница», а не как 500
    const junk = await get(teacherTok, `/api/classes/${classId}/lessons/archive?before=не-дата`);
    expect(junk.statusCode).toBe(200);
    expect(junk.json().items.length).toBe(all.items.length);
  });

  it('deleting an archive entry takes its boards, comments and attendance with it', async () => {
    const target = await makeEndedLesson('На удаление', { comment: 'спросить потом' });
    const r = await del(teacherTok, `/api/lessons/${target}/archive`);
    expect(r.statusCode).toBe(200);
    expect((await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, target)))).toHaveLength(0);
    expect((await t.db.select().from(whiteboards).where(eq(whiteboards.sessionId, target)))).toHaveLength(0);
    expect((await t.db.select().from(lessonComments).where(eq(lessonComments.sessionId, target)))).toHaveLength(0);
    expect((await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, target)))).toHaveLength(0);
    // второй раз — уже «нет такой записи», и ответ тот же, что у выдуманного id
    const again = await del(teacherTok, `/api/lessons/${target}/archive`);
    expect(again.statusCode).toBe(404);
    expect(again.body).toBe((await del(teacherTok, `/api/lessons/${MADE_UP}/archive`)).body);
  });

  it('retention is off by default and only ever deletes ENDED lessons', async () => {
    const recent = await makeEndedLesson('Свежий');
    const [s] = await t.db.insert(lessonSessions).values({ classId, roomName: 'room-old', createdBy: (await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'ar@x.io')).limit(1))[0]!.id }).returning();
    const old = s!.id;
    await t.db.update(lessonSessions).set({
      startedAt: new Date(Date.now() - 400 * 86_400_000),
      endedAt: new Date(Date.now() - 400 * 86_400_000),
    }).where(eq(lessonSessions.id, old));
    // идущий урок старше срока — всё равно не трогается: он не архив
    const [live] = await t.db.insert(lessonSessions).values({
      classId, roomName: 'room-live-ancient',
      createdBy: (await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'ar@x.io')).limit(1))[0]!.id,
      startedAt: new Date(Date.now() - 400 * 86_400_000),
    }).returning();

    expect(await sweepArchive(t.db, 0), '0 = не удалять никогда').toBe(0);
    expect(await sweepArchive(t.db, 30), '30 дней: ушёл только старый завершённый').toBe(1);
    const left = await t.db.select({ id: lessonSessions.id }).from(lessonSessions)
      .where(and(isNull(lessonSessions.endedAt)));
    expect(left.map((r) => r.id)).toEqual([live!.id]);
    expect((await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, old)))).toHaveLength(0);
    expect((await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, recent))).length).toBe(1);
    await t.db.delete(lessonSessions).where(eq(lessonSessions.id, live!.id));
  });

  it('attendance keeps one row per person: the first join survives a reconnect, the end closes it', async () => {
    const started = await post(teacherTok, '/api/lessons/start', { classId });
    const id = started.json().id as string;
    await post(studentTok, `/api/lessons/${id}/join`);
    await post(studentTok, `/api/lessons/${id}/join`);
    await post(studentTok, `/api/lessons/${id}/join`);
    const rows = await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, id));
    const mine = rows.filter((r) => r.userId === studentId);
    expect(mine.length, 'переподключения не множат строки').toBe(1);
    expect(mine[0]!.leftAt).toBeNull();
    await post(teacherTok, `/api/lessons/${id}/end`);
    const closed = await t.db.select().from(lessonAttendance).where(eq(lessonAttendance.sessionId, id));
    expect(closed.every((r) => r.leftAt !== null), 'завершение урока закрывает незакрытые приходы').toBe(true);
    sessionIds.push(id);
  });

  it('a calendar link by event id opens exactly that lesson, and a junk id is a 400', async () => {
    const [teacher] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'ar@x.io')).limit(1);
    // событие по-настоящему: `lesson_sessions.event_id` ссылается на `events`, и выдуманный id
    // база не приняла бы
    const [evt] = await t.db.insert(events).values({
      classId, kind: 'lesson', title: 'Дробы',
      startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000), tz: 'UTC',
    }).returning();
    const [s] = await t.db.insert(lessonSessions).values({
      classId, roomName: 'room-evt', createdBy: teacher!.id, eventId: evt!.id,
      startedAt: new Date(Date.now() - 3_600_000), endedAt: new Date(Date.now() - 1_800_000),
    }).returning();
    const byEvent = (await get(teacherTok, `/api/classes/${classId}/lessons/archive?event=${evt!.id}`)).json();
    expect(byEvent.items.map((x: { id: string }) => x.id)).toEqual([s!.id]);
    // чужого события в этом классе нет ⇒ пустой список, а не «вот урок другого учителя»
    expect((await get(teacherTok, `/api/classes/${classId}/lessons/archive?event=${crypto.randomUUID()}`))
      .json().items).toEqual([]);
    expect((await get(teacherTok, `/api/classes/${classId}/lessons/archive?event=не-id`)).statusCode).toBe(400);
    await t.db.delete(lessonSessions).where(eq(lessonSessions.id, s!.id));
    await t.db.delete(events).where(eq(events.id, evt!.id));
  });

  it('a scene that does not fit the request body is refused on the direct save path', async () => {
    const started = await post(teacherTok, '/api/lessons/start', { classId });
    const id = started.json().id as string;
    // Потолок тела транспорта (1 МБ у Fastify) строже потолка сцены (2 МБ), поэтому прямое
    // сохранение не может записать сцену крупнее лимита: запрос отсекается ещё до обработчика.
    // Проверяем именно это — код отказа нам не важен, важен факт: 4xx и НИЧЕГО не записано.
    const fat = { id: 'big', version: 1, versionNonce: 1, type: 'draw', data: 'x'.repeat(MAX_SCENE_BYTES) };
    const r = await put(teacherTok, `/api/lessons/${id}/board/page`, { pageNo: 1, elements: [fat] });
    expect(r.statusCode).toBe(413);
    const saved = await t.db.select().from(whiteboards).where(eq(whiteboards.sessionId, id));
    expect(saved, 'ничего не записано').toHaveLength(0);
    await post(teacherTok, `/api/lessons/${id}/end`);
    await del(teacherTok, `/api/lessons/${id}/archive`);
  });
});
