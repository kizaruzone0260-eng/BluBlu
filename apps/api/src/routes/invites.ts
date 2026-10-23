import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inviteCreateSchema, inviteLinkCreateSchema, inviteUrlFor } from '@klass/shared';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { effectiveSiteBase } from '../lib/prodConfig.js';
import { audit } from '../services/audit.js';
import { resolveClass } from '../services/classes.js';
import {
  createInviteCode, listInviteCodes, revokeInvitation,
  createInviteLink, listInvitations,
} from '../services/invites.js';

const params = z.object({ id: z.string().uuid(), inviteId: z.string().uuid().optional() });

/** Teacher-only. Foreign/unknown class → 404 (§7). */
export function registerInviteRoutes(db: DB): (app: FastifyInstance) => Promise<void> {
  return async function invites(app) {
    app.post('/api/classes/:id/invites', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'notFound' });
      const parsed = inviteCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      const { id, code, expiresAt } = await createInviteCode(db, cls.id, req.user!.id, parsed.data.ttlDays);
      audit(db, req.user!.id, 'invite_create', { classId: cls.id, inviteId: id });
      // The plain code is returned exactly once and never stored.
      return reply.code(201).send({ id, code, expiresAt });
    });

    app.get('/api/classes/:id/invites', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'notFound' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      return listInviteCodes(db, cls.id);
    });

    /* ─── одноразовые ссылки-приглашения (2026-10-23, часть A) ─────────────────────────── */

    /**
     * Создать ссылку. Ответ содержит ПЛАЙН токен ровно один раз и только в этом ответе:
     * в базе лежит хеш, а история (`GET …/invitations`) токена не знает ни в каком виде.
     * URL собирается из `effectiveSiteBase` — того же адреса, что уже стоит в telegram-ссылках,
     * поэтому приглашение ведёт туда, где ученик реально откроет приложение.
     */
    app.post('/api/classes/:id/invites/link', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'notFound' });
      const parsed = inviteLinkCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      const base = effectiveSiteBase({ publicUrl: env.PUBLIC_URL, domain: env.DOMAIN, publicWebOrigin: env.PUBLIC_WEB_ORIGIN });
      if (!base) return reply.code(503).send({ error: 'registrationUnavailable' });
      const { id, token, expiresAt } = await createInviteLink(db, cls.id, req.user!.id, {
        label: parsed.data.label, ttlDays: parsed.data.ttlDays,
      });
      // в журнал — только идентификаторы; токена там нет и быть не должно
      audit(db, req.user!.id, 'invite_link_create', { classId: cls.id, inviteId: id, ttlDays: parsed.data.ttlDays });
      return reply.code(201).send({ id, url: inviteUrlFor(base, token), expiresAt });
    });

    /** История приглашений класса: оба вида, статусы, подпись и имя вошедшего ученика. */
    app.get('/api/classes/:id/invitations', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'notFound' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      return listInvitations(db, cls.id);
    });

    /**
     * Отзыв — общие ворота для кода и ссылки: маршрут не спрашивает, что именно отзывают,
     * сервер смотрит на строку. `revokedBy` пишется в обе формы, поэтому по журналу видно,
     * кто закрыл приглашение.
     */
    app.post('/api/classes/:id/invites/:inviteId/revoke', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success || !p.data.inviteId) return reply.code(404).send({ error: 'notFound' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      const kind = await revokeInvitation(db, p.data.inviteId, cls.id, req.user!.id);
      if (!kind) return reply.code(404).send({ error: 'notFound' });
      audit(db, req.user!.id, 'invite_revoke', { classId: cls.id, inviteId: p.data.inviteId, kind });
      return { ok: true };
    });
  };
}
