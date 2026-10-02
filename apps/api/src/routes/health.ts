import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';

export async function healthRoutes(app: FastifyInstance, opts: { db: DB }) {
  app.get('/api/health', async (_req, reply) => {
    try {
      await opts.db.execute(sql`select 1`);
      return reply.send({ status: 'ok', version: '0.1.0', db: 'up' });
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'down' });
    }
  });
  app.get('/api/health/live', async () => ({ status: 'ok' }));
}
