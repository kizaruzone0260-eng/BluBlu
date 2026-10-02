import { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { sendDue, scanReminders, type NotifyTransport } from './notify.js';
import { classes } from '../db/schema.js';

let boss: PgBoss | null = null;
let heartbeat: NodeJS.Timeout | null = null;

/**
 * pg-boss (MIT) provides the delayed queue over Postgres — no Redis (§5).
 * A slow heartbeat is kept as a safety net: enqueue/fan-out is idempotent via
 * dedupe_key, so double scheduling can never double-send.
 */
export async function initNotifyWorker(db: DB, transport: NotifyTransport): Promise<void> {
  boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  await boss.start();
  await boss.createQueue('notify-flush');
  await boss.work('notify-flush', () => sendDue(db, transport));
  heartbeat = setInterval(() => {
    void sendDue(db, transport).catch(() => undefined);
    void scanReminders(db).catch(() => undefined);
  }, 30_000);
  heartbeat.unref?.();
}

export async function stopNotifyWorker(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (boss) { await boss.stop({ graceful: false }); boss = null; }
}

/** Schedule a flush shortly after `at` (coalesced per minute bucket). */
export function scheduleFlush(at: Date): void {
  void boss?.send('notify-flush', {}, {
    startAfter: at,
    singletonKey: `flush:${Math.floor(at.getTime() / 60_000)}`,
    retryLimit: 3,
    retryBackoff: true,
  }).catch(() => undefined);
}

export async function classTitle(db: DB, classId: string): Promise<string> {
  const [c] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1);
  return c?.name ?? '';
}
