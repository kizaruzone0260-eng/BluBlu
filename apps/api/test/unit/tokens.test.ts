import { describe, it, expect } from 'vitest';
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } from '../../src/lib/tokens';
import { sanitizeRequestUrl } from '../../src/app';

describe('request-log sanitizer (audit: no secrets in logs)', () => {
  it('strips query strings', () => {
    expect(sanitizeRequestUrl('/api/ws/board/abc?ticket=SECRET')).toBe('/api/ws/board/abc');
    expect(sanitizeRequestUrl('/api/health/live')).toBe('/api/health/live');
    expect(sanitizeRequestUrl(undefined)).toBe('');
  });

  /**
   * Added 2026-10-10: the personal ICS subscription carries its secret token as a PATH segment
   * (`/api/ical/<token>`), which dropping the query string never touched. The route must stay
   * recognizable in the log — only the segment is replaced.
   */
  it('masks a token that lives in the path, and only that segment', () => {
    expect(sanitizeRequestUrl('/api/ical/Vxsabc123_xyz')).toBe('/api/ical/[redacted]');
    expect(sanitizeRequestUrl('/api/ical/abc?from=1')).toBe('/api/ical/[redacted]');
    expect(sanitizeRequestUrl('/api/me/ical-token')).toBe('/api/me/ical-token'); // the issuer, not a token
    expect(sanitizeRequestUrl('/api/ical')).toBe('/api/ical');
    expect(sanitizeRequestUrl('/api/classes/7/ical-token')).toBe('/api/classes/7/ical-token');
  });
});

describe('tokens (§3.1)', () => {
  it('access JWT round-trip with claims', async () => {
    const jwt = await signAccessToken({ sub: 'user-1', role: 'teacher', locale: 'ru' });
    const claims = await verifyAccessToken(jwt);
    expect(claims).toEqual({ sub: 'user-1', role: 'teacher', locale: 'ru' });
  });

  it('rejects tampered and foreign tokens', async () => {
    expect(await verifyAccessToken('abc')).toBeNull();
    const jwt = await signAccessToken({ sub: 'u', role: 'student', locale: 'uz' });
    expect(await verifyAccessToken(jwt + 'x')).toBeNull();
  });

  it('refresh tokens are unique, url-safe, and only stored hashed', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
  });
});
