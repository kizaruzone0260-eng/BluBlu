import type { FastifyInstance } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import {
  registerByCodeSchema, loginSchema, profileUpdateSchema,
} from '@klass/shared';
import { users, refreshTokens } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import {
  registerStudentByCode, login, issueRefreshSession, rotateRefresh, logout, signAccessTokenForUser,
} from '../services/auth.js';
import { normalizeInviteCode } from '../lib/invite.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../lib/throttle.js';

const REFRESH_COOKIE = 'klass_rt';

function refreshCookieOpts(ttlMs: number) {
  return {
    path: '/api/auth',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    maxAge: Math.floor(ttlMs / 1000),
  };
}

/** §3.9/§4: refresh endpoint must reject cross-origin POSTs (Origin, when present, must match). */
function checkSameOrigin(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin navigations
  const allowed = new Set([env.PUBLIC_WEB_ORIGIN, `https://${env.DOMAIN ?? ''}`, `http://localhost:5173`]);
  if (!allowed.has(origin)) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

export function authRoutes(db: DB): (app: FastifyInstance) => Promise<void> {
  return async function routes(app) {
    // POST /api/auth/register — new student by one-time class code
    app.post('/api/auth/register', async (req, reply) => {
      const parsed = registerByCodeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      const key = `code:${req.ip}`;
      const gate = throttleCheck(key);
      if (!gate.allowed) {
        return reply.code(429).header('retry-after', String(gate.retryAfterSec)).send({ error: 'codeRateLimited' });
      }
      throttleRecordAttempt(key);
      const result = await registerStudentByCode(db, {
        ...parsed.data,
        code: normalizeInviteCode(parsed.data.code),
      });
      if (!result.ok) {
        // Same generic message for wrong / used / expired code (§3.2)
        if (result.error === 'invalidCode') return reply.code(400).send({ error: 'invalidCode' });
        if (result.error === 'emailTaken') return reply.code(409).send({ error: 'emailTaken' });
        return reply.code(400).send({ error: 'invalidInput' });
      }
      throttleReset(key);
      const session = await issueRefreshSession(db, result.user.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      return reply.send({ accessToken: result.accessToken, user: result.user });
    });

    app.post('/api/auth/login', async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      const result = await login(db, parsed.data.email, parsed.data.password);
      if (!result.ok) return reply.code(401).send({ error: 'invalidCredentials' });
      const session = await issueRefreshSession(db, result.user.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      return reply.send({ accessToken: result.accessToken, user: result.user });
    });

    app.post('/api/auth/refresh', async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const token = req.cookies?.[REFRESH_COOKIE];
      if (!token) return reply.code(401).send({ error: 'unauthorized' });
      const rotated = await rotateRefresh(db, token);
      if (!rotated.ok) {
        reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const [user] = await db.select().from(users)
        .where(and(eq(users.id, rotated.userId), isNull(users.deletedAt))).limit(1);
      if (!user) {
        await logout(db, token);
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const accessToken = await signAccessTokenForUser(user);
      reply.setCookie(REFRESH_COOKIE, rotated.newRefresh.refreshToken,
        refreshCookieOpts(rotated.newRefresh.expiresAt.getTime() - Date.now()));
      return reply.send({ accessToken });
    });

    app.post('/api/auth/logout', async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const token = req.cookies?.[REFRESH_COOKIE];
      if (token) await logout(db, token);
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return reply.send({ ok: true });
    });

    app.get('/api/me', { preHandler: app.authenticate }, async (req, reply) => {
      const [user] = await db.select().from(users).where(and(eq(users.id, req.user!.id), isNull(users.deletedAt))).limit(1);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      return {
        id: user.id, role: user.role, name: user.name, email: user.email,
        locale: user.locale, tz: user.tz,
      };
    });

    app.patch('/api/me/profile', { preHandler: app.authenticate }, async (req, reply) => {
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      const [user] = await db
        .update(users)
        .set(parsed.data)
        .where(eq(users.id, req.user!.id))
        .returning();
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      return { id: user.id, role: user.role, name: user.name, email: user.email, locale: user.locale, tz: user.tz };
    });

    // Full account removal (§3.1 privacy). Cascade removes memberships; refresh tokens revoked.
    app.delete('/api/me', { preHandler: app.authenticate }, async (req, reply) => {
      await db.update(users).set({ deletedAt: new Date(), email: `deleted-${req.user!.id}@invalid.local` })
        .where(eq(users.id, req.user!.id));
      await db.delete(refreshTokens).where(eq(refreshTokens.userId, req.user!.id));
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return { ok: true };
    });
  };
}
