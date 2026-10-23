import type { FastifyInstance } from 'fastify';
import { invitePreviewSchema, inviteRegisterSchema, inviteJoinSchema, passwordIssueCode } from '@klass/shared';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { errorBody } from '../lib/requestId.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../lib/throttle.js';
import { effectiveIpFailMax } from '../lib/prodConfig.js';
import { peekInviteLink, joinClassByInviteLink, inviteStateCode } from '../services/invites.js';
import { registerStudentByInviteLink, issueRefreshSession } from '../services/auth.js';
import { audit } from '../services/audit.js';
import { looksLikeInviteToken } from '../lib/inviteLink.js';
import { REFRESH_COOKIE, refreshCookieOpts } from '../lib/sessionCookie.js';

/**
 * Публичная половина приглашений (задача 2026-10-23, часть A).
 *
 * Три маршрута, и все три отвечают кодом интерфейса + `reqId` (тот же контракт, что у входа):
 *  • `preview` — «куда меня зовут», ничего не расходует;
 *  • `register` — новый аккаунт + членство + расход токена одним ходом;
 *  • `join` — то же для уже вошедшего аккаунта (под `authenticate`).
 *
 * Прожорливость лимитов здесь подобрана под человека, а не под атаку: токен — 24 случайных байта,
 * его не перебирают, поэтому потолок на адрес стоит общий (120 / 10 мин, то есть заведомо больше
 * требованных 60), а отдельно считается только СЧЁТ ВЕРНЫХ-НЕВЕРНЫХ проверок: повторный стук
 * заведомо мусорным токеном блокирует адрес на 15 минут, как и на входе с кодом.
 */

/** Плохое состояние токена → код интерфейса: маппинг один, в `services/invites.ts`. */

export function invitationRoutes(db: DB): (app: FastifyInstance) => Promise<void> {
  return async function routes(app) {
    // общий «мусорный токен» счётчик на адрес: валидные проверки в него не идут
    const junkKey = (ip: string) => `ivj:${ip}`;
    const ipMax = effectiveIpFailMax(env.NODE_ENV, env.RATE_IP_FAIL_MAX);

    /**
     * POST /api/invitations/preview — только показать класс и срок. НЕ расходывает: открытие
     * ссылки, перезагрузка страницы и предпросмотр в мессенджере обязаны оставлять приглашение
     * живым (иначе «ученик открыл ссылку и она сломалась» стало бы нормой).
     *
     * `config.rateLimit` здесь не ставится: потолок на адрес назначает общий `onRoute`-хук в
     * `app.ts` (те же 120 / 10 мин, что у входа по коду), и он всё равно перезаписал бы local.
     */
    app.post('/api/invitations/preview', async (req, reply) => {
      const parsed = invitePreviewSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'inviteInvalid'));
      const junk = throttleCheck(junkKey(req.ip));
      if (!junk.allowed) {
        return reply.code(429).header('retry-after', String(junk.retryAfterSec))
          .send(errorBody(req.id, 'codeRateLimited'));
      }
      if (!looksLikeInviteToken(parsed.data.token)) {
        throttleRecordAttempt(junkKey(req.ip), Date.now(), ipMax);
        return reply.code(400).send(errorBody(req.id, 'inviteInvalid'));
      }
      const peek = await peekInviteLink(db, parsed.data.token);
      if (peek.state !== 'ok') {
        // «неверный» — это промах по хешу, то есть перебор; просрочен/отозван/использован —
        // чужая уже закрытая история, стук в неё тоже считается, но намеренно: блокировка
        // остаётся на стороне признака, а не адреса
        throttleRecordAttempt(junkKey(req.ip), Date.now(), ipMax);
        return reply.code(400).send(errorBody(req.id, inviteStateCode(peek.state)));
      }
      throttleReset(junkKey(req.ip));
      // РОВНО два поля: как класс называется и до какого момента ссылка жива. Учителя, его почты,
      // признака «есть ли у тебя аккаунт» здесь нет — предпросмотр открывает человек, который
      // ещё ничего не ввёл.
      return { className: peek.className, expiresAt: peek.expiresAt?.toISOString() ?? null };
    });

    /** POST /api/invitations/register — новый аккаунт по приглашению. */
    app.post('/api/invitations/register', async (req, reply) => {
      const parsed = inviteRegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        const pw = passwordIssueCode(parsed.error.issues.find((i) => i.path[0] === 'password'));
        if (pw) return reply.code(400).send(errorBody(req.id, pw));
        const tok = parsed.error.issues.find((i) => i.path[0] === 'token');
        if (tok) return reply.code(400).send(errorBody(req.id, 'inviteInvalid'));
        return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      }
      const junk = throttleCheck(junkKey(req.ip));
      if (!junk.allowed) {
        return reply.code(429).header('retry-after', String(junk.retryAfterSec))
          .send(errorBody(req.id, 'codeRateLimited'));
      }
      const d = parsed.data;
      const result = await registerStudentByInviteLink(db, {
        token: d.token, firstName: d.firstName, lastName: d.lastName, email: d.email,
        password: d.password, locale: d.locale,
      });
      if (!result.ok) {
        req.log.warn(`invite register refused: reason=${result.error}`);
        if (result.error === 'emailTaken') return reply.code(409).send(errorBody(req.id, 'emailTaken'));
        if (result.error.startsWith('invite')) return reply.code(400).send(errorBody(req.id, result.error));
        return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      }
      throttleReset(junkKey(req.ip));
      const session = await issueRefreshSession(db, result.user.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken,
        refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      // журнал: кто вошёл и куда; ни токена, ни почты в цели нет
      audit(db, result.user.id, 'invite_redeem', { classId: result.classId, inviteId: result.inviteId });
      // `classId` здесь нужен экрану: человек пришёл по приглашению В КОНКРЕТНЫЙ класс, и
      // показать ему надо именно его, а не «разбирайся на главной»
      return reply.send({ accessToken: result.accessToken, user: result.user, classId: result.classId });
    });

    /** POST /api/invitations/join — войти в приглашённый класс уже существующим аккаунтом. */
    app.post('/api/invitations/join', { preHandler: app.authenticate }, async (req, reply) => {
      if (req.user!.role !== 'student') return reply.code(403).send({ error: 'forbidden' });
      const parsed = inviteJoinSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'inviteInvalid'));
      const res = await joinClassByInviteLink(db, parsed.data.token, req.user!.id);
      if (!res.ok) {
        req.log.warn(`invite join refused: reason=${res.state}`);
        return reply.code(400).send(errorBody(req.id, inviteStateCode(res.state)));
      }
      return { classId: res.classId, alreadyMember: res.already };
    });
  };
}
