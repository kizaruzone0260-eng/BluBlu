/**
 * Одноразовые ссылки-приглашения (задача 2026-10-23, части A и B) — интеграция без браузера.
 *
 * Проверяются четыре обещания, на которых держится весь механизм:
 *  1) предпросмотр НЕ расходует: открытие ссылки, перезагрузка и «карточка» в мессенджере не
 *     могут сломать приглашение;
 *  2) расход атомарен: аккаунт + членство + пометка «израсходовано» либо вместе, либо ничего,
 *     а из десяти параллельных запросов с одной ссылкой проходит ровно один;
 *  3) наружу не уходит лишнего: ни хеш, ни учителева почта, ни признак «такая почта уже есть»
 *     тому, кто пришёл с мусорным токеном;
 *  4) прежний способ — восьмизначный код класса — выведен из продукта и НЕ работает бок о бок.
 *
 * Пункт 4 переписан 2026-10-27: обещание «код живёт рядом со ссылкой», данное в задачах 2026-10-23
 * и 2026-10-26, отозвано. Причина не в том, что код был плохим, а в том, что приём по нему
 * требовал от учителя уметь читать восемь символов вслух или пересылать их по слову. Теперь
 * проверка выглядит так: мёртвые маршруты отвечают 410 и ничего не делают, а строки прежнего
 * вида (`kind = 'code'`) остаются в базе как история и не являются правом на вход — их не расходует
 * ни один путь, потому что функции, умевшие это делать, удалены из сборки.
 *
 * Токен в этих тестах никогда не печатается в описаниях проверок — только в assert-сообщениях
 * туда попадают состояния и идентификаторы.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { inviteCodes, users, classMembers, auditLog, classes } from '../../src/db/schema.js';
import { isInviteToken, INVITE_TOKEN_LENGTH } from '@klass/shared';
import { generateInviteToken, hashInviteToken } from '../../src/lib/inviteLink.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PAGE_ORIGIN = 'https://blublu.example';
const PW = 'PupilPass2026';

suite('A/B: одноразовые ссылки-приглашения', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
  /** аудит пишется без ожидания (`audit()` fire-and-forget) — перед проверкой даём ходу вставки завершиться */
  const settle = () => new Promise((r) => setTimeout(r, 80));

  async function teacherToken(email: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Passw0rd123' } });
    return (r.json().accessToken as string) ?? '';
  }
  async function newClass(tok: string, name: string) {
    const r = await app.inject({ method: 'POST', url: '/api/classes', headers: bearer(tok), payload: { name } });
    return r.json().id as string;
  }
  /** Создать ссылку и вернуть {id, token}: токен живёт в этой переменной и наружу не выводится. */
  async function newLink(tok: string, classId: string, body: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: 'POST', url: `/api/classes/${classId}/invites/link`, headers: bearer(tok), payload: body,
    });
    expect(r.statusCode, r.body).toBe(201);
    const url = r.json().url as string;
    const token = url.split('#')[1] ?? '';
    return { id: r.json().id as string, url, token, expiresAt: r.json().expiresAt as string };
  }
  const preview = (token: string) => app.inject({ method: 'POST', url: '/api/invitations/preview', payload: { token } });
  const register = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/invitations/register', payload: body });
  const join = (tok: string, token: string) => app.inject({
    method: 'POST', url: '/api/invitations/join', headers: bearer(tok), payload: { token },
  });

  const rows = async (classId: string) =>
    t.db.select().from(inviteCodes).where(eq(inviteCodes.classId, classId));

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.PUBLIC_URL = PAGE_ORIGIN;      // ссылка обязана собираться из публичного адреса
    env.RATE_IP_FAIL_MAX = 1000;       // в файле нарочно есть мусорные токены
    env.RATE_IP_MAX = 1000;
    app = await buildApp(t.db);
  });
  afterAll(async () => {
    env.PUBLIC_URL = '';
    await app?.close();
    await t?.sql.end();
  });

  it('учитель создаёт ссылку: она указывает на /join#<32 символа>, а в базе лежит только хеш', async () => {
    const te = await makeTeacher(t.sql, `lk-a-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Link A');
    const link = await newLink(tok, cls, { label: 'Aziza', ttlDays: 7 });

    expect(link.url.startsWith(`${PAGE_ORIGIN}/join#`), 'публичный адрес берётся из PUBLIC_URL').toBe(true);
    expect(isInviteToken(link.token)).toBe(true);
    expect(link.token.length).toBe(INVITE_TOKEN_LENGTH);

    const [row] = await rows(cls);
    expect(row.codeHash).not.toContain(link.token);
    expect(row.codeHash).toBe(hashInviteToken(link.token, env.JWT_SECRET));
    expect(row.kind).toBe('link');
    expect(row.label).toBe('Aziza');
    expect(row.usedAt, 'созданная ссылка ещё не израсходована').toBeNull();
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
  });

  it('срок выбирается из трёх (1/7/30), чужой срок не принимается', async () => {
    const te = await makeTeacher(t.sql, `lk-ttl-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Link ttl');
    for (const days of [1, 30] as const) {
      const link = await newLink(tok, cls, { ttlDays: days });
      const spans = new Date(link.expiresAt).getTime() - Date.now();
      const low = (days - 0.01) * 86_400_000;
      const high = (days + 0.01) * 86_400_000;
      expect(spans > low && spans < high, `ttl=${days}`).toBe(true);
    }
    const bad = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/link`, headers: bearer(tok), payload: { ttlDays: 2 },
    });
    expect(bad.statusCode, 'срока «2 дня» в интерфейсе нет, и сервер его не выдумывает').toBe(400);
  });

  it('предпросмотр ничего не расходует и повторяем', async () => {
    const te = await makeTeacher(t.sql, `lk-p-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Preview class');
    const link = await newLink(tok, cls);

    for (let i = 1; i <= 3; i++) {
      const r = await preview(link.token);
      expect(r.statusCode, `открытие ${i}`).toBe(200);
      expect(r.json().className).toBe('Preview class');
    }
    const [row] = await rows(cls);
    expect(row.usedAt, 'три просмотра — и ноль расходов').toBeNull();

    // и после просмотров ссылка по-прежнему расходуется регистрацией
    const reg = await register({
      token: link.token, firstName: 'Ada', lastName: 'Lina', email: `lk-p-up-${Date.now()}@x.io`,
      password: PW, locale: 'ru',
    });
    expect(reg.statusCode, reg.body).toBe(200);
  });

  it('предпросмотр отдаёт РОВНО имя класса и срок: ни почты учителя, ни хеша, ни токена', async () => {
    const te = await makeTeacher(t.sql, `lk-min-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Minimal');
    const link = await newLink(tok, cls);
    const r = await preview(link.token);
    expect(Object.keys(r.json()).sort()).toEqual(['className', 'expiresAt']);
    expect(r.body).not.toContain(te.email);
    expect(r.body, 'ответ не может содержать токен, из которого его только что спрашивали').not.toContain(link.token);
    expect(r.headers['cache-control'], 'предпросмотр не кэшируется').toBe('no-store');
  });

  it('плохие состояния токена различаются и отвечают кодом + reqId', async () => {
    const te = await makeTeacher(t.sql, `lk-states-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'States');

    const expired = await newLink(tok, cls);
    await t.db.update(inviteCodes).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(inviteCodes.id, expired.id));
    expect((await preview(expired.token)).json().error).toBe('inviteExpired');

    const revoked = await newLink(tok, cls);
    await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/${revoked.id}/revoke`, headers: bearer(tok),
    });
    expect((await preview(revoked.token)).json().error).toBe('inviteRevoked');

    const used = await newLink(tok, cls);
    expect((await register({
      token: used.token, firstName: 'Used', lastName: 'One', email: `lk-used-${Date.now()}@x.io`, password: PW,
    })).statusCode).toBe(200);
    const afterUse = await preview(used.token);
    expect(afterUse.json().error).toBe('inviteUsed');

    const junk = await preview('not-a-real-token-0000000000000');
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error).toBe('inviteInvalid');
    expect(junk.json().reqId, 'у каждого отказа есть id, по которому его найдут в журнале').toMatch(/^[0-9a-z]{10}$/);
  });

  it('регистрация по ссылке: аккаунт, членство и расход — одним ходом', async () => {
    const te = await makeTeacher(t.sql, `lk-r-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Register me');
    const link = await newLink(tok, cls, { label: 'Bek' });
    const email = `lk-r-p-${Date.now()}@x.io`;

    const r = await register({ token: link.token, firstName: 'Bek', lastName: 'Zoda', email, password: PW, locale: 'uz' });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.role).toBe('student');
    expect(body.user.mustChangePassword, 'свой пароль при регистрации менять не нужно').toBe(false);

    const [u] = await t.db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(u, 'аккаунт создан').toBeTruthy();
    expect(u!.passwordHash).not.toBe(PW);
    const member = await t.db.select().from(classMembers)
      .where(and(eq(classMembers.classId, cls), eq(classMembers.userId, u!.id))).limit(1);
    expect(member.length, 'ученик в классе').toBe(1);

    const [row] = await rows(cls);
    expect(row.usedBy).toBe(u!.id);
    expect(row.usedAt).toBeTruthy();

    // и сессию можно обновить: кука выдаётся тем же общим механизмом, что и обычный вход
    const cookie = r.headers['set-cookie'];
    const raw = Array.isArray(cookie) ? cookie.join('\n') : String(cookie ?? '');
    const refresh = /(?:^|\s)klass_rt=([^;]+)/.exec(raw)?.[1] ?? '';
    expect(refresh.length).toBeGreaterThan(10);
    const rot = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `klass_rt=${refresh}` } });
    expect(rot.statusCode, 'сессия, выданная ссылкой, настоящая').toBe(200);
  });

  it('занятая почта: 409, аккаунта нет, И ссылка не сожжена (можно повторить с другой почтой)', async () => {
    const te = await makeTeacher(t.sql, `lk-e-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Taken mail');
    const link = await newLink(tok, cls);
    const existing = `lk-e-has-${Date.now()}@x.io`;
    const other = await makeTeacher(t.sql, existing); // тот же хеш-фикстурный пароль, роль не важна для проверки

    const r = await register({ token: link.token, firstName: 'Ann', lastName: 'On', email: existing, password: PW });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('emailTaken');
    const [row] = await rows(cls);
    expect(row.usedAt, 'отказ по почте не тратит приглашение').toBeNull();
    expect(row.usedBy, 'и не привязывает к себе чужой аккаунт').toBeNull();
    expect(await t.db.select().from(users).where(eq(users.name, 'Ann')).limit(1), 'аккаунт-огрызок не создан').toEqual([]);

    // вторая попытка — с чистой почтой — проходит той же ссылкой
    const again = await register({
      token: link.token, firstName: 'Ann', lastName: 'On', email: `lk-e-new-${Date.now()}@x.io`, password: PW,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(other.id).toBeTruthy();
  });

  it('слабый пароль: 400 с внятной причиной, аккаунта нет, ссылка цела', async () => {
    const te = await makeTeacher(t.sql, `lk-w-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Weak pw');
    const link = await newLink(tok, cls);

    const short = await register({
      token: link.token, firstName: 'Weak', lastName: 'Pw', email: `lk-w1-${Date.now()}@x.io`, password: 'Ab1',
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe('passwordTooShort');

    const common = await register({
      token: link.token, firstName: 'Weak', lastName: 'Pw', email: `lk-w2-${Date.now()}@x.io`, password: '1234567890',
    });
    expect(common.statusCode, 'политика не ослаблена ради приглашения').toBe(400);

    const [row] = await rows(cls);
    expect(row.usedAt).toBeNull();
    expect(await t.db.select().from(users).where(eq(users.name, 'Weak')).limit(1), 'ни одного огрызка аккаунта').toEqual([]);
  });

  it('ровно один из десяти параллельных запросов с одной ссылкой создаёт аккаунт', async () => {
    const te = await makeTeacher(t.sql, `lk-c-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Concurrent');
    const link = await newLink(tok, cls);
    const stamp = Date.now();

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => register({
      token: link.token, firstName: 'Race', lastName: `Pup${i}`, email: `lk-c-${stamp}-${i}@x.io`, password: PW,
    })));
    const okCount = results.filter((r) => r.statusCode === 200).length;
    expect(okCount, 'успех ровно один').toBe(1);
    const refused = results.filter((r) => r.statusCode !== 200);
    expect(refused.length).toBe(9);
    expect(refused.every((r) => r.json().error === 'inviteUsed'), `остальные слышат «уже использовано»: ${JSON.stringify(refused.map((r) => r.json().error))}`).toBe(true);

    const pupils = await t.db.select({ id: users.id }).from(users).where(eq(users.name, 'Race'));
    expect(pupils.length, 'девять отклонённых запросов не оставили аккаунтов').toBe(1);
    const members = await t.db.select().from(classMembers).where(eq(classMembers.classId, cls));
    expect(members.length).toBe(1);
  });

  it('отзыв: ссылка перестаёт работать, отзыв повторный не проходит, хеш остаётся в базе', async () => {
    const te = await makeTeacher(t.sql, `lk-rev-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Revoke');
    const link = await newLink(tok, cls);

    const rev = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/${link.id}/revoke`, headers: bearer(tok),
    });
    expect(rev.statusCode, rev.body).toBe(200);
    expect((await preview(link.token)).json().error).toBe('inviteRevoked');
    const reg = await register({
      token: link.token, firstName: 'Rev', lastName: 'oked', email: `lk-rev-p-${Date.now()}@x.io`, password: PW,
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe('inviteRevoked');

    const again = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/${link.id}/revoke`, headers: bearer(tok),
    });
    expect(again.statusCode, 'повторный отзыв — это 404, а не «успех»').toBe(404);

    const [row] = await rows(cls);
    expect(row.revokedBy, 'журнал отзыва знает, КТО отозвал').toBe(te.id);
  });

  it('история класса: статусы, подпись и имя ученика — только своему учителю', async () => {
    const te = await makeTeacher(t.sql, `lk-h-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'History');
    const used = await newLink(tok, cls, { label: 'Aziza' });
    const active = await newLink(tok, cls, { label: 'Bek' });
    const expired = await newLink(tok, cls, { label: 'Old' });
    await t.db.update(inviteCodes).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(inviteCodes.id, expired.id));
    await register({
      token: used.token, firstName: 'Soph', lastName: 'Ia', email: `lk-h-p-${Date.now()}@x.io`, password: PW,
    });

    const r = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(tok) });
    expect(r.statusCode).toBe(200);
    const listed = r.json() as { id: string; kind: string; label: string; status: string; usedByName: string | null }[];
    expect(listed.length).toBe(3);
    const byId = (id: string) => listed.find((x) => x.id === id)!;
    expect(byId(used.id).status).toBe('used');
    expect(byId(used.id).usedByName, 'учитель видит, КТО вошёл по ссылке').toBe('Soph Ia');
    expect(byId(active.id).status).toBe('active');
    expect(byId(expired.id).status).toBe('expired');
    expect(listed.every((x) => x.kind === 'link')).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(used.token);

    // чужой учитель не видит ни списка, ни имён
    const other = await makeTeacher(t.sql, `lk-h-o-${Date.now()}@x.io`);
    const otherTok = await teacherToken(other.email);
    const peek = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(otherTok) });
    expect(peek.statusCode).toBe(404);
    // и без прав входа в список нет
    const anon = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations` });
    expect(anon.statusCode).toBe(401);
  });

  it('существующий аккаунт входит по ссылке; повторный вход не плодит членство', async () => {
    const te = await makeTeacher(t.sql, `lk-j-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Join existing');
    const email = `lk-j-p-${Date.now()}@x.io`;
    // ученик заведён обычным путём и уже состоит в классе
    const first = await newLink(tok, cls);
    const reg = await register({ token: first.token, firstName: 'Jo', lastName: 'In', email, password: PW });
    expect(reg.statusCode).toBe(200);
    const pTok = reg.json().accessToken as string;

    const second = await newLink(tok, cls);
    const r = await join(pTok, second.token);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().classId).toBe(cls);
    expect(r.json().alreadyMember, 'он же уже тут — это надо сказать, а не молча сделать вид').toBe(true);

    const [u] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const members = await t.db.select().from(classMembers).where(and(eq(classMembers.classId, cls), eq(classMembers.userId, u!.id)));
    expect(members.length, 'одна строка членства, не две').toBe(1);

    // ссылка при этом всё равно израсходована: иначе «одно приглашение — один человек» не выполняется
    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, second.id)).limit(1);
    expect(row.usedAt).toBeTruthy();

    // учитель не может войти по ссылке ученика
    const third = await newLink(tok, cls);
    const asTeacher = await join(tok, third.token);
    expect(asTeacher.statusCode).toBe(403);

    // а другой класс по своей ссылке — может: новый вход без дублей
    const cls2 = await newClass(tok, 'Join second');
    const link2 = await newLink(tok, cls2);
    const r2 = await join(pTok, link2.token);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().classId).toBe(cls2);
    expect(r2.json().alreadyMember).toBe(false);
  });

  /**
   * Задача 2026-10-28: «ученика удалили, а потом снова пригласили».
   *
   * Цикл проверялся только для ученика, который всё это время состоял в классе. Здесь — именно
   * возврат: строку `class_members` удалили (жёсткое удаление, не флаг), аккаунт остался, и
   * новая ссылка должна вернуть человека ровно одной строкой. Заодно фиксируются все способы
   * НЕ вернуть: израсходованная, отозванная и истёкшая ссылки отвечают своими кодами и
   * членства не создают, а два одновременных входа с одной ссылкой дают один успех.
   */
  it('удалённый ученик возвращается по новой ссылке тем же аккаунтом; повтор и отзыв не плодят членство', async () => {
    const te = await makeTeacher(t.sql, `lk-re-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Removed then reinvited');
    const email = `lk-re-p-${Date.now()}@x.io`;

    const first = await newLink(tok, cls);
    const reg = await register({ token: first.token, firstName: 'Re', lastName: 'Join', email, password: PW });
    expect(reg.statusCode, reg.body).toBe(200);
    const [u] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const membership = () => t.db.select().from(classMembers)
      .where(and(eq(classMembers.classId, cls), eq(classMembers.userId, u!.id)));

    expect(await membership()).toHaveLength(1);

    // учитель удаляет ученика из класса: строка исчезает, аккаунт и его пароль — нет
    const del = await app.inject({
      method: 'DELETE', url: `/api/classes/${cls}/members/${u!.id}`, headers: bearer(tok),
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await membership(), 'удаление — это DELETE, а не флаг').toHaveLength(0);

    // ученик входит тем же аккаунтом — ровно так экран /join идёт после «уже есть аккаунт? войти»
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    expect(login.statusCode, login.body).toBe(200);
    const pTok = login.json().accessToken as string;

    const again = await newLink(tok, cls);
    const back = await join(pTok, again.token);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().classId).toBe(cls);
    expect(back.json().alreadyMember, 'членства не было — это возврат, а не повтор').toBe(false);
    expect(await membership(), 'ровно одна строка после возврата').toHaveLength(1);

    // израсходованная ссылка второй раз не пускает и второй строки не создаёт
    const replay = await join(pTok, again.token);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('inviteUsed');
    expect(await membership()).toHaveLength(1);

    // отозванная ссылка не возвращает удалённого ученика
    await app.inject({ method: 'DELETE', url: `/api/classes/${cls}/members/${u!.id}`, headers: bearer(tok) });
    const revoked = await newLink(tok, cls);
    await app.inject({ method: 'POST', url: `/api/classes/${cls}/invites/${revoked.id}/revoke`, headers: bearer(tok) });
    const denied = await join(pTok, revoked.token);
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe('inviteRevoked');
    expect(await membership(), 'отозванная ссылка не создала членство').toHaveLength(0);

    // истёкшая ссылка — тоже отказ, а не «почти сработало»
    const expired = await newLink(tok, cls);
    await t.db.update(inviteCodes).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(inviteCodes.id, expired.id));
    const late = await join(pTok, expired.token);
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe('inviteExpired');
    expect(await membership()).toHaveLength(0);

    // два одновременных входа с одной новой ссылкой: один расход, одна строка членства
    const raceLink = await newLink(tok, cls);
    const [a, b] = await Promise.all([join(pTok, raceLink.token), join(pTok, raceLink.token)]);
    expect([a.statusCode, b.statusCode].sort(), 'ровно один прошёл').toEqual([200, 400]);
    const refused = a.statusCode === 400 ? a : b;
    expect(refused.json().error).toBe('inviteUsed');
    expect(await membership()).toHaveLength(1);
  });

  /**
   * Задача 2026-10-26. Учитель, открывший ученическую ссылку, получает не безликое `forbidden`,
   * а код, по которому экран объясняет «нужен ученический аккаунт» и предлагает пересесть.
   * И — главное — отказ НЕ расходует ссылку: человек мог открыть её из любопытства, а ссылка
   * должна остаться рабочей для настоящего ученика.
   */
  it('учитель на ученической ссылке: studentAccountRequired, ссылка остаётся целой', async () => {
    const te = await makeTeacher(t.sql, `lk-t-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Teacher on join');
    const link = await newLink(tok, cls);

    const asTeacher = await join(tok, link.token);
    expect(asTeacher.statusCode, asTeacher.body).toBe(403);
    expect(asTeacher.json().error).toBe('studentAccountRequired');
    expect(asTeacher.json().reqId, 'у отказа есть идентификатор для разбора').toBeTruthy();

    const stillPreview = await preview(link.token);
    expect(stillPreview.statusCode, 'отказ учителя не спалил приглашение').toBe(200);
    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, link.id)).limit(1);
    expect(row!.usedAt, 'отказ не расходует ссылку').toBeNull();
    expect(row!.usedBy).toBeNull();

    const pupilEmail = `lk-t-p-${Date.now()}@x.io`;
    const reg = await register({
      token: link.token, firstName: 'Real', lastName: 'Pupil', email: pupilEmail, password: PW,
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const [pupil] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, pupilEmail)).limit(1);
    const rowsAfter = await t.db.select().from(classMembers)
      .where(and(eq(classMembers.classId, cls), eq(classMembers.userId, pupil!.id)));
    expect(rowsAfter.length, 'ровно одно членство у настоящего ученика').toBe(1);
    const [after] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, link.id)).limit(1);
    expect(after!.usedAt).toBeTruthy();
  });

  /**
   * Почта — ключ, по которому учитель позже найдёт аккаунт для добавления в класс. Если
   * регистрация сохранит другой регистр, добавление по почте не найдёт человека. Схема
   * нормализует адрес до сохранения; тест фиксирует это на публичном входе по ссылке.
   */
  it('регистрация по ссылке нормализует почту: регистр и пробелы не создают отдельный аккаунт', async () => {
    const te = await makeTeacher(t.sql, `lk-n-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Normalize');
    const link = await newLink(tok, cls);
    const email = `lk-n-p-${Date.now()}@x.io`;

    const reg = await register({
      token: link.token, firstName: 'Norm', lastName: 'Al', email: `  ${email.toUpperCase()}  `, password: PW,
    });
    expect(reg.statusCode, reg.body).toBe(200);
    expect(reg.json().user.email as string).toBe(email);

    const again = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    expect(again.statusCode, again.body).toBe(200);

    const rows = await t.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows.length, 'один аккаунт на нормализованный адрес').toBe(1);
  });

  it('мусор вместо токена до сервера не доходит: форма важнее содержимого', async () => {
    for (const bad of ['', 'short', 'a'.repeat(INVITE_TOKEN_LENGTH), 'x'.repeat(INVITE_TOKEN_LENGTH - 1) + '=', 'A'.repeat(INVITE_TOKEN_LENGTH)]) {
      const p = await preview(bad);
      expect(p.statusCode, `«${bad.length}»`).toBe(400);
    }
    const reg = await register({
      token: 'a'.repeat(INVITE_TOKEN_LENGTH), firstName: 'No', lastName: 'Pupil',
      email: `lk-junk-${Date.now()}@x.io`, password: PW,
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe('inviteInvalid');
  });

  /**
   * Прежний способ выведен (2026-10-27), и проверка говорит ровно это. Два разных факта, которые
   * нельзя смешать:
   *  • маршруты кода живы ТОЛЬКО как ответ 410 — они не проверяют, не выпускают и не расходуют
   *    ничего, поэтому и аккаунта не создают;
   *  • строка вида `kind = 'code'` остаётся в базе (историю не удаляли) и не является правом на
   *    вход. Проверяется сильно: легаси-строке подставлен `code_hash`, который даёт штатный
   *    токен ссылки, — то есть от живой записи её отличает только вид. Если кто-то однажды
   *    уберёт фильтр по `kind` в `peekInviteLink`/`redeemInviteLink`, эта проверка станет красной.
   *
   * При этом история учителя строку показывает: `GET …/invitations` читает приглашения обоих
   * видов, и удаление исторических строк не требовалось ни постановке, ни аудиту.
   */
  it('выведенный восьмизначный код: маршруты дают 410, а строка kind=code inert и видна в истории', async () => {
    const te = await makeTeacher(t.sql, `lk-legacy-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Legacy');
    const before = await t.db.select({ id: users.id }).from(users);

    const dead: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
      { method: 'POST', url: `/api/classes/${cls}/invites`, payload: { ttlDays: 7 } },
      { method: 'GET', url: `/api/classes/${cls}/invites` },
      { method: 'POST', url: '/api/auth/check-code', payload: { code: 'ABCD2345' } },
      { method: 'POST', url: '/api/auth/register', payload: {
        firstName: 'Old', lastName: 'Way', email: `lk-legacy-p-${Date.now()}@x.io`, password: PW, code: 'ABCD2345',
      } },
      { method: 'POST', url: '/api/join-by-code', payload: { code: 'ABCD2345' } },
    ];
    for (const call of dead) {
      const r = await app.inject({
        method: call.method, url: call.url, headers: bearer(tok), payload: call.payload as object,
      });
      expect(r.statusCode, `${call.method} ${call.url}`).toBe(410);
      expect(r.json().error, 'переводимое слово, а не «Route not found»').toBe('enrollmentRetired');
      expect(r.json().reqId, 'id для разбора в access-логе остаётся').toBeTruthy();
    }
    expect(await t.db.select({ id: users.id }).from(users), 'ни один мёртвый маршрут не завёл аккаунта')
      .toHaveLength(before.length);
    expect(await t.db.select().from(classMembers).where(eq(classMembers.classId, cls)), 'и не создал членства')
      .toHaveLength(0);

    // легаси-строка: создать её нечем (маршрут умер), поэтому вставка прямая — как в прежней базе
    const ghost = generateInviteToken();
    const legacyId = crypto.randomUUID();
    await t.db.insert(inviteCodes).values({
      id: legacyId, classId: cls, codeHash: hashInviteToken(ghost, env.JWT_SECRET), createdBy: te.id,
      expiresAt: new Date(Date.now() + 7 * 86_400_000), kind: 'code',
    });

    // по форме это законный токен ссылки, и хеш совпадает — а расходуется как несуществующий
    expect(isInviteToken(ghost)).toBe(true);
    const peek = await preview(ghost);
    expect(peek.statusCode).toBe(400);
    expect(peek.json().error, 'вид `code` не читается как приглашение').toBe('inviteInvalid');
    const reg = await register({
      token: ghost, firstName: 'Ghost', lastName: 'Code', email: `lk-legacy-g-${Date.now()}@x.io`, password: PW,
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe('inviteInvalid');
    const joinBy = await join(tok, ghost);
    expect(joinBy.statusCode, 'учитель по такой «ссылке» тоже ничего не может — роль, а не строка').toBe(403);
    const [row] = await t.db.select().from(inviteCodes).where(eq(inviteCodes.id, legacyId)).limit(1);
    expect(row.usedAt, 'легаси-строка осталась не тронутой').toBeNull();
    expect(row.revokedAt).toBeNull();

    // а в истории она видна: строки истории не удаляются, и экран различает виды
    const hist = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(tok) });
    expect(hist.statusCode).toBe(200);
    const listed = hist.json() as { id: string; kind: string; status: string }[];
    const mine = listed.find((x) => x.id === legacyId);
    expect(mine, 'учитель видит прежний код в списке приглашений').toBeTruthy();
    expect(mine!.kind).toBe('code');
    /*
     * Не израсходованный и не отозванный код отдаётся как `retired`, а не как `active`: срок у
     * строки, может быть, ещё не вышел, но войти по нему нечем — способа больше нет в продукте.
     * Зелёная «Активная» на выключенной двери была бы обещанием, которое экран не может выполнить,
     * и учитель отправил бы к ней ученика. Исторические пометки при этом читаются как есть:
     * отозванная или израсходованная строка кода остаётся `revoked` / `used` — это факты прошлого.
     */
    expect(mine!.status, 'прежний код показан помеченным, а не живым').toBe('retired');
    // и чужому учителю — ничего, включая эту строку
    const stranger = await makeTeacher(t.sql, `lk-legacy-s-${Date.now()}@x.io`);
    const strangerTok = await teacherToken(stranger.email);
    const peeked = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(strangerTok) });
    expect(peeked.statusCode).toBe(404);
  });

  it('журнал: создание, отзыв, расход и сброс пароля записаны, и ни в одной цели нет токена или пароля', async () => {
    const te = await makeTeacher(t.sql, `lk-au-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Audit');
    const link = await newLink(tok, cls, { label: 'Nina' });
    const email = `lk-au-p-${Date.now()}@x.io`;
    const reg = await register({ token: link.token, firstName: 'Nina', lastName: 'Rov', email, password: PW });
    expect(reg.statusCode, reg.body).toBe(200);

    const [u] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    await app.inject({ method: 'POST', url: `/api/classes/${cls}/members/${u!.id}/reset-password`, headers: bearer(tok), payload: { password: 'TempPupil2026' } });
    const cls2 = await newClass(tok, 'Audit revoke');
    const gone = await newLink(tok, cls2);
    await app.inject({ method: 'POST', url: `/api/classes/${cls2}/invites/${gone.id}/revoke`, headers: bearer(tok) });
    await settle();

    const logRows = await t.db.select().from(auditLog);
    const actions = logRows.map((r) => r.action);
    expect(actions).toContain('invite_link_create');
    expect(actions).toContain('invite_redeem');
    expect(actions).toContain('invite_revoke');
    expect(actions).toContain('reset_password');

    const dump = JSON.stringify(logRows.map((r) => r.target));
    expect(dump, 'ни один токен не ушёл в журнал').not.toContain(link.token);
    expect(dump, 'ни один пароль не ушёл в журнал').not.toContain(PW);
    expect(dump).not.toContain('TempPupil2026');
    expect(dump, 'журнал не хранит почты приглашённых').not.toContain(email);

    // таблица журнала общая на весь файл, поэтому ищем СВОИ строки — по id приглашения
    const forInvite = (action: string, id: string) =>
      logRows.find((r) => r.action === action && (r.target as Record<string, unknown>).inviteId === id);

    const redeem = forInvite('invite_redeem', link.id)!;
    expect(redeem, 'расход записан').toBeTruthy();
    expect((redeem.target as Record<string, unknown>).classId).toBe(cls);
    expect(redeem.actorId, 'расход пишет актёром самого вошедшего ученика').toBe(u!.id);

    const revoke = forInvite('invite_revoke', gone.id)!;
    expect(revoke, 'отзыв записан').toBeTruthy();
    expect(revoke.actorId).toBe(te.id);
    expect((revoke.target as Record<string, unknown>).kind).toBe('link');

    const created = forInvite('invite_link_create', link.id)!;
    expect(created.actorId, 'создание ссылки тоже в журнале').toBe(te.id);
    expect((created.target as Record<string, unknown>).ttlDays, 'срок — можно, токен — нет').toBe(7);
  });

  it('ссылка чужого класса недоступна: список и отзыв закрыты для постороннего учителя', async () => {
    const owner = await makeTeacher(t.sql, `lk-o-${Date.now()}@x.io`);
    const ownerTok = await teacherToken(owner.email);
    const cls = await newClass(ownerTok, 'Private class');
    await newLink(ownerTok, cls);

    const stranger = await makeTeacher(t.sql, `lk-s-${Date.now()}@x.io`);
    const strangerTok = await teacherToken(stranger.email);
    const list = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(strangerTok) });
    expect(list.statusCode).toBe(404);
    expect(JSON.stringify(list.json())).not.toContain('Private class');

    // отзыв чужого приглашения — тоже 404, и он ничего не отзывает
    const [row] = await rows(cls);
    const rev = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/${row.id}/revoke`, headers: bearer(strangerTok),
    });
    expect(rev.statusCode).toBe(404);
    const [still] = await rows(cls);
    expect(still.revokedAt).toBeNull();

    // и чужие попытки ничего не меняют в самом приглашении: ссылка остаётся активной для адресата
    const probe = await preview('a'.repeat(INVITE_TOKEN_LENGTH));
    expect(probe.statusCode, 'промах по форме токена — отказ, а не 500').toBe(400);
    const [after] = await rows(cls);
    expect(after.revokedAt, 'посторонний не отозвал чужую ссылку').toBeNull();
    expect(after.usedAt, 'и не израсходовал').toBeNull();

    const clsName = await t.db.select({ name: classes.name }).from(classes).where(eq(classes.id, cls)).limit(1);
    expect(clsName[0]!.name, 'сама ссылка при чужих попытках не пострадала').toBe('Private class');
  });

  it('ссылку создаёт только учитель: анониму и ученику этого же класса вход закрыт', async () => {    const te = await makeTeacher(t.sql, `lk-role-${Date.now()}@x.io`);
    const tok = await teacherToken(te.email);
    const cls = await newClass(tok, 'Roles');
    const link = await newLink(tok, cls);

    const anon = await app.inject({ method: 'POST', url: `/api/classes/${cls}/invites/link`, payload: {} });
    expect(anon.statusCode).toBe(401);

    // ученик этого класса — не учитель, и создать ссылку не может
    const reg = await register({
      token: link.token, firstName: 'Pup', lastName: 'Il', email: `lk-role-p-${Date.now()}@x.io`, password: PW,
    });
    expect(reg.statusCode).toBe(200);
    const pTok = reg.json().accessToken as string;
    const asPupil = await app.inject({
      method: 'POST', url: `/api/classes/${cls}/invites/link`, headers: bearer(pTok), payload: {},
    });
    expect(asPupil.statusCode).toBe(403);

    const extra = await app.inject({ method: 'GET', url: `/api/classes/${cls}/invitations`, headers: bearer(pTok) });
    expect(extra.statusCode, 'история приглашений — не ученическая').toBe(403);
  });

  /**
   * §7: новые колонки не открывают нового доступа. Миграция только добавила столбцы в
   * СУЩЕСТВУЮЩУЮ таблицу, а защита в этом проекте держится на таблице целиком (RLS включён на
   * всю схему `public`, права у `anon`/`authenticated` отозваны — `custom/secure-public.sql`),
   * так что `kind`/`label`/`revoked_by` унаследовали позу автоматически. Проверка нужна ровно на
   * это «автоматически»: если кто-то однажды выдаст доступ на уровне колонок, тест зашумит.
   */
  it('поза доступа к invite_codes не изменилась: RLS включён, у публичных ролей нет прав', async () => {
    const [raw] = await t.sql`
      select c.relrowsecurity as rls, c.relforcerowsecurity as forced, c.relacl as acl,
             (select count(*) from pg_roles r
                where r.rolname in ('anon','authenticated','public','supabase_read_only_user')
                  and has_table_privilege(r.rolname, 'public.invite_codes', 'SELECT'))::int as readable_by_public_roles
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'invite_codes'`;
    expect(raw.rls, 'RLS на таблице приглашений остался включённым').toBe(true);
    expect(raw.forced, 'FORCE не ставили: приложение — владелец таблиц').toBe(false);
    expect(raw.readable_by_public_roles, 'ни одна публичная роль не читает хеши приглашений').toBe(0);

    // и сами новые колонки additive: значение по умолчанию превращает каждую прежнюю строку в
    // КОД, то есть прежнее поведение сохраняется без единого UPDATE
    const cols = await t.sql`
      select a.attname as name, pg_get_expr(d.adbin, d.adrelid) as deparsed, a.attnotnull as not_null
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.invite_codes'::regclass
        and a.attname in ('kind','label','revoked_by')
      order by a.attname`;
    const byName = Object.fromEntries(cols.map((c: { name: string }) => [c.name, c]));
    expect(cols.length, 'все три колонки на месте').toBe(3);
    expect(byName.kind.deparsed, 'старые строки остались кодами').toContain("'code'");
    expect(byName.kind.not_null).toBe(true);
    expect(byName.label.deparsed).toContain("''");
    expect(byName.revoked_by.not_null, 'отозвавший — справочное поле, его может и не быть').toBe(false);
  });
});
