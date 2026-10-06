/**
 * Part 4а — LiveKit lesson-token TTL helpers.
 *
 * The join token is a short-lived signed JWT; a lesson can run LONGER than it.
 * Two safety nets make that survivable:
 *  1. the TTL is environment-driven (env.RTC_TOKEN_TTL) so operators can set a
 *     value comfortably above the longest scheduled lesson;
 *  2. in PRODUCTION the effective TTL is floored at 2 h, so a mistyped small
 *     value can never cause mid-lesson disconnects.
 *
 * The SDK's token is a `jsonwebtoken` expiresIn: a unit string ('6h','90m','45s')
 * or a bare number of seconds. `ttlSeconds` understands the same grammar.
 */

/** Convert a TTL ('6h', '90m', '30d', '45', seconds) to whole seconds; 0 if invalid. */
export function ttlSeconds(ttl: string | number): number {
  if (typeof ttl === 'number') return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0;
  const m = /^(\d+)\s*([smhd])?$/i.exec(String(ttl).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * mult;
}

/** Production floor: never below 2 h. Non-production returns the value verbatim. */
export function effectiveTokenTtl(ttl: string | number, nodeEnv: string): string | number {
  if (nodeEnv !== 'production') return ttl;
  const minSec = 2 * 3600;
  return ttlSeconds(ttl) < minSec ? '2h' : ttl;
}
