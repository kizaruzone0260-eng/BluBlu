import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
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
  await t.sql`truncate users, classes, class_members, invite_codes, refresh_tokens, audit_log, posts, files, teacher_notes, events, ics_tokens, lesson_sessions, whiteboards, student_notes, telegram_links, telegram_tokens, class_telegram_chats, class_link_tokens, notification_prefs, class_notify_prefs, notifications, ws_tickets, chat_messages, chat_mutes, chat_reads, chat_ws_tickets restart identity cascade`;
  return t;
}

export async function makeTeacher(sql: postgres.Sql, email = 't@x.io', name = 'T') {
  const id = crypto.randomUUID();
  const lower = email.toLowerCase(); // register/login normalize to lowercase — helpers must too
  const hash = await (await import('../../src/lib/password.js')).hashPassword('Passw0rd123');
  await sql`insert into users (id, role, name, email, password_hash, locale, tz, created_at)
            values (${id}, 'teacher', ${name}, ${lower}, ${hash}, 'ru', 'Asia/Tashkent', now())`;
  return { id, email: lower, password: 'Passw0rd123' };
}
