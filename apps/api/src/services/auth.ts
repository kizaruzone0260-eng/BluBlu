import { eq, and, isNull, lt } from 'drizzle-orm';
import type { Locale } from '@klass/shared';
import { users, classMembers, refreshTokens, loginAttempts } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  signAccessToken, generateRefreshToken, generateFamilyId, hashRefreshToken,
} from '../lib/tokens.js';
import { redeemInviteCode, redeemInviteLink, peekInviteLink, inviteStateCode } from './invites.js';
import { consumeEmailCode, precheckEmailCode } from './emailVerify.js';

export type AuthResult =
  | { ok: true; accessToken: string; user: PublicUser }
  | { ok: false; error: 'invalidCredentials' | 'invalidCode' | 'emailTaken' | 'emailCodeInvalid' };

export interface PublicUser {
  id: string;
  role: 'teacher' | 'student';
  name: string;
  /** item 9 — family name ('' for accounts created before the split). */
  lastName: string;
  email: string;
  locale: string;
  /** task 1: was this language ever chosen by the person, or is it the column default? */
  localeExplicit: boolean;
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
    localeExplicit: u.localeExplicit,
    mustChangePassword: u.mustChangePassword,
  };
}

/**
 * New student: create user, redeem class code atomically, add membership —
 * all inside ONE transaction. If the code is invalid/used or the email is
 * taken, everything rolls back; the race between two concurrent redemptions
 * of the same code is decided by the single UPDATE … WHERE used_at IS NULL.
 *
 * Часть F (2026-10-16): код из письма списывается ТЕМ ЖЕ транзакционным ходом. Причина не в
 * аккуратности, а в двух обещаниях сразу: «списание атомарно» (два параллельных подтверждения
 * одного кода не создадут двух аккаунтов) и «ошибка не сжигает письмо» (не тот код класса или
 * занятый email откатывают и списание, и человек может попробовать снова тем же кодом).
 */
class InvalidCodeError extends Error {}
class EmailCodeError extends Error {}
class EmailTakenError extends Error {}

/**
 * Task B (2026-10-23) — the reason a pupil saw «Something went wrong» on step 2.
 *
 * The unique index on `users.email` is the race guard for two registrations of one address, and
 * the code below used to read `err.code === '23505'` to turn it into `emailTaken`. Inside
 * `db.transaction` that never matches: drizzle-orm wraps whatever the driver threw in its own
 * `Failed query: …` error and the Postgres code lands on `err.cause.code` (proved by the
 * reproduction that became test/integration/auth-nat.test.ts — a second registration of a taken
 * address answered 500, not 409, and the screen had nothing better to say than the generic
 * sentence). So the walk goes down the cause chain, and the check is paired with an explicit
 * pre-read inside the same transaction so the ordinary case does not depend on error shapes at
 * all. Neither of them replaces the other: the pre-read is the common path, the constraint is the
 * concurrent path.
 */
function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if ((cur as { code?: string }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function registerStudentByCode(
  db: DB,
  input: {
    firstName: string; lastName: string; email: string; password: string; code: string;
    locale?: Locale;
    /** код из письма; `undefined` = подтверждение почты выключено (EMAIL_PROVIDER=none) */
    emailCode?: string;
  },
): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);
  /*
   * Часть F: ПРОВЕРКА кода — до транзакции (чтобы засчитанная попытка пережила откат),
   * СПИСАНИЕ — внутри (чтобы отказ по коду класса не сжёг письмо). Один шаг вместо двух так
   * не делается: и то, и другое утверждения про разный отказ, и откатывает транзакция только
   * одно из них.
   */
  if (input.emailCode !== undefined
    && (await precheckEmailCode(db, input.email, input.emailCode)) !== 'live') {
    return { ok: false, error: 'emailCodeInvalid' };
  }
  try {
    const user = await db.transaction(async (tx) => {
      // Task B: a taken address is the ordinary case, so it is answered by a read, not by a
      // constraint violation. `users.email` is unique over ALL rows — a soft-deleted account holds
      // its address too — so the check deliberately ignores `deleted_at`, exactly like the index.
      const takenBefore = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (takenBefore.length > 0) throw new EmailTakenError();
      if (input.emailCode !== undefined) {
        const spent = await consumeEmailCode(tx as unknown as DB, input.email, input.emailCode);
        if (!spent) throw new EmailCodeError();
      }
      const [u] = await tx
        .insert(users)
        .values({
          role: 'student', name: input.firstName, lastName: input.lastName, email: input.email, passwordHash,
          // registration step 2 already collected BOTH names → no gate later
          profileCompletedAt: new Date(),
          // Language (task 1): the register screen's own switch used to be thrown away here —
          // the row took the column default, and the app then applied THAT over the user's pick.
          ...(input.locale ? { locale: input.locale, localeExplicit: true } : {}),
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
    if (err instanceof EmailCodeError) return { ok: false, error: 'emailCodeInvalid' };
    if (err instanceof EmailTakenError) return { ok: false, error: 'emailTaken' };
    // the race path: two registrations of one address in the same instant — the second is stopped
    // by the unique index, and its code may sit anywhere in the wrapper chain.
    if (isUniqueViolation(err)) return { ok: false, error: 'emailTaken' };
    throw err;
  }
}

/**
 * Одноразовая ссылка-приглашение (2026-10-23, часть A): регистрация тем же атомарным ходом, что и
 * регистрация по коду класса. Отличие одно — вместо проверки восьмизначного кода расходуется
 * токен приглашения, и расход происходит ВНУТРИ той же транзакции.
 *
 * Почему это важно ровно так же, как с кодом: если бы токен списывался до вставки аккаунта,
 * любая ошибка (занятая почта, отвалившийся коннект) оставляла человека без приглашения, а
 * учитель получал бы «ссылка не работает» вместо второй попытки. Здесь либо аккаунт + членство +
 * израсходованное приглашение, либо ничего.
 */
export type InviteRegisterResult =
  | { ok: true; accessToken: string; user: PublicUser; classId: string; inviteId: string }
  | { ok: false; error: 'emailTaken' | 'invalidInput' | 'inviteInvalid' | 'inviteExpired' | 'inviteRevoked' | 'inviteUsed' };

class InviteStateError extends Error {
  constructor(readonly state: 'inviteInvalid' | 'inviteExpired' | 'inviteRevoked' | 'inviteUsed' | 'invalidInput') { super(state); }
}

export async function registerStudentByInviteLink(
  db: DB,
  input: {
    token: string; firstName: string; lastName: string; email: string; password: string; locale?: Locale;
  },
): Promise<InviteRegisterResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    const created = await db.transaction(async (tx) => {
      // Порядок внутри транзакции важен. Сначала — состояние токена: пока приглашение не
      // проверено, мы не имеем права сообщить НИЧЕГО про адрес (иначе постучать списком почт
      // можно было бы любым мусорным токеном). Расход же остаётся ПОСЛЕДНИМ шагом: промах
      // по адресу или по вставке откатывает всё, и ссылка не сгорает.
      const peek = await peekInviteLink(tx, input.token);
      if (peek.state !== 'ok') throw new InviteStateError(inviteStateCode(peek.state));
      // занятый адрес читается ЯВНО до любых записей, чтобы обычный случай не зависел от формы
      // ошибки уникального индекса (тот же приём, что у `registerStudentByCode`)
      const taken = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (taken.length > 0) throw new EmailTakenError();
      const [u] = await tx.insert(users).values({
        role: 'student', name: input.firstName, lastName: input.lastName, email: input.email, passwordHash,
        profileCompletedAt: new Date(),
        ...(input.locale ? { locale: input.locale, localeExplicit: true } : {}),
      }).returning();
      if (!u) throw new InviteStateError('invalidInput');
      // расход — ПОСЛЕ вставки аккаунта и ТЕМ ЖЕ ходом: `UPDATE … WHERE used_at IS NULL` решает
      // и гонку двух запросов с одной ссылкой (один проходит, второй кидает InviteStateError и
      // вся транзакция, вместе с аккаунтом, откатывается), и «сбой не сжигает приглашение»
      const redeem = await redeemInviteLink(tx, input.token, u.id);
      if (!redeem.ok) throw new InviteStateError(inviteStateCode(redeem.state));
      await tx.insert(classMembers).values({ classId: redeem.classId, userId: u.id });
      return { user: u, classId: redeem.classId, inviteId: redeem.inviteId };
    });
    const accessToken = await signAccessToken({
      sub: created.user.id, role: created.user.role, locale: created.user.locale,
    });
    return { ok: true, accessToken, user: toPublic(created.user), classId: created.classId, inviteId: created.inviteId };
  } catch (err) {
    if (err instanceof EmailTakenError) return { ok: false, error: 'emailTaken' };
    if (err instanceof InviteStateError) {
      return err.state === 'invalidInput'
        ? { ok: false, error: 'invalidInput' }
        : { ok: false, error: err.state };
    }
    if (isUniqueViolation(err)) return { ok: false, error: 'emailTaken' };
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

/** Одна задержка на «нет такого аккаунта» и «не тот пароль» — и на смене пароля тоже. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * B2 (2026-10-16): строка счётчика, у которой нет активной блокировки и которая не
 * обновлялась сутки, ничего не защищает — она просто копит email'ы. Удаляется фоновой
 * уборкой. Строки с наступившей блокировкой не трогаются намеренно: `failCount` у них и есть
 * память о том, что окно следующего перебора должно быть длиннее.
 */
export const LOGIN_ATTEMPT_TTL_MS = 24 * 3600_000;

export async function sweepLoginAttempts(db: DB, now = new Date(), maxAgeMs = LOGIN_ATTEMPT_TTL_MS): Promise<number> {
  const rows = await db.delete(loginAttempts).where(and(
    isNull(loginAttempts.lockedUntil),
    lt(loginAttempts.updatedAt, new Date(now.getTime() - maxAgeMs)),
  )).returning({ email: loginAttempts.email });
  return rows.length;
}

export async function login(db: DB, email: string, password: string): Promise<AuthResult> {
  // Locked out? Record the attempt anyway (so continued hammering GROWS the
  // window, up to the cap) but return the SAME generic failure as a bad
  // password — the response never reveals whether the account exists or is
  // merely throttled. A dummy verify keeps the timing uniform.
  if ((await lockState(db, email)).locked) {
    await verifyPassword(DUMMY_HASH, password);
    await recordFailure(db, email);
    return { ok: false, error: 'invalidCredentials' };
  }
  const [user] = await db.select().from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  if (!user) {
    await verifyPassword(DUMMY_HASH, password); // constant-ish time on missing user
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

/**
 * Временный пароль ученика (задание учителя из списка класса).
 *
 * Три вещи происходят обязательно, и вторая из них — причина, по которой сброс раньше «не
 * работал»:
 *  1) новый хеш + `must_change_password = true` (серверный гейт в `plugins/auth.ts` не пустит
 *     дальше смены пароля);
 *  2) снятие существующих refresh-сессий;
 *  3) снятие строки `login_attempts`.
 *
 * Пункт 3 — это и есть исправление (задача 2026-10-23, часть C). Ученик, которого не пускает в
 * аккаунт, и есть тот, кому ставят новый пароль: к этому моменту он уже успел пять раз ошибиться,
 * а `login()` под блокировкой пароль даже не проверяет. Пока строка счётчика висела, учитель
 * менял пароль, ученик вводил новый и получал тот же 401 — до 15 минут, и каждая попытка окно
 * удлиняла. Сброс пароля access возвращает сразу.
 *
 * Анти-перебор это не ослабляет: снимается ровно строка того аккаунта, чей пароль только что
 * поменял учитель с правами на этот класс. Дальше счётчик начинается с нуля — как после любого
 * законного входа.
 */
export async function setTempPassword(db: DB, userId: string, newPassword: string): Promise<void> {
  const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: true })
    .where(eq(users.id, userId));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  if (who?.email) await db.delete(loginAttempts).where(eq(loginAttempts.email, who.email));
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
  if (!u) return { ok: false, reason: 'wrongCurrent' };
  /*
   * B1 (2026-10-16): смена пароля — это тоже проверка текущего, и раньше она ничего
   * не стоила: счётчик перебора стоял только на входе. Модель можно было подбирать здесь
   * сколько угодно, обходя локаут, который держит `/api/auth/login`. Теперь тот же счётчик
   * (ключ — нормализованный email аккаунта), та же задержка и тот же ответ: «wrongCurrent»
   * не различает «не угадал» и «заблокирован на N минут», а успех сбрасывает счётчик.
   */
  if ((await lockState(db, u.email)).locked) {
    await verifyPassword(DUMMY_HASH, current); // ровный тайминг и под блокировкой
    await recordFailure(db, u.email);          // продолжение стука растит окно (до потолка)
    return { ok: false, reason: 'wrongCurrent' };
  }
  if (!(await verifyPassword(u.passwordHash, current))) {
    await recordFailure(db, u.email);
    return { ok: false, reason: 'wrongCurrent' };
  }
  // same policy as registration (≥10, letters, no spaces, not a common password)
  const { passwordPolicy } = await import('@klass/shared');
  if (!passwordPolicy.safeParse(next).success) return { ok: false, reason: 'weak' };
  await db.update(users)
    .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
    .where(eq(users.id, userId));
  // успех сбрасывает счётчик — как вход, иначе одна опечатка помнит аккаунту сутки
  await db.delete(loginAttempts).where(eq(loginAttempts.email, u.email));
  await revokeAllSessions(db, userId);
  return { ok: true };
}

export function signAccessTokenForUser(u: typeof users.$inferSelect): Promise<string> {
  return signAccessToken({ sub: u.id, role: u.role, locale: u.locale });
}
