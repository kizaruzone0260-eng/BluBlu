import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import {
  registerByCodeSchema, loginSchema, profileUpdateSchema, checkCodeSchema, POLICY_VERSION,
} from '@klass/shared';
import { users, refreshTokens, policyAcceptances } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import {
  registerStudentByCode, login, issueRefreshSession, rotateRefresh, logout, signAccessTokenForUser,
} from '../services/auth.js';
import { peekInviteCode } from '../services/invites.js';
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

/** §3.9/§4 + Hardening (Phase 1в): refresh/logout must reject cross-origin POSTs.
 * When we KNOW our public origin (PUBLIC_URL or DOMAIN is configured — i.e. any
 * real deploy) the Origin must match that allowlist EXACTLY; the request `Host`
 * is never trusted, so a Host-header-injecting client cannot widen the door.
 * Only in local dev/e2e (no PUBLIC_URL/DOMAIN) do we fall back to the request's
 * own Host, which lets a same-origin page on an ephemeral port refresh without
 * env config. The configured origins always include the dev vite origin. */
function checkSameOrigin(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin navigations
  const allowed = new Set<string>([
    env.PUBLIC_WEB_ORIGIN, 'http://localhost:5173',
    ...(env.PUBLIC_URL ? [env.PUBLIC_URL] : []),
    ...(env.DOMAIN ? [`https://${env.DOMAIN}`] : []),
  ]);
  const known = Boolean(env.PUBLIC_URL || env.DOMAIN);
  let ok = allowed.has(origin);
  if (!ok && !known) {
    // dev/e2e only: a same-origin page whose Host we could not know from env.
    try { ok = new URL(origin).host === (req.headers.host ?? ''); } catch { /* malformed ⇒ not same host */ }
  }
  if (!ok) {
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
      if (!parsed.success) {
        // Hardening (Phase 1д): surface a SPECIFIC, translated password reason
        // so the user knows why their password was rejected; every other input
        // problem stays the generic 'invalidInput' (no field enumeration).
        const pw = parsed.error.issues.find((i) => i.path[0] === 'password');
        if (pw) {
          const code = pw.code === 'too_small' ? 'passwordTooShort'
            : pw.code === 'invalid_string' ? 'passwordTooSimple'
            : pw.code === 'custom' ? 'passwordTooCommon' : null;
          if (code) return reply.code(400).send({ error: code });
        }
        return reply.code(400).send({ error: 'invalidInput' });
      }
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

    // Item 9 step 1 — code check WITHOUT consumption. One generic answer for
    // wrong/used/expired/revoked, per-IP attempt throttle like register itself;
    // email never touches this endpoint, so no account enumeration here.
    app.post('/api/auth/check-code', async (req, reply) => {
      const parsed = checkCodeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalidCode' });
      const key = `cc:${req.ip}`;
      const gate = throttleCheck(key);
      if (!gate.allowed) {
        return reply.code(429).header('retry-after', String(gate.retryAfterSec)).send({ error: 'codeRateLimited' });
      }
      const okCode = await peekInviteCode(db, normalizeInviteCode(parsed.data.code));
      if (!okCode) {
        // failures count toward the probe budget (like login), successes don't
        throttleRecordAttempt(key);
        return reply.code(400).send({ error: 'invalidCode' });
      }
      return { ok: true };
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
      const [acc] = await db.select({ version: policyAcceptances.version })
        .from(policyAcceptances).where(eq(policyAcceptances.userId, user.id)).limit(1);
      return {
        id: user.id, role: user.role, name: user.name, lastName: user.lastName, email: user.email,
        locale: user.locale, tz: user.tz, profileCompleted: user.profileCompletedAt != null,
        mustChangePassword: user.mustChangePassword,
        // Legal (Phase 2): the SPA shows the accept gate when this is false.
        policyAccepted: acc?.version === POLICY_VERSION,
      };
    });

    // Part 3: change your own password. Verifies the current one, applies the
    // registration policy to the new one, clears the must-change flag, revokes
    // every other session, and re-issues a fresh session for THIS device so the
    // user stays signed in where they just acted.
    app.post('/api/me/change-password', { preHandler: app.authenticate }, async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const b = z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalidInput' });
      const { changePassword } = await import('../services/auth.js');
      const res = await changePassword(db, req.user!.id, b.data.current, b.data.next);
      if (!res.ok) return reply.code(res.reason === 'wrongCurrent' ? 403 : 400).send({ error: res.reason === 'wrongCurrent' ? 'wrongPassword' : 'passwordTooWeak' });
      const session = await issueRefreshSession(db, req.user!.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      const { audit } = await import('../services/audit.js');
      audit(db, req.user!.id, 'password_changed', { userId: req.user!.id });
      return { ok: true };
    });

    // Part 3: sign out of every device — revoke all refresh sessions.
    app.post('/api/auth/logout-all', { preHandler: app.authenticate }, async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const { revokeAllSessions } = await import('../services/auth.js');
      await revokeAllSessions(db, req.user!.id);
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      const { audit } = await import('../services/audit.js');
      audit(db, req.user!.id, 'logout_all', { userId: req.user!.id });
      return { ok: true };
    });

    // Legal (Phase 2): record acceptance of the current privacy+terms bundle.
    // Idempotent upsert; the client only reaches the app once this is set, so
    // registration step 2, teacher first login and every existing user's next
    // login all funnel through here.
    app.post('/api/me/accept-policy', { preHandler: app.authenticate }, async (req, reply) => {
      const b = z.object({ version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalidInput' });
      if (b.data.version !== POLICY_VERSION) return reply.code(409).send({ error: 'policyVersionStale' });
      await db.insert(policyAcceptances)
        .values({ userId: req.user!.id, version: POLICY_VERSION, acceptedAt: new Date() })
        .onConflictDoUpdate({ target: policyAcceptances.userId, set: { version: POLICY_VERSION, acceptedAt: new Date() } });
      const { audit } = await import('../services/audit.js');
      audit(db, req.user!.id, 'policy_accepted', { version: POLICY_VERSION });
      return { ok: true, version: POLICY_VERSION };
    });

    app.patch('/api/me/profile', { preHandler: app.authenticate }, async (req, reply) => {
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      let [user] = await db
        .update(users)
        .set(parsed.data)
        .where(eq(users.id, req.user!.id))
        .returning();
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      // name screen (task 2): the flag flips to complete exactly once, when both
      // names are non-empty — and is never taken back (an empty lastName in a
      // later PATCH does not re-open the gate).
      if (user.profileCompletedAt == null && user.name.trim() !== '' && user.lastName.trim() !== '') {
        const [done] = await db.update(users).set({ profileCompletedAt: new Date() })
          .where(eq(users.id, req.user!.id)).returning();
        if (done) user = done;
      }
      return {
        id: user.id, role: user.role, name: user.name, lastName: user.lastName,
        email: user.email, locale: user.locale, tz: user.tz, profileCompleted: user.profileCompletedAt != null,
      };
    });

    // Full account removal (§3.1 privacy + Part 1в right-to-be-forgotten). Personal
    // data (chat/notes/TG-link/tokens/prefs/consent/membership) is erased; authored
    // class content stays but the author identity is anonymized. See services/account.
    app.delete('/api/me', { preHandler: app.authenticate }, async (req, reply) => {
      const { eraseAccount } = await import('../services/account.js');
      await eraseAccount(db, req.user!.id);
      const { audit } = await import('../services/audit.js');
      audit(db, req.user!.id, 'account_deleted', { userId: req.user!.id });
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return { ok: true };
    });
  };
}
