import { z } from 'zod';
import { getDb, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { eq, and } from 'drizzle-orm';
import { isNull } from 'drizzle-orm';

/** Creates the instance-owner teacher (§2). Run once: pnpm seed:teacher */
const seedSchema = z.object({
  SEED_TEACHER_EMAIL: z.string().email(),
  SEED_TEACHER_NAME: z.string().min(1),
  SEED_TEACHER_PASSWORD: z.string().min(8),
});

async function main() {
  const cfg = seedSchema.parse(process.env);
  const db = getDb(process.env.DATABASE_URL ?? 'postgres://klass:klass@localhost:5432/klass');
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, cfg.SEED_TEACHER_EMAIL.toLowerCase()), isNull(users.deletedAt)))
    .limit(1);
  if (existing) {
    console.log(`teacher ${cfg.SEED_TEACHER_EMAIL} already exists (${existing.id})`);
  } else {
    const passwordHash = await hashPassword(cfg.SEED_TEACHER_PASSWORD);
    const [t] = await db.insert(users).values({
      role: 'teacher',
      name: cfg.SEED_TEACHER_NAME,
      email: cfg.SEED_TEACHER_EMAIL.toLowerCase(),
      passwordHash,
    }).returning({ id: users.id });
    console.log(`created teacher ${cfg.SEED_TEACHER_EMAIL} (${t?.id})`);
  }
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
