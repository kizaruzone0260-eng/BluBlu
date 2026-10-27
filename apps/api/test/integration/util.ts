import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as schema from '../../src/db/schema';

export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? '';

export type TestDB = ReturnType<typeof makeDb>;
export function makeDb(url: string) {
  const sql = postgres(url, { max: 25 });
  return { sql, db: drizzle(sql, { schema }) };
}

export async function preparedDb(url: string) {
  const t = makeDb(url);
  await migrate(t.db, { migrationsFolder: path.resolve('src/db/migrations') });
  await t.sql`truncate users, classes, class_members, invite_codes, refresh_tokens, login_attempts, audit_log, posts, files, teacher_notes, events, ics_tokens, lesson_sessions, lesson_comments, lesson_comment_mutes, lesson_comment_reads, lesson_hands, lesson_attendance, whiteboards, student_notes, telegram_links, telegram_tokens, class_telegram_chats, class_link_tokens, notification_prefs, class_notify_prefs, notifications, ws_tickets, chat_messages, chat_mutes, chat_reads, chat_ws_tickets, bot_sessions, bot_updates, contact_reports, contact_blocklist, topics, post_attachments, post_audience, policy_acceptances, email_verifications, tg_operators, tg_groups, tg_bind_tokens, tg_drafts, tg_draft_targets, tg_draft_items, tg_draft_materials, tg_materials, tg_material_groups, tg_publications, tg_callback_tokens restart identity cascade`;
  return t;
}

export async function makeTeacher(sql: postgres.Sql, email = 't@x.io', name = 'T') {
  const id = crypto.randomUUID();
  const lower = email.toLowerCase(); // register/login normalize to lowercase — helpers must too
  const hash = await (await import('../../src/lib/password.js')).hashPassword('Passw0rd123');
  // The fixture speaks Russian on purpose (its texts and assertions are Russian), and since
  // migration 0024 that has to be SAID: `locale` alone now means "nobody chose, this is the
  // English default", so an un-marked 'ru' row would answer in English.
  await sql`insert into users (id, role, name, email, password_hash, locale, locale_explicit, tz, created_at)
            values (${id}, 'teacher', ${name}, ${lower}, ${hash}, 'ru', true, 'Asia/Tashkent', now())`;
  return { id, email: lower, password: 'Passw0rd123' };
}

/* ─── ученик в тесте: три способа, и ни одного «кода класса» ─────────────────────────────
 *
 * 2026-10-27. Почти все интеграционные тесты заводили ученика одним маршрутом —
 * `POST /api/auth/register` с восьмизначным кодом: это был самый короткий способ получить
 * человека с токеном. Приём по коду выведен из продукта, и эти файлы остались бы красными не
 * потому, что проверяли коды (почти все они про другое: чат, доски, заметки, права), а потому,
 * что их фикстура держалась на умершем способе.
 *
 * Что выбрано и почему:
 *  • `makeStudent` — прямая вставка аккаунта и членства. Тесту, которому нужен «просто ученик в
 *    классе», незачем держать внутри сценарий приёма. Прецедент в репозитории уже был:
 *    `member-add-email.test.ts` (`makePupil`) и `race.test.ts` (ученики вставлялись и раньше).
 *  • `createStudentViaApi` — настоящий продукт: аккаунт создаёт учитель. Там, где тесту важно,
 *    что ученик появился ИМЕННО так, он обязан идти через маршрут, а не через вставку.
 *  • `makeInviteLink` + `registerViaLink` — второй легальный путь, для тестов про сам приём.
 *
 * Токен нигде не «достаётся из воздуха»: `loginToken` входит тем же маршрутом, которым входит
 * браузер. Иначе фикстура начала бы расходиться с продуктом — и зелёный тест ничего не значил бы.
 */

const PW = 'Passw0rd123';

/** Вставка ученика (и, если нужно, его членства) прямо в базу. raw-SQL, как у `makeTeacher`. */
export async function makeStudent(sql: postgres.Sql, opts: {
  classId: string; email: string; password?: string; name?: string; lastName?: string;
  /** 'teacher' — чтобы проверить отказ: учителя в ученики не добавляют */
  role?: 'student' | 'teacher';
  /** false — не создавать строку class_members (аккаунт «есть, но вне класса») */
  member?: boolean;
  /** true — мягко удалённый аккаунт: почта у него занята, но войти нельзя */
  deleted?: boolean;
}) {
  const id = crypto.randomUUID();
  const lower = opts.email.toLowerCase();
  const password = opts.password ?? PW;
  const hash = await (await import('../../src/lib/password.js')).hashPassword(password);
  await sql`insert into users (id, role, name, last_name, email, password_hash, locale, locale_explicit,
                               profile_completed_at, created_at, deleted_at)
            values (${id}, ${opts.role ?? 'student'}, ${opts.name ?? 'Pupil'}, ${opts.lastName ?? 'Test'},
                    ${lower}, ${hash}, 'ru', true, now(), now(),
                    ${opts.deleted ? new Date() : null})`;
  if ((opts.member ?? true) && opts.role !== 'teacher') {
    await sql`insert into class_members (class_id, user_id) values (${opts.classId}, ${id})
              on conflict do nothing`;
  }
  return { id, email: lower, password };
}

/** Токен обычным входом — тот же маршрут, что у браузера. Никакого JWT «в обход пароля». */
export async function loginToken(app: FastifyInstance, email: string, password = PW): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (r.statusCode !== 200) throw new Error(`loginToken failed: ${r.statusCode} ${r.body}`);
  return (r.json() as { accessToken: string }).accessToken;
}

/** Ученик, созданный учителем через продукт (POST /api/classes/:id/students). */
export async function createStudentViaApi(app: FastifyInstance, teacherTok: string, classId: string, opts: {
  email: string; firstName?: string; lastName?: string; password?: string;
}) {
  const password = opts.password ?? PW;
  const r = await app.inject({
    method: 'POST', url: `/api/classes/${classId}/students`,
    headers: { authorization: `Bearer ${teacherTok}` },
    payload: {
      firstName: opts.firstName ?? 'Pupil', lastName: opts.lastName ?? 'Test',
      email: opts.email, password,
    },
  });
  if (r.statusCode !== 201) throw new Error(`createStudentViaApi failed: ${r.statusCode} ${r.body}`);
  const j = r.json() as { userId: string; name: string; email: string };
  return { userId: j.userId, name: j.name, email: j.email, password };
}

/**
 * Одноразовая ссылка класса — тем же маршрутом, что и экран учителя. Возвращает и `url`, и
 * `token` (фрагмент адреса). Токен не печатается в названии теста и не попадает в журнал — ровно
 * как в продукте, где сервер хранит только его хеш.
 */
export async function makeInviteLink(app: FastifyInstance, teacherTok: string, classId: string, body: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: 'POST', url: `/api/classes/${classId}/invites/link`,
    headers: { authorization: `Bearer ${teacherTok}` }, payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`makeInviteLink failed: ${r.statusCode} ${r.body}`);
  const j = r.json() as { id: string; url: string };
  return { id: j.id, url: j.url, token: j.url.split('#')[1] ?? '' };
}

/** Регистрация по ссылке — публичный путь нового ученика (POST /api/invitations/register). */
export async function registerViaLink(app: FastifyInstance, token: string, opts: {
  email: string; firstName?: string; lastName?: string; password?: string; locale?: string; emailCode?: string;
}) {
  const password = opts.password ?? 'Secret1234';
  const r = await app.inject({
    method: 'POST', url: '/api/invitations/register',
    payload: {
      token, firstName: opts.firstName ?? 'Pupil', lastName: opts.lastName ?? 'Test',
      email: opts.email, password, ...(opts.locale ? { locale: opts.locale } : {}),
      ...(opts.emailCode ? { emailCode: opts.emailCode } : {}),
    },
  });
  return { statusCode: r.statusCode, body: r.body, json: r.json() as Record<string, unknown>, password };
}

