import { createHmac, randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';
import type { UserRole } from '@klass/shared';

const secretKey = () => new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  locale: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role, locale: claims.locale })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null;
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      locale: typeof payload.locale === 'string' ? payload.locale : 'ru',
    };
  } catch {
    return null;
  }
}

/** Opaque refresh token (not a JWT) — only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(38).toString('base64url');
}

export function generateFamilyId(): string {
  return randomBytes(16).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHmac('sha256', secretKeyBytes()).update(token).digest('hex');
}

function secretKeyBytes(): Buffer {
  return Buffer.from(env.JWT_SECRET, 'utf8');
}

/** Constant-time compare helper for token digests. */
export function hashSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
