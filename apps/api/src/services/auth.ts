import { eq, and, isNull } from 'drizzle-orm';
import { users, classMembers, refreshTokens } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  signAccessToken, generateRefreshToken, generateFamilyId, hashRefreshToken,
} from '../lib/tokens.js';
import { redeemInviteCode } from './invites.js';

export type AuthResult =
  | { ok: true; accessToken: string; user: PublicUser }
  | { ok: false; error: 'invalidCredentials' | 'invalidCode' | 'emailTaken' };

export interface PublicUser {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  /** item 9 — family name ('' for accounts created before the split). */
  lastName: string;
  email: string;
  locale: string;
  tz: string;
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return { id: u.id, role: u.role, name: u.name, lastName: u.lastName, email: u.email, locale: u.locale, tz: u.tz };
}

/**
 * New student: create user, redeem class code atomically, add membership —
 * all inside ONE transaction. If the code is invalid/used or the email is
 * taken, everything rolls back; the race between two concurrent redemptions
 * of the same code is decided by the single UPDATE … WHERE used_at IS NULL.
 */
class InvalidCodeError extends Error {}

export async function registerStudentByCode(
  db: DB,
  input: { firstName: string; lastName: string; email: string; password: string; code: string },
): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ role: 'student', name: input.firstName, lastName: input.lastName, email: input.email, passwordHash })
        .returning();
      if (!u) throw new InvalidCodeError();
      const redeem = await redeemInviteCode(tx as unknown as DB, input.code, u.id);
      if (!redeem.ok || !redeem.classId) throw new InvalidCodeError();
      await tx.insert(classMembers).values({ classId: redeem.classId, userId: u.id });
      return u;
    });
    const accessToken = await signAccessToken({ sub: user.id, role: user.role, locale: user.locale });
    return { ok: true, accessToken, user: toPublic(user) };
  } catch (err) {
    if (err instanceof InvalidCodeError) return { ok: false, error: 'invalidCode' };
    if ((err as { code?: string }).code === '23505') return { ok: false, error: 'emailTaken' };
    throw err;
  }
}

export async function login(db: DB, email: string, password: string): Promise<AuthResult> {
  const [user] = await db.select().from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (!user) {
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', password); // constant-ish time on missing user
    return { ok: false, error: 'invalidCredentials' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    return { ok: false, error: 'invalidCredentials' };
  }
  const accessToken = await signAccessToken({ sub: user.id, role: user.role, locale: user.locale });
  return { ok: true, accessToken, user: toPublic(user) };
}

export interface SessionPair {
  refreshToken: string;
  expiresAt: Date;
}

export async function issueRefreshSession(db: DB, userId: string, familyId?: string): Promise<SessionPair> {
  const token = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000);
  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashRefreshToken(token),
    familyId: familyId ?? generateFamilyId(),
    expiresAt,
  });
  return { refreshToken: token, expiresAt };
}

export type RefreshResult =
  | { ok: true; userId: string; newRefresh: SessionPair }
  | { ok: false; reason: 'invalid' | 'expired' | 'reused' };

/**
 * Rotation: old token is marked replaced; presenting a replaced token kills the
 * whole family — UNLESS within REFRESH_REUSE_GRACE_MS of the rotation AND the
 * family still has its active successor untouched. That grace covers the benign
 * case: the browser aborted the rotation response (instant reload) and replays
 * the stale token; a real thief replay gets a fresh session ≤5 s old, while any
 * later replay still triggers the family kill.
 */
export async function rotateRefresh(db: DB, token: string): Promise<RefreshResult> {
  const hash = hashRefreshToken(token);
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.replacedAt) {
    const withinGrace = Date.now() - row.replacedAt.getTime() <= env.REFRESH_REUSE_GRACE_MS;
    if (withinGrace) {
      const [successor] = await db.select({ id: refreshTokens.id }).from(refreshTokens)
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.replacedAt)))
        .limit(1);
      if (successor) {
        await db.update(refreshTokens).set({ replacedAt: new Date() })
          .where(and(eq(refreshTokens.id, successor.id), isNull(refreshTokens.replacedAt)));
        const fresh = await issueRefreshSession(db, row.userId, row.familyId);
        return { ok: true, userId: row.userId, newRefresh: fresh };
      }
    }
    await db.delete(refreshTokens).where(eq(refreshTokens.familyId, row.familyId));
    return { ok: false, reason: 'reused' };
  }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  const updated = await db
    .update(refreshTokens)
    .set({ replacedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.replacedAt)))
    .returning({ id: refreshTokens.id });
  if (updated.length === 0) {
    // concurrent double-use: treat as reuse
    await db.delete(refreshTokens).where(eq(refreshTokens.familyId, row.familyId));
    return { ok: false, reason: 'reused' };
  }
  const newRefresh = await issueRefreshSession(db, row.userId, row.familyId);
  return { ok: true, userId: row.userId, newRefresh };
}

export async function logout(db: DB, token: string): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));
}

export async function setTempPassword(db: DB, userId: string, newPassword: string): Promise<void> {
  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, userId));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}

export function signAccessTokenForUser(u: typeof users.$inferSelect): Promise<string> {
  return signAccessToken({ sub: u.id, role: u.role, locale: u.locale });
}
