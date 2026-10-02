import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { DB } from './db/index.js';
import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { classRoutes } from './routes/classes.js';
import { rtcRoutes } from './routes/rtc.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(db: DB): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test'
      ? false
      : {
          level: 'info',
          transport: env.NODE_ENV === 'development'
            ? { target: 'pino/file', options: { destination: 1 } } // pretty-less stdout
            : undefined,
        },
    trustProxy: true, // behind Caddy
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false, // tightened in stage 7 checklist
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  const corsOrigins = env.NODE_ENV === 'production'
    ? (env.DOMAIN ? [`https://${env.DOMAIN}`] : [])
    : [env.PUBLIC_WEB_ORIGIN];
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  // Global safety net; stricter limits per route below (§4).
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(authPlugin, { db });

  await app.register(healthRoutes, { db });
  await app.register(authRoutes(db));
  await app.register(classRoutes, { db });
  await app.register(rtcRoutes, { db });

  // Stricter limits: login (brute force), register (code attempts handled in-route too)
  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    if (url === '/api/auth/login') {
      routeOptions.config = { rateLimit: { max: 10, timeWindow: '1 minute' } };
    }
    if (url === '/api/auth/register' || url === '/api/join-by-code') {
      routeOptions.config = { rateLimit: { max: 6, timeWindow: '1 minute' } };
    }
  });

  // SPA static serving in production (web bundle baked into the image)
  if (env.WEB_DIST) {
    await app.register(fastifyStatic, { root: path.resolve(env.WEB_DIST), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
        return reply.code(404).send({ error: 'notFound' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: 'notFound' });
    });
  }

  return app;
}
