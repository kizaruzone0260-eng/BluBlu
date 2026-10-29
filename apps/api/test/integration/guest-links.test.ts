/**
 * Задача 2026-10-28, часть 3 — гостевой доступ к уроку по ссылке с одобрением учителя.
 *
 * Десять `it`-блоков повторяют десять сценариев брифа один к одному:
 *  1. валидная ссылка открывает страницу гостя без регистрации;
 *  2. новый запрос виден ПРАВИЛЬНОМУ учителю;
 *  3. до одобрения нет ни LiveKit-токена, ни защищённых данных;
 *  4. после одобрения выдаются только права зрителя;
 *  5. отказ блокирует вход;
 *  6. отзыв ссылки и конец урока закрывают дверь;
 *  7. просроченный/поддельный/повторно использованный токен не открывает ничего;
 *  8. гость не попадает на другой урок и не получает прав учителя;
 *  9. чужие классы и неуполномоченные пользователи изолированы;
 * 10. повторные и параллельные запросы обрабатываются корректно.
 *
 * Чего здесь нет и почему: настоящего подключения к LiveKit. Токен проверяется криптографически
 * (`TokenVerifier`) — это доказывает права и комнату, но не то, что комната их чтит; это делает
 * e2e (`apps/e2e/tests/guest-lesson.spec.ts`) против живого медиа-сервера. Отключение гостя из
 * комнаты (`removeParticipant`) здесь тоже не наблюдается: медиа-сервера нет, и вызов честно
 * проваливается в `catch` — запись в базе при этом уже закрывает дверь, что и проверяется.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { TokenVerifier } from 'livekit-server-sdk';
import type { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, makeStudent, loginToken, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import {
  auditLog, classMembers, classes, lessonGuestLinks, lessonGuestRequests, lessonSessions,
} from '../../src/db/schema.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';
/**
 * Ключ гостя — то, что браузер генерирует сам и хранит в localStorage вкладки. Здесь он фиксирован:
 * тест должен отличать «мою» заявку от чужой, а не проверять случайность (она в юните).
 */
const GUEST_KEY = 'guestkey-0123456789abcdef';
const GUEST_KEY_B = 'guestkey-fedcba9876543210';

suite('guest lesson links (part 3)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherTok = '';
  let otherTok = '';
  let studentTok = '';
  let teacherId = '';
  let classId = '';
  let otherClassId = '';
  let sessionId = '';
  let otherSessionId = '';
  let roomName = '';
  let otherRoomName = '';

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const post = (tok: string, url: string, body: unknown = {}) =>
    app.inject({ method: 'POST', url, headers: auth(tok), payload: body as object });
  const get = (tok: string, url: string) => app.inject({ method: 'GET', url, headers: auth(tok) });
  /** Гость: публичный POST без токена и без cookie — ровно как страница `/guest`. */
  const guest = (url: string, body: unknown = {}) => app.inject({ method: 'POST', url, payload: body as object });
  const verifier = () => new TokenVerifier(
    process.env.LIVEKIT_API_KEY ?? 'devkey',
    process.env.LIVEKIT_API_SECRET ?? 'devsecretdevsecretdevsecret123456',
  );

  const activeLinkRows = () => t.db.select().from(lessonGuestLinks).where(and(
    eq(lessonGuestLinks.sessionId, sessionId),
    isNull(lessonGuestLinks.revokedAt),
    gt(lessonGuestLinks.expiresAt, new Date()),
  ));

  /** Новая ссылка — единственным продуктом-путём; возвращает одноразовый токен из фрагмента. */
  async function newLink(): Promise<string> {
    const r = await post(teacherTok, `/api/lessons/${sessionId}/guest-link`);
    expect(r.statusCode, r.body).toBe(201);
    const url = (r.json() as { url: string }).url;
    expect(url).toContain('/guest#');
    return url.split('#')[1]!;
  }

  async function guests(): Promise<{
    link: { active: boolean; createdAt: string; expiresAt: string } | null;
    requests: { id: string; name: string; status: string; createdAt: string }[];
    pending: number;
  }> {
    const r = await get(teacherTok, `/api/lessons/${sessionId}/guests`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }

  async function requestOf(name: string) {
    const found = (await guests()).requests.find((x) => x.name === name);
    expect(found, `заявка «${name}» видна учителю`).toBeTruthy();
    return found!;
  }

  async function approve(name: string) {
    const r = await post(teacherTok, `/api/lessons/${sessionId}/guests/${(await requestOf(name)).id}/approve`);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { status: string }).status).toBe('approved');
  }

  /** Журнал пишется «выстрелил и забыл»: ждём появления строки, а не спим фиксированно. */
  async function auditRow(action: string, contains: string) {
    for (let i = 0; i < 80; i++) {
      const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, action));
      const row = rows.reverse().find((r) => JSON.stringify(r.target).includes(contains));
      if (row) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, 'gl-t@x.io', 'GL Teacher');
    const other = await makeTeacher(t.sql, 'gl-o@x.io', 'GL Other');
    teacherId = teacher.id;
    const [cls] = await t.db.insert(classes).values({ name: 'Guest A', teacherId: teacher.id }).returning();
    const [otherCls] = await t.db.insert(classes).values({ name: 'Guest B', teacherId: other.id }).returning();
    classId = cls!.id;
    otherClassId = otherCls!.id;
    const student = await makeStudent(t.sql, { classId, email: 'gl-s@x.io', name: 'GL Student' });
    await t.db.insert(classMembers).values({ classId: otherClassId, userId: student.id }).onConflictDoNothing();
    teacherTok = await loginToken(app, teacher.email, PW);
    otherTok = await loginToken(app, other.email, PW);
    studentTok = await loginToken(app, student.email, PW);

    const started = await post(teacherTok, '/api/lessons/start', { classId });
    expect(started.statusCode).toBe(201);
    sessionId = (started.json() as { id: string }).id;
    roomName = (started.json() as { roomName: string }).roomName;
    const otherStarted = await post(otherTok, '/api/lessons/start', { classId: otherClassId });
    expect(otherStarted.statusCode).toBe(201);
    otherSessionId = (otherStarted.json() as { id: string }).id;
    otherRoomName = (otherStarted.json() as { roomName: string }).roomName;
    expect(otherRoomName).not.toBe(roomName);
  });

  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('1. a valid link opens the guest page with no registration and no account data', async () => {
    const token = await newLink();
    const pv = await guest('/api/guest/preview', { token });
    expect(pv.statusCode, pv.body).toBe(200);
    // РОВНО эти поля: класс и срок. Ни сессии, ни комнаты, ни учителя, ни участников.
    expect(pv.json()).toEqual({ state: 'ok', className: 'Guest A', expiresAt: expect.any(String) });
    expect(pv.body).not.toContain(sessionId);
    expect(pv.body).not.toContain(teacherId);
    expect(pv.body).not.toContain(roomName);
    expect(pv.headers['set-cookie']).toBeUndefined();

    // В базе — только хеш: ни токен, ни его префикс не хранятся открытым текстом.
    const rows = await t.db.select().from(lessonGuestLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);

    // Открытие ссылки ничего не расходует: предпросмотр можно повторять сколько угодно.
    expect((await guest('/api/guest/preview', { token })).statusCode).toBe(200);
  });

  it('2. a new request reaches exactly the teacher who owns the lesson', async () => {
    const token = await newLink();
    const r = await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Dilnoza' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ status: 'pending' });

    const list = await guests();
    expect(list.link).toMatchObject({ active: true });
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ name: 'Dilnoza', status: 'pending' });
    expect(list.pending).toBe(1);

    // Чужой учитель не видит ни списка, ни ссылки; ученик не управляет гостями вообще.
    expect((await get(otherTok, `/api/lessons/${sessionId}/guests`)).statusCode).toBe(404);
    expect((await get(studentTok, `/api/lessons/${sessionId}/guests`)).statusCode).toBe(403);

    // Журнал: заявка записана, но без имени гостя — имя он вводит сам, аудиту оно не нужно.
    const row = await auditRow('guest_access_request', (await requestOf('Dilnoza')).id);
    expect(row, 'guest_access_request записан').toBeTruthy();
    expect(JSON.stringify(row!.target)).not.toContain('Dilnoza');
  });

  it('3. before approval there is no LiveKit token and no protected data', async () => {
    const token = await newLink();
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Pre Approve' })).statusCode).toBe(201);

    const rtc = await guest('/api/guest/rtc', { token, key: GUEST_KEY });
    expect(rtc.statusCode).toBe(403);
    expect(rtc.json()).toMatchObject({ error: 'guestApprovalRequired' });
    expect((rtc.json() as { token?: string }).token).toBeUndefined();
    expect(rtc.headers['set-cookie']).toBeUndefined();

    expect((await guest('/api/guest/status', { token, key: GUEST_KEY })).json()).toEqual({ status: 'pending' });

    // Токен ссылки — не пользовательский access-токен: обычные API его не принимают.
    const asUser = await app.inject({
      method: 'GET', url: `/api/lessons/active?classId=${classId}`, headers: auth(token),
    });
    expect(asUser.statusCode).toBe(401);
    const board = await app.inject({ method: 'GET', url: `/api/lessons/${sessionId}/board`, headers: auth(token) });
    expect(board.statusCode).toBe(401);
  });

  it('4. after approval the guest gets the viewer grant only', async () => {
    const token = await newLink();
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Approved Guest' })).statusCode).toBe(201);
    const id = (await requestOf('Approved Guest')).id;
    await approve('Approved Guest');

    const rtc = await guest('/api/guest/rtc', { token, key: GUEST_KEY });
    expect(rtc.statusCode, rtc.body).toBe(200);
    const body = rtc.json() as { token: string; wsUrl: string; room: string };
    expect(body.room).toBe(roomName);
    const claims = await verifier().verify(body.token);
    expect(claims.video?.room).toBe(roomName);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish, 'гость не публикует ни звук, ни видео').toBe(false);
    expect(claims.video?.canSubscribe).toBe(true);
    expect(claims.video?.canPublishData, 'гость не шлёт данные в комнату').toBe(false);
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.sub).toBe(`guest:${id}`);
    expect(claims.name).toBe('Approved Guest');
    // короткая жизнь: перевыпуск только через сервер после повторной проверки заявки
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(61);

    expect((await auditRow('guest_access_approve', id))).toBeTruthy();
  });

  it('5. a refusal blocks the entrance, and an approved guest can be removed', async () => {
    const token = await newLink();
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Refused Guest' })).statusCode).toBe(201);
    const refusedId = (await requestOf('Refused Guest')).id;
    const rj = await post(teacherTok, `/api/lessons/${sessionId}/guests/${refusedId}/reject`);
    expect(rj.statusCode).toBe(200);
    expect((rj.json() as { status: string }).status).toBe('rejected');

    const rtc = await guest('/api/guest/rtc', { token, key: GUEST_KEY });
    expect(rtc.statusCode).toBe(410);
    expect(rtc.json()).toMatchObject({ error: 'guestRequestRejected' });
    expect((await guest('/api/guest/status', { token, key: GUEST_KEY })).json()).toEqual({ status: 'rejected' });
    // повтор заявки с тем же ключом не отменяет решение учителя сам по себе
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Refused Guest' })).json())
      .toEqual({ status: 'rejected' });
    expect((await auditRow('guest_access_reject', refusedId))).toBeTruthy();

    // Второй гость: одобрен, затем «убрать из урока» — токен больше не выдаётся.
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY_B, name: 'Removed Guest' })).statusCode).toBe(201);
    await approve('Removed Guest');
    const removeId = (await requestOf('Removed Guest')).id;
    expect((await guest('/api/guest/rtc', { token, key: GUEST_KEY_B })).statusCode).toBe(200);
    expect((await post(teacherTok, `/api/lessons/${sessionId}/guests/${removeId}/reject`)).statusCode).toBe(200);
    expect((await guest('/api/guest/rtc', { token, key: GUEST_KEY_B })).statusCode).toBe(410);
  });

  it('6. revoking the link and ending the lesson close the door for new connections', async () => {
    const revokedToken = await newLink();
    expect((await guest('/api/guest/request', { token: revokedToken, key: GUEST_KEY, name: 'Revoked Guest' })).statusCode).toBe(201);
    await approve('Revoked Guest');
    expect((await guest('/api/guest/rtc', { token: revokedToken, key: GUEST_KEY })).statusCode).toBe(200);

    const rv = await post(teacherTok, `/api/lessons/${sessionId}/guest-link/revoke`);
    expect(rv.statusCode).toBe(200);
    expect((rv.json() as { revoked: number }).revoked).toBe(1);
    expect((await guest('/api/guest/preview', { token: revokedToken })).statusCode).toBe(410);
    const revokedRtc = await guest('/api/guest/rtc', { token: revokedToken, key: GUEST_KEY });
    expect(revokedRtc.statusCode).toBe(410);
    expect(revokedRtc.json()).toMatchObject({ error: 'guestLinkRevoked' });
    expect((await auditRow('guest_link_revoke', sessionId))).toBeTruthy();

    // Урок закончился — даже новая, только что выпущенная ссылка больше не открывается.
    const endToken = await newLink();
    expect((await guest('/api/guest/request', { token: endToken, key: GUEST_KEY, name: 'End Guest' })).statusCode).toBe(201);
    await approve('End Guest');
    expect((await guest('/api/guest/rtc', { token: endToken, key: GUEST_KEY })).statusCode).toBe(200);

    expect((await post(teacherTok, `/api/lessons/${sessionId}/end`)).statusCode).toBe(200);
    const endedPreview = await guest('/api/guest/preview', { token: endToken });
    expect(endedPreview.statusCode).toBe(410);
    expect(endedPreview.json()).toMatchObject({ error: 'lessonEnded' });
    expect((await guest('/api/guest/rtc', { token: endToken, key: GUEST_KEY })).json())
      .toMatchObject({ error: 'lessonEnded' });
    // «старый одобренный ответ» не переоткрывает урок: статус заявки отвечает «урок закончен»
    expect((await guest('/api/guest/status', { token: endToken, key: GUEST_KEY })).json())
      .toEqual({ status: 'ended' });

    // Продолжение сценариев: новый урок — новая сессия и новая дверь.
    const restart = await post(teacherTok, '/api/lessons/start', { classId });
    expect(restart.statusCode).toBe(201);
    const next = restart.json() as { id: string; roomName: string };
    expect(next.id).not.toBe(sessionId);
    sessionId = next.id;
    roomName = next.roomName;
  });

  it('7. expired, forged and reused tokens never open the door', async () => {
    const forged = 'A'.repeat(43);
    const forgedRes = await guest('/api/guest/preview', { token: forged });
    expect(forgedRes.statusCode).toBe(404);
    expect(forgedRes.json()).toMatchObject({ error: 'guestLinkInvalid' });
    expect((await guest('/api/guest/preview', { token: 'short' })).statusCode).toBe(404);

    // Просроченная ссылка: TTL сдвинут в прошлое напрямую в базе — так выглядит урок, который
    // забыли завершить; ответ обязан быть «истекла», а не 500 и не «пустим».
    const token = await newLink();
    await t.db.update(lessonGuestLinks).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(and(eq(lessonGuestLinks.sessionId, sessionId), isNull(lessonGuestLinks.revokedAt)));
    const expired = await guest('/api/guest/preview', { token });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: 'guestLinkExpired' });
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Late' })).statusCode).toBe(410);

    // Ротация: старая ссылка погашена новой — «сохранённая у кого-то в переписке» не работает.
    const fresh = await newLink();
    expect((await guest('/api/guest/preview', { token })).statusCode).toBe(410);
    expect((await guest('/api/guest/preview', { token: fresh })).statusCode).toBe(200);

    // Старый одобренный допуск нельзя «переиграть» после отзыва ссылки.
    expect((await guest('/api/guest/request', { token: fresh, key: GUEST_KEY, name: 'Replay Guest' })).statusCode).toBe(201);
    await approve('Replay Guest');
    expect((await guest('/api/guest/rtc', { token: fresh, key: GUEST_KEY })).statusCode).toBe(200);
    expect((await post(teacherTok, `/api/lessons/${sessionId}/guest-link/revoke`)).statusCode).toBe(200);
    expect((await guest('/api/guest/rtc', { token: fresh, key: GUEST_KEY })).statusCode).toBe(410);
  });

  it('8. a guest cannot reach another lesson, edit the board or gain teacher powers', async () => {
    const token = await newLink();
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Scope Guest' })).statusCode).toBe(201);
    // Клиентские поля «я уже одобрен», «другой урок», «другая роль» не принимаются: схема маршрута
    // читает только token/key/name, а состояние выводится из базы.
    const sneaky = await guest('/api/guest/request', {
      token, key: GUEST_KEY, name: 'Scope Guest',
      status: 'approved', sessionId: otherSessionId, requestId: '00000000-0000-4000-8000-000000000000',
      role: 'teacher',
    });
    expect(sneaky.statusCode).toBe(200);
    expect(sneaky.json()).toEqual({ status: 'pending' });

    await approve('Scope Guest');
    const id = (await requestOf('Scope Guest')).id;
    const rtc = await guest('/api/guest/rtc', {
      token, key: GUEST_KEY, sessionId: otherSessionId, room: otherRoomName, role: 'teacher',
    });
    expect(rtc.statusCode).toBe(200);
    const claims = await verifier().verify((rtc.json() as { token: string }).token);
    // комната — только своя сессия, а не та, что попросил клиент
    expect(claims.video?.room).toBe(roomName);
    expect(claims.video?.room).not.toBe(otherRoomName);
    expect(claims.sub).toBe(`guest:${id}`);
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.video?.roomCreate).toBeFalsy();
    expect(claims.video?.roomList).toBeFalsy();
    expect(claims.video?.canUpdateOwnMetadata).toBeFalsy();

    // Доска и завершение урока — только с пользовательской сессией; у гостя её нет.
    const board = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`,
      payload: { page: 2 }, headers: auth(token),
    });
    expect(board.statusCode).toBe(401);
    const noAuthBoard = await app.inject({
      method: 'PUT', url: `/api/lessons/${sessionId}/board/page`, payload: { page: 2 },
    });
    expect(noAuthBoard.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/lessons/${sessionId}/end`, payload: {} })).statusCode).toBe(401);
  });

  it('9. requests from other classes and from unauthorised users are isolated', async () => {
    const token = await newLink();
    expect((await guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Cross Guest' })).statusCode).toBe(201);
    const reqId = (await requestOf('Cross Guest')).id;

    // Чужой учитель: ни списка, ни ссылки, ни решения по чужой заявке.
    expect((await get(otherTok, `/api/lessons/${sessionId}/guests`)).statusCode).toBe(404);
    expect((await post(otherTok, `/api/lessons/${sessionId}/guest-link`)).statusCode).toBe(404);
    expect((await post(otherTok, `/api/lessons/${sessionId}/guest-link/revoke`)).statusCode).toBe(404);
    expect((await post(otherTok, `/api/lessons/${sessionId}/guests/${reqId}/approve`)).statusCode).toBe(404);
    // Даже со СВОИМ уроком заявка чужой сессии не находится: фильтр по session_id в запросе.
    expect((await post(otherTok, `/api/lessons/${otherSessionId}/guests/${reqId}/approve`)).statusCode).toBe(404);
    expect((await post(otherTok, `/api/lessons/${otherSessionId}/guests/${reqId}/reject`)).statusCode).toBe(404);

    // Ученик — не учитель: управление гостями закрыто целиком.
    expect((await post(studentTok, `/api/lessons/${sessionId}/guest-link`)).statusCode).toBe(403);
    expect((await post(studentTok, `/api/lessons/${sessionId}/guests/${reqId}/approve`)).statusCode).toBe(403);
    expect((await post(studentTok, `/api/lessons/${sessionId}/guest-link/revoke`)).statusCode).toBe(403);

    // Ссылка класса B — своя дверь и свой список; заявка класса A там не видна.
    expect((await get(otherTok, `/api/lessons/${otherSessionId}/guests`)).json())
      .toMatchObject({ link: null, requests: [], pending: 0 });
    expect((await requestOf('Cross Guest')).status).toBe('pending');
  });

  it('10. repeated and parallel requests are handled correctly', async () => {
    const token = await newLink();
    // Один и тот же гость (ключ) не плодит строки: insert + уникальный индекс, повтор читает ту же.
    const [first, second] = await Promise.all([
      guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Parallel Guest' }),
      guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Parallel Guest' }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    const storm = await Promise.all(Array.from({ length: 6 }, () =>
      guest('/api/guest/request', { token, key: GUEST_KEY, name: 'Parallel Guest' })));
    expect(storm.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    const rows = await t.db.select().from(lessonGuestRequests)
      .where(eq(lessonGuestRequests.sessionId, sessionId));
    const parallel = rows.filter((r) => r.name === 'Parallel Guest');
    expect(parallel).toHaveLength(1);

    // Повторное одобрение идемпотентно: и статус, и строка остаются одними.
    const id = parallel[0]!.id;
    const [a1, a2] = await Promise.all([
      post(teacherTok, `/api/lessons/${sessionId}/guests/${id}/approve`),
      post(teacherTok, `/api/lessons/${sessionId}/guests/${id}/approve`),
    ]);
    expect([a1.statusCode, a2.statusCode]).toEqual([200, 200]);
    const after = await t.db.select().from(lessonGuestRequests).where(eq(lessonGuestRequests.id, id));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('approved');

    // Два «создать ссылку» одновременно — одна активная дверь, а не две.
    const made = await Promise.all([
      post(teacherTok, `/api/lessons/${sessionId}/guest-link`),
      post(teacherTok, `/api/lessons/${sessionId}/guest-link`),
    ]);
    expect(made.map((r) => r.statusCode)).toEqual([201, 201]);
    const active = await activeLinkRows();
    expect(active).toHaveLength(1);
    const tokens = made.map((r) => (r.json() as { url: string }).url.split('#')[1]!);
    expect(tokens[0]).not.toBe(tokens[1]);
    const previews = await Promise.all(tokens.map((x) => guest('/api/guest/preview', { token: x })));
    expect(previews.filter((p) => p.statusCode === 200)).toHaveLength(1);
    expect(previews.filter((p) => p.statusCode === 410)).toHaveLength(1);
  });
});
