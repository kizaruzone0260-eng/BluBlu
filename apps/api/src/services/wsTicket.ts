import { sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { env } from '../env.js';

const TTL_MS = 30_000; // §logs: 30-second one-time ticket
const hash = (t: string) => createHash('sha256').update(`${env.JWT_SECRET}.${t}`).digest('hex');

/** Issue a ticket bound to (user, lesson session). Plain value is returned once. */
export async function createWsTicket(db: DB, userId: string, sessionId: string): Promise<string> {
  const ticket = randomBytes(24).toString('base64url');
  await db.insert((await import('../db/schema.js')).wsTickets).values({
    tokenHash: hash(ticket), userId, sessionId,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return ticket;
}

/**
 * Atomic single-use consumption: UPDATE … WHERE used_at IS NULL AND expires_at > now().
 * Returns the bound user (with role, live from users) or null.
 */
export async function consumeWsTicket(
  db: DB, ticket: string, sessionId: string,
): Promise<{ userId: string; role: 'teacher' | 'student' } | null> {
  const res = await db.execute(sql`
    UPDATE ws_tickets wt
       SET used_at = now()
      FROM users u
     WHERE wt.token_hash = ${hash(ticket)}
       AND wt.session_id = ${sessionId}
       AND wt.user_id = u.id
       AND wt.used_at IS NULL
       AND wt.expires_at > now()
       AND u.deleted_at IS NULL
    RETURNING u.id AS user_id, u.role::text AS role`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as
    { user_id: string; role: 'teacher' | 'student' }[];
  const row = rows[0];
  return row ? { userId: row.user_id, role: row.role } : null;
}

/** Housekeeping: expired/used tickets older than an hour. */
export async function sweepWsTickets(db: DB): Promise<void> {
  await db.execute(sql`DELETE FROM ws_tickets WHERE expires_at < now() - interval '1 hour'`);
}
