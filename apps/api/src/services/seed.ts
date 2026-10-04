import { and, eq, isNull } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { env } from '../env.js';
import type { DB } from '../db/index.js';

/**
 * Cloud boot seeding: create the instance-owner teacher from
 * SEED_TEACHER_EMAIL/SEED_TEACHER_PASSWORD when BOTH are set and the database
 * has no such user. No-op when unset. NEVER logs the password.
 */
export async function seedTeacherAtBoot(db: DB): Promise<void> {
  const email = env.SEED_TEACHER_EMAIL?.toLowerCase().trim();
  const password = env.SEED_TEACHER_PASSWORD;
  if (!email || !password) return;
  const [existing] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (existing) return;
  const [teacher] = await db.insert(users).values({
    role: 'teacher',
    name: env.SEED_TEACHER_NAME || 'Teacher',
    email,
    passwordHash: await hashPassword(password),
  }).returning({ id: users.id });
  console.log(`[seed] teacher ${email} ready (${teacher?.id ?? '?'})`);
}
