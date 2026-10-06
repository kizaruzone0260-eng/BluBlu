import { eq, and, isNull } from 'drizzle-orm';
import { users, classMembers, refreshTokens, loginAttempts } from '../db/schema.js';
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
  /** name screen (task 2): false → the «Имя и фамилия» gate must be shown. */
  profileCompleted: boolean;
  /** part 3: a temporary password was issued — force a change before use. */
  mustChangePassword: boolean;
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return {
    id: u.id, role: u.role, name: u.name, lastName: u.lastName, email: u.email,
    locale: u.locale, tz: u.tz, profileCompleted: u.profileCompletedAt != null,
    mustChangePassword: u.mustChangePassword,
  };
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
        .values({
          role: 'student', name: input.firstName, lastName: input.lastName, email: input.email, passwordHash,
          // registration step 2 already collected BOTH names → no gate later
          profileCompletedAt: new Date(),
        })
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

/**
 * Progressive, per-account brute-force lockout (Hardening part 2). Postgres-
 * backed so it survives restarts and applies across every client IP. The delay
 * grows exponentially after 5 consecutive failures (30 s, 60 s, …) and is
 * CAPPED at 15 minutes, so no account — owner or teacher included — is ever
 * locked out permanently. `email` arrives normalized (the login schema
 * lowercases/trims it).
 */
const LOCK_THRESHOLD = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 900_000; // 15 minutes

async function lockState(db: DB, email: string): Promise<{ locked: boolean }> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1);
  if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) return { locked: true };
  return { locked: false };
}

async function recordFailure(db: DB, email: string): Promise<void> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email)).limit(1);
  const failCount = (row?.failCount ?? 0) + 1;
  const lockedUntil = failCount >= LOCK_THRESHOLD
    ? new Date(Date.now() + Math.min(LOCK_BASE_MS * 2 ** (failCount - LOCK_THRESHOLD), LOCK_MAX_MS))
    : null;
  await db.insert(loginAttempts)
    .values({ email, failCount, lockedUntil, updatedAt: new Date() })
    .onConflictDoUpdate({ target: loginAttempts.email, set: { failCount, lockedUntil, updatedAt: new Date() } });
}

export async function login(db: DB, email: string, password: string): Promise<AuthResult> {
  // Locked out? Record the attempt anyway (so continued hammering GROWS the
  // window, up to the cap) but return the SAME generic failure as a bad
  // password — the response never reveals whether the account exists or is
  // merely throttled. A dummy verify keeps the timing uniform.
  if ((await lockState(db, email)).locked) {
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', password);
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  const [user] = await db.select().from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (!user) {
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', password); // constant-ish time on missing user
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  // success clears the counter for this account
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
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
  await db.update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: true })
    .where(eq(users.id, userId));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}

/** Revoke every refresh session for a user (logout-all / on password change). */
export async function revokeAllSessions(db: DB, userId: string): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}

/**
 * Part 3: change one's own password. Verifies the current password, applies the
 * registration policy to the new one, clears the must-change flag, and revokes
 * ALL other refresh sessions (the caller re-issues a fresh session for the
 * current device so the user is not kicked out where they just acted).
 * Returns false when the current password is wrong or the new one is invalid.
 */
export async function changePassword(
  db: DB, userId: string, current: string, next: string,
): Promise<{ ok: true } | { ok: false; reason: 'wrongCurrent' | 'weak' }> {
  const [u] = await db.select().from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
  if (!u || !(await verifyPassword(u.passwordHash, current))) return { ok: false, reason: 'wrongCurrent' };
  // same policy as registration (≥10, letters, no spaces, not a common password)
  const { passwordPolicy } = await import('@klass/shared');
  if (!passwordPolicy.safeParse(next).success) return { ok: false, reason: 'weak' };
  await db.update(users)
    .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
    .where(eq(users.id, userId));
  await revokeAllSessions(db, userId);
  return { ok: true };
}

export function signAccessTokenForUser(u: typeof users.$inferSelect): Promise<string> {
  return signAccessToken({ sub: u.id, role: u.role, locale: u.locale });
}
