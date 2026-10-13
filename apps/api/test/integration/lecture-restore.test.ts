/**
 * Часть 1 (2026-10-13) — «после режима лекции».
 *
 * Что доказуемо без медиа-сервера и что здесь честно остаётся недоказанным:
 *  - решение учителя «вернуть устройства после лекции» хранится НА СЕССИИ и возвращается статусом,
 *    то есть переживает перезагрузку и переподключение ученика;
 *  - снимок «что горело» тоже живёт на сессии, и из `lecture_pre_devices` наружу уходит только
 *    запись спрашивающего — чужой микрофон никто не видит (тест ниже проверяет оба адреса);
 *  - при недоступном медиа-сервере снимок остаётся пустым: публикацию не отняли, значит возвращать
 *    нечего, и выдумывать включённые устройства маршрут не вправе;
 *  - выключение режима лекции при недоступном медиа-сервере даёт 502 и НЕ меняет состояние.
 *    До правки этот же вызов отвечал 200 и писал `lectureMode=false`, оставляя учеников с
 *    `canPublish: false` — то есть «успех», после которого урок невозможно продолжить. Это и есть
 *    проверка «красный до / зелёный после»: прежнее поведение здесь падает на обоих утверждениях;
 *    граница «ушедший участник — не 502» (тот же цикл, другой код ошибки) — в
 *    `test/unit/participant-gone.test.ts`; в живом прогоне этот путь поймал zz19 (CI 38407412645),
 *    где страницы предыдущих спеков ещё не вышли из комнаты, а новый вход уже идёт;
 *  - что именно возвращается каждому ученику (сложение с выданным словом) — арифметика прав, она
 *    в `test/unit/floor-permission.test.ts`, а сам снимок — в `test/unit/lecture-pre-devices.test.ts`;
 *    реальное включение микрофона у трёх учеников — в `apps/e2e/tests/zz19-lecture-restore.spec.ts`,
 *    который в CI крутится против настоящего LiveKit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { classMembers, classes, lessonSessions, users } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

suite('after lecture mode (part 1)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let studentTok = '';
  let studentBTok = '';
  let outsiderTok = '';
  let studentId = '';
  let studentBId = '';
  let classId = '';
  let foreignClassId = '';
  let sessionId = '';
  let foreignSessionId = '';

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });
  const row = async () =>
    (await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, sessionId)).limit(1))[0];

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const pw = await hashPassword(PW);
    const [teacher] = await t.db.insert(users).values({
      role: 'teacher', name: 'LR Teacher', email: 'lrt@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [student] = await t.db.insert(users).values({
      role: 'student', name: 'LR Student', email: 'lrs@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [studentB] = await t.db.insert(users).values({
      role: 'student', name: 'LR Student B', email: 'lrsb@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [outsider] = await t.db.insert(users).values({
      role: 'teacher', name: 'LR Other', email: 'lro@x.io', passwordHash: pw, tz: 'UTC',
    }).returning();
    const [cls] = await t.db.insert(classes).values({ name: '7LR', teacherId: teacher.id }).returning();
    const [foreign] = await t.db.insert(classes).values({ name: '9LR', teacherId: outsider.id }).returning();
    await t.db.insert(classMembers).values([
      { classId: cls.id, userId: student.id }, { classId: cls.id, userId: studentB!.id },
      { classId: foreign.id, userId: student.id },
    ]);
    const login = async (email: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } }))
        .json().accessToken as string;
    teacherTok = await login('lrt@x.io');
    studentTok = await login('lrs@x.io');
    studentBTok = await login('lrsb@x.io');
    outsiderTok = await login('lro@x.io');
    studentId = student!.id;
    studentBId = studentB!.id;
    classId = cls.id;
    foreignClassId = foreign.id;
    const started = await post(teacherTok, '/api/lessons/start', { classId: cls.id });
    sessionId = started.json().id as string;
    foreignSessionId = (await post(outsiderTok, '/api/lessons/start', { classId: foreign.id })).json().id as string;
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('the teacher\'s choice is stored on the session and answers with the status', async () => {
    expect((await post(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: true, restore: false })).statusCode).toBe(200);
    expect((await row()).lectureMode).toBe(true);
    expect((await row()).lectureRestore).toBe(false);
    const st = await get(studentTok, `/api/lessons/active?classId=${classId}`);
    expect(st.json().session).toMatchObject({ lectureMode: true, lectureRestore: false });

    // включение без поля = прежний поток: возвращать по умолчанию
    expect((await post(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: true })).statusCode).toBe(200);
    expect((await row()).lectureRestore).toBe(true);
    // медиа-сервера нет → список участников не прочитан → снимок пустой. Пустой, а НЕ «включим всем»:
    // выдумывать горевшие устройства маршрут не вправе, иначе после лекции заговорит молчавший.
    expect((await row()).lecturePreDevices).toEqual({});
  });

  it('each student\'s status exposes ONLY their own snapshot; the teacher sees the whole roster', async () => {
    // Медиа-сервера в этом окружении нет, поэтому снимок пишется напрямую: проверяется НЕ арифметика
    // устройств (она в юните), а приватность: из `lecture_pre_devices` ученику уходит только его
    // запись, полная карта — владельцу урока. Целиком карта ученику — это «A видит, что у B горел
    // микрофон до лекции».
    await t.db.update(lessonSessions)
      .set({ lecturePreDevices: { [studentId]: { mic: true, cam: false }, [studentBId]: { mic: false, cam: true } } })
      .where(eq(lessonSessions.id, sessionId));

    const a = (await get(studentTok, `/api/lessons/active?classId=${classId}`)).json().session;
    const b = (await get(studentBTok, `/api/lessons/active?classId=${classId}`)).json().session;
    expect(a.preLecture).toEqual({ mic: true, cam: false });
    expect(b.preLecture).toEqual({ mic: false, cam: true });
    // чужой identity и сама roster-карта не уезжают ученику
    expect(JSON.stringify(a)).not.toContain(studentBId);
    expect(JSON.stringify(b)).not.toContain(studentId);
    expect(a.preLectureRoster).toBeUndefined();
    expect(b.preLectureRoster).toBeUndefined();

    // учитель своего урока видит ВСЕ записи
    const teach = (await get(teacherTok, `/api/lessons/active?classId=${classId}`)).json().session;
    expect(teach.preLecture).toBeNull(); // учителя нет в снимке — он говорит всегда
    expect(teach.preLectureRoster).toEqual({
      [studentId]: { mic: true, cam: false }, [studentBId]: { mic: false, cam: true },
    });

    // чужой класс и несуществующий дают ОДИНАКОВЫЙ 404 (учитель чужого класса не видит roster)
    const foreignClass = await get(teacherTok, `/api/lessons/active?classId=${foreignClassId}`);
    const madeUpClass = await get(teacherTok, '/api/lessons/active?classId=00000000-0000-4000-8000-000000000000');
    expect([foreignClass.statusCode, madeUpClass.statusCode]).toEqual([404, 404]);
    expect(foreignClass.body).toBe(madeUpClass.body);
  });

  it('turning it off against an unreachable media server is 502 and changes NOTHING', async () => {
    // медиа-сервера в этом окружении нет: `listParticipants` отказывает. Именно это раньше и
    // превращалось в ложный успех — маршрут писал `lectureMode=false` и отвечал 200.
    const off = await post(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: false });
    expect(off.statusCode).toBe(502);
    expect(off.json()).toEqual({ error: 'mediaServerUnavailable' });
    expect((await row()).lectureMode).toBe(true);
    const st = await get(studentTok, `/api/lessons/active?classId=${classId}`);
    expect(st.json().session.lectureMode).toBe(true);
  });

  it('a body that is not a switch is refused before anything is touched', async () => {
    const bad = await post(teacherTok, `/api/lessons/${sessionId}/lecture-mode`, { on: 'yes' });
    expect(bad.statusCode).toBe(400);
    expect((await row()).lectureMode).toBe(true);
  });

  it('rights: a student gets 403, and a foreign class and a made-up lesson answer alike', async () => {
    expect((await post(studentTok, `/api/lessons/${sessionId}/lecture-mode`, { on: true })).statusCode).toBe(403);
    const foreign = await post(teacherTok, `/api/lessons/${foreignSessionId}/lecture-mode`, { on: true });
    const madeUp = await post(teacherTok, '/api/lessons/00000000-0000-4000-8000-000000000000/lecture-mode', { on: true });
    expect([foreign.statusCode, madeUp.statusCode]).toEqual([404, 404]);
    expect(foreign.body).toBe(madeUp.body);
  });

  it('the class of the foreign session was not affected by any of the above', async () => {
    const r = await t.db.select().from(lessonSessions).where(eq(lessonSessions.id, foreignSessionId)).limit(1);
    expect(r[0].lectureMode).toBe(false);
  });

  it('ending the lesson deletes the snapshot', async () => {
    await t.db.update(lessonSessions)
      .set({ lecturePreDevices: { [studentId]: { mic: true, cam: true } } })
      .where(eq(lessonSessions.id, sessionId));
    expect((await row()).lecturePreDevices[studentId]).toEqual({ mic: true, cam: true });
    // завершение урока не требует медиа-сервера (kick — best-effort через `media()`)
    expect((await post(teacherTok, `/api/lessons/${sessionId}/end`)).statusCode).toBe(200);
    expect((await row()).lecturePreDevices).toEqual({});
  });
});
