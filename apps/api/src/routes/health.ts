import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance, opts: { db: DB }) {
  // unauthenticated, tiny, no versions/secrets (render health check)
  app.get('/api/health', async (_req, reply) => {
    try {
      await opts.db.execute(sql`select 1`);
      return reply.send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'down' });
    }
  });
  app.get('/api/health/live', async () => ({ status: 'ok' }));
}
