/**
 * Часть B4 (2026-10-16): стирание учётной записи закрывает остатки и держит доступ закрытым.
 *
 * Проверяются четыре вещи:
 *  1) аккаунт, помеченный удалённым, НЕ работает ни на одном запросе — даже если у клиента
 *     остался access-токен, выданный ДО стирания и всё ещё валидный по подписи (гейт держит
 *     `deleted_at` на каждом запросе, а не только на входе), и refresh-сессия не оживает;
 *  2) `eraseAccount` убирает то, что раньше переживало стирание: состояние диалогов бота
 *     (`bot_sessions` по чатам человека), его отчёты /contact, его список заблокированных,
 *     привязки групповых чатов класса; `audit_log` обезличивается (actor + ключ `userId`
 *     в цели) вместо удаления — история действий сохраняется;
 *  3) честное перечисление остатка: какие таблицы ещё держат идентификатор человека (список
 *     снят с `pg_constraint`, а не по памяти) — ровно ли это те владения, что оставлены
 *     политикой «контент класса живёт, личность анонимна», и что это только колонки uuid;
 *  4) ни email, ни имя, ни фамилия, ни telegram-чат стёртого человека не встречаются в схеме
 *     `public` нигде: обход всех text/varchar/jsonb колонок.
 *
 * Все данные фиктивные.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import { DELETED_NAME } from '../../src/services/account.js';
import { issueRefreshSession } from '../../src/services/auth.js';
import { startLesson } from '../../src/services/lessons.js';
import { hashPassword } from '../../src/lib/password.js';
import {
  auditLog, botSessions, chatMessages, classLinkTokens, classMembers, classTelegramChats,
  classes, contactBlocklist, contactReports, inviteCodes, posts, telegramLinks, users,
} from '../../src/db/schema.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const PW = 'Passw0rd123';

/**
 * Остаток, который политика оставляет намеренно: владение контентом класса. Это только
 * uuid на стёртую строку `users`, где личность уже анонимна (см. проверку типов и sentinel-обход).
 */
const KEPT_BY_POLICY = [
  'class_link_tokens.created_by',
  'classes.teacher_id',
  'invite_codes.created_by',
  'lesson_sessions.created_by',
  'posts.author_id',
];

suite('B4: стирание аккаунта — доступ, остатки, персональные данные', () => {
  let t: TestDB;
  let app: FastifyInstance;

  const stamp = Date.now();
  const victimEmail = `b4-victim-${stamp}@x.io`;
  const victimName = 'Erasevich';
  const victimLast = 'Fictus';
  const victimChat = '900000000001';       // фиктивный личный chat_id
  const groupChat = '-1000000000002';      // фиктивный чат класса
  const senderChat = '900000000003';       // чат человека, написавшего в /contact

  const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

  async function loginRaw(email: string, password = PW) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const cookie = r.headers['set-cookie'];
    return {
      res: r,
      accessToken: (r.json().accessToken as string) ?? '',
      cookie: Array.isArray(cookie) ? cookie.map((c) => String(c).split(';')[0]).join('; ') : String(cookie ?? '').split(';')[0],
    };
  }

  /** Сколько строк во всех text/varchar/jsonb колонках public-схемы содержат этот sentinel. */
  async function scanFor(hay: string): Promise<Record<string, number>> {
    // sentinel проверяется на «безопасно вставлять в LIKE»: кавычек, переводов и обратных
    // слэшей быть не должно; имена таблиц и колонок берутся из каталога, а не из ввода.
    if (!/^[A-Za-z0-9@._+\- ]+$/.test(hay)) throw new Error('unsafe sentinel');
    const cols = await t.sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and data_type in ('text', 'character varying', 'jsonb')`;
    const hits: Record<string, number> = {};
    for (const c of cols as { table_name: string; column_name: string }[]) {
      const r = await t.sql.unsafe(
        `select count(*)::int as n from "${c.table_name}" `
        + `where coalesce("${c.column_name}"::text, '') like '%${hay}%'`,
      ) as unknown as { n: number }[];
      const n = Number(r[0]?.n ?? 0);
      if (n > 0) hits[`${c.table_name}.${c.column_name}`] = n;
    }
    return hits;
  }

  /** Таблицы, у которых есть FK на users(id) — одна колонка на ограничение. */
  async function userFkColumns(): Promise<{ tbl: string; col: string }[]> {
    const rows = await t.sql`
      select c.relname as tbl, a.attname as col
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = (con.conkey)[1]
        join pg_class rc on rc.oid = con.confrelid
       where n.nspname = 'public' and rc.relname = 'users' and con.contype = 'f'
         and array_length(con.conkey, 1) = 1
       order by 1, 2`;
    return (rows as { tbl: string; col: string }[]).filter((r) => r.tbl !== 'users');
  }

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL);
    env.RATE_LOGIN_MAX = 500; // файл намеренно много раз входит и выходит
    app = await buildApp(t.db);
  });
  afterAll(async () => { await app?.close(); await t?.sql.end(); });

  it('удалённый аккаунт не работает ни на одном запросе, даже со старым access-токеном', async () => {
    const te = await makeTeacher(t.sql, `b4a${stamp}@x.io`);
    const l = await loginRaw(te.email);
    expect(l.accessToken).not.toBe('');
    const [cls] = await t.db.insert(classes).values({ teacherId: te.id, name: `Класс стирания ${stamp}` }).returning();

    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: bearer(l.accessToken) });
    expect(del.statusCode).toBe(200);

    // `/api/classes/:id` как маршрут не существует (404 даёт сам роутер), поэтому список
    // состоит из настоящих маршрутов: каждый обязан ответить 401, а не данными.
    for (const url of ['/api/me', `/api/classes/${cls!.id}/members`, '/api/classes', '/api/notes', '/api/events']) {
      const r = await app.inject({ method: 'GET', url, headers: bearer(l.accessToken) });
      expect(r.statusCode, `${url} после стирания`).toBe(401);
    }
    const post = await app.inject({ method: 'POST', url: '/api/classes', headers: bearer(l.accessToken), payload: { name: 'новый' } });
    expect(post.statusCode).toBe(401);
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: l.cookie } });
    expect(refreshed.statusCode, 'refresh-сессия не оживает: строки удалены вместе с аккаунтом').toBe(401);

    // и запись в журнале об этом удалении тоже обезличена (порядок: аудит ДО стирания)
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'account_deleted'));
    for (const r of rows) {
      expect(r.actorId, 'ни одна строка «account_deleted» не указывает на стёртого').toBeNull();
      expect(JSON.stringify(r.target)).not.toContain(te.id);
    }
  });

  it('eraseAccount убирает диалоги бота, отчёты, привязки групп и обезличивает журнал', async () => {
    const id = crypto.randomUUID();
    await t.db.insert(users).values({
      id, role: 'teacher', name: victimName, lastName: victimLast, email: victimEmail,
      passwordHash: await hashPassword(PW), locale: 'ru', localeExplicit: true, tz: 'Asia/Tashkent',
    });
    const [other] = await t.db.insert(users).values({
      id: crypto.randomUUID(), role: 'student', name: 'Other', lastName: 'Classmate', email: `b4s${stamp}@x.io`,
      passwordHash: 'x', locale: 'ru', localeExplicit: true, tz: 'Asia/Tashkent',
    }).returning();
    const [cls] = await t.db.insert(classes).values({ teacherId: id, name: `Класс B4 ${stamp}` }).returning();
    const classId = cls!.id;
    await t.db.insert(classMembers).values({ classId, userId: other!.id });
    await t.db.insert(posts).values({ classId, authorId: id, kind: 'material', title: 'Материал', body: 'neutral text' });
    await t.db.insert(telegramLinks).values({ userId: id, chatId: victimChat });
    await t.db.insert(botSessions).values([
      { chatId: victimChat, state: 'announce:confirm', data: { text: 'личное объявление', classId }, expiresAt: new Date(Date.now() + 600_000) },
      { chatId: senderChat, state: 'contact:text', data: { step: 'text' }, expiresAt: new Date(Date.now() + 600_000) },
    ]);
    await t.db.insert(classTelegramChats).values({ classId, chatId: groupChat, linkedBy: id });
    await t.db.insert(contactBlocklist).values({ senderChatId: senderChat, blockedBy: id });
    await t.db.insert(contactReports).values([
      {
        senderChatId: victimChat, senderUserId: id, name: victimName, classHint: 'X',
        message: 'приватный текст отправителя', teacherUserId: null, teacherChatId: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        senderChatId: senderChat, senderUserId: null, name: 'Someone Else', classHint: 'Y',
        message: 'вопрос к учителю', teacherUserId: id, teacherChatId: victimChat,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    await t.db.insert(inviteCodes).values({ classId, codeHash: `unused-hash-${stamp}`, createdBy: id, expiresAt: new Date(Date.now() + 86_400_000) });
    await t.db.insert(classLinkTokens).values({ tokenHash: `link-token-${stamp}`, classId, createdBy: id, expiresAt: new Date(Date.now() + 900_000) });
    await startLesson(t.db, id, classId);
    await t.db.insert(chatMessages).values({ classId, authorId: other!.id, text: 'сообщение одноклассника' });
    await t.db.insert(auditLog).values([
      { actorId: id, action: 'class_create', target: { classId } },
      { actorId: id, action: 'reset_password', target: { classId, userId: id } },
      { actorId: other!.id, action: 'member_remove', target: { classId, userId: id } },
    ]);

    const sess = await loginRaw(victimEmail);
    expect(sess.accessToken).not.toBe('');
    await issueRefreshSession(t.db, id);
    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: bearer(sess.accessToken) });
    expect(del.statusCode).toBe(200);

    // 2а: персональные остатки, которые раньше выживали
    expect(await t.db.select().from(botSessions).where(eq(botSessions.chatId, victimChat))).toHaveLength(0);
    expect(await t.db.select().from(classTelegramChats).where(eq(classTelegramChats.classId, classId))).toHaveLength(0);
    expect(await t.db.select().from(contactBlocklist).where(eq(contactBlocklist.blockedBy, id))).toHaveLength(0);
    expect(await t.db.select().from(contactReports).where(eq(contactReports.senderUserId, id)),
      'отчёт, который человек написал, стёрт вместе с ним').toHaveLength(0);
    const addressed = await t.db.select().from(contactReports).where(eq(contactReports.senderChatId, senderChat));
    expect(addressed, 'чужой отчёт остаётся отправителю').toHaveLength(1);
    expect(addressed[0]!.teacherUserId, 'но больше ни на кого не указывает').toBeNull();
    expect(addressed[0]!.teacherChatId).toBeNull();

    // 2б: журнал обезличен, но не уничтожен
    const log = await t.db.select().from(auditLog).where(sql`target ->> 'classId' = ${classId}`);
    expect(log.length, 'записи журнала остались: историю класса не переписывают').toBeGreaterThanOrEqual(3);
    for (const r of log) {
      expect(r.actorId, 'ни одна строка не указывает на стёртого как на автора').not.toBe(id);
      expect(JSON.stringify(r.target), `из цели «${r.action}» вырезан userId стёртого`).not.toContain(id);
    }
    expect(log.some((r) => r.action === 'class_create'), 'сам факт действия виден').toBe(true);

    // 2в: личность анонимна, чужие сообщения класса — нет
    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u!.name).toBe(DELETED_NAME);
    expect(u!.lastName).toBe('');
    expect(u!.email).toBe(`deleted-${id}@invalid.local`);
    expect(u!.deletedAt).toBeTruthy();
    expect((await t.db.select().from(chatMessages).where(eq(chatMessages.classId, classId))).length,
      'чужие сообщения в классе не исчезают').toBe(1);

    // 3: перечень остатка снят с pg_constraint, а не по памяти
    const survivors: string[] = [];
    for (const { tbl, col } of await userFkColumns()) {
      const c = await t.sql.unsafe(
        `select count(*)::int as n from "${tbl}" where "${col}" = '${id}'`,
      ) as unknown as { n: number }[];
      if (Number(c[0]?.n ?? 0) > 0) survivors.push(`${tbl}.${col}`);
    }
    expect(survivors.sort(), 'остались ровно те владения, что разрешены политикой').toEqual(KEPT_BY_POLICY);
    for (const item of KEPT_BY_POLICY) {
      const [tbl, col] = item.split('.') as [string, string];
      const ty = await t.sql`
        select data_type from information_schema.columns
         where table_schema = 'public' and table_name = ${tbl} and column_name = ${col}`;
      expect(String((ty[0] as { data_type: string }).data_type), `${item}: тип колонки`).toContain('uuid');
    }

    // 4: sentinel-обход: ни email, ни имя, ни фамилия, ни чат стёртого человека нигде
    for (const hay of [victimEmail, victimName, victimLast, victimChat]) {
      const hits = await scanFor(hay);
      expect(hits, `«${hay}» остался в: ${Object.keys(hits).join(', ')}`).toEqual({});
    }
    // адрес группы без привязки тоже нигде не должен оставаться
    expect(await scanFor(groupChat), 'адрес группы не хранится без привязки').toEqual({});
  });

  it('отрицательный контроль: стирание одного аккаунта не ломает вход остальных', async () => {
    const te = await makeTeacher(t.sql, `b4c${stamp}@x.io`);
    const l = await loginRaw(te.email);
    expect(l.res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(l.accessToken) });
    expect(me.statusCode).toBe(200);
  });
});
