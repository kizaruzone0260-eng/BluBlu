import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

/**
 * Часть A (2026-10-16): включатели нового поведения, которыеSPA обязана узнать ДО того, как
 * смонтирует урок. Отдельный маршрут, а не развлечение `/api/health`: хелфинг проверяется
 * смук-тестами по точной форме ответа, и добавлять сюда что-либо значит дергать их все.
 *
 * Наружу уходят только булевы значения. Ни версии сборки, ни числа пользователей, ни строк из
 * `env` — тот же закон, что держит `/api/health` пустым.
 */
export async function featureRoutes(app: FastifyInstance) {
  app.get('/api/features', async (_req, reply) => {
    return reply.send({ lessonPersist: env.LESSON_PERSIST });
  });
}
