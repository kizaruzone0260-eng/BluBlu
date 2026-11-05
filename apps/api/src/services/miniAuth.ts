/**
 * Exchanging a verified Telegram launch for a limited Mini App session.
 *
 * Reuses the existing identity source (`telegram_links` → `users`), never a parallel account.
 * A Telegram user who never linked BluBlu gets a precise, non-enumerating answer: the Mini App
 * tells her to open the bot and link the account. Only a teacher may enter — a linked student
 * is refused here and every route repeats that check against the live row.
 *
 * Task G.2 adds the second door to the SAME session type: `exchangeWebSession` turns an already
 * verified BluBlu web session into a `web`-surface Mini App token. There is still exactly one
 * identity source per door and no third account system: the teacher row is read from `users`,
 * rights are re-checked on every request, and `surface` is a claim the server signed — a client
 * cannot choose it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { telegramLinks, users } from '../db/schema.js';
import { env } from '../env.js';
import {
  signMiniToken, verifyMiniToken, verifyTelegramInitData,
  type InitDataError, type MiniSurface, type MiniTokenClaims,
} from '../lib/telegramMiniAuth.js';
import { audit } from './audit.js';

export type MiniAuthFailure =
  | 'miniUnavailable' | 'invalidInitData' | 'miniNotLinked' | 'miniTeacherOnly'
  | 'passwordChangeRequired' | 'sessionExpired';

export type MiniAuthResult =
  | {
    ok: true;
    token: string;
    teacher: { id: string; name: string; locale: string; tz: string };
  }
  | { ok: false; status: number; error: MiniAuthFailure };

function failure(status: number, error: MiniAuthFailure): MiniAuthResult {
  return { ok: false, status, error };
}

/**
 * Map a verifier failure to a public answer without echoing the payload. The raw initData
 * contains a signed user profile and never belongs in a log line, an error body or a metric.
 */
export function initDataFailure(error: InitDataError): MiniAuthResult {
  void error;
  return failure(401, 'invalidInitData');
}

/** The single account behind one Telegram user, with the live link state. */
async function accountForTelegramUser(db: DB, telegramUserId: number) {
  const [row] = await db.select({
    id: users.id,
    role: users.role,
    name: users.name,
    locale: users.locale,
    tz: users.tz,
    deletedAt: users.deletedAt,
    mustChangePassword: users.mustChangePassword,
    chatId: telegramLinks.chatId,
    blockedAt: telegramLinks.blockedAt,
  }).from(telegramLinks)
    .innerJoin(users, eq(users.id, telegramLinks.userId))
    .where(eq(telegramLinks.chatId, String(telegramUserId)))
    .limit(1);
  return row ?? null;
}

/** Verify raw initData and mint a session token. No DB write beyond the audit entry. */
export async function exchangeInitData(db: DB, rawInitData: string): Promise<MiniAuthResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return failure(503, 'miniUnavailable');
  const verified = verifyTelegramInitData(rawInitData, { botToken: env.TELEGRAM_BOT_TOKEN });
  if (!verified.ok) return initDataFailure(verified.error);

  const account = await accountForTelegramUser(db, verified.data.user.id);
  if (!account || account.deletedAt || account.blockedAt) return failure(403, 'miniNotLinked');
  if (account.role !== 'teacher') return failure(403, 'miniTeacherOnly');
  if (account.mustChangePassword) return failure(403, 'passwordChangeRequired');

  const token = await signMiniToken({
    sub: account.id,
    role: 'teacher',
    locale: account.locale,
    tg: verified.data.user.id,
    surface: 'tg',
  });
  audit(db, account.id, 'mini_login', { surface: 'mini' });
  return {
    ok: true,
    token,
    teacher: { id: account.id, name: account.name, locale: account.locale, tz: account.tz },
  };
}

/**
 * Task G.2: Browser mode — сессия Mini App из ОБЫЧной BluBlu-сессии.
 *
 * Идентичность берётся единственно откуда ей взяться: из проверенного access-токена, который
 * маршрут получил через `app.authenticateTeacher` (там же — «аккаунт жив, роль teacher,
 * временный пароль сменён»). Никакого user id из тела, из заголовка или из `initDataUnsafe`:
 * тело запроса у этого маршрута вообще нет.
 *
 * Дальше — тот же ограниченный токен Mini App, но поверхности `web`: он не утверждает, что
 * человек пришёл из Telegram, и потому не проверяется по `telegram_links`. Права от этого не
 * меняются: `services/homework/mini.ts` решает доступ по `session.userId` ровно так же, и
 * группа/материал/черновик видятся только свои.
 */
export async function exchangeWebSession(db: DB, userId: string): Promise<MiniAuthResult> {
  const [account] = await db.select({
    id: users.id,
    role: users.role,
    name: users.name,
    locale: users.locale,
    tz: users.tz,
    deletedAt: users.deletedAt,
    mustChangePassword: users.mustChangePassword,
  }).from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  // 401, а не 403: для человека это «сессия кончилась, войди заново», а не «тебе отказано».
  if (!account) return failure(401, 'sessionExpired');
  if (account.role !== 'teacher') return failure(403, 'miniTeacherOnly');
  if (account.mustChangePassword) return failure(403, 'passwordChangeRequired');

  const token = await signMiniToken({
    sub: account.id,
    role: 'teacher',
    locale: account.locale,
    surface: 'web',
  });
  audit(db, account.id, 'mini_login', { surface: 'web' });
  return {
    ok: true,
    token,
    teacher: { id: account.id, name: account.name, locale: account.locale, tz: account.tz },
  };
}

export interface MiniSession {
  userId: string;
  role: 'teacher';
  locale: string;
  /** Telegram id для `tg`-сессии; null — когда вход обычный веб (Task G.2). */
  telegramUserId: number | null;
  surface: MiniSurface;
  name: string;
  tz: string;
}

/**
 * Re-check a session on every request, not just at launch:
 *  • the signature and expiry are verified with the Mini App key;
 *  • the account still exists and is still a teacher;
 *  • the SAME Telegram account is still linked (unlinking in the profile revokes the session);
 *  • a new forced password change is honoured immediately.
 */
export async function resolveMiniSession(
  db: DB, token: string,
): Promise<{ ok: true; session: MiniSession } | { ok: false; status: number; error: MiniAuthFailure }> {
  const claims: MiniTokenClaims | null = await verifyMiniToken(token);
  if (!claims) return { ok: false, status: 401, error: 'sessionExpired' };

  const [account] = await db.select({
    id: users.id,
    role: users.role,
    name: users.name,
    locale: users.locale,
    tz: users.tz,
    deletedAt: users.deletedAt,
    mustChangePassword: users.mustChangePassword,
  }).from(users)
    .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)))
    .limit(1);

  if (!account) return { ok: false, status: 401, error: 'sessionExpired' };
  if (account.role !== 'teacher') return { ok: false, status: 403, error: 'miniTeacherOnly' };
  if (account.mustChangePassword) {
    return { ok: false, status: 403, error: 'passwordChangeRequired' };
  }

  /*
   * `tg`-сессия: живая ссылка обязана называть ровно тот Telegram id, что подписан в токене.
   * Ответы сохранены ровно такие, какие были до Task G.2 (это внешний контракт клиента):
   *  • ссылки нет вовсе — `sessionExpired` (связь, на которой держался вход, исчезла);
   *  • ссылка есть, но забанена или называет другой id — `miniNotLinked`.
   * `web`-сессия: ссылки нет по построению, и проверка аккаунта выше — вся, что для неё нужна.
   */
  let telegramUserId: number | null = null;
  if (claims.surface === 'tg') {
    const [link] = await db.select({
      chatId: telegramLinks.chatId,
      blockedAt: telegramLinks.blockedAt,
    }).from(telegramLinks)
      .where(eq(telegramLinks.userId, account.id))
      .limit(1);
    if (!link) return { ok: false, status: 401, error: 'sessionExpired' };
    if (link.blockedAt || link.chatId !== String(claims.tg)) {
      return { ok: false, status: 401, error: 'miniNotLinked' };
    }
    telegramUserId = claims.tg as number;
  }

  return {
    ok: true,
    session: {
      userId: account.id,
      role: 'teacher',
      locale: account.locale,
      telegramUserId,
      surface: claims.surface,
      name: account.name,
      tz: account.tz,
    },
  };
}
