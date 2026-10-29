/**
 * Telegram Mini App launch authentication.
 *
 * The ONLY thing the client is trusted for is the raw `initData` string. Its signature is
 * verified here with the bot token (`HMAC_SHA256("WebAppData", token)` over the sorted
 * `key=value` lines, as Telegram Web Apps specifies), compared in constant time, and the
 * `auth_date` is checked for age and for a clock far in the future. The Telegram user id is
 * then read from the SIGNED payload — never from `initDataUnsafe`, a header or a body field
 * the caller could have written.
 *
 * A verified launch is exchanged for a limited Mini App session token. It is signed with a
 * key derived from JWT_SECRET and carries `aud: blublu-mini` + `scope: mini`, so the regular
 * API (which verifies with the plain JWT_SECRET) cannot accept it, and this module refuses a
 * normal access token in the other direction. The token also names the Telegram user id, so
 * unlinking that Telegram account revokes it on the next request (routes re-check the live
 * `telegram_links` row, not just the signature).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';

export type InitDataError =
  | 'initDataMissing' | 'initDataMalformed' | 'initDataHashMissing'
  | 'initDataHashInvalid' | 'initDataExpired' | 'initDataFromFuture'
  | 'initDataUserMissing';

export interface TelegramWebAppUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedInitData {
  user: TelegramWebAppUser;
  authDate: Date;
  queryId: string | null;
  /** When true, the launch came from Telegram's inline/attachment menu. Informational only. */
  inlineMode: boolean;
}

/** Telegram explicitly recommends accepting initData for no longer than a day. */
export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;
/** A device clock a few minutes ahead must not lock the teacher out; an hour is not a launch. */
export const INIT_DATA_FUTURE_SKEW_SEC = 5 * 60;
/** Limited session: enough for a homework session, short enough to be a session, not a key. */
export const MINI_SESSION_TTL = '8h';
export const MINI_SESSION_TTL_SEC = 8 * 60 * 60;

/** Derive the documented WebAppData secret: HMAC_SHA256(key="WebAppData", message=token). */
function webAppSecret(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

/** The exact string Telegram signs: decoded `key=value` lines, sorted by key, hash excluded. */
export function dataCheckString(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    if (seen.has(key)) throw new Error('duplicate initData key');
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export type VerifyResult =
  | { ok: true; data: VerifiedInitData }
  | { ok: false; error: InitDataError };

/**
 * Verify a raw `initData` string. `botToken` is the existing @classblu_bot token; without a
 * token this function cannot verify anything and says so (the route turns that into 503).
 */
export function verifyTelegramInitData(
  raw: string,
  opts: {
    botToken: string;
    now?: Date;
    maxAgeSec?: number;
    futureSkewSec?: number;
  },
): VerifyResult {
  if (!raw.trim()) return { ok: false, error: 'initDataMissing' };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, error: 'initDataMalformed' };
  }
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'initDataHashMissing' };
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, error: 'initDataHashInvalid' };

  let check: string;
  try {
    check = dataCheckString(params);
  } catch {
    return { ok: false, error: 'initDataMalformed' };
  }

  const expected = createHmac('sha256', webAppSecret(opts.botToken))
    .update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: 'initDataHashInvalid' };
  }

  const authRaw = params.get('auth_date');
  if (!authRaw || !/^\d{1,12}$/.test(authRaw)) return { ok: false, error: 'initDataMalformed' };
  const authDate = new Date(Number(authRaw) * 1000);
  if (Number.isNaN(authDate.getTime())) return { ok: false, error: 'initDataMalformed' };
  const now = opts.now ?? new Date();
  const ageSec = (now.getTime() - authDate.getTime()) / 1000;
  if (ageSec > (opts.maxAgeSec ?? INIT_DATA_MAX_AGE_SEC)) {
    return { ok: false, error: 'initDataExpired' };
  }
  if (ageSec < -(opts.futureSkewSec ?? INIT_DATA_FUTURE_SKEW_SEC)) {
    return { ok: false, error: 'initDataFromFuture' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, error: 'initDataUserMissing' };
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    return { ok: false, error: 'initDataUserMissing' };
  }
  if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) {
    return { ok: false, error: 'initDataUserMissing' };
  }
  if (user.is_bot === true) return { ok: false, error: 'initDataUserMissing' };

  return {
    ok: true,
    data: {
      user,
      authDate,
      queryId: params.get('query_id'),
      inlineMode: params.get('chat_type') === 'inline',
    },
  };
}

// ─── limited Mini App session ────────────────────────────────────────────────

export interface MiniTokenClaims {
  sub: string;
  role: 'teacher';
  locale: string;
  /** Telegram user id from the signed payload; the live link must still name this id. */
  tg: number;
}

function miniKey(): Uint8Array {
  return createHmac('sha256', env.JWT_SECRET).update('blublu-mini-app-v1').digest();
}

export async function signMiniToken(claims: MiniTokenClaims): Promise<string> {
  return new SignJWT({
    role: claims.role,
    locale: claims.locale,
    tg: claims.tg,
    scope: 'mini',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience('blublu-mini')
    .setIssuedAt()
    .setExpirationTime(MINI_SESSION_TTL)
    .sign(miniKey());
}

export async function verifyMiniToken(token: string): Promise<MiniTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, miniKey(), { audience: 'blublu-mini' });
    if (payload.scope !== 'mini') return null;
    if (typeof payload.sub !== 'string' || payload.role !== 'teacher') return null;
    if (typeof payload.tg !== 'number' || !Number.isSafeInteger(payload.tg) || payload.tg <= 0) return null;
    return {
      sub: payload.sub,
      role: 'teacher',
      locale: typeof payload.locale === 'string' ? payload.locale : 'en',
      tg: payload.tg,
    };
  } catch {
    return null;
  }
}

/** `expiresAt` in ISO, derived from the same 8h constant (never a second, drifting value). */
export function miniSessionExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + MINI_SESSION_TTL_SEC * 1000).toISOString();
}
