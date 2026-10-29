import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import {
  loginSchema, profileUpdateSchema,
  emailCodeRequestSchema, POLICY_VERSION,
} from '@klass/shared';
import { users, refreshTokens } from '../db/schema.js';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import {
  login, issueRefreshSession, rotateRefresh, logout, signAccessTokenForUser,
} from '../services/auth.js';
import { requestOriginAllowed } from '../lib/origin.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../lib/throttle.js';
import { effectiveIpFailMax, effectiveLoginMax } from '../lib/prodConfig.js';
import { REFRESH_COOKIE, refreshCookieOpts } from '../lib/sessionCookie.js';
import { errorBody } from '../lib/requestId.js';
import { retiredEnrollment } from '../lib/retired.js';
import type { EmailTransport } from '../services/email.js';
import { requestEmailCode } from '../services/emailVerify.js';
import { acceptLegal, legalStatus } from '../services/legal.js';

/**
 * One credential-scoped throttle key (task B, 2026-10-23).
 *
 * The IP alone was the bug: 30 pupils behind one school address share an IP, so a budget of
 * «5 attempts per minute per IP» refused the twelfth of them and the screen had no words for the
 * refusal. Carrying the credential in the key keeps the per-credential budget exactly as strict
 * (a probe of one code or one mailbox still stops at 5–10 a minute) while a whole class costs
 * one budget per pupil instead of one for everybody.
 */
const credKey = (kind: string, ip: string, credential: string): string =>
  `${kind}:${ip}:${credential.trim().toLowerCase()}`;

/** Failed auth attempts of ANY kind from one address — the anti-stuffing counter. */
const ipFailKey = (ip: string): string => `af:${ip}`;

/*
 * Атрибуты refresh-куки больше не описаны здесь: они живут в `lib/sessionCookie.ts`, потому что
 * сессию теперь выдаёт и `/api/invitations/register` (задача 2026-10-23, часть A). Два
 * одинаковых описания одного набора — это способ однажды получить «вход работает, вход по
 * ссылке — нет».
 */

/** §3.9/§4 + Hardening (Phase 1в) + production regression fix: refresh/logout must
 * reject cross-origin POSTs. The rule lives in lib/origin.ts so the WebSocket gate
 * uses exactly the same decision: a configured Origin (PUBLIC_WEB_ORIGIN / PUBLIC_URL
 * / https://DOMAIN) passes, and so does an Origin equal to the host the request
 * arrived on — a genuinely same-origin call from the deployed page, which a browser
 * cannot be made to fake. Without that fallback any drift between the configured
 * address and the address the UI is really served from (PUBLIC_URL left pointing at
 * a tunnel, PUBLIC_WEB_ORIGIN never set) made POST /api/auth/refresh answer 403,
 * the SPA dropped the access token and Video Lesson bounced to Sign In — the exact
 * live incident behind this task. Cross-site origins are still rejected. */
function checkSameOrigin(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): boolean {
  if (requestOriginAllowed(req)) return true;
  reply.code(403).send(errorBody(req.id, 'forbidden'));
  return false;
}

/**
 * Ответ умершему способу приёма в класс живёт в `lib/retired.ts` — он один на четыре маршрута
 * (`/api/auth/register`, `/api/auth/check-code`, `/api/join-by-code`, `/api/classes/:id/invites`),
 * и у маршрута, который больше ничего не умеет, не должно быть собственной копии тела ответа.
 */
export function authRoutes(db: DB, email: EmailTransport): (app: FastifyInstance) => Promise<void> {
  return async function routes(app) {
    /*
     * Часть F (2026-10-16): требовать код из письма или нет — СВОЙСТВО ВНЕДРЁННОГО транспорта, а не
     * строки из env. Тест получает настоящий тракт (`ConsoleEmailTransport`) без подмены `process.env`
     * и без mock'а самого себя, а живой процесс — ровно то, что настроил владелец.
     */
    const requireEmailCode = email.provider !== 'none';

    /**
     * POST /api/auth/email-code — письмо с шестизначным кодом на адрес.
     *
     * ОТВЕТ НИЧЕГО НЕ СООБЩАЕТ о том, занят ли адрес: `sent:true` (письмо ушло) и `sent:false`
     * (аккаунт с таким адресом уже есть — письма нет) дают ОДНУ И ТУ ЖЕ форму 202 `{ok:true}`.
     * Проверяющему нечем различить эти ветки, потому что письмо он не держит в руках.
     *
     * Единственные ответы, которые чем-то отличаются, — про скорость и про провайдера: они
     * говорят о состоянии сервера, а не о наличии аккаунта.
     */
    app.post('/api/auth/email-code', async (req, reply) => {
      if (!requireEmailCode) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      const parsed = emailCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      const key = credKey('ec', req.ip, parsed.data.email);
      const gate = throttleCheck(key);
      if (!gate.allowed) {
        return reply.code(429).header('retry-after', String(gate.retryAfterSec))
          .send(errorBody(req.id, 'codeRateLimited'));
      }
      throttleRecordAttempt(key);
      const result = await requestEmailCode({
        db, transport: email,
        email: parsed.data.email, firstName: parsed.data.firstName, lastName: parsed.data.lastName,
        locale: parsed.data.locale,
      });
      if (!result.ok) {
        if (result.error === 'cooldown') {
          return reply.code(429).header('retry-after', String(result.retryAfterSec))
            .send(errorBody(req.id, 'emailCooldown'));
        }
        // отказ провайдера: наружу — одно слово, причина — в лог уже вымытая (без письма, адреса
        // и ключа: `reason` приходит из `safeErrorMessage`)
        req.log.warn(`email send refused: ${result.reason}`);
        return reply.code(503).send(errorBody(req.id, 'emailUnavailable'));
      }
      throttleReset(key);
      return reply.code(202).send({ ok: true });
    });

    /*
     * POST /api/auth/register и POST /api/auth/check-code — приём в класс по восьмизначному коду
     * (2026-10-27). Оба маршрута выведены из продукта и оставлены одной строкой каждый, чтобы
     * ответить 410 переводимым предложением, а не служебным «Route not found»: у человека остаётся
     * закладочка `/register`, у школы — прежняя сборка SPA, у владельца — старый скрипт.
     *
     * Ничего другого эти маршруты не делают и сделать не могут: функции, которые проверяли или
     * расходовали код класса (`registerStudentByCode`, `peekInviteCode`, `redeemInviteCode`,
     * `createInviteCode`), из кодовой базы удалены, а `invite_codes.kind = 'code'` больше нигде не
     * читается как право на вход. Ученик заводится теперь двумя способами — по одноразовой ссылке
     * (`/api/invitations/register`) или аккаунтом, который создаёт учитель
     * (`POST /api/classes/:id/students`).
     */
    app.post('/api/auth/register', retiredEnrollment);
    app.post('/api/auth/check-code', retiredEnrollment);

    app.post('/api/auth/login', async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      /*
       * Task B: two checks before the password is even looked at. The credential pair
       * (address + email) gets the per-minute budget that used to be shared by a whole school;
       * the address-wide counter only ever counts FAILURES, so thirty pupils signing in
       * successfully cost nothing, while one machine trying many mailboxes still stops.
       * The progressive per-account lockout in services/auth.ts is untouched and stays the
       * main brute-force net — this only adds the "one address, many accounts" case.
       */
      const key = credKey('lg', req.ip, parsed.data.email);
      const fails = ipFailKey(req.ip);
      const ipMax = effectiveIpFailMax(env.NODE_ENV, env.RATE_IP_FAIL_MAX);
      const gate = throttleCheck(key);
      const gateIp = throttleCheck(fails);
      if (!gate.allowed || !gateIp.allowed) {
        return reply.code(429)
          .header('retry-after', String(Math.max(gate.retryAfterSec, gateIp.retryAfterSec)))
          .send(errorBody(req.id, 'tooManyRequests'));
      }
      const result = await login(db, parsed.data.email, parsed.data.password);
      if (!result.ok) {
        throttleRecordAttempt(key, Date.now(), effectiveLoginMax(env.NODE_ENV, env.RATE_LOGIN_MAX));
        throttleRecordAttempt(fails, Date.now(), ipMax);
        // `invalidCredentials` covers "no such account", "wrong password" and "currently
        // locked" with one answer on purpose; the log says only that it was refused.
        req.log.warn('login refused: reason=invalidCredentials');
        return reply.code(401).send(errorBody(req.id, 'invalidCredentials'));
      }
      throttleReset(key);
      const session = await issueRefreshSession(db, result.user.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      return reply.send({ accessToken: result.accessToken, user: result.user });
    });

    app.post('/api/auth/refresh', async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const token = req.cookies?.[REFRESH_COOKIE];
      if (!token) return reply.code(401).send(errorBody(req.id, 'unauthorized'));
      const rotated = await rotateRefresh(db, token);
      if (!rotated.ok) {
        reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
        return reply.code(401).send(errorBody(req.id, 'unauthorized'));
      }
      const [user] = await db.select().from(users)
        .where(and(eq(users.id, rotated.userId), isNull(users.deletedAt))).limit(1);
      if (!user) {
        await logout(db, token);
        return reply.code(401).send(errorBody(req.id, 'unauthorized'));
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
      if (!user) return reply.code(401).send(errorBody(req.id, 'unauthorized'));
      const legal = await legalStatus(db, user.id);
      return {
        id: user.id, role: user.role, name: user.name, lastName: user.lastName, email: user.email,
        locale: user.locale, tz: user.tz, profileCompleted: user.profileCompletedAt != null,
        // Language (task 1): the SPA may only apply this locale over the device's own choice
        // when somebody actually picked it.
        localeExplicit: user.localeExplicit,
        mustChangePassword: user.mustChangePassword,
        // Legal (Phase 2 / Task G): the SPA shows the accept gate while this is false. The
        // detailed record lets a stale tab explain that the documents' version has changed.
        policyAccepted: legal.accepted,
        legal,
      };
    });

    // Part 3: change your own password. Verifies the current one, applies the
    // registration policy to the new one, clears the must-change flag, revokes
    // every other session, and re-issues a fresh session for THIS device so the
    // user stays signed in where they just acted.
    app.post('/api/me/change-password', { preHandler: app.authenticate }, async (req, reply) => {
      if (!checkSameOrigin(req, reply)) return;
      const b = z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      const { changePassword } = await import('../services/auth.js');
      const res = await changePassword(db, req.user!.id, b.data.current, b.data.next);
      if (!res.ok) {
        const code = res.reason === 'wrongCurrent' ? 'wrongPassword' : 'passwordTooWeak';
        if (res.reason === 'wrongCurrent') req.log.warn('change-password refused: reason=wrongCurrent');
        return reply.code(res.reason === 'wrongCurrent' ? 403 : 400).send(errorBody(req.id, code));
      }
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

    // Legal (Phase 2, versioned in Task G): record acceptance of the current Privacy + Terms.
    // Idempotent upsert; the client only reaches the app once this is set, so registration
    // step 2, teacher first login and every existing user's next login all funnel through here.
    // The legacy `{version}` body is still accepted — its value is the aggregate bundle tag —
    // while new clients send the two document versions explicitly.
    app.post('/api/me/accept-policy', { preHandler: app.authenticate }, async (req, reply) => {
      const b = z.object({
        version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        privacyVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        termsVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        locale: z.enum(['ru', 'uz', 'en']).optional(),
      }).refine(
        (v) => Boolean(v.version || (v.privacyVersion && v.termsVersion)),
        { message: 'version required' },
      ).safeParse(req.body);
      if (!b.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      const privacyVersion = b.data.privacyVersion ?? b.data.version!;
      const termsVersion = b.data.termsVersion ?? b.data.version!;
      const result = await acceptLegal(db, req.user!.id, {
        privacyVersion, termsVersion, locale: b.data.locale, context: 'web',
      });
      if (result === 'stale') return reply.code(409).send(errorBody(req.id, 'policyVersionStale'));
      const { audit } = await import('../services/audit.js');
      audit(db, req.user!.id, 'policy_accepted', {
        version: POLICY_VERSION, privacyVersion, termsVersion, context: 'web',
      });
      return { ok: true, version: POLICY_VERSION, privacyVersion, termsVersion };
    });

    app.patch('/api/me/profile', { preHandler: app.authenticate }, async (req, reply) => {
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      // Language (task 1): a PATCH that carries a DIFFERENT locale is a person choosing a
      // language — that is what `locale_explicit` records. A PATCH that merely re-sends the
      // stored value must not pretend somebody chose it, and a PATCH that says nothing about
      // the language (the timezone sync, the name screen) does not carry the field at all, so
      // the column is left alone. The last part is the fix for run 37974043289: two profile
      // PATCHes racing after login used to make the automatic sync overwrite a picked language.
      const [before] = await db.select({ locale: users.locale }).from(users)
        .where(eq(users.id, req.user!.id)).limit(1);
      const changedLocale = parsed.data.locale !== undefined && parsed.data.locale !== before?.locale;
      let [user] = await db
        .update(users)
        .set({ ...parsed.data, ...(changedLocale ? { localeExplicit: true } : {}) })
        .where(eq(users.id, req.user!.id))
        .returning();
      if (!user) return reply.code(401).send(errorBody(req.id, 'unauthorized'));
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
        localeExplicit: user.localeExplicit,
      };
    });

    // Full account removal (§3.1 privacy + Part 1в right-to-be-forgotten). Personal
    // data (chat/notes/TG-link/tokens/prefs/consent/membership) is erased; authored
    // class content stays but the author identity is anonymized. See services/account.
    app.delete('/api/me', { preHandler: app.authenticate }, async (req, reply) => {
      const { eraseAccount } = await import('../services/account.js');
      const { auditAndWait } = await import('../services/audit.js');
      // B4: запись об удалении пишется ДО стирания и дожидается — иначе `eraseAccount`
      // обезличивает журнал, а эта строка успевает влететь после и навсегда оставляет
      // идентификатор стёртого человека в `actor_id` и в цели.
      await auditAndWait(db, req.user!.id, 'account_deleted', { userId: req.user!.id });
      await eraseAccount(db, req.user!.id);
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return { ok: true };
    });
  };
}
