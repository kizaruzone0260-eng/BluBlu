import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GUEST_NAME_MAX, isGuestKey } from '@klass/shared';
import type { DB } from '../db/index.js';
import { livekitPublicWsUrl } from '../env.js';
import { errorBody } from '../lib/requestId.js';
import { guestJunkGate, noteGuestHit, noteGuestMiss } from '../lib/guestThrottle.js';
import { wsBroadcast, teacherRoomKey } from '../lib/wsHub.js';
import { audit } from '../services/audit.js';
import {
  findGuestLink, findGuestRequest, requestGuestAccess, guestLinkState, effectiveGuestState,
  buildGuestRtcToken,
} from '../services/lessonGuests.js';

/**
 * Публичная половина гостевого доступа (задача 2026-10-28, часть 3).
 *
 * Четыре маршрута, и ни один не принимает идентификатор урока, гостя или роль: всё выводится из
 * токена ссылки и ключа гостя (оба в базе только хешем). Пока заявка не одобрена, ответы не
 * содержат ни LiveKit-токена, ни имени комнаты — только «ждём».
 *
 * Защита перебора: потолок на адрес назначает общий `onRoute`-хук в `app.ts` (та же группа, что
 * у приглашений), а счётчик промахов по токену/ключу живёт в `lib/guestThrottle.ts`. Сюда
 * попадает только то, что прошло привратника, и промах засчитывается ДО обращения к базе.
 */
export function guestRoutes(db: DB): (app: FastifyInstance) => Promise<void> {
  return async function routes(app) {
    /** Ответ «адрес закрыт за промахи» — тот же код, что у остальных публичных входов. */
    function blocked(reply: FastifyReply, reqId: unknown, retryAfterSec: number) {
      return reply.code(429).header('retry-after', String(retryAfterSec))
        .send(errorBody(reqId, 'codeRateLimited'));
    }

    /** Плохой токен/ключ: промах и ответ «ссылка не подходит» (без подробностей базы). */
    function miss(reply: FastifyReply, ip: string, reqId: unknown, code = 'guestLinkInvalid', status = 404) {
      noteGuestMiss(ip);
      return reply.code(status).send(errorBody(reqId, code));
    }

    /** Найти ссылку и сразу ответить, если дверь уже закрыта. `null` — ответ уже отправлен. */
    async function openLink(reply: FastifyReply, ip: string, reqId: unknown, token: string) {
      const link = await findGuestLink(db, token);
      if (!link) { miss(reply, ip, reqId); return null; }
      const state = guestLinkState(link, { endedAt: link.endedAt });
      if (state !== 'ok') {
        noteGuestMiss(ip);
        reply.code(410).send(errorBody(reqId,
          state === 'ended' ? 'lessonEnded' : state === 'expired' ? 'guestLinkExpired' : 'guestLinkRevoked'));
        return null;
      }
      noteGuestHit(ip);
      return link;
    }

    /** Что за урок — и ничего больше: имя класса и срок ссылки. */
    app.post('/api/guest/preview', async (req, reply) => {
      const gate = guestJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(req.body);
      if (!parsed.success) return miss(reply, req.ip, req.id);
      const link = await findGuestLink(db, parsed.data.token);
      if (!link) return miss(reply, req.ip, req.id);
      const state = guestLinkState(link, { endedAt: link.endedAt });
      if (state !== 'ok') {
        noteGuestMiss(req.ip);
        return reply.code(410).send(errorBody(req.id,
          state === 'ended' ? 'lessonEnded' : state === 'expired' ? 'guestLinkExpired' : 'guestLinkRevoked'));
      }
      noteGuestHit(req.ip);
      // РОВНО эти поля: ни учителя, ни списка участников, ни идентификатора урока наружу не идёт.
      return { state: 'ok', className: link.className, expiresAt: link.expiresAt.toISOString() };
    });

    /** Заявка: имя + ключ браузера. Повтор с тем же ключом не создаёт вторую строку. */
    app.post('/api/guest/request', async (req, reply) => {
      const gate = guestJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const parsed = z.object({
        token: z.string().min(1).max(200),
        key: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(GUEST_NAME_MAX),
      }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
      if (!isGuestKey(parsed.data.key)) return miss(reply, req.ip, req.id);
      const link = await openLink(reply, req.ip, req.id, parsed.data.token);
      if (!link) return;
      const { request, created } = await requestGuestAccess(
        db, link, parsed.data.name.replace(/\s+/g, ' '), parsed.data.key,
      );
      if (!request.id) return miss(reply, req.ip, req.id);
      if (created) {
        // журнал: кто постучал, но без имени и ключа — имя гость вводит сам, и хранить его в
        // аудите рядом с идентификаторами незачем
        audit(db, null, 'guest_access_request', {
          sessionId: link.sessionId, linkId: link.id, requestId: request.id,
        });
        // учителю — по тому же сокету урока, в служебную комнату «только учитель»
        wsBroadcast(teacherRoomKey(link.sessionId), {
          type: 'guestRequest',
          request: { id: request.id, name: request.name, createdAt: request.createdAt.toISOString() },
        });
      }
      const status = effectiveGuestState(link, { endedAt: link.endedAt }, request.status);
      return reply.code(created ? 201 : 200).send({ status });
    });

    /** Статус своей заявки. Ключ обязателен: без него чужая заявка не читается. */
    app.post('/api/guest/status', async (req, reply) => {
      const gate = guestJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const parsed = z.object({ token: z.string().min(1).max(200), key: z.string().min(1).max(200) })
        .safeParse(req.body);
      if (!parsed.success) return miss(reply, req.ip, req.id);
      if (!isGuestKey(parsed.data.key)) return miss(reply, req.ip, req.id);
      const link = await findGuestLink(db, parsed.data.token);
      if (!link) return miss(reply, req.ip, req.id);
      const request = await findGuestRequest(db, link.id, parsed.data.key);
      if (!request) return miss(reply, req.ip, req.id, 'guestRequestNotFound');
      noteGuestHit(req.ip);
      return { status: effectiveGuestState(link, { endedAt: link.endedAt }, request.status) };
    });

    /**
     * LiveKit-токен «только смотреть». Серверная проверка здесь — последняя и единственная
     * дверь в комнату: старый одобренный ответ клиента, отозванная ссылка и закончившийся урок
     * не дают ничего, потому что всё перечитывается заново.
     */
    app.post('/api/guest/rtc', async (req, reply) => {
      const gate = guestJunkGate(req.ip);
      if (!gate.allowed) return blocked(reply, req.id, gate.retryAfterSec);
      const parsed = z.object({ token: z.string().min(1).max(200), key: z.string().min(1).max(200) })
        .safeParse(req.body);
      if (!parsed.success) return miss(reply, req.ip, req.id);
      if (!isGuestKey(parsed.data.key)) return miss(reply, req.ip, req.id);
      const link = await findGuestLink(db, parsed.data.token);
      if (!link) return miss(reply, req.ip, req.id);
      const request = await findGuestRequest(db, link.id, parsed.data.key);
      if (!request) return miss(reply, req.ip, req.id, 'guestRequestNotFound');
      const status = effectiveGuestState(link, { endedAt: link.endedAt }, request.status);
      if (status !== 'approved') {
        noteGuestMiss(req.ip);
        const code = status === 'pending' ? 'guestApprovalRequired'
          : status === 'rejected' ? 'guestRequestRejected'
            : status === 'ended' ? 'lessonEnded'
              : status === 'expired' ? 'guestLinkExpired' : 'guestLinkRevoked';
        return reply.code(status === 'pending' ? 403 : 410).send(errorBody(req.id, code));
      }
      noteGuestHit(req.ip);
      const token = await buildGuestRtcToken({
        room: link.roomName, requestId: request.id, name: request.name,
      });
      return { token, wsUrl: livekitPublicWsUrl(), room: link.roomName };
    });
  };
}
