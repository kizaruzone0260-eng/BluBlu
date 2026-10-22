import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { DB } from '../../db/index.js';
import { tgBindTokens, tgCallbackTokens } from '../../db/schema.js';
import { hashToken } from '../notify.js';

/**
 * Telegram limits callback_data to 64 BYTES. The existing signed callbacks in bot.ts
 * are longer, so this module does not reuse them: the button carries a 19-byte opaque
 * reference and the meaning lives in Postgres.
 */
export const HW_CALLBACK_PREFIX = 'h1.';
const CALLBACK_TTL_MS = 24 * 3600_000;

export function isHomeworkCallback(data: string): boolean {
  return data.startsWith(HW_CALLBACK_PREFIX);
}

function token(): string {
  // 12 random bytes → 16 base64url chars; prefix makes 19 bytes.
  return randomBytes(12).toString('base64url');
}

export async function makeHomeworkCallback(
  db: DB, ownerId: string, payload: Record<string, string>, opts: { once?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const once = opts.once ?? true;
  const ttl = Math.max(60_000, Math.min(opts.ttlMs ?? CALLBACK_TTL_MS, CALLBACK_TTL_MS));
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = token();
    const inserted = await db.insert(tgCallbackTokens).values({
      token: t, ownerId, payload, once,
      expiresAt: new Date(Date.now() + ttl),
    }).onConflictDoNothing().returning({ token: tgCallbackTokens.token });
    if (inserted.length) {
      const data = `${HW_CALLBACK_PREFIX}${t}`;
      if (Buffer.byteLength(data, 'utf8') > 64) throw new Error('homework callback data exceeds Telegram limit');
      return data;
    }
  }
  throw new Error('could not allocate a homework callback token');
}

/**
 * Resolve a pressed button. Returns null for another owner, an expired row, a stale
 * one-time token, or a reused one. One-time rows are claimed with a single UPDATE, so
 * two parallel presses of “Publish” cannot both win.
 */
export async function claimHomeworkCallback(
  db: DB, data: string, ownerId: string,
): Promise<Record<string, string> | null> {
  if (!isHomeworkCallback(data)) return null;
  const t = data.slice(HW_CALLBACK_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(t)) return null;
  const [row] = await db.select().from(tgCallbackTokens).where(eq(tgCallbackTokens.token, t)).limit(1);
  if (!row || row.ownerId !== ownerId) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.once) return row.payload;
  if (row.usedAt) return null;
  const claimed = await db.update(tgCallbackTokens).set({ usedAt: new Date() })
    .where(and(
      eq(tgCallbackTokens.token, t),
      eq(tgCallbackTokens.ownerId, ownerId),
      isNull(tgCallbackTokens.usedAt),
      gt(tgCallbackTokens.expiresAt, new Date()),
    ))
    .returning({ payload: tgCallbackTokens.payload });
  return claimed[0]?.payload ?? null;
}

/** One-time group-binding code, typed in the group as `/bind CODE`. Only its hash is stored. */
const BIND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newBindCode(): { code: string; hash: string; expiresAt: Date } {
  let code = '';
  for (let i = 0; i < 8; i++) code += BIND_ALPHABET[randomInt(BIND_ALPHABET.length)];
  return { code, hash: hashToken(code), expiresAt: new Date(Date.now() + 30 * 60_000) };
}

export async function createBindCode(db: DB, ownerId: string): Promise<string> {
  const { code, hash, expiresAt } = newBindCode();
  await db.insert(tgBindTokens).values({ tokenHash: hash, ownerId, expiresAt });
  return code;
}

/** Consume a bind code atomically. The wrong linked account does NOT burn the code. */
export type BindClaim =
  | { status: 'ok'; ownerId: string }
  | { status: 'wrongAccount'; ownerId: string };

export async function claimBindCode(
  db: DB, rawCode: string, expectedOwnerId?: string,
): Promise<BindClaim | null> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) return null;
  const hash = hashToken(code);
  const [row] = await db.select({ ownerId: tgBindTokens.ownerId }).from(tgBindTokens)
    .where(and(
      eq(tgBindTokens.tokenHash, hash),
      isNull(tgBindTokens.usedAt),
      gt(tgBindTokens.expiresAt, new Date()),
    )).limit(1);
  if (!row) return null;
  if (expectedOwnerId && row.ownerId !== expectedOwnerId) {
    return { status: 'wrongAccount', ownerId: row.ownerId };
  }
  const claimed = await db.update(tgBindTokens).set({ usedAt: new Date() })
    .where(and(
      eq(tgBindTokens.tokenHash, hash),
      isNull(tgBindTokens.usedAt),
      gt(tgBindTokens.expiresAt, new Date()),
    ))
    .returning({ ownerId: tgBindTokens.ownerId });
  return claimed[0] ? { status: 'ok', ownerId: claimed[0].ownerId } : null;
}

/** Remove only expired helper rows; drafts and publications are history and stay. */
export async function sweepHomeworkTokens(db: DB, now = new Date()): Promise<void> {
  await db.delete(tgCallbackTokens).where(lt(tgCallbackTokens.expiresAt, now));
  // One day of grace keeps an “expired” code answer honest long enough to be diagnosed.
  await db.delete(tgBindTokens).where(lt(tgBindTokens.expiresAt, new Date(now.getTime() - 86_400_000)));
}
