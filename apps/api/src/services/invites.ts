import { sql, eq, and, isNull, gt, desc } from 'drizzle-orm';
import { inviteCodes, classes } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { generateInviteCode, hashInviteCode } from '../lib/invite.js';
import { randomUUID } from 'node:crypto';

export interface RedeemResult {
  ok: boolean;
  classId?: string;
}

export async function createInviteCode(
  db: DB,
  classId: string,
  createdBy: string,
  ttlDays: number,
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generateInviteCode();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.insert(inviteCodes).values({
    id,
    classId,
    codeHash: hashInviteCode(code, env.JWT_SECRET),
    createdBy,
    expiresAt,
  });
  return { id, code, expiresAt };
}

/**
 * Atomic single-statement redemption (acceptance criterion of stage 1):
 * two concurrent requests can never consume the same code, because the row
 * is locked by the UPDATE itself and only an unused, unrevoked, unexpired row matches.
 */
/**
 * Item 9 step 1 — verify WITHOUT consuming: active, unredeemed, unexpired, unrevoked.
 * The caller must answer with ONE generic error for every failing state, so an
 * attacker cannot tell a wrong code from a used or expired one.
 */
export async function peekInviteCode(db: DB, plainCode: string): Promise<boolean> {
  const hash = hashInviteCode(plainCode, env.JWT_SECRET);
  const [row] = await db
    .select({ id: inviteCodes.id })
    .from(inviteCodes)
    .where(and(
      eq(inviteCodes.codeHash, hash),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .limit(1);
  return Boolean(row);
}

export async function redeemInviteCode(db: DB, plainCode: string, userId: string): Promise<RedeemResult> {
  const hash = hashInviteCode(plainCode, env.JWT_SECRET);
  const res = await db.execute(sql`
    UPDATE invite_codes
       SET used_by = ${userId}, used_at = now()
     WHERE code_hash = ${hash}
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
    RETURNING class_id`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as { class_id: string }[];
  const row = rows[0];
  if (!row) return { ok: false };
  return { ok: true, classId: row.class_id };
}

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export async function listInviteCodes(db: DB, classId: string) {
  const rows = await db
    .select({
      id: inviteCodes.id,
      createdAt: inviteCodes.createdAt,
      expiresAt: inviteCodes.expiresAt,
      usedAt: inviteCodes.usedAt,
      revokedAt: inviteCodes.revokedAt,
      usedByName: sql<string | null>`(select name from users where users.id = invite_codes.used_by)`,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.classId, classId))
    .orderBy(desc(inviteCodes.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    status: (r.revokedAt ? 'revoked' : r.usedAt ? 'used' : r.expiresAt.getTime() <= now ? 'expired' : 'active') as InviteStatus,
  }));
}

/** Only the ACTIVE code of a class may be revoked. Returns true if it was active. */
export async function revokeInviteCode(db: DB, id: string, classId: string): Promise<boolean> {
  const res = await db
    .update(inviteCodes)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(inviteCodes.id, id),
      eq(inviteCodes.classId, classId),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .returning({ id: inviteCodes.id });
  return res.length > 0;
}

export async function getActiveInviteForClass(db: DB, classId: string) {
  const [row] = await db
    .select({ id: inviteCodes.id, expiresAt: inviteCodes.expiresAt })
    .from(inviteCodes)
    .where(and(
      eq(inviteCodes.classId, classId),
      isNull(inviteCodes.usedAt),
      isNull(inviteCodes.revokedAt),
      gt(inviteCodes.expiresAt, new Date()),
    ))
    .limit(1);
  return row ?? null;
}

export async function classExists(db: DB, classId: string) {
  const [c] = await db.select({ id: classes.id }).from(classes).where(eq(classes.id, classId)).limit(1);
  return Boolean(c);
}
