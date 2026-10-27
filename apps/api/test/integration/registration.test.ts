/**
 * Регистрация по одноразовой ссылке — прежний сюжет «двухшаговой регистрации» (item 9).
 *
 * 2026-10-27. Шаги «проверить восьмизначный код класса → ввести данные» выведены из продукта
 * вместе с маршрутами `/api/auth/check-code` и `/api/auth/register`, и этот файл не про коды: он
 * про те же свойства приёма, которые проверялись там. Предпросмотр ничего не расходует; ученик,
 * бросивший регистрацию посреди пути, не стоит классу ничего; расход атомарен (две параллельные
 * регистрации с одним приглашением дают РОВНО один аккаунт); оба имени обязательны; отказ не
 * оставляет огрызка аккаунта и не сжигает приглашение. Всё это переехало на выживший путь —
 * `POST /api/invitations/preview` + `POST /api/invitations/register`.
 *
 * Одно свойство переезжать НЕ может, и это надо назвать прямо, чтобы потом не «починили». У кода
 * класса любое плохое состояние обязано было отвечать ОДНОЙ фразой: восьмизначный код перебирают,
 * и по разнице ответов атакующий узнал бы, что код существует но просрочен. У токена ссылки
 * состояний четыре и они названы по имени (`inviteInvalid` / `inviteExpired` / `inviteRevoked` /
 * `inviteUsed`) — потому что токен это 24 случайных байта, его не перебирают, а ученику,
 * пришедшему по просроченной ссылке, «ссылка не подходит» бесполезно: ему нужно сказать, что
 * просить у учителя НОВУЮ. Значит перечисление состояний здесь — не дыра, а контракт.
 *
 * Прежняя «неперечислимость» не исчезает, а переносится туда, где она что-то защищает: наружу ни
 * одно состояние чужого аккаунта не отвечает, пока не проверено приглашение. Проверка это и
 * держит — по списку почт с мусорным токеном нельзя узнать, есть ли такой адрес.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  TEST_DATABASE_URL, preparedDb, makeTeacher, makeStudent, loginToken, makeInviteLink,
  registerViaLink, type TestDB,
} from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { classMembers, classes, inviteCodes, users } from '../../src/db/schema.js';
import { REQUEST_ID_PATTERN } from '../../src/lib/requestId.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PAGE_ORIGIN = 'https://blublu.example';
const PW = 'Secret1234';

suite('регистрация по одноразовой ссылке (бывший item 9)', () => {
  let t: TestDB;
  let app: FastifyInstance;
  let teacherId = '';
  let teacherTok = '';
  let classId = '';

  /** предпросмотр — локальный хелпер: в `util.ts` его нет, а проверять надо именно маршрут. */
  const preview = (token: string) => app.inject({ method: 'POST', url: '/api/invitations/preview', payload: { token } });
  const revoke = (inviteId: string) => app.inject({
    method: 'POST', url: `/api/classes/${classId}/invites/${inviteId}/revoke`,
    headers: { authorization: `Bearer ${teacherTok}` },
  });
  /** строка приглашения класса по его id — только состояние, без токена */
  const linkRow = async (id: string) => (await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).limit(1))[0]!;
  /**
   * Почему регистрация не удалась — СМОТРИМ КОД ОТКАЗА, а не тело ответа: в теле лежит почта
   * ученика, и в сообщение её печатать нельзя даже в тесте.
   */
  const refusal = (res: { json: Record<string, unknown> }) => String((res.json as { error?: string }).error ?? 'no error');

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    // ссылка обязана собираться из публичного адреса: без него маршрут отвечает 503, и фикстура
    // молча сломалась бы на первом же шаге
    env.PUBLIC_URL = PAGE_ORIGIN;
    app = await buildApp(t.db);
    const teacher = await makeTeacher(t.sql, `reg9t${Date.now()}@x.io`);
    teacherId = teacher.id;
    teacherTok = await loginToken(app, teacher.email, teacher.password);
    const [c] = await t.db.insert(classes).values({ teacherId, name: 'Reg9' }).returning();
    classId = c!.id;
  });
  afterAll(async () => {
    env.PUBLIC_URL = '';
    await app?.close();
    await t?.sql.end();
  });

  it('предпросмотр валидирует, не расходуя (дважды), а шаг 2 завершается', async () => {
    const link = await makeInviteLink(app, teacherTok, classId);
    const email = `r9a${Date.now()}@x.io`;

    const a = await preview(link.token);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().className).toBe('Reg9');
    // всё ещё жива: предпросмотр не имеет права ничего сжигать
    expect((await linkRow(link.id)).usedAt).toBeNull();

    const b = await preview(link.token);
    expect(b.statusCode, b.body).toBe(200);

    const r = await registerViaLink(app, link.token, {
      email, firstName: 'Ханс', lastName: 'Мюller', password: PW,
    });
    expect(r.statusCode, refusal(r)).toBe(200);
    const user = (r.json as { user: { name: string; lastName: string; role: string; email: string } }).user;
    expect(user.role).toBe('student');
    // имя и фамилия хранятся раздельно — ровно то, ради чего в item 9 ввели вторую колонку
    expect(user.name).toBe('Ханс');
    expect(user.lastName).toBe('Мюller');
    const [row] = await t.db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row.lastName, 'фамилия легла в свою колонку, а не в конец имени').toBe('Мюller');
    expect(row.name).toBe('Ханс');
  });

  it('ушедший посреди регистрации не стоит классу ничего: ссылку берёт следующий ученик', async () => {
    const link = await makeInviteLink(app, teacherTok, classId);
    // «открыл, посмотрел и закрыл» — ни одного вызова register
    expect((await preview(link.token)).statusCode).toBe(200);

    const r = await registerViaLink(app, link.token, { email: `r9b${Date.now()}@x.io`, password: PW });
    expect(r.statusCode, refusal(r)).toBe(200);
  });

  /**
   * ЧЕТЫРЕ разных ответа вместо одного «неверный код» — осознанная смена контракта, она
   * объяснена в шапке файла. Здесь важно и второе: у каждого отказа есть `reqId`, по которому
   * строку найдут в access-логе, а форма отказа (400 + код + id) одинакова для всех четырёх.
   */
  it('состояния токена различимы: неверный, просроченный, отозванный, использованный', async () => {
    const bodies: Record<string, unknown>[] = [];

    const junk = await preview('n'.repeat(32));
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error).toBe('inviteInvalid');
    bodies.push(junk.json() as Record<string, unknown>);

    const expired = await makeInviteLink(app, teacherTok, classId);
    await t.db.update(inviteCodes).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(inviteCodes.id, expired.id));
    const expiredRes = await preview(expired.token);
    expect(expiredRes.json().error).toBe('inviteExpired');
    bodies.push(expiredRes.json() as Record<string, unknown>);

    const revoked = await makeInviteLink(app, teacherTok, classId);
    expect((await revoke(revoked.id)).statusCode).toBe(200);
    const revokedRes = await preview(revoked.token);
    expect(revokedRes.json().error).toBe('inviteRevoked');
    bodies.push(revokedRes.json() as Record<string, unknown>);

    const used = await makeInviteLink(app, teacherTok, classId);
    expect((await registerViaLink(app, used.token, { email: `r9c${Date.now()}@x.io`, password: PW })).statusCode).toBe(200);
    const afterUse = await preview(used.token);
    expect(afterUse.statusCode).toBe(400);
    expect(afterUse.json().error).toBe('inviteUsed');
    bodies.push(afterUse.json() as Record<string, unknown>);

    const codes = bodies.map((b) => String(b.error));
    expect(new Set(codes).size, 'состояния не схлопнулись в одно слово').toBe(4);
    for (const b of bodies) {
      expect(REQUEST_ID_PATTERN.test(String(b.reqId)), 'у каждого отказа есть id для разбора').toBe(true);
    }
  });

  /**
   * Эквивалент прежнего «по коду нельзя перечислять» — в выжившем дизайне он звучит так: ни один
   * ответ про чужой аккаунт не выходит, пока не проверено приглашение. Мусорный токен обязан
   * ответить `inviteInvalid`, а не `emailTaken`, иначе список адресов прогоняется по любому
   * неподходящему значению. Разница с кодом названа в шапке: здесь токен не угадывается, поэтому
   * запрет держится не на одинаковом ответе, а на ПОРЯДКЕ проверок.
   */
  it('мусорный токен не отвечает про адрес: занятая почта звучит только для настоящего приглашения', async () => {
    const taken = `r9d${Date.now()}@x.io`;
    // аккаунт есть, но ВНЕ класса: фикстура не должна мешать подсчётам членств в других проверках
    await makeStudent(t.sql, { classId, email: taken, member: false });

    const probe = await app.inject({
      method: 'POST', url: '/api/invitations/register',
      payload: { token: 'm'.repeat(32), firstName: 'Список', lastName: 'Адресов', email: taken, password: PW },
    });
    expect(probe.statusCode).toBe(400);
    expect(probe.json().error, 'сначала приглашение, потом всё остальное').toBe('inviteInvalid');

    // и предпросмотр по чужому мусору не выдаёт ни класса, ни признака «такой адрес есть»
    const peek = await preview('m'.repeat(32));
    expect(Object.keys(peek.json()).sort()).toEqual(['error', 'reqId']);

    // настоящий токен получает честный 409 — и ссылка при этом НЕ сожжена
    const link = await makeInviteLink(app, teacherTok, classId);
    const real = await registerViaLink(app, link.token, { email: taken, password: PW });
    expect(real.statusCode).toBe(409);
    expect((real.json as { error: string }).error).toBe('emailTaken');
    expect((await linkRow(link.id)).usedAt, 'отказ по почте не тратит приглашение').toBeNull();
  });

  it('гонка: две параллельные регистрации с ОДНОЙ ссылкой → ровно один аккаунт', async () => {
    const link = await makeInviteLink(app, teacherTok, classId);
    const stamp = Date.now();
    const both = await Promise.all([
      registerViaLink(app, link.token, { email: `r9e${stamp}@x.io`, firstName: 'Гонка', lastName: 'Один', password: PW }),
      registerViaLink(app, link.token, { email: `r9f${stamp}@x.io`, firstName: 'Гонка', lastName: 'Два', password: PW }),
    ]);
    const okCount = both.filter((r) => r.statusCode === 200).length;
    expect(okCount, 'успех обязан быть ровно одним').toBe(1);
    const refused = both.filter((r) => r.statusCode !== 200);
    expect(refused).toHaveLength(1);
    expect((refused[0]!.json as { error: string }).error).toBe('inviteUsed');

    const created = await t.db.select({ id: users.id }).from(users).where(eq(users.name, 'Гонка'));
    expect(created, 'проигравший не оставил аккаунта').toHaveLength(1);
    const members = await t.db.select().from(classMembers)
      .where(and(eq(classMembers.classId, classId), eq(classMembers.userId, created[0]!.id)));
    expect(members, 'и членство одно — расход и вставка идут одним ходом').toHaveLength(1);
    expect((await linkRow(link.id)).usedBy, 'приглашение записано на победителя').toBe(created[0]!.id);
  });

  it('без второго имени регистрация не проходит, а ссылка остаётся целой', async () => {
    const link = await makeInviteLink(app, teacherTok, classId);
    const r = await app.inject({
      method: 'POST', url: '/api/invitations/register',
      payload: { token: link.token, firstName: 'Без', email: `r9g${Date.now()}@x.io`, password: PW },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalidInput');
    expect((await linkRow(link.id)).usedAt, 'отказ по форме не сжигает приглашение').toBeNull();
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.name, 'Без')), 'огрызка аккаунта не осталось')
      .toHaveLength(0);

    // той же ссылкой можно довести дело до конца, когда оба имени на месте
    const again = await registerViaLink(app, link.token, { email: `r9h${Date.now()}@x.io`, firstName: 'Без', lastName: 'Фамилии', password: PW });
    expect(again.statusCode, refusal(again)).toBe(200);
  });

  it('прежние аккаунты работают: пустая фамилия по умолчанию и она же необязательна в профиле', async () => {
    // makeTeacher вставляет строку без last_name → дефолт ''
    const teacher = await makeTeacher(t.sql, `r9old${Date.now()}@x.io`);
    const tok = await loginToken(app, teacher.email, teacher.password);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tok}` } });
    expect((me.json() as { lastName: string }).lastName).toBe('');
    const p = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers: { authorization: `Bearer ${tok}` },
      payload: { name: 'Tch', lastName: '', locale: 'en', tz: 'Asia/Tashkent' },
    });
    expect(p.statusCode).toBe(200);
    expect((p.json() as { lastName: string }).lastName).toBe('');
  });
});
