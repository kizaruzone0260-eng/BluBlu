import { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { sendDue, scanReminders, type NotifyTransport } from './notify.js';
import { publishDuePosts } from './posts.js';
import { attachErrorLogging } from '../lib/errorObservers.js';
import { classes } from '../db/schema.js';

let boss: PgBoss | null = null;
let heartbeat: NodeJS.Timeout | null = null;

/**
 * pg-boss (MIT) provides the delayed queue over Postgres — no Redis (§5).
 * A slow heartbeat is kept as a safety net: enqueue/fan-out is idempotent via
 * dedupe_key, so double scheduling can never double-send. The same is true of
 * scheduled material publishing (task A): publishDuePosts flips rows from
 * 'scheduled' to 'published' with a status guard, so boss + heartbeat racing
 * publishes exactly once.
 */
export async function initNotifyWorker(db: DB, transport: NotifyTransport): Promise<void> {
  boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  // pg-boss extends EventEmitter: an unhandled 'error' would surface as an uncaughtException and
  // take the API down. Log the class and the code, keep the queue running.
  attachErrorLogging(boss, 'pg-boss');
  await boss.start();
  await boss.createQueue('notify-flush');
  await boss.work('notify-flush', () => sendDue(db, transport));
  await boss.createQueue('publish-post');
  await boss.work('publish-post', () => publishDuePosts(db));
  heartbeat = setInterval(() => {
    void sendDue(db, transport).catch(() => undefined);
    void scanReminders(db).catch(() => undefined);
    void publishDuePosts(db).catch(() => undefined);
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

/** Material task A: fire the publish scan at (or just after) the scheduled time. */
export function schedulePostPublish(at: Date): void {
  void boss?.send('publish-post', {}, {
    startAfter: at,
    singletonKey: `publish:${Math.floor(at.getTime() / 15_000)}`,
    retryLimit: 3,
    retryBackoff: true,
  }).catch(() => undefined);
}

export async function classTitle(db: DB, classId: string): Promise<string> {
  const [c] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1);
  return c?.name ?? '';
}
