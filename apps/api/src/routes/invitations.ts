import type { FastifyInstance, FastifyReply } from 'fastify';
import { invitePreviewSchema, inviteRegisterSchema, inviteJoinSchema, passwordIssueCode } from '@klass/shared';
import type { DB } from '../db/index.js';
import { errorBody } from '../lib/requestId.js';
import { inviteJunkGate, noteInviteTokenHit, noteInviteTokenMiss } from '../lib/inviteThrottle.js';
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
 * требованных 60), а отдельно считается только СЧЁТ ПРОМАХОВ по токену: повторный стук заведомо
 * мусорным токеном блокирует адрес на 15 минут, как и на входе с кодом.
 *
 * Правка 2026-10-24: этот счётчик стал ОБЩИМ для всех трёх маршрутов (`lib/inviteThrottle.ts`).
 * Раньше его вело только `preview`, и защита обходилась переездом на `register` или `join`: те же
 * самые промахи там не засчитывались вообще. Порядок в каждом маршруте теперь одинаковый —
 * сначала разбор формы (он решает, про токен ли отказ), потом привратник, потом база.
 */

/** Ответ, пока адрес закрыт за промахи по токену. */
function blocked(reply: FastifyReply, reqId: unknown, retryAfterSec: number) {
  return reply.code(429).header('retry-after', String(retryAfterSec))
    .send(errorBody(reqId, 'codeRateLimited'));
}

/** Плохой токен: засчитать промах и ответить кодом состояния. */
function refusedToken(ip: string, reply: FastifyReply, reqId: unknown, code: string) {
  noteInviteTokenMiss(ip);
  return reply.code(400).send(errorBody(reqId, code));
}

/** Отказ схемы задел именно это поле? Только тогда он считается промахом по токену. */
function touchesField(issues: readonly { path: readonly (string | number)[] }[], field: string): boolean {
  return issues.some((i) => i.path[0] === field);
}

export function invitationRoutes(db: DB): (app: FastifyInstance) => Promise<void> {
  return async function routes(app) {
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
      if (!parsed.success) {
        // поле здесь ровно одно (токен), поэтому любой отказ схемы — это промах по токену
        return refusedToken(req.ip, reply, req.id, 'inviteInvalid');
      }
      const gate = inviteJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      if (!looksLikeInviteToken(parsed.data.token)) {
        return refusedToken(req.ip, reply, req.id, 'inviteInvalid');
      }
      const peek = await peekInviteLink(db, parsed.data.token);
      if (peek.state !== 'ok') {
        // «неверный» — это промах по хешу, то есть перебор; просрочен/отозван/использован —
        // чужая уже закрытая история, стук в неё тоже считается, но намеренно: блокировка
        // остаётся на стороне признака, а не адреса
        return refusedToken(req.ip, reply, req.id, inviteStateCode(peek.state));
      }
      noteInviteTokenHit(req.ip);
      // РОВНО два поля: как класс называется и до какого момента ссылка жива. Учителя, его почты,
      // признака «есть ли у тебя аккаунт» здесь нет — предпросмотр открывает человек, который
      // ещё ничего не ввёл.
      return { className: peek.className, expiresAt: peek.expiresAt?.toISOString() ?? null };
    });

    /** POST /api/invitations/register — новый аккаунт по приглашению. */
    app.post('/api/invitations/register', async (req, reply) => {
      const parsed = inviteRegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        // Слабый пароль, пустое имя или кривая почта — это НЕ промах по токену: засчитать их
        // значит закрыть адрес школы за опечатку в фамилии. Промах — только когда не прошла
        // сама форма токена.
        const pw = passwordIssueCode(parsed.error.issues.find((i) => i.path[0] === 'password'));
        if (pw) return reply.code(400).send(errorBody(req.id, pw));
        if (touchesField(parsed.error.issues, 'token')) {
          return refusedToken(req.ip, reply, req.id, 'inviteInvalid');
        }
        return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      }
      const gate = inviteJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const d = parsed.data;
      const result = await registerStudentByInviteLink(db, {
        token: d.token, firstName: d.firstName, lastName: d.lastName, email: d.email,
        password: d.password, locale: d.locale,
      });
      if (!result.ok) {
        req.log.warn(`invite register refused: reason=${result.error}`);
        // занятая почта — отказ по ХОРОШЕМУ токену: сервер сначала проверил приглашение и только
        // потом посмотрел адрес. Значит это hit, а не miss — иначе список адресов, прогнанный по
        // одной настоящей ссылке, выглядел бы как перебор токенов
        if (result.error === 'emailTaken') {
          noteInviteTokenHit(req.ip);
          return reply.code(409).send(errorBody(req.id, 'emailTaken'));
        }
        if (result.error.startsWith('invite')) {
          return refusedToken(req.ip, reply, req.id, result.error);
        }
        return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      }
      noteInviteTokenHit(req.ip);
      const session = await issueRefreshSession(db, result.user.id);
      reply.setCookie(REFRESH_COOKIE, session.refreshToken,
        refreshCookieOpts(session.expiresAt.getTime() - Date.now()));
      // журнал: кто вошёл и куда; ни токена, ни почты в цели нет
      audit(db, result.user.id, 'invite_redeem', { classId: result.classId, inviteId: result.inviteId });
      // `classId` здесь нужен экрану: человек пришёл по приглашению В КОНКРЕТНЫЙ класс, и
      // показать ему надо именно его, а не «разбирайся на главной»
      return reply.send({ accessToken: result.accessToken, user: result.user, classId: result.classId });
    });

    /**
     * POST /api/invitations/join — войти в приглашённый класс уже существующим аккаунтом.
     *
     * Ошибка аутентификации до этого кода не доходит вовсе (`preHandler` отвечает 401 сам), и
     * счётчик токена её не трогается: «не вошёл в систему» — не то же самое, что «угадывал
     * токен», и смешивать их значит штрафовать честный вход.
     */
    app.post('/api/invitations/join', { preHandler: app.authenticate }, async (req, reply) => {
      if (req.user!.role !== 'student') return reply.code(403).send({ error: 'forbidden' });
      const parsed = inviteJoinSchema.safeParse(req.body);
      if (!parsed.success) {
        return refusedToken(req.ip, reply, req.id, 'inviteInvalid');
      }
      const gate = inviteJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const res = await joinClassByInviteLink(db, parsed.data.token, req.user!.id);
      if (!res.ok) {
        req.log.warn(`invite join refused: reason=${res.state}`);
        return refusedToken(req.ip, reply, req.id, inviteStateCode(res.state));
      }
      noteInviteTokenHit(req.ip);
      return { classId: res.classId, alreadyMember: res.already };
    });
  };
}
