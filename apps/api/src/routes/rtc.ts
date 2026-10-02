import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import type { DB } from '../db/index.js';
import { env } from '../env.js';

/**
 * Stage-0 spike + stage-4 base: server-issued short-lived LiveKit JWT.
 * identity = user id, name = display name; permissions come from role.
 * For the spike we allow arbitrary rooms matching /^spike-[a-z0-9-]+$/i.
 * Stage 4 replaces this with lesson-session-bound rooms.
 */
const bodySchema = z.object({
  room: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
});

export async function rtcRoutes(app: FastifyInstance, _opts: { db: DB }) {
  app.post('/api/rtc/token', { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const room = parsed.data.room;
    const isSpike = /^spike-[a-z0-9-]+$/i.test(room);
    if (!isSpike) {
      return reply.code(501).send({ error: 'lessonRoomsComeInStage4' });
    }
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: req.user!.id,
      name: req.user!.role + '-' + room.slice(0, 12),
      ttl: '6h',
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return { token: await at.toJwt(), wsUrl: env.LIVEKIT_WS_URL, room };
  });
}
