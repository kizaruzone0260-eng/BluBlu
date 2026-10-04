import { and, eq, isNull } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';

/**
 * Demo seed (docs/DEMO.md) — MINIMAL by design (task C.1):
 * one teacher account for login and an otherwise EMPTY database.
 * Everything else (classes, events, materials, notes, invite codes)
 * is created live in the UI during the demo, so the client sees the
 * product being used, not a pile of fixtures.
 *
 * Idempotent: re-running only ensures the teacher exists.
 */
const TEACHER = { email: 'teacher@demo.klass.local', name: 'Учитель Демо', password: 'DemoTeacher123' };

async function main() {
  const db = getDb(process.env.DATABASE_URL ?? 'postgres://klass:klass@127.0.0.1:5434/klass');
  const email = TEACHER.email.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (!existing) {
    const passwordHash = await hashPassword(TEACHER.password);
    await db.insert(users).values({ role: 'teacher', name: TEACHER.name, email, passwordHash, locale: 'ru' });
  }
  console.log(JSON.stringify({
    teacherEmail: TEACHER.email,
    teacherPassword: TEACHER.password,
    fresh: !existing,
  }, null, 2));
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
