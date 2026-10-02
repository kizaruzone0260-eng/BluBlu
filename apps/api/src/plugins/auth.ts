import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/tokens.js';
import type { DB } from '../db/index.js';
import type { UserRole } from '@klass/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user: (AccessTokenClaims & { id: string }) | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    authenticateTeacher: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { db: DB }) => {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const claims = await verifyAccessToken(header.slice(7));
      if (claims) req.user = { ...claims, id: claims.sub };
    }
  });

  async function loadAndCheck(req: FastifyRequest, reply: FastifyReply, role?: UserRole) {
    if (!req.user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const [u] = await opts.db
      .select()
      .from(users)
      .where(and(eq(users.id, req.user.id), isNull(users.deletedAt)))
      .limit(1);
    if (!u) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (role && u.role !== role) {
      return reply.code(role === 'teacher' ? 403 : 401).send({ error: 'forbidden' });
    }
    return undefined;
  }

  app.decorate('authenticate', (req, reply) => loadAndCheck(req, reply));
  app.decorate('authenticateTeacher', (req, reply) => loadAndCheck(req, reply, 'teacher'));
});
