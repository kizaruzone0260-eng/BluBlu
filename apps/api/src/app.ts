import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db/index.js';
import { currentBuildId, injectBuildMeta } from './lib/build.js';
import { env, livekitPublicWsUrl } from './env.js';
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
import { chatRoutes } from './routes/chat.js';

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
    // §rate-limit task: trust X-Forwarded-For ONLY when we really run behind a
    // proxy (Caddy in production, cloudflared in demo, Render in the cloud).
    // Configurable via TRUST_PROXY env; default off — otherwise a client could
    // forge the header and dodge the per-IP auth limits.
    trustProxy: env.TRUST_PROXY,
  });

  // CSP: connect-src names ONLY concrete origins — same-origin API/WS via 'self'
  // (CSP treats https:'self' as matching its wss counterpart) plus the LiveKit
  // address taken from the environment (LIVEKIT_URL wins over LIVEKIT_WS_URL).
  // No bare ws:/wss: wildcards. The client also fetches https://<host>/settings/
  // regions over REGULAR HTTP (livekit-client region discovery) — the wss://
  // origin alone did NOT authorize it and CSP broke that call on every lesson,
  // so both schemes of the same host are named.
  const livekitConnectOrigins = (() => {
    try {
      const u = new URL(livekitPublicWsUrl());
      const http = u.protocol === 'wss:' ? `https://${u.host}` : u.protocol === 'ws:' ? `http://${u.host}` : u.origin;
      return [u.origin, http];
    } catch { return []; }
  })();
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
        connectSrc: ["'self'", 'blob:', ...livekitConnectOrigins],
        // Material task A: YouTube attachments embed ONLY through the privacy-
        // enhanced domain, and only after the user clicks the card. No other
        // frame source exists; blob: stays for our own PDF/text previews.
        frameSrc: ["'self'", 'blob:', 'https://www.youtube-nocookie.com'],
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
  // video lesson: camera/mic/screen-share must be allowed for OUR OWN origin.
  // helmet v8 dropped its Permissions-Policy middleware, so the header is set
  // here. Without it a restrictive embedder/default policy could silently kill
  // getUserMedia — the SPA would then show the localized «нет разрешения» error.
  //
  // Hardening (Phase 1а): every PRIVATE API/webhook response is marked
  // `no-store` so an intermediate cache (Render/proxy/browser) can never retain
  // class data, chat history or /api/me. Static assets (the SPA shell/chunks)
  // are served WITHOUT a leading /api or /webhook and keep their own caching.
  app.addHook('onSend', (req, reply, payload, done) => {
    reply.header('permissions-policy', 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self)');
    // Hardening (Phase 3): this is a private, login-gated app — never index it.
    // X-Robots-Tag covers EVERY response (SPA shell, chunks, API, webhooks),
    // complementing robots.txt and the <meta name="robots"> in index.html.
    reply.header('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet');
    const url = (req.raw.url ?? '').split('?')[0] ?? '';
    // Private API/webhook data is never cached by any layer.
    if (url.startsWith('/api') || url.startsWith('/webhook')) {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    } else if (url.startsWith('/assets/')) {
      // Performance (Phase 4): Vite content-hashes everything under /assets/, so
      // those URLs are permanently cacheable — long maxAge + immutable skips the
      // revalidation round-trip on every return visit.
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (url === '/sw.js') {
      // The service worker must revalidate so a new deploy is picked up.
      reply.header('cache-control', 'no-cache');
    } else if (reply.getHeader('content-type')?.toString().includes('text/html')) {
      // SPA shell + index: always revalidate (etag/304) so a deploy shows up fast.
      reply.header('cache-control', 'no-cache');
    }
    done(null, payload);
  });

  // Hardening (Phase 1а): a single error handler so an unexpected 5xx never
  // echoes Fastify's default `{message}` (which can carry driver/library text).
  // Intentional 4xx replies thrown as errors keep their status; anything 500+
  // is logged internally and answered with a generic, version-free body.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log?.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'serverError' });
    }
    // known client status: reuse the code, drop any message detail
    const payload = (err as { response?: unknown }).response;
    if (payload && typeof payload === 'object' && 'error' in payload) {
      return reply.code(status).send(payload as { error: string });
    }
    return reply.code(status).send({ error: 'invalidInput' });
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
  // Performance (Phase 4): transparently gzip/brotli text-like responses (the SPA
  // shell, hashed JS/CSS chunks, JSON API, ICS, SVG). @fastify/compress only
  // touches its default-compressible MIME set, so media/PDF range streams served
  // by serveFile are left untouched (no broken byte-range seeking).
  await app.register(compress, { encodings: ['br', 'gzip'], threshold: 0 });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // File uploads (§3.3): 100 MB per file, ≤4 files per request
  await app.register(multipart, {
    limits: { fileSize: env.MAX_FILE_MB * 1024 * 1024, files: 4 },
  });

  // Rate limiting (task §2): the 300/min/IP safety net covers the API surface
  // (/api/* and /webhook/*) only — static web assets are OUT of the limiter
  // (an SPA boot pulls ~30 chunks; capping that punished real users, not floods).
  // @fastify/rate-limit v10 has no plugin-level `exclude`, so we register with
  // global:false and attach the cap per-route via config.rateLimit.
  // IMPORTANT: this hook must be added BEFORE registering the plugin — awaiting
  // app.register() flushes avvio, and the plugin's own onRoute (which reads
  // config.rateLimit) would otherwise run before we set it.
  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    const isApi = url === '/api' || url.startsWith('/api/') || url.startsWith('/webhook');
    if (isApi) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: { max: 300, timeWindow: '1 minute' },
      };
    }
    // stricter: login (brute force), register/join (one-time code attempts).
    // The caps are env-overridable (defaults 10 / 8) so the e2e suite, which
    // logs in far more than a real user, can relax them without touching prod.
    // Hardening (Phase 1г): in PRODUCTION the env overrides are IGNORED — the
    // strict caps below are always applied, so a leaked/accidental
    // RATE_LOGIN_MAX=99999 in the deploy environment can never dis-arm the
    // brute-force net. Non-prod (test/dev/e2e) keeps honoring the env.
    if (url === '/api/auth/login') {
      routeOptions.config = { ...routeOptions.config, rateLimit: { max: env.NODE_ENV === 'production' ? 10 : env.RATE_LOGIN_MAX, timeWindow: '1 minute' } };
    }
    if (url === '/api/auth/register' || url === '/api/join-by-code' || url === '/api/auth/check-code') {
      routeOptions.config = { ...routeOptions.config, rateLimit: { max: env.NODE_ENV === 'production' ? 8 : env.RATE_CODE_MAX, timeWindow: '1 minute' } };
    }
  });
  await app.register(rateLimit, { global: false });

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
  await app.register(chatRoutes, { db }); // item 8

  // SPA static serving in production (web bundle baked into the image).
  // The build stamp (task 1) is injected into the HTML shell here — Render
  // provides RENDER_GIT_COMMIT at runtime; the value is NOT exposed in any
  // JSON API response.
  if (env.WEB_DIST) {
    const root = path.resolve(env.WEB_DIST);
    await app.register(fastifyStatic, { root, wildcard: false, index: false });
    let shellHtml: string | null = null;
    const shell = () => {
      shellHtml ??= injectBuildMeta(
        readFileSync(path.join(root, 'index.html'), 'utf8'),
        currentBuildId(),
      );
      return shellHtml;
    };
    app.get('/', (_req, reply) => reply.type('text/html').send(shell()));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
        return reply.code(404).send({ error: 'notFound' });
      }
      return reply.type('text/html').send(shell());
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: 'notFound' });
    });
  }

  return app;
}
