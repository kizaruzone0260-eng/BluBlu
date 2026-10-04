import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { DB } from './db/index.js';
import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { classRoutes } from './routes/classes.js';
import { rtcRoutes } from './routes/rtc.js';
import { healthRoutes } from './routes/health.js';
import { postRoutes } from './routes/posts.js';
import { noteRoutes } from './routes/notes.js';
import { eventRoutes } from './routes/events.js';
import { lessonRoutes } from './routes/lessons.js';
import { boardRoutes } from './routes/board.js';
import { studentNoteRoutes } from './routes/studentNotes.js';
import { telegramRoutes } from './routes/telegram.js';

/** Strip query strings from request logs — tickets/tokens must never hit logs. */
export function sanitizeRequestUrl(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

export async function buildApp(db: DB): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test'
      ? false
      : {
          level: 'info',
          // access-token/bearer заголовки в логи не пишутся
          redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
          serializers: {
            request: (req) => ({
              type: 'request',
              method: req.method,
              url: sanitizeRequestUrl(req.url),
              hostname: req.hostname,
              remoteAddress: req.ip,
              remotePort: req.socket?.remotePort,
            }),
          },
        },
    trustProxy: true, // behind Caddy
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Excalidraw injects inline styles
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
  });

  const corsOrigins = env.NODE_ENV === 'production'
    ? (env.DOMAIN ? [`https://${env.DOMAIN}`] : [])
    : [env.PUBLIC_WEB_ORIGIN, ...(env.PUBLIC_URL ? [env.PUBLIC_URL] : [])];
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // File uploads (§3.3): 100 MB per file, ≤4 files per request
  await app.register(multipart, {
    limits: { fileSize: env.MAX_FILE_MB * 1024 * 1024, files: 4 },
  });

  // Global safety net; stricter limits per route below (§4).
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  // Stricter limits: login (brute force), register/join (code attempts).
  // NOTE: onRoute hook must be added BEFORE routes are registered.
  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    if (url === '/api/auth/login') {
      routeOptions.config = { rateLimit: { max: 10, timeWindow: '1 minute' } };
    }
    if (url === '/api/auth/register' || url === '/api/join-by-code') {
      routeOptions.config = { rateLimit: { max: 8, timeWindow: '1 minute' } };
    }
  });

  await app.register(authPlugin, { db });

  await app.register(healthRoutes, { db });
  await app.register(authRoutes(db));
  await app.register(classRoutes, { db });
  await app.register(rtcRoutes, { db });
  await app.register(postRoutes, { db });
  await app.register(noteRoutes, { db });
  await app.register(eventRoutes, { db });
  await app.register(lessonRoutes, { db });
  await app.register(boardRoutes, { db });
  await app.register(studentNoteRoutes, { db });
  await app.register(telegramRoutes, { db });

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
