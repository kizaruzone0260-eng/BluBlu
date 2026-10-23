import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

/**
 * Тип транзакции drizzle (то, что приходит в колбэк `db.transaction(fn)`). Нужен затем, чтобы
 * функция, которой надо встать в ЧУЖУЮ транзакцию, принимала её явно, а не звала `as unknown as DB`
 * на месте: расходуемые операции (приглашение-ссылка, код класса) обязаны сходиться одним ходом
 * с созданием аккаунта, и это свойство видно в сигнатуре.
 */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

let pool: { sql: postgres.Sql; db: DB } | null = null;

/** Lazy singleton so unit tests can import app code without a database. */
export function getDb(databaseUrl: string): DB {
  if (!pool) {
    const sql = postgres(databaseUrl, { max: 10, idle_timeout: 30 });
    pool = { sql, db: drizzle(sql, { schema }) };
  }
  return pool.db;
}

export async function closeDb() {
  if (pool) {
    await pool.sql.end();
    pool = null;
  }
}

export { schema };
