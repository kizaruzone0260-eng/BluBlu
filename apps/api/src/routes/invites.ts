import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inviteCreateSchema } from '@klass/shared';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import { createInviteCode, listInviteCodes, revokeInviteCode } from '../services/invites.js';

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

    app.post('/api/classes/:id/invites/:inviteId/revoke', { preHandler: app.authenticateTeacher }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success || !p.data.inviteId) return reply.code(404).send({ error: 'notFound' });
      const cls = await resolveClass(db, req.user!.id, 'teacher', p.data.id);
      if (!cls) return reply.code(404).send({ error: 'notFound' });
      const ok = await revokeInviteCode(db, p.data.inviteId, cls.id);
      if (!ok) return reply.code(404).send({ error: 'notFound' });
      return { ok: true };
    });
  };
}
