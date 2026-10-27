/**
 * Полный сценарий stage-1 API на настоящем Postgres.
 * Требует DATABASE_URL_TEST (docker compose из тестовой композации), иначе suite пропускается.
 *
 * 2026-10-27. Приём в класс по восьмизначному коду класса выведен из продукта, и три проверки
 * этого файла жили именно на нём. Сюжет не исчез — он переехал на выживший путь:
 *  • «учитель создаёт класс и код, ученик регистрируется по коду один раз, повтор не проходит» →
 *    то же на одноразовой ССЫЛКЕ: `POST /api/classes/:id/invites/link` и
 *    `POST /api/invitations/register`; повторный заход слышит `inviteUsed`;
 *  • «перебор кода закрывает адрес» → привратник мусорных токенов приглашения
 *    (`lib/inviteThrottle.ts`); цифры берутся из тех же констант, что их применяют, а полный
 *    разбор этого слоя ведут `invite-limit.test.ts` и `invite-throttle.test.ts` — здесь только
 *    то, что проверял этот файл: форма отказа (429, переводимый код, `retry-after`, `reqId`);
 *  • фикстура «правил доступа (§7)», которая заводила ученика кодом, заводит его ссылкой.
 *
 * Отдельно добавлена проверка самого факта вывода: `POST /api/auth/register` обязан отвечать
 * 410 `enrollmentRetired` и НЕ создавать аккаунт. Мёртвый маршрут, который ещё что-то делает,
 * был бы второй системой регистрации.
 *
 * Разница, которую нельзя «починить»: у кода класса любое плохое состояние отвечало ОДНОЙ
 * фразой, потому что код перебирают. У токена ссылки четыре состояния называются по имени —
 * 24 случайных байта не угадываются, а ученику нужно знать, просить ли новую ссылку.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, loginToken, makeInviteLink, registerViaLink, type TestDB } from './util';
import { buildApp } from '../../src/app';
import { env } from '../../src/env';
import { classMembers, inviteCodes, users } from '../../src/db/schema';
import { PROD_IP_FAILURE_MAX_PER_MIN } from '../../src/lib/prodConfig';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PAGE_ORIGIN = 'https://blublu.example';
const PW = 'Secret1234';

suite('stage 1: accounts, classes, invite links, members', () => {
  let t: TestDB;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    // без публичного адреса ссылка не собирается, и маршрут отвечает 503 — фикстура обязана
    // дать именно продукт, а не «ссылку, которой нет»
    env.PUBLIC_URL = PAGE_ORIGIN;
  });
  afterAll(async () => {
    env.PUBLIC_URL = '';
    await t?.sql.end();
  });

  async function freshApp(): Promise<FastifyInstance> {
    return buildApp(t.db);
  }
  /** кука `klass_rt` в ответе: Fastify отдаёт её и строкой, и массивом — сводим к одному виду */
  const cookieHeader = (raw: unknown): string => (Array.isArray(raw) ? raw.join('\n') : String(raw ?? ''));

  it('teacher creates class + link; pupil registers by link once; reuse answers inviteUsed', async () => {
    const app = await freshApp();
    const teacher = await makeTeacher(t.sql, `t${Date.now()}@x.io`);
    const at = await loginToken(app, teacher.email, teacher.password);
    const auth = { authorization: `Bearer ${at}` };

    const cls = await app.inject({ method: 'POST', url: '/api/classes', headers: auth, payload: { name: 'Math 7A' } });
    expect(cls.statusCode).toBe(201);
    const classId = cls.json().id as string;

    const link = await makeInviteLink(app, at, classId, { ttlDays: 7 });
    expect(link.url.startsWith(`${PAGE_ORIGIN}/join#`), 'публичный адрес берётся из PUBLIC_URL').toBe(true);

    const reg = await app.inject({
      method: 'POST', url: '/api/invitations/register',
      payload: { token: link.token, firstName: 'Alice', lastName: 'Test', email: 'alice@x.io', password: PW },
    });
    // сообщение — код отказа, а не тело: в теле лежит почта ученика
    expect(reg.statusCode, String(reg.json().error ?? 'no error')).toBe(200);
    const body = reg.json() as { accessToken: string; user: { role: string }; classId: string };
    expect(body.user.role).toBe('student');
    expect(body.classId, 'экрану нужно показать класс, в который привела ссылка').toBe(classId);
    // этот вызов идёт напрямую, а не через `registerViaLink`: проверять нужно ЗАГОЛОВКИ ответа —
    // ссылка выдаёт настоящую сессию, а не только access-токен
    expect(cookieHeader(reg.headers['set-cookie'])).toContain('klass_rt');
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'alice@x.io'))).toHaveLength(1);

    /*
     * Повтор того же приглашения — это `inviteUsed`, а не «приглашение не подходит»: ссылка
     * одноразовая, и человек обязан узнать об этом словами, а не гадать. Мусорный токен отвечает
     * отдельно (`inviteInvalid`) — отличие от прежнего кода класса названо в шапке файла.
     */
    const again = await registerViaLink(app, link.token, { email: 'bob@x.io', firstName: 'Bob', lastName: 'Test', password: PW });
    expect(again.statusCode).toBe(400);
    expect((again.json as { error: string }).error).toBe('inviteUsed');
    const junk = await registerViaLink(app, 'z'.repeat(32), { email: 'eve@x.io', firstName: 'Eve', lastName: 'Test', password: PW });
    expect(junk.statusCode).toBe(400);
    expect((junk.json as { error: string }).error).toBe('inviteInvalid');
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.name, 'Bob')), 'отказ не оставил аккаунта').toHaveLength(0);

    // ученик видит свой класс
    const studentList = await app.inject({ method: 'GET', url: '/api/classes', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect((studentList.json() as { id: string }[]).some((c) => c.id === classId)).toBe(true);

    // учитель видит ученика в списке
    const members = await app.inject({ method: 'GET', url: `/api/classes/${classId}/members`, headers: auth });
    expect(members.json()).toHaveLength(1);

    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, link.id)).limit(1);
    expect(row.usedAt, 'приглашение израсходовано ровно один раз').toBeTruthy();

    await app.close();
  });

  it('access rules (§7): outsider gets 404, student gets 403 on teacher routes, anon 401', async () => {
    const app = await freshApp();
    const teacher = await makeTeacher(t.sql, `t2${Date.now()}@x.io`);
    const at = await loginToken(app, teacher.email, teacher.password);
    const auth = { authorization: `Bearer ${at}` };
    const cls = await app.inject({ method: 'POST', url: '/api/classes', headers: auth, payload: { name: 'Phys' } });
    const classId = cls.json().id as string;

    // второй учитель (чужой аккаунт) → 404, а не 403: существование класса не выдаётся
    const teacher2 = await makeTeacher(t.sql, `t3${Date.now()}@x.io`);
    const at2 = await loginToken(app, teacher2.email, teacher2.password);
    const foreign = await app.inject({
      method: 'GET', url: `/api/classes/${classId}/members`, headers: { authorization: `Bearer ${at2}` },
    });
    expect(foreign.statusCode).toBe(404);

    /*
     * Ученик заведён выжившим путём — по ссылке учителя (бывший «по коду класса»). Пароль его
     * выбран самим учеником, поэтому `mustChangePassword` не поднят и 403 ниже — это ровно отказ
     * по роли, а не серверный гейт временного пароля.
     */
    const link = await makeInviteLink(app, at, classId);
    const reg = await registerViaLink(app, link.token, { email: `s2${Date.now()}@x.io`, firstName: 'S2', lastName: 'Test', password: PW });
    expect(reg.statusCode, String((reg.json as { error?: string }).error ?? 'no error')).toBe(200);
    const sa = { authorization: `Bearer ${(reg.json as { accessToken: string }).accessToken}` };

    const studCreate = await app.inject({ method: 'POST', url: '/api/classes', headers: sa, payload: { name: 'No' } });
    expect(studCreate.statusCode).toBe(403);

    // аноним → 401
    const anon = await app.inject({ method: 'GET', url: `/api/classes/${classId}/members` });
    expect(anon.statusCode).toBe(401);

    await app.close();
  });

  /**
   * Мёртвый способ обязан остаться мёртвым: 410 с переводимым кодом и НИКАКОЙ записи.
   * Права доступа на нём не проверяются вовсе (маршрут ничего не делает), поэтому и аноним
   * получает 410 — это часть контракта, а не небрежность: ответ не должен зависеть от того,
   * кто стучится, иначе по разнице ответов начнут узнавать существование класса.
   */
  it('POST /api/auth/register is retired: 410 enrollmentRetired and nothing is created', async () => {
    const app = await freshApp();
    const teacher = await makeTeacher(t.sql, `t410${Date.now()}@x.io`);
    const at = await loginToken(app, teacher.email, teacher.password);
    const cls = await app.inject({
      method: 'POST', url: '/api/classes', headers: { authorization: `Bearer ${at}` }, payload: { name: 'Dead route' },
    });
    const classId = cls.json().id as string;

    const before = await t.db.select({ id: users.id }).from(users);
    const r = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { firstName: 'Призрак', lastName: 'Кода', email: 'ghost@x.io', password: PW, code: 'ABCD234E' },
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error).toBe('enrollmentRetired');
    expect(r.json().reqId, 'у отказа должен остаться id для разбора в access-логе').toBeTruthy();

    expect(await t.db.select({ id: users.id }).from(users), 'ни одного аккаунта').toHaveLength(before.length);
    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, classId))).toHaveLength(0);
    expect(await t.db.select().from(inviteCodes).where(eq(inviteCodes.classId, classId)),
      'мёртвый вход не создаёт и строк приглашений').toHaveLength(0);
    expect(await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'ghost@x.io'))).toHaveLength(0);

    await app.close();
  });

  /**
   * Прежняя проверка «перебор кода класса закрывает адрес» живёт теперь на привратнике токенов
   * приглашения. Числа не переписаны: потолок — `PROD_IP_FAILURE_MAX_PER_MIN` из того же модуля,
   * что его применяет, а вне прода он намеренно поднят (500/мин), поэтому проверка идёт в
   * продакшеновом значении и на СВОЁМ адресе — бакен привязан к IP. Полный слой (общий для трёх
   * маршрутов, сброс на успехе, «занятая почта — не промах») ведут `invite-throttle.test.ts` и
   * `invite-limit.test.ts`; здесь ровно то, что проверял этот файл: форма отказа.
   */
  it('invitation token junk gate: 20 failed token probes in a minute → 429, uniform body', async () => {
    const app = await freshApp();
    const prevEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    const ip = '10.66.1.7';
    const junk = (n: number) => `j${String(n).padStart(4, '0')}`.padEnd(32, 'x').slice(0, 32);
    const codes: number[] = [];
    try {
      for (let i = 1; i <= PROD_IP_FAILURE_MAX_PER_MIN; i++) {
        const r = await app.inject({
          method: 'POST', url: '/api/invitations/register', remoteAddress: ip,
          payload: { token: junk(i), firstName: 'Guess', lastName: 'Er', email: `thr${i}${Date.now()}@x.io`, password: PW },
        });
        codes.push(r.statusCode);
        expect(r.json().error, `промах ${i} обязан быть обычным отказом токена`).toBe('inviteInvalid');
      }
      expect(codes.every((c) => c === 400), `промахи: ${codes.join(',')}`).toBe(true);

      const limited = await app.inject({
        method: 'POST', url: '/api/invitations/register', remoteAddress: ip,
        payload: { token: junk(99), firstName: 'Guess', lastName: 'Er', email: 'y@x.io', password: PW },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error, 'единственное слово, которое экран умеет переводить').toBe('codeRateLimited');
      expect(limited.json().reqId, 'отказ без request id некому показать').toBeTruthy();
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      env.NODE_ENV = prevEnv;
      await app.close();
    }
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
