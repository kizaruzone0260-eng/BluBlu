/**
 * §7 access-rights audit matrix. Two tenants: A (victim) and B (attacker).
 * For every class-scoped endpoint: anonymous → 401; foreign teacher/student → 404
 * (never 403 — existence must not leak); student on teacher route → 403;
 * ownership filters (notes/sheets) → 404 for foreign ids; LiveKit/board tokens
 * only for active-session members. Also: lesson session cannot bind an event of
 * another class.
 *
 * 2026-10-27. Приём в класс по восьмизначному коду выведен из продукта, и это коснулось файла
 * с двух сторон. Фикстура (`enroll()`) больше не заводит ученика кодом: ученик вставляется через
 * `makeStudent` и входит тем же маршрутом, которым входит браузер (`loginToken`) — прав-то
 * проверяются именно на входе, а не на регистрации. А строки матрицы про коды (`GET/POST
 * /api/classes/:id/invites`, `POST /api/join-by-code`) переставлены на то, что эти маршруты дают
 * теперь: 410. Отдельно названо, что делает реализация: у мёртвых маршрутов НЕТ проверки прав и
 * они не смотрят ни на класс, ни на тело, поэтому чужой класс здесь отвечает тем же 410, а не
 * 404, — и ни о чём не сообщает, потому что сообщать нечем. Выжившие же учительские маршруты
 * держат прежнюю тройку (401 / 403 / 404), и проверка этой тройки добавлена для
 * `POST /api/classes/:id/students` и `POST /api/classes/:id/members/lookup`. Ни одна строка
 * атаки из этого файла не выброшена.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, makeStudent, loginToken, makeInviteLink, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classes, posts, files as filesTable, users, classTelegramChats } from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PAGE_ORIGIN = 'https://blublu.example';

suite('§7 rights audit', () => {
  let t: TestDB;
  let app: FastifyInstance;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  let classA = '', classB = '', teacherAId = '', teacherBId = '', studentAId = '', studentBId = '';
  let postA = '', fileA = '', noteA = '', eventA = '', sessionA = '', sheetA = '', inviteA = '';

  /*
   * Ученик в фикстуре — вставленный аккаунт и обычный вход. Прежний способ («код класса →
   * /api/auth/register») выведен, а тестам этого файла нужен человек с токеном, а не сценарий
   * приёма: проверяются права на чужих ресурсах.
   */
  async function enroll(email: string, classId: string, who: string) {
    const pupil = await makeStudent(t.sql, { classId, email });
    tok[who] = await loginToken(app, pupil.email, pupil.password);
    if (who === 'studentA') studentAId = pupil.id;
    if (who === 'studentB') studentBId = pupil.id;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.PUBLIC_URL = PAGE_ORIGIN;   // ссылка-приглашение без публичного адреса не собирается
    app = await buildApp(t.db);
    const tA = await makeTeacher(t.sql, `audA${Date.now()}@x.io`);
    teacherAId = tA.id;
    const tB = await makeTeacher(t.sql, `audB${Date.now()}@x.io`);
    teacherBId = tB.id;
    const chk = await t.sql`select email, left(password_hash, 14) as h from users where id = ${tA.id}`;
    if (!chk.length) throw new Error('teacher row missing after insert!');
    for (const [who, u] of [['teacherA', tA], ['teacherB', tB]] as const) {
      const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: u.password } });
      if (l.statusCode !== 200) {
        const { login: svcLogin } = await import('../../src/services/auth.js');
        const svc = await svcLogin(t.db, u.email, u.password);
        const raw = await t.sql`select email, password_hash, deleted_at from users where email = ${u.email}`;
        throw new Error(`login ${who} → ${l.statusCode}; svc=${JSON.stringify(svc).slice(0, 60)}; raw=${JSON.stringify(raw).slice(0, 120)}`);
      }
      tok[who] = l.json().accessToken as string;
    }
    const [cA] = await t.db.insert(classes).values({ teacherId: teacherAId, name: 'Class A' }).returning();
    const [cB] = await t.db.insert(classes).values({ teacherId: tB.id, name: 'Class B' }).returning();
    classA = cA!.id; classB = cB!.id;
    await enroll(`aa${Date.now()}@x.io`, classA, 'studentA');
    await enroll(`bb${Date.now()}@x.io`, classB, 'studentB');

    // victim resources in class A
    /*
     * Строка приглашения для проверки отзыва: раньше её выпускали маршрутом кодов, теперь —
     * маршрутом ссылок. Для матрицы прав это не меняет ничего: отзыв (`…/invites/:id/revoke`)
     * выжил и проверяется ровно так же, а id строки нужен только чтобы было что отзывать.
     */
    inviteA = (await makeInviteLink(app, tok.teacherA, classA)).id;
    const up = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from('x'.repeat(200))]);
    const head = `--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\nVictim doc\r\n--BND\r\nContent-Disposition: form-data; name="file"; filename="d.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const mat = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/materials`,
      headers: { authorization: `Bearer ${tok.teacherA}`, 'content-type': 'multipart/form-data; boundary=BND' },
      payload: Buffer.concat([Buffer.from(head, 'utf8'), up, Buffer.from('\r\n--BND--\r\n', 'utf8')]),
    });
    postA = mat.json().id;
    if (mat.statusCode !== 201) throw new Error(`material upload failed ${mat.statusCode} ${mat.body.slice(0, 200)}`);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: { authorization: `Bearer ${tok.studentA}` } });
    fileA = feed.json().find((p: { id: string }) => p.id === postA).attachments[0].file.id;

    const note = await app.inject({ method: 'POST', url: '/api/notes', headers: { authorization: `Bearer ${tok.teacherA}` }, payload: { classId: classA, title: 'N', body: 'secret plan' } });
    noteA = note.json().id;
    const ev = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/events`, headers: { authorization: `Bearer ${tok.teacherA}` },
      payload: { kind: 'lesson', title: 'Victim lesson', description: '', startLocal: '2026-11-02T19:00', durationMin: 50, tz: 'Asia/Tashkent' },
    });
    eventA = ev.json().id;
    const ses = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: { authorization: `Bearer ${tok.teacherA}` }, payload: { classId: classA, eventId: eventA } });
    sessionA = ses.json().id;
    const sheet = await app.inject({ method: 'POST', url: '/api/student-notes', headers: { authorization: `Bearer ${tok.studentA}` }, payload: { classId: classA, title: 'S', body: 'private' } });
    sheetA = sheet.json().id;
    const ics = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: { authorization: `Bearer ${tok.teacherA}` } });
    id.icsA = ics.json().token;
  });
  afterAll(async () => {
    env.PUBLIC_URL = '';
    await app?.close(); await t?.sql.end();
  });

  const a = (who: string) => ({ authorization: `Bearer ${tok[who]}` });

  // ── classes & members ───────────────────────────────────────────────────────
  it('anonymous → 401 on every member-scoped GET', async () => {
    // список приглашений (`…/invitations`) встал сюда вместо умершего `…/invites`: это выживший
    // учительский GET, и он обязан требовать сессию ровно как остальные
    for (const url of ['/api/classes', `/api/classes/${classA}/feed`, '/api/events', '/api/notes', '/api/student-notes', `/api/classes/${classA}/members`, `/api/classes/${classA}/invitations`, `/api/lessons/active?classId=${classA}`, `/api/files/${fileA}`]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  /**
   * Мёртвые маршруты приёма по коду (410) — что делает реализация, а не что было бы удобно.
   * `retiredEnrollment` висит на них ОДНИМ выражением и без `preHandler`: он не читает ни id
   * класса, ни тело, ни сессию. Значит «владение проверяется первым, и чужой класс отвечает
   * 404» здесь неприменимо — чужой класс, свой класс, ученик и аноним получают ОДИН ответ 410.
   * Дыры в этом нет: по разнице ответов нельзя узнать существование класса, потому что разницы
   * нет вообще; и ни одна строка не создаётся (см. «join-by-code» ниже и http.test.ts).
   */
  it('retired code endpoints: 410 for everyone, own or foreign class alike', async () => {
    const dead: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
      { method: 'POST', url: '/api/auth/register', payload: { firstName: 'P', lastName: 'P', email: 'x@x.io', password: 'Secret1234', code: 'ABCDEFGH' } },
      { method: 'POST', url: '/api/auth/check-code', payload: { code: 'ABCDEFGH' } },
      { method: 'POST', url: `/api/classes/${classA}/invites`, payload: {} },
      { method: 'GET', url: `/api/classes/${classA}/invites` },
      // чужой класс: ровно тот же ответ, потому что маршруту нечем проверять владение
      { method: 'POST', url: `/api/classes/${classB}/invites`, payload: {} },
      { method: 'GET', url: `/api/classes/${classB}/invites` },
    ];
    const shapes = new Set<string>();
    for (const call of dead) {
      for (const who of ['teacherA', 'teacherB', 'studentA'] as const) {
        const r = await app.inject({ method: call.method, url: call.url, headers: a(who), payload: call.payload as object });
        expect(r.statusCode, `${who} ${call.method} ${call.url}`).toBe(410);
        expect(r.json().error).toBe('enrollmentRetired');
        expect(r.json().reqId, 'отказ обязан оставаться находимым в access-логе').toBeTruthy();
        shapes.add(JSON.stringify({ ...r.json(), reqId: '' }));
      }
      const anon = await app.inject({ method: call.method, url: call.url, payload: call.payload as object });
      expect(anon.statusCode, `anon ${call.method} ${call.url}`).toBe(410);
      expect(anon.json().error).toBe('enrollmentRetired');
    }
    expect(shapes.size, 'ответ мёртвого маршрута не зависит от того, кто и куда стучится').toBe(1);
  });

  it('B cannot touch A class: patch/archive/members/invites/reset → 404; A students list is invisible', async () => {
    const attacks: [string, string, unknown?][] = [
      ['PATCH', `/api/classes/${classA}`, { name: 'hijacked' }],
      ['POST', `/api/classes/${classA}/archive`],
      ['GET', `/api/classes/${classA}/members`],
      ['POST', `/api/classes/${classA}/members`, { userId: studentAId }],
      ['DELETE', `/api/classes/${classA}/members/${studentAId}`],
      ['POST', `/api/classes/${classA}/members/${studentAId}/move`, { toClassId: classB }],
      ['POST', `/api/classes/${classA}/members/${studentAId}/reset-password`],
      // выжившие учительские маршруты приёма: вместо «выпустить код» — «завести аккаунт» и
      // «найти по почте». Тела заведомо валидные: 404 обязан быть отказом по владению, а не по
      // форме запроса.
      ['POST', `/api/classes/${classA}/students`, { firstName: 'Чужой', lastName: 'Учитель', email: `r-priv${Date.now()}@x.io`, password: 'Secret1234' }],
      ['POST', `/api/classes/${classA}/members/lookup`, { email: `r-look${Date.now()}@x.io` }],
      ['GET', `/api/classes/${classA}/invitations`],
      ['POST', `/api/classes/${classA}/invites/link`, { ttlDays: 7 }],
      ['POST', `/api/classes/${classA}/invites/${inviteA}/revoke`],
      ['POST', `/api/classes/${classA}/events`, { kind: 'other', title: 'x', startLocal: '2026-11-03T10:00', durationMin: 60, tz: 'UTC' }],
      ['GET', `/api/classes/${classA}/telegram`],
      ['POST', `/api/classes/${classA}/link-token`],
      ['PUT', `/api/classes/${classA}/notify-channel`, { channel: 'group' }],
    ];
    for (const [method, url, payload] of attacks) {
      const rB = await app.inject({ method: method as 'GET', url, headers: a('teacherB'), payload: payload as object });
      expect(rB.statusCode, `teacherB ${method} ${url}`).toBe(404);
      const rAnon = await app.inject({ method: method as 'GET', url, payload: payload as object });
      expect(rAnon.statusCode, `anon ${method} ${url}`).toBe(401);
    }
  });

  it('student on teacher routes → 403 (not 404 — route-level role)', async () => {
    const r1 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/members`, headers: a('studentA') });
    expect(r1.statusCode).toBe(403);
    // выживший маршрут выпуска приглашений: вместо «создать код» — «создать ссылку»
    const r2 = await app.inject({ method: 'POST', url: `/api/classes/${classA}/invites/link`, headers: a('studentA'), payload: {} });
    expect(r2.statusCode).toBe(403);
    const r3 = await app.inject({ method: 'POST', url: '/api/notes', headers: a('studentA'), payload: { classId: classA } });
    expect(r3.statusCode).toBe(403);
  });

  /**
   * Тройка ответов на выживших маршрутах приёма — та же, что у остальной учительской половины
   * API: аноним 401, ученик 403, чужой класс 404. Порядок проверок у двух маршрутов разный, и
   * это названо: `students` смотрит владение ДО разбора тела (поэтому чужой класс отвечает 404
   * даже с кривым телом), а `members/lookup` разбирает тело первым — с валидным письмом он всё
   * равно приходит к 404, но с мусорным телом ответил бы 400.
   */
  it('enrollment routes keep the trio: anon 401, student 403, foreign class 404', async () => {
    const studentBody = { firstName: 'Новый', lastName: 'Ученик', email: `r-trio${Date.now()}@x.io`, password: 'Secret1234' };

    const anonCreate = await app.inject({ method: 'POST', url: `/api/classes/${classA}/students`, payload: studentBody });
    expect(anonCreate.statusCode).toBe(401);
    const pupilCreate = await app.inject({ method: 'POST', url: `/api/classes/${classA}/students`, headers: a('studentA'), payload: studentBody });
    expect(pupilCreate.statusCode, pupilCreate.body).toBe(403);
    const foreignCreate = await app.inject({ method: 'POST', url: `/api/classes/${classA}/students`, headers: a('teacherB'), payload: studentBody });
    expect(foreignCreate.statusCode).toBe(404);
    // владение раньше тела: кривое тело на чужом классе — тот же 404, а не 400
    const foreignBad = await app.inject({ method: 'POST', url: `/api/classes/${classA}/students`, headers: a('teacherB'), payload: { firstName: 'Ч' } });
    expect(foreignBad.statusCode, 'чужой класс не светит ответом на плохое тело').toBe(404);

    const lookupBody = { email: `r-lookup${Date.now()}@x.io` };
    const anonLookup = await app.inject({ method: 'POST', url: `/api/classes/${classA}/members/lookup`, payload: lookupBody });
    expect(anonLookup.statusCode).toBe(401);
    const pupilLookup = await app.inject({ method: 'POST', url: `/api/classes/${classA}/members/lookup`, headers: a('studentA'), payload: lookupBody });
    expect(pupilLookup.statusCode).toBe(403);
    const foreignLookup = await app.inject({ method: 'POST', url: `/api/classes/${classA}/members/lookup`, headers: a('teacherB'), payload: lookupBody });
    expect(foreignLookup.statusCode).toBe(404);

    // и своим классом оба маршрута живые: отказ по правам не сломал их
    const own = await app.inject({ method: 'POST', url: `/api/classes/${classB}/students`, headers: a('teacherB'), payload: studentBody });
    expect(own.statusCode, String(own.json().error ?? 'no error')).toBe(201);
    const ownLookup = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members/lookup`, headers: a('teacherB'), payload: lookupBody });
    expect(ownLookup.statusCode, 'несуществующая почта — это 404 studentNotFound, а не отказ прав')
      .toBe(404);
    expect(ownLookup.json().error).toBe('studentNotFound');

    // никто из посторонних не создал аккаунта
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, studentBody.email)),
      'аккаунт появился только от собственного учителя').toHaveLength(1);
  });

  /**
   * Прежний «присоединиться по коду второго класса» выведен, и строка проверки говорит теперь
   * ровно это: маршрут отвечает 410 — ученику, чужому учителю и анонему одинаково, — и не
   * создаёт членства. Дальше идёт то, что проверялось всегда: учитель MAY добавить существующего
   * ученика по uuid, но не учителя.
   */
  it('retired join-by-code answers 410; B teacher cannot add A student to B class by id enumeration', async () => {
    for (const [who, expected] of [['studentB', 410], ['teacherB', 410], ['anon', 410]] as const) {
      const r = await app.inject({
        method: 'POST', url: '/api/join-by-code',
        ...(who === 'anon' ? {} : { headers: a(who) }), payload: { code: 'ZZZZZZZZ' },
      });
      expect(r.statusCode, `${who} /api/join-by-code`).toBe(expected);
      expect(r.json().error).toBe('enrollmentRetired');
    }
    const membersBefore = await app.inject({ method: 'GET', url: `/api/classes/${classB}/members`, headers: a('teacherB') });
    expect((membersBefore.json() as unknown[]).some((m) => (m as { userId: string }).userId === studentAId)).toBe(false);

    // by design a teacher MAY add an existing student knowing their uuid (uuid is unguessable; §3.2 direct-add)
    const add = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members`, headers: a('teacherB'), payload: { userId: studentAId } });
    expect(add.statusCode).toBe(200);
    const membersB = await app.inject({ method: 'GET', url: `/api/classes/${classB}/members`, headers: a('teacherB') });
    expect(membersB.json().some((m: { userId: string }) => m.userId === studentAId)).toBe(true);
    // but adding a TEACHER as member must fail
    const addT = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members`, headers: a('teacherB'), payload: { userId: teacherAId } });
    expect(addT.statusCode).toBe(400);
  });

  it('move between classes of different teachers → 400 (ownership of target checked)', async () => {
    // studentA was just added to B by teacherB; teacherA cannot move him into A via B-class route...
    const r = await app.inject({ method: 'POST', url: `/api/classes/${classB}/members/${studentAId}/move`, headers: a('teacherA'), payload: { toClassId: classA } });
    expect(r.statusCode).toBe(404); // teacherA doesn't own classB (source) at all
  });

  // ── posts/files ─────────────────────────────────────────────────────────────
  it('A feed/files invisible to B-student and B-teacher (404), B-student cannot download file', async () => {
    const f1 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('studentB') });
    expect(f1.statusCode).toBe(404);
    const f2 = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('teacherB') });
    expect(f2.statusCode).toBe(404);
    const dl = await app.inject({ method: 'GET', url: `/api/files/${fileA}`, headers: a('studentB') });
    expect(dl.statusCode).toBe(404);
    const inline = await app.inject({ method: 'GET', url: `/api/files/${fileA}/inline`, headers: a('teacherB') });
    expect(inline.statusCode).toBe(404);
    const dlA = await app.inject({ method: 'GET', url: `/api/files/${fileA}`, headers: a('studentA') });
    expect(dlA.statusCode).toBe(200); // control: legit member still ok
  });

  it('B cannot edit/delete A posts (404); students cannot (403)', async () => {
    const r1 = await app.inject({ method: 'PATCH', url: `/api/posts/${postA}`, headers: a('teacherB'), payload: { title: 'hij' } });
    expect(r1.statusCode).toBe(404);
    const r2 = await app.inject({ method: 'DELETE', url: `/api/posts/${postA}`, headers: a('teacherB') });
    expect(r2.statusCode).toBe(404);
    const r3 = await app.inject({ method: 'DELETE', url: `/api/posts/${postA}`, headers: a('studentA') });
    expect(r3.statusCode).toBe(403);
  });

  it('B teacher cannot upload into A class (404) and cannot read A teacher notes', async () => {
    const head = `--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n--BND\r\nContent-Disposition: form-data; name="file"; filename="d.pdf"\r\n\r\n%PDF-1.4\r\n--BND--\r\n`;
    const up = await app.inject({
      method: 'POST', url: `/api/classes/${classA}/materials`,
      headers: { ...a('teacherB'), 'content-type': 'multipart/form-data; boundary=BND' }, payload: head,
    });
    expect(up.statusCode).toBe(404);
    const notesB = await app.inject({ method: 'GET', url: '/api/notes', headers: a('teacherB') });
    expect(notesB.json()).toEqual([]);
    const patch = await app.inject({ method: 'PATCH', url: `/api/notes/${noteA}`, headers: a('teacherB'), payload: { body: 'x' } });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/notes/${noteA}`, headers: a('teacherB') });
    expect(del.statusCode).toBe(404);
    const pub = await app.inject({ method: 'POST', url: `/api/notes/${noteA}/publish`, headers: a('teacherB') });
    expect(pub.statusCode).toBe(404);
    // creating a note in A class as B-teacher → 404
    const create = await app.inject({ method: 'POST', url: '/api/notes', headers: a('teacherB'), payload: { classId: classA, title: '', body: '' } });
    expect(create.statusCode).toBe(404);
  });

  // ── events / ICS ────────────────────────────────────────────────────────────
  it('B sees no A events; B cannot patch/delete A event; event of A visible to A-student only', async () => {
    const evB = await app.inject({ method: 'GET', url: '/api/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', headers: a('teacherB') });
    expect((evB.json() as unknown[]).length).toBe(0);
    const p = await app.inject({ method: 'PATCH', url: `/api/events/${eventA}`, headers: a('teacherB'), payload: { scope: 'all', changes: { kind: 'other', title: 'x', description: '', startLocal: '2026-11-02T19:00', durationMin: 50, tz: 'UTC' } } });
    expect(p.statusCode).toBe(404);
    const d = await app.inject({ method: 'DELETE', url: `/api/events/${eventA}?scope=all`, headers: a('teacherB') });
    expect(d.statusCode).toBe(404);
    const evA = await app.inject({ method: 'GET', url: '/api/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', headers: a('studentA') });
    expect((evA.json() as { eventId: string }[]).some((o) => o.eventId === eventA)).toBe(true);
    // B-student filtering by A classId → empty, no existence leak in message
    const filt = await app.inject({ method: 'GET', url: `/api/events?classId=${classA}`, headers: a('studentB') });
    expect(filt.statusCode).toBe(200);
    expect((filt.json() as unknown[]).length).toBe(0);
  });

  it('ICS: A token exposes A data only; B cannot mint token for A; bad token 404', async () => {
    const icsA = await app.inject({ method: 'GET', url: `/api/ical/${id.icsA}` });
    expect(icsA.body).toContain('Victim lesson');
    expect(icsA.body).not.toContain('Class B');
    const bad = await app.inject({ method: 'GET', url: '/api/ical/not-a-real-token-xyz' });
    expect(bad.statusCode).toBe(404);
    const tokB = await app.inject({ method: 'POST', url: '/api/me/ical-token', headers: a('teacherB') });
    const icsB = await app.inject({ method: 'GET', url: `/api/ical/${tokB.json().token}` });
    expect(icsB.body).not.toContain('Victim lesson');
  });

  // ── lessons / RTC token / WS ───────────────────────────────────────────────
  it('B cannot join A lesson (404), cannot get token after end; A student gets valid token', async () => {
    const jB = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentB') });
    expect(jB.statusCode).toBe(404);
    const jT = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('teacherB') });
    expect(jT.statusCode).toBe(404);
    const jA = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentA') });
    expect(jA.statusCode).toBe(200);
    // moderation from B → 404
    for (const path of ['end', 'lecture-mode', 'mute', 'kick', 'grant-screen']) {
      const r = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/${path}`, headers: a('teacherB'), payload: path === 'mute' ? { all: true } : path === 'lecture-mode' ? { on: true } : path === 'kick' || path === 'grant-screen' ? { identity: studentAId } : {} });
      expect(r.statusCode, path).toBe(404);
    }
    const lay = await app.inject({ method: 'PATCH', url: `/api/lessons/${sessionA}/layout`, headers: a('teacherB'), payload: { layout: 'stage' } });
    expect(lay.statusCode).toBe(404);
    // A teacher can end (control) — and after end nobody joins
    const end = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/end`, headers: a('teacherA') });
    expect(end.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/join`, headers: a('studentA') });
    expect(after.statusCode).toBe(404);
  });

  it('lesson session cannot bind an event of ANOTHER class (anti-confusion)', async () => {
    const ev = await app.inject({
      method: 'POST', url: `/api/classes/${classB}/events`, headers: a('teacherB'),
      payload: { kind: 'lesson', title: 'B lesson', description: '', startLocal: '2026-11-05T10:00', durationMin: 45, tz: 'UTC' },
    });
    const bEvent = ev.json().id as string;
    const start = await app.inject({
      method: 'POST', url: '/api/lessons/start', headers: a('teacherB'),
      payload: { classId: classB, eventId: bEvent },
    });
    expect(start.statusCode).toBe(201);
    const evil = await app.inject({
      method: 'POST', url: '/api/lessons/start', headers: a('teacherB'),
      payload: { classId: classB, eventId: eventA }, // eventA belongs to classA
    });
    expect(evil.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/lessons/${start.json().id}/end`, headers: a('teacherB') });
  });

  it('WS tickets: one-time, session-bound, member gets snapshot; anon gets 4401 with zero data', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    interface Outcome { opened: boolean; code: number | null; messages: string[] }
    function probe(url: string, ms = 1200): Promise<Outcome> {
      return new Promise((res) => {
        const out: Outcome = { opened: false, code: null, messages: [] };
        const ws = new WebSocket(url);
        ws.onopen = () => { out.opened = true; };
        ws.onmessage = (e) => { out.messages.push(String(e.data)); };
        ws.onclose = (e) => { out.code = e.code; res(out); };
        setTimeout(() => { try { ws.close(); } catch { /* noop */ } res(out); }, ms);
      });
    }
    // fresh live sessions for both tenants
    const stA = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherA'), payload: { classId: classA } });
    const liveA = stA.json().id as string;
    const stB = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherB'), payload: { classId: classB } });
    const liveB = stB.json().id as string;

    const bad = await probe(`ws://127.0.0.1:${port}/api/ws/lesson/${liveA}?ticket=xx`);
    expect(bad.messages, 'no bytes to an invalid ticket').toEqual([]);
    expect(bad.code).toBe(4401);

    const tr = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: liveA } });
    expect(tr.statusCode).toBe(200);
    const ticket = tr.json().ticket as string;
    const ok = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(ticket)}`, 900);
    expect(ok.opened).toBe(true);
    expect(ok.messages.length, 'member receives init').toBeGreaterThan(0);
    expect(ok.code, 'member socket stays open').toBeNull();

    // ONE-TIME: the consumed ticket is dead
    const reuse = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(ticket)}`);
    expect(reuse.code).toBe(4401);

    // SESSION-BOUND: valid ticket for B's session cannot open A's board
    const trB = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentB'), payload: { sessionId: liveB } });
    const cross = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${trB.json().ticket as string}`);
    expect(cross.code).toBe(4401);

    // membership enforced AT ISSUANCE: B cannot get a ticket for A's session
    const denied = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentB'), payload: { sessionId: liveA } });
    expect(denied.statusCode).toBe(404);
    // ended session → no tickets
    const ended = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: sessionA } });
    expect(ended.statusCode).toBe(404);

    // EXPIRED ticket (rows aged manually) → 4401
    const t2 = await app.inject({ method: 'POST', url: '/api/ws/ticket', headers: a('studentA'), payload: { sessionId: liveA } });
    const plain = t2.json().ticket as string;
    await t.sql`update ws_tickets set expires_at = now() - interval '1 minute'`;
    const expired = await probe(`ws://127.0.0.1:${port}/api/ws/board/${liveA}?ticket=${encodeURIComponent(plain)}`);
    expect(expired.code).toBe(4401);

    await app.inject({ method: 'POST', url: `/api/lessons/${liveA}/end`, headers: a('teacherA') });
    await app.inject({ method: 'POST', url: `/api/lessons/${liveB}/end`, headers: a('teacherB') });
  });

  // ── board & student sheets ──────────────────────────────────────────────────
  it('B cannot read/write/publish A board; A members can', async () => {
    const gB = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('teacherB') });
    expect(gB.statusCode).toBe(404);
    const gB2 = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('studentB') });
    expect(gB2.statusCode).toBe(404);
    const put = await app.inject({ method: 'PUT', url: `/api/lessons/${sessionA}/board/page`, headers: a('teacherB'), payload: { pageNo: 1, elements: [{ id: 'x' }] } });
    expect(put.statusCode).toBe(404);
    const pub = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionA}/board/publish`, headers: a('teacherB'),
      payload: { dataUrl: 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString('base64'), kind: 'png', title: 'steal' },
    });
    expect(pub.statusCode).toBe(404);
    const pubStu = await app.inject({
      method: 'POST', url: `/api/lessons/${sessionA}/board/publish`, headers: a('studentA'),
      payload: { dataUrl: 'data:image/png;base64,iVBORw0K', kind: 'png', title: 'x' },
    });
    expect(pubStu.statusCode).toBe(403);
    const okGet = await app.inject({ method: 'GET', url: `/api/lessons/${sessionA}/board`, headers: a('studentA') });
    expect(okGet.statusCode).toBe(200);
  });

  /**
   * Stage 4: четыре маршрута, которые аудит назвал непроверенными отрицательными тестами.
   * Реализация их уже проверяла (`chatAccess` / `resolveClass` / `authenticateTeacher`), здесь
   * фиксируется ответ на чужого и на анонима, чтобы правило не размылось молча. Для отвязки
   * telegram проверяется ещё и то, чего тест ответа не видит: после отказа чужая строка привязки
   * остаётся на месте — маршрут не должен успеть удалить её «до» проверки владения.
   */
  it('chat ticket/read, telegram unbind and board authors refuse the foreign tenant', async () => {
    // ── чат: аноним 401, чужой учитель и чужой ученик 404, свой участник работает ──
    for (const path of ['ticket', 'read']) {
      const url = `/api/classes/${classA}/chat/${path}`;
      const anon = await app.inject({ method: 'POST', url });
      expect(anon.statusCode, `anon ${url}`).toBe(401);
      for (const who of ['teacherB', 'studentB'] as const) {
        const r = await app.inject({ method: 'POST', url, headers: a(who) });
        expect(r.statusCode, `${who} ${url}`).toBe(404);
      }
    }
    const ownTicket = await app.inject({ method: 'POST', url: `/api/classes/${classA}/chat/ticket`, headers: a('studentA') });
    expect(ownTicket.statusCode).toBe(200);
    expect(typeof ownTicket.json().ticket).toBe('string');
    const ownRead = await app.inject({ method: 'POST', url: `/api/classes/${classA}/chat/read`, headers: a('studentA') });
    expect(ownRead.statusCode).toBe(200);

    // ── отвязка telegram: чужой класс 404, ученик 403, аноним 401; строки не тронуты ──
    const chatA = '-1009000000001';
    const chatB = '-1009000000002';
    await t.db.insert(classTelegramChats).values([
      { classId: classA, chatId: chatA, linkedBy: teacherAId },
      { classId: classB, chatId: chatB, linkedBy: teacherBId },
    ]);
    const foreign = await app.inject({ method: 'DELETE', url: `/api/classes/${classA}/telegram/${chatA}`, headers: a('teacherB') });
    expect(foreign.statusCode).toBe(404);
    // чат, привязанный к СВОЕМУ классу B, через маршрут класса A тоже не удаляется
    const crossBound = await app.inject({ method: 'DELETE', url: `/api/classes/${classA}/telegram/${chatB}`, headers: a('teacherB') });
    expect(crossBound.statusCode).toBe(404);
    const pupil = await app.inject({ method: 'DELETE', url: `/api/classes/${classA}/telegram/${chatA}`, headers: a('studentA') });
    expect(pupil.statusCode).toBe(403);
    const anon = await app.inject({ method: 'DELETE', url: `/api/classes/${classA}/telegram/${chatA}` });
    expect(anon.statusCode).toBe(401);
    const bindings = await t.db.select({ classId: classTelegramChats.classId, chatId: classTelegramChats.chatId })
      .from(classTelegramChats);
    expect(bindings.map((b) => b.chatId).sort(), 'неудачные попытки не удалили ни одной привязки')
      .toEqual([chatA, chatB].sort());
    // контроль: владелец снимает свою привязку
    const own = await app.inject({ method: 'DELETE', url: `/api/classes/${classA}/telegram/${chatA}`, headers: a('teacherA') });
    expect(own.statusCode).toBe(200);
    const left = await t.db.select({ chatId: classTelegramChats.chatId }).from(classTelegramChats)
      .where(eq(classTelegramChats.classId, classA));
    expect(left.map((b) => b.chatId)).toEqual([]);

    // ── авторы рисунков: учительский маршрут, чужой урок 404, свой 200 ──
    const authors = `/api/lessons/${sessionA}/board/authors`;
    const anonAuthors = await app.inject({ method: 'GET', url: authors });
    expect(anonAuthors.statusCode).toBe(401);
    const pupilAuthors = await app.inject({ method: 'GET', url: authors, headers: a('studentA') });
    expect(pupilAuthors.statusCode).toBe(403);
    const foreignAuthors = await app.inject({ method: 'GET', url: authors, headers: a('teacherB') });
    expect(foreignAuthors.statusCode).toBe(404);
    const ownAuthors = await app.inject({ method: 'GET', url: authors, headers: a('teacherA') });
    expect(ownAuthors.statusCode).toBe(200);
    const counts = (ownAuthors.json() as { byAuthor: Record<string, number> }).byAuthor;
    expect(typeof counts).toBe('object');
    expect(Object.values(counts).every((n) => typeof n === 'number')).toBe(true);
  });

  it('student sheets are owner-only: B list empty, B patch/delete 404, teacher never sees them', async () => {
    const lb = await app.inject({ method: 'GET', url: '/api/student-notes', headers: a('studentB') });
    expect(lb.json()).toEqual([]);
    const pb = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('studentB'), payload: { body: 'x' } });
    expect(pb.statusCode).toBe(404);
    const db = await app.inject({ method: 'DELETE', url: `/api/student-notes/${sheetA}`, headers: a('studentB') });
    expect(db.statusCode).toBe(404);
    const byTeacher = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('teacherA'), payload: { body: 'x' } });
    expect(byTeacher.statusCode).toBe(404);
    const listTeacher = await app.inject({ method: 'GET', url: '/api/student-notes', headers: a('teacherA') });
    expect(listTeacher.json()).toEqual([]);
    // creating a sheet for a class you are NOT member of → 404
    const fake = await app.inject({ method: 'POST', url: '/api/student-notes', headers: a('studentB'), payload: { classId: classA, title: '', body: '' } });
    expect(fake.statusCode).toBe(404);
    const okA = await app.inject({ method: 'PATCH', url: `/api/student-notes/${sheetA}`, headers: a('studentA'), payload: { body: 'v2' } });
    expect(okA.statusCode).toBe(200);
  });

  // ── misc ────────────────────────────────────────────────────────────────────
  it('rtc spike route cannot be used to mint lesson-room tokens; telegram endpoints are owner-scoped', async () => {
    const lesson = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: a('studentA'), payload: { room: `lesson-${classA.slice(0, 8)}-abc` } });
    expect(lesson.statusCode).toBe(501); // lesson rooms live on the session flow only
    const spike = await app.inject({ method: 'POST', url: '/api/rtc/token', headers: a('studentA'), payload: { room: 'spike-9' } });
    expect(spike.statusCode).toBe(200);
    const anonSpike = await app.inject({ method: 'POST', url: '/api/rtc/token', payload: { room: 'spike-9' } });
    expect(anonSpike.statusCode).toBe(401);
    const linkB = await app.inject({ method: 'DELETE', url: '/api/me/telegram-link', headers: a('studentB') });
    expect(linkB.statusCode).toBe(200); // unlinks self only
    const tg = await app.inject({ method: 'GET', url: `/api/classes/${classA}/telegram`, headers: a('studentA') });
    expect(tg.statusCode).toBe(403);
  });

  it('extra edges: classId-filtered lists, self-kick, teacher on student routes, anon telegram-status', async () => {
    // notes list filtered by A class as B teacher → empty, no leak
    const nb = await app.inject({ method: 'GET', url: `/api/notes?classId=${classA}`, headers: a('teacherB') });
    expect(nb.json()).toEqual([]);
    // sheets scoped by someone else's session → empty
    const sb = await app.inject({ method: 'GET', url: `/api/student-notes?sessionId=${sessionA}`, headers: a('studentB') });
    expect(sb.json()).toEqual([]);
    // учитель не может «присоединиться к классу по коду»: маршрут выведен и отвечает 410 тому,
    // кто стучится, — роли и владения он не спрашивает вовсе (был 403 по роли, стал 410 по факту
    // вывода способа: проверять роль в маршруте, который ничего не делает, нечем)
    const tj = await app.inject({ method: 'POST', url: '/api/join-by-code', headers: a('teacherB'), payload: { code: 'ABCDEFGH' } });
    expect(tj.statusCode).toBe(410);
    expect(tj.json().error).toBe('enrollmentRetired');
    // AUDIT-H3 check: moderation of an ENDED session → 404 (like missing)
    const sk = await app.inject({ method: 'POST', url: `/api/lessons/${sessionA}/kick`, headers: a('teacherA'), payload: { identity: teacherAId } });
    expect(sk.statusCode).toBe(404);
    // on a LIVE session self-kick is rejected 400
    const live = await app.inject({ method: 'POST', url: '/api/lessons/start', headers: a('teacherA'), payload: { classId: classA } });
    const liveId = live.json().id as string;
    const selfKick = await app.inject({ method: 'POST', url: `/api/lessons/${liveId}/kick`, headers: a('teacherA'), payload: { identity: teacherAId } });
    expect(selfKick.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/lessons/${liveId}/end`, headers: a('teacherA') });
    // anonymous telegram status & spike rtc
    for (const url of ['/api/me/telegram-status', '/api/me/notify-prefs']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
    // B cannot publish notes into A class feed even via note create+publish chain
    const nc = await app.inject({ method: 'POST', url: '/api/notes', headers: a('teacherB'), payload: { classId: classA, title: 'x', body: 'y' } });
    expect(nc.statusCode).toBe(404);
  });

  it('sanity: A-side happy paths still work after audit (no over-blocking)', async () => {
    const cls = await app.inject({ method: 'GET', url: '/api/classes', headers: a('studentA') });
    expect(cls.json().some((c: { id: string }) => c.id === classA)).toBe(true);
    const feed = await app.inject({ method: 'GET', url: `/api/classes/${classA}/feed`, headers: a('studentA') });
    expect((feed.json() as unknown[]).length).toBeGreaterThan(0);
    const mine = await app.inject({ method: 'GET', url: '/api/me', headers: a('studentA') });
    expect(mine.json().role).toBe('student');
    const left = await app.inject({ method: 'POST', url: `/api/classes/${classB}/leave`, headers: a('studentA') });
    expect(left.statusCode).toBe(200); // studentA was force-added to B earlier — leaving must work
    const membersB = await app.inject({ method: 'GET', url: `/api/classes/${classB}/members`, headers: a('teacherB') });
    expect(membersB.json().some((m: { userId: string }) => m.userId === studentAId)).toBe(false);
  });
});
