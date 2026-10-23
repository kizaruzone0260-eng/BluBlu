import { cookieIsSecure } from './prodConfig.js';
import { env } from '../env.js';

/**
 * Единственные атрибуты refresh-куки (2026-10-23).
 *
 * Раньше они были написаны один раз внутри `routes/auth.ts`, и это было терпимо, пока вход был
 * один. Регистрация по одноразовой ссылке выдаёт ту же сессию другим маршрутом — а расхождение в
 * одном слове (`samesite`, `path` или `secure`) между двумя путями даёт либо утечку куки на
 * чужой origin, либо «вход работает, а вход по ссылке — нет». Поэтому форма одна, и она проверяется
 * тестом на обоих путях.
 */
export const REFRESH_COOKIE = 'klass_rt';

export function refreshCookieOpts(ttlMs: number) {
  return {
    path: '/api/auth',
    httpOnly: true,
    // SameSite=Lax is what actually stops a cross-site POST from carrying the refresh
    // cookie; Secure is mandatory in production (a real deploy is https-only) — see
    // lib/prodConfig.ts. Do not weaken either: the Origin gate is the third layer.
    sameSite: 'lax' as const,
    secure: cookieIsSecure(env.NODE_ENV),
    maxAge: Math.floor(ttlMs / 1000),
  };
}
