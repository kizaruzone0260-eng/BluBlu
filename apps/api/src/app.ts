import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
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
import { redactSecrets, safeErrorMessage } from './lib/redact.js';
import { isSpaRoute, looksLikeStaticFile } from './lib/spaRoutes.js';
import { effectiveCorsOrigins, effectiveIpWindowMax, effectiveIpWindowMs } from './lib/prodConfig.js';
import { errorBody, newRequestId } from './lib/requestId.js';
import { JSON_BODY_LIMIT } from './lib/bodyLimits.js';
// The auth error vocabulary is shared with the web screens and with the locale-parity test on
// purpose: a code the interface cannot name is a dead end for the person seeing it.
import { isAuthErrorCode } from '@klass/shared';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { createEmailTransport, type EmailTransport } from './services/email.js';
import { classRoutes } from './routes/classes.js';
import { invitationRoutes } from './routes/invitations.js';
import { rtcRoutes } from './routes/rtc.js';
import { healthRoutes } from './routes/health.js';
import { featureRoutes } from './routes/features.js';
import { postRoutes } from './routes/posts.js';
import { noteRoutes } from './routes/notes.js';
import { eventRoutes } from './routes/events.js';
import { lessonRoutes } from './routes/lessons.js';
// часть 3: гость без аккаунта — публичные входы и учительское управление ссылкой
import { guestRoutes } from './routes/guest.js';
import { lessonGuestRoutes } from './routes/lessonGuests.js';
import { boardRoutes } from './routes/board.js';
import { lessonArchiveRoutes } from './routes/lessonArchive.js';
import { studentNoteRoutes } from './routes/studentNotes.js';
import { telegramRoutes } from './routes/telegram.js';
import { miniRoutes, type MiniRouteOptions } from './routes/mini.js';
import { chatRoutes } from './routes/chat.js';
import { lessonCommentRoutes } from './routes/lessonComments.js';
import { lessonHandRoutes } from './routes/lessonHands.js';

/**
 * What the access log is allowed to know about a URL.
 *
 * Two shapes hide a credential, and both occur here:
 *  - a query string (`/api/ws/lesson/<id>?ticket=<one-time ticket>`) — dropped entirely;
 *  - a token that IS a path segment (`/api/ical/<secret>` — the personal ICS subscription,
 *    §3.5, whose token must never be logged). Stripping the query would not have touched it, so
 *    the segment is replaced by a fixed marker; the route itself stays recognizable.
 */
export function sanitizeRequestUrl(url: string | undefined): string {
  return ((url ?? '').split('?')[0] ?? '').replace(/^\/api\/ical\/[^/]+/, '/api/ical/[redacted]');
}

/**
 * The logger options Fastify hands to pino. Exported because the only honest test of a log
 * format is the OUTPUT of the real object: `test/integration/access-log.test.ts` builds the
 * same app with a pino instance created from these very options and asserts on the lines.
 *
 * The serializer key is `req`, not `request`. pino (and therefore Fastify, which just passes
 * this object through) reads `serializers.req/res/err`; a `request` key is not an error, not a
 * warning, and not even a type error — it is simply ignored, and the DEFAULT serializer runs
 * instead. That is how `/api/ws/lesson/<id>?ticket=<one-time ticket>` reached the access log
 * while `sanitizeRequestUrl` had a green unit test next to it (measured 2026-10-10: zero lines
 * with our `type:"request"` field, 18 lines carrying `?ticket=`).
 */
export const accessLogOptions = {
  level: 'info',
  // Second line of defence: the serializer below never returns headers at all, so these paths
  // have no target today — they stay so that a future `{ req }` log cannot widen the shape.
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
  serializers: {
    req: (req: {
      id?: string; method?: string; url?: string; hostname?: string; ip?: string;
      socket?: { remotePort?: number };
    }) => ({
      type: 'request',
      // Task B: the same id the student sees under the error message. Without it a complaint
      // («ученица не может войти») cannot be matched to a line in the log at all.
      reqId: req.id,
      method: req.method,
      url: sanitizeRequestUrl(req.url),
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
    /*
     * The error half of the same contract. `err.message` is exactly where postgres-js puts the
     * connection string and where drizzle puts the bound parameters of the failing query (in this
     * app: emails, note text, chat bodies), so the message and the stack — whose first line repeats
     * the message — go through `safeErrorMessage`, and the code stays: `28P01` / `ECONNREFUSED` /
     * `401` is what an operator needs. Extra error fields are deliberately not expanded: drizzle
     * carries `query` and `params` on the object, and a future `{ ...err }` would publish them.
     */
    err: (err: {
      name?: string; message?: string; stack?: string; code?: string | number;
      statusCode?: string | number; cause?: unknown;
    }) => ({
      type: 'err',
      name: err?.name ?? '',
      code: err?.code ?? err?.statusCode
        ?? (err?.cause as { code?: string | number } | undefined)?.code,
      message: safeErrorMessage(err),
      stack: err?.stack ? safeErrorMessage(err.stack) : '',
    }),
  },
};

/**
 * Task F (2026-10-28): CSP for the one document that must run inside Telegram.
 *
 * The global policy below stays exactly as it was — `script-src 'self'` and
 * `frame-ancestors 'none'` — because it is pinned by the hardening tests and is right for every
 * other page. The Mini App is the sole exception and needs exactly two widenings:
 *
 *  • `script-src https://telegram.org` — the official `telegram-web-app.js` SDK; without it
 *    `window.Telegram.WebApp` is absent and there is no `initData` to verify;
 *  • `frame-ancestors https://*.telegram.org https://telegram.org` — Telegram Web embeds the
 *    page in an iframe (mobile clients use a webview and ignore this directive, so the policy is
 *    still narrow for a plain browser tab: only Telegram can frame it).
 *
 * It is applied per-response in the `onSend` hook, only for `/mini`, so a request to any other
 * path continues to receive the strict document-wide policy. The LiveKit origins are not listed:
 * the Mini App never opens a call.
 */
const MINI_APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "frame-src 'self' blob: https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'self' https://telegram.org https://*.telegram.org",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** `/mini` and its sub-paths (there are none today, but keep the check exact). */
function isMiniAppPath(url: string): boolean {
  return url === '/mini' || url.startsWith('/mini/');
}

export async function buildApp(
  db: DB,
  opts: {
    logger?: FastifyBaseLogger;
    email?: EmailTransport;
    /**
     * Task F: seams for the Mini App tests (capturing bot API, fake formatter). Production passes
     * nothing and the routes build the shared bot API and the env-configured AI client themselves.
     */
    mini?: Omit<MiniRouteOptions, 'db'>;
  } = {},
): Promise<FastifyInstance> {
  /*
   * Часть F (2026-10-16): транспорт писем входит в приложение, а не читается из модульного
   * синглтона. Причина та же, из-за чего `TELEGRAM_TRANSPORT` выбирает log/telegram на старте:
   * проверка «письмо отправилось» обязана исполнять НАСТОЯЩИЙ код отправки. Тест подставляет
   * `ConsoleEmailTransport` (он пишет в память) и видит тот же тракт, что проходит живой
   * процесс; по умолчанию — то, что настроено в env.
   */
  const email: EmailTransport = opts.email ?? createEmailTransport(env);
  // `loggerInstance` (a logger we were handed) and `logger` (options for Fastify's own pino)
  // are mutually exclusive in Fastify, hence the two branches rather than one spread.
  //
  // `bodyLimit` named explicitly in BOTH branches (task 2026-10-27 part A): until now the JSON
  // body ceiling was Fastify's silent 1 MB default, so it appeared nowhere in the source and no
  // test pinned it. Same number, now stated — see lib/bodyLimits.ts for what is deliberately NOT
  // covered here (multipart uploads, WebSocket frames) and for the single route that needs more.
  const app = opts.logger
    ? Fastify({
        loggerInstance: opts.logger,
        trustProxy: env.TRUST_PROXY,
        genReqId: newRequestId,
        bodyLimit: JSON_BODY_LIMIT,
      })
    : Fastify({
        logger: env.NODE_ENV === 'test' ? false : accessLogOptions,
        // §rate-limit task: trust X-Forwarded-For ONLY when we really run behind a
        // proxy (Caddy in production, cloudflared in demo, Render in the cloud).
        // Configurable via TRUST_PROXY env; default off — otherwise a client could
        // forge the header and dodge the per-IP auth limits.
        trustProxy: env.TRUST_PROXY,
        // Task B: one short random id per request, printed under an auth error and written to
        // the access log, so «не могу войти» becomes a findable line instead of a shrug.
        genReqId: newRequestId,
        bodyLimit: JSON_BODY_LIMIT,
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
    // Task F: the Mini App document is the one response that may load the Telegram SDK and be
    // framed by Telegram Web; see MINI_APP_CSP. `X-Frame-Options` is removed for it because the
    // old header knows only SAMEORIGIN/DENY, and some Telegram webviews honour XFO while
    // ignoring frame-ancestors.
    if (isMiniAppPath(url)) {
      reply.header('content-security-policy', MINI_APP_CSP);
      reply.removeHeader('x-frame-options');
    }
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
    } else if (url.startsWith('/fonts/') || url.startsWith('/excalidraw-assets/')) {
      // SEC-30 (аудит 2026-10-28): эти файлы отдавались без max-age и ревалидировались на каждом
      // заходе — 736 KB шрифтов на вход и 14 MB ассетов Excalidraw при первом открытии доски.
      // Имена здесь НЕ хэшированные (в отличие от /assets/), поэтому «immutable на год» соврал
      // бы: держим неделю и разрешаем отдать закэшированное, пока идёт фоновая проверка.
      reply.header('cache-control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else if (reply.getHeader('content-type')?.toString().includes('text/html')) {
      // SPA shell + index: always revalidate (etag/304) so a deploy shows up fast.
      reply.header('cache-control', 'no-cache');
    }
    // Task B: the id is also on the wire, so a browser extension, a proxy log or a
    // screenshot of the Network tab can carry it. Not a secret, not derived from the user.
    if (typeof req.id === 'string') reply.header('x-request-id', req.id);
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
      return reply.code(500).send(errorBody(req.id, 'serverError'));
    }
    /*
     * Task B (2026-10-23): a 429 from @fastify/rate-limit used to reach the browser as
     * `{error: "Too Many Requests"}` — a string that is not an interface code, so every
     * throttled student read «Something went wrong. Please try again.» and nobody, including
     * the teacher, could tell "wait a minute" from "the server is broken". Normalised to one
     * code with the retry window attached; the header is what the client counts from.
     */
    if (status === 429) {
      const retryAfter = reply.getHeader('retry-after') ?? reply.getHeader('Retry-After');
      return reply.code(429).send(errorBody(req.id, 'tooManyRequests'))
        .header('retry-after', typeof retryAfter === 'string' && retryAfter ? retryAfter : '60');
    }
    // known client status: reuse the code, drop any message detail
    const payload = (err as { response?: unknown }).response;
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const code = String((payload as { error: unknown }).error);
      return reply.code(status).send(errorBody(req.id, isAuthErrorCode(code) ? code : 'invalidInput'));
    }
    return reply.code(status).send(errorBody(req.id, 'invalidInput'));
  });

  // Production CORS: no cross-origin entry is needed (the API serves the SPA), and an
  // explicitly configured PUBLIC_WEB_ORIGIN is honoured instead of dropped — see
  // lib/prodConfig.ts, which also documents why production IGNORES the rate relaxations.
  const corsOrigins = effectiveCorsOrigins({
    nodeEnv: env.NODE_ENV,
    domain: env.DOMAIN,
    publicWebOrigin: env.PUBLIC_WEB_ORIGIN,
    publicUrl: env.PUBLIC_URL,
  });
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
    // Hardening (Phase 4в): never compress responses that carry secrets — the
    // auth endpoints (login/refresh/register issue access+refresh tokens) and
    // every ticket/token issuer. Compressing attacker-influenced plaintext
    // alongside a secret (BREACH/CRIME class) is exactly what to avoid, so these
    // opt out of @fastify/compress via the plugin's per-route `compress:false`.
    if (
      url.startsWith('/api/auth')
      || url.startsWith('/api/guest')
      || url === '/api/invitations/register'
      || url === '/api/ws/ticket'
      // Task F: the Mini App launch exchange answers with a bearer session token — same reason.
      || url === '/api/mini/auth'
      || /^\/api\/[^/]+\/[^/]+\/(chat\/ticket|link-token|telegram-link|ical-token)$/.test(url)
      || /^\/api\/(classes|lessons)\/[^/]+\/(chat\/ticket|link-token)$/.test(url)
      || url === '/api/rtc/token'
      || /ticket|token/.test(url)
    ) {
      // @fastify/compress reads the per-route `compress` option (route-level,
      // not config). Setting it false opts this route out of compression.
      routeOptions.compress = false;
    }
    // Task B (2026-10-23): the auth routes' per-IP limiter is a FLOOD ceiling on a shared
    // address, not the brute-force net — a class of 30 registers and logs in through one school
    // IP, and that traffic must not be refused. The brute-force defence lives per credential
    // (services/auth.ts lockout + lib/throttle.ts credential windows) and is unchanged.
    // The caps are env-overridable outside production (see lib/prodConfig.ts for the arithmetic
    // behind 120/10 min) and production always applies its own value.
    if (url === '/api/auth/login') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: effectiveIpWindowMax(env.NODE_ENV, env.RATE_IP_MAX),
          timeWindow: effectiveIpWindowMs(),
        },
      };
    }
    // Часть F (2026-10-16): /api/auth/email-code — под тот же потолок, что и остальные
    // кодовые маршруты: это тоже вход с общего адреса, и письма шлёт целый класс.
    // Задача 2026-10-23 (часть A): публичные маршруты приглашений — это ровно тот же «вход с
    // общего адреса школы», что и регистрация по коду, поэтому они в этом же списке, а не со
    // своим лимитом в обработчике: общий `onRoute` выше перезаписал бы любой per-route config,
    // и настоящий потолок держит именно здесь.
    // 2026-10-27: приём по коду класса выведен, и три его маршрута (`/api/auth/register`,
    // `/api/auth/check-code`, `/api/join-by-code`) остались в этом списке ОСОЗНАННО, хотя теперь
    // только отвечают 410: сломанный клиент, который крутит мёртвый вызов в цикле, не должен
    // выигрывать у сервера право ничего не лимитировать. Потолок им тот же, что живым публичным
    // входам, — школа с одного адреса бьёт в них не чаще, чем в регистрацию по ссылке.
    if (url === '/api/auth/register' || url === '/api/join-by-code' || url === '/api/auth/check-code'
      || url === '/api/auth/email-code'
      || url === '/api/invitations/preview' || url === '/api/invitations/register' || url === '/api/invitations/join'
      // часть 3 (2026-10-28): гостевые входы — тот же «вход с общего адреса школы», что и
      // приглашения: с одного IP может стучаться целый класс гостей, и потолок должен быть общим
      || url === '/api/guest/preview' || url === '/api/guest/request'
      || url === '/api/guest/status' || url === '/api/guest/rtc'
      // Task F (2026-10-28): обмен initData на сессию Mini App — тоже публичный вход, и с одного
      // школьного/мобильного адреса (CGNAT) его могут проходить десятки учителей. Потолок общий;
      // отдельный per-user лимит на публикацию живёт в самих маршрутах.
      || url === '/api/mini/auth') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: effectiveIpWindowMax(env.NODE_ENV, env.RATE_IP_MAX),
          timeWindow: effectiveIpWindowMs(),
        },
      };
    }
  });
  await app.register(rateLimit, { global: false });

  // Performance (Phase 4): transparently gzip/brotli text-like responses (the SPA
  // shell, hashed JS/CSS chunks, JSON API, ICS, SVG). Registered AFTER the onRoute
  // hook above so that hook's per-route `compress:false` (Phase 4в — never
  // compress auth/token/ticket responses) is already applied when the plugin's
  // own onRoute captures each route. @fastify/compress only touches its default
  // compressible MIME set, so media/PDF range streams stay untouched.
  await app.register(compress, { encodings: ['br', 'gzip'], threshold: 0 });

  await app.register(authPlugin, { db });

  await app.register(healthRoutes, { db });
  // часть A: включатель «урок не прерывается»; часть F: «регистрация требует код из письма»
  await app.register(featureRoutes, { emailVerification: email.provider !== 'none' });
  await app.register(authRoutes(db, email));
  await app.register(classRoutes, { db });
  // задача 2026-10-23 (часть A): публичная половина приглашений — предпросмотр, регистрация по
  // одноразовой ссылке и вход существующим аккаунтом
  await app.register(invitationRoutes(db, email));
  await app.register(rtcRoutes, { db });
  await app.register(postRoutes, { db });
  await app.register(noteRoutes, { db });
  await app.register(eventRoutes, { db });
  await app.register(lessonRoutes, { db });
  await app.register(guestRoutes(db));
  await app.register(lessonGuestRoutes, { db });
  await app.register(boardRoutes, { db });
  await app.register(lessonArchiveRoutes, { db }); // часть 4: архив уроков
  await app.register(studentNoteRoutes, { db });
  await app.register(telegramRoutes, { db });
  // Task F (2026-10-28): the Mini App surface. It reuses the same bot API and homework engine as
  // the bot, so the two entry points cannot publish through different code paths.
  await app.register(miniRoutes, { db, ...opts.mini });
  await app.register(chatRoutes, { db }); // item 8
  await app.register(lessonCommentRoutes, { db }); // task 2 (2026-10-09): comments during a lesson
  await app.register(lessonHandRoutes, { db }); // task 2Б (2026-10-10): raise hand / give the floor

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
    /*
     * LOW-07 (аудит 2026-10-28): не-API путь больше не получает 200 «на всякий случай».
     *  • известный маршрут SPA (список = App.tsx, паритет держит spa-routes.test.ts) → оболочка 200;
     *  • неизвестная страница → та же оболочка, но 404: SPA нарисует свой экран, а поисковик и
     *    монитор увидят честный код;
     *  • файл с расширением (`.js`, `.map`, `.woff2`, …) → обычный 404 без HTML: оболочка вместо
     *    скрипта — это ошибка разбора, а не страница.
     */
    app.setNotFoundHandler((req, reply) => {
      const pathname = (req.url.split('?')[0] ?? '/');
      if (pathname.startsWith('/api') || pathname.startsWith('/webhook')) {
        return reply.code(404).send({ error: 'notFound' });
      }
      if (looksLikeStaticFile(pathname)) return reply.code(404).send({ error: 'notFound' });
      if (isSpaRoute(pathname)) return reply.type('text/html').send(shell());
      return reply.code(404).type('text/html').send(shell());
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: 'notFound' });
    });
  }

  return app;
}
