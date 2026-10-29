import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guestUrlFor } from '@klass/shared';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { effectiveSiteBase } from '../lib/prodConfig.js';
import { wsBroadcast, teacherRoomKey } from '../lib/wsHub.js';
import { audit } from '../services/audit.js';
import { getRoomService } from '../services/lessons.js';
import {
  createGuestLink, revokeGuestLinks, guestOverview, decideGuestRequest,
} from '../services/lessonGuests.js';
import { teacherSessionFor } from './lessons.js';

/**
 * Учительская половина гостевого доступа (задача 2026-10-28, часть 3).
 *
 * Только владелец урока (та же проверка `teacherSessionFor`, что у остальной модерации):
 * создать ссылку, увидеть заявки, одобрить/отклонить, отозвать ссылку. Пять маршрутов, все под
 * `authenticateTeacher` и все отвечают 404 на чужой/несуществующий урок — как принято в проекте.
 *
 * Плата за «как в Meet» ложится на сервер, а не на клиента: ссылка создаётся заново только
 * вместе с отзывом прежней, при отзыве комната отключает одобренных гостей, а решение учителя
 * уходит всем его вкладкам кадром того же сокета урока (`g:<sessionId>`).
 */
export function lessonGuestRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  /** Отключить гостей комнаты: всех или одну заявку. Медиа-сервер может быть недоступен. */
  async function kickGuests(roomName: string, requestId?: string): Promise<void> {
    try {
      const rs = getRoomService();
      const list = await rs.listParticipants(roomName);
      for (const p of list) {
        if (!p.identity.startsWith('guest:')) continue;
        if (requestId && p.identity !== `guest:${requestId}`) continue;
        try { await rs.removeParticipant(roomName, p.identity); } catch { /* уже ушёл */ }
      }
    } catch {
      // отзыв не должен зависеть от доступности медиа-сервера: запись в базе уже закрывает дверь
    }
  }

  async function teacher(req: FastifyRequest, reply: FastifyReply, id: string) {
    if (!z.string().uuid().safeParse(id).success) {
      await reply.code(404).send({ error: 'notFound' });
      return null;
    }
    return teacherSessionFor(db, req.user!.id, reply, id);
  }

  /** Ссылка + заявки: статус для панели учителя. Токена здесь нет и быть не может. */
  app.get('/api/lessons/:id/guests', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const s = await teacher(req, reply, (req.params as { id: string }).id);
    if (!s) return;
    const overview = await guestOverview(db, s);
    // счётчик — по ТОЙ ЖЕ ссылке, что видит панель: заявки отозванной ссылки в списке не
    // показываются, и бейдж не должен считать людей, которых всё равно не видно
    return { ...overview, pending: overview.requests.filter((r) => r.status === 'pending').length };
  });

  /**
   * Новая ссылка. Прежняя активная отзывается тем же ходом (одна дверь на урок): гости,
   * одобренные по ней, отключаются от комнаты — иначе «создал новую» оставляло бы старых внутри.
   * Плейн-токен — только в этом ответе; в журнал и в базу он не попадает.
   */
  app.post('/api/lessons/:id/guest-link', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const s = await teacher(req, reply, (req.params as { id: string }).id);
    if (!s) return;
    const base = effectiveSiteBase({ publicUrl: env.PUBLIC_URL, domain: env.DOMAIN, publicWebOrigin: env.PUBLIC_WEB_ORIGIN });
    if (!base) return reply.code(503).send({ error: 'registrationUnavailable' });
    const created = await createGuestLink(db, s, req.user!.id);
    if (created.revoked.length > 0) await kickGuests(s.roomName);
    audit(db, req.user!.id, 'guest_link_create', {
      sessionId: s.id, classId: s.classId, linkId: created.id, revoked: created.revoked.length,
    });
    wsBroadcast(teacherRoomKey(s.id), { type: 'guestUpdate' });
    return reply.code(201).send({ url: guestUrlFor(base, created.token), expiresAt: created.expiresAt });
  });

  app.post('/api/lessons/:id/guest-link/revoke', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const s = await teacher(req, reply, (req.params as { id: string }).id);
    if (!s) return;
    const linkIds = await revokeGuestLinks(db, s.id);
    if (linkIds.length > 0) await kickGuests(s.roomName);
    audit(db, req.user!.id, 'guest_link_revoke', { sessionId: s.id, linkIds });
    wsBroadcast(teacherRoomKey(s.id), { type: 'guestUpdate' });
    return { ok: true, revoked: linkIds.length };
  });

  const decision = (status: 'approved' | 'rejected') =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const p = z.object({ id: z.string().uuid(), requestId: z.string().uuid() }).safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'notFound' });
      const s = await teacher(req, reply, p.data.id);
      if (!s) return;
      const res = await decideGuestRequest(db, s.id, p.data.requestId, status, req.user!.id);
      if (!res) return reply.code(404).send({ error: 'notFound' });
      // отдых гостя после одобрения — это и есть отказ: заявка остаётся строкой истории, но
      // человек больше не в комнате и новый токен ему не выдадут
      if (status === 'rejected' && res.previous === 'approved') {
        await kickGuests(s.roomName, p.data.requestId);
      }
      audit(db, req.user!.id, status === 'approved' ? 'guest_access_approve' : 'guest_access_reject',
        { sessionId: s.id, requestId: p.data.requestId });
      wsBroadcast(teacherRoomKey(s.id), {
        type: 'guestUpdate', request: { id: res.request.id, status: res.request.status },
      });
      return { ok: true, status: res.request.status };
    };

  app.post('/api/lessons/:id/guests/:requestId/approve', {
    preHandler: app.authenticateTeacher,
  }, decision('approved'));

  app.post('/api/lessons/:id/guests/:requestId/reject', {
    preHandler: app.authenticateTeacher,
  }, decision('rejected'));
}
