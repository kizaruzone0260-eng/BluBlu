import { z } from 'zod';
import { effectiveTokenTtl } from './lib/tokenTtl.js';
import { effectiveLiveKitApiBase, effectiveLiveKitWs, effectiveRefreshGrace, effectiveWebOrigin, productionSecretProblems } from './lib/prodConfig.js';

const DEV_SECRET = 'dev-only-secret-change-me-0123456789abcdefgh';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z
      .string()
      .default('postgres://klass:klass@localhost:5432/klass'),
    JWT_SECRET: z.string().min(32).default(DEV_SECRET),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  // Grace for replaying an ALREADY-ROTATED refresh token: browsers that abort a
  // rotation response (instant reload mid-boot) would otherwise trip the
  // reuse-theft kill. 0 restores strict §4 behaviour (used by the theft test).
  REFRESH_REUSE_GRACE_MS: z.coerce.number().min(0).max(30_000).default(5000),
  ARGON2_MEMORY_COST: z.coerce.number().default(19456),
  ARGON2_TIME_COST: z.coerce.number().default(2),
  ARGON2_PARALLELISM: z.coerce.number().default(1),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecretdevsecretdevsecret123456'),
  LIVEKIT_WS_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_INTERNAL_URL: z.string().default('http://localhost:7880'),
  // Demo (docs/DEMO.md): external LiveKit address (e.g. LiveKit Cloud wss://…).
  // When set it overrides LIVEKIT_WS_URL (client) and LIVEKIT_INTERNAL_URL (RoomService API).
  LIVEKIT_URL: z.string().default(''),
  // Part 4а: LiveKit LESSON join-token TTL. A lesson may run longer than the
  // token, so this is env-tunable; in PRODUCTION it is floored at 2 h (see the
  // clamp below). Format: '<n><smhd>' ('6h','90m') or a bare number of seconds.
  RTC_TOKEN_TTL: z.string().default('6h'),
  // Demo: public origin of this deployment (e.g. https://xxxx.trycloudflare.com).
  // Used for notification links and same-origin checks. Empty ⇒ production logic (DOMAIN).
  PUBLIC_URL: z.string().default(''),
  STORAGE_DIR: z.string().default('./files-store'),
  MAX_FILE_MB: z.coerce.number().default(100),
  TEACHER_QUOTA_GB: z.coerce.number().default(5),
  // Origin of the UI. The schema default is EMPTY on purpose: lib/prodConfig keeps the
  // vite dev origin for development/test and leaves production unset (see task 2в).
  PUBLIC_WEB_ORIGIN: z.string().default(''),
  DOMAIN: z.string().optional(),
  WEB_DIST: z.string().optional(),
  // trust X-Forwarded-For for client IP (rate limits, logs): '1' behind Caddy/
  // cloudflared/Render, '0' (default) when the API socket IS the client address.
  TRUST_PROXY: z
    .union([z.enum(['0', '1', 'true', 'false']), z.boolean()])
    .default('0')
    .transform((v) => v === true || v === '1' || v === 'true'),
  // Часть A (2026-10-16): «урок не прерывается при переходах». Комната и сокет урока живут над
  // роутером, поэтому страница «Чат» или «Заметки» больше не рвёт соединение, а на других
  // экранах урок виден в мини-окне. Выключатель дан намеренно: это новое поведение всего
  // медиа-тракта, и владелец может вернуть прежнее (урок живёт ровно на своей странице)
  // одной переменной в Render, без пересборки. По умолчанию ВКЛ.
  LESSON_PERSIST: z
    .union([z.enum(['0', '1', 'true', 'false']), z.boolean()])
    .default('1')
    .transform((v) => v === true || v === '1' || v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  // item 5: NO default bot name — without TELEGRAM_BOT_NAME the app must not
  // invent t.me/… links; the UI then shows «Telegram notifications not configured».
  TELEGRAM_BOT_NAME: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_TRANSPORT: z.enum(['log', 'telegram']).default('log'),
  // Demo: 'polling' uses grammY long-polling (no public webhook needed);
  // production keeps 'webhook' behind Caddy.
  TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('webhook'),
  // Instance owner teacher created at boot on an EMPTY database (cloud deploys).
  // Both must be set to do anything; the password is never logged.
  SEED_TEACHER_EMAIL: z.string().optional(),
  SEED_TEACHER_NAME: z.string().default('Teacher'),
  SEED_TEACHER_PASSWORD: z.string().min(8).optional(),
  // Auth rate caps. Production keeps the strict defaults (login 10/min, code
  // attempts 8/min); the e2e suite logs in far more than a real user, so the
  // stack overrides these to keep the run from tripping its own safety net.
  // Часть 4: срок хранения архива уроков в днях. 0 (по умолчанию) — НЕ удалять никогда:
  // архив — учебная история, и терять её по умолчанию нельзя.
  BOARD_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  RATE_LOGIN_MAX: z.coerce.number().default(10),
  RATE_CODE_MAX: z.coerce.number().default(8),
  /*
   * Часть F (2026-10-16): подтверждение почты при регистрации.
   *
   * `none` — ВЫКЛЮЧАТЕЛЬ ПО УМОЛЧанию, и это не лень, а свойство отката: при `none` маршруты
   * регистрации остаются байт-в-байт прежними (ни письма, ни кода, ни нового поля в форме),
   * поэтому включение части F не может сломать ни живой деплой без настроенной почты, ни
   * существующие тесты. Владелец включает провайдер одной переменной.
   */
  EMAIL_PROVIDER: z.enum(['none', 'console', 'brevo', 'resend', 'smtp']).default('none'),
  /** От кого: «support@школа.уз» — обязателен для любого провайдера кроме `none`. */
  EMAIL_FROM: z.string().default(''),
  EMAIL_FROM_NAME: z.string().default('BluBlu'),
  EMAIL_REPLY_TO: z.string().default(''),
  /** Потолок одного HTTP-шага к провайдеру: зависший Brevo не должен держать процесс. */
  EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  BREVO_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURITY: z.enum(['starttls', 'tls', 'plain']).default('starttls'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** Имя в EHLO/HELO: почтовые серверы требуют FQDN, а не «localhost». */
  SMTP_HELO_NAME: z.string().default('blublu.local'),
})
  .superRefine((v, ctx) => {
    if (v.SEED_TEACHER_EMAIL && !v.SEED_TEACHER_PASSWORD) {
      ctx.addIssue({ code: 'custom', message: 'SEED_TEACHER_PASSWORD is required when SEED_TEACHER_EMAIL is set', path: ['SEED_TEACHER_PASSWORD'] });
    }
    /*
     * Часть F: наполовину настроенная почта — это не «выключено», а «учитель жмёт „получить
     * код“, и ничего не приходит». Поэтому связка «провайдер ⇔ его обязательные ключи»
     * проверяется на старте процесса, а не в момент регистрации, когда человек уже потратил
     * минуту на форму.
     */
    if (v.EMAIL_PROVIDER !== 'none') {
      if (!v.EMAIL_FROM) {
        ctx.addIssue({ code: 'custom', message: 'EMAIL_FROM is required when EMAIL_PROVIDER is not none', path: ['EMAIL_FROM'] });
      }
      if (v.EMAIL_PROVIDER === 'brevo' && !v.BREVO_API_KEY) {
        ctx.addIssue({ code: 'custom', message: 'BREVO_API_KEY is required for EMAIL_PROVIDER=brevo', path: ['BREVO_API_KEY'] });
      }
      if (v.EMAIL_PROVIDER === 'resend' && !v.RESEND_API_KEY) {
        ctx.addIssue({ code: 'custom', message: 'RESEND_API_KEY is required for EMAIL_PROVIDER=resend', path: ['RESEND_API_KEY'] });
      }
      if (v.EMAIL_PROVIDER === 'smtp') {
        if (!v.SMTP_HOST) {
          ctx.addIssue({ code: 'custom', message: 'SMTP_HOST is required for EMAIL_PROVIDER=smtp', path: ['SMTP_HOST'] });
        }
        // половина пары логин+пароль невозможна: AUTH не состоится, а отказ молчаливый
        if ((v.SMTP_USER && !v.SMTP_PASS) || (!v.SMTP_USER && v.SMTP_PASS)) {
          ctx.addIssue({ code: 'custom', message: 'SMTP_USER and SMTP_PASS must be set together', path: ['SMTP_PASS'] });
        }
      }
    }
    // The rule itself is lib/prodConfig.productionSecretProblems (unit-tested in both shapes)
    for (const p of productionSecretProblems({
      nodeEnv: v.NODE_ENV, jwtSecret: v.JWT_SECRET, devJwtSecret: DEV_SECRET,
      livekitApiKey: v.LIVEKIT_API_KEY, devLiveKitKey: 'devkey',
      livekitApiSecret: v.LIVEKIT_API_SECRET, devLiveKitSecret: 'devsecretdevsecretdevsecret123456',
    })) {
      ctx.addIssue({ code: 'custom', message: p.message, path: [p.path] });
    }
  });

/*
 * A rejected config is printed WITHOUT its values. `ZodError` puts the offending input into every
 * issue as `received: …`, so an unguarded `.parse` at import time hands Node's own crash printer a
 * line containing the too-short JWT secret, the malformed database URL (with password), or the
 * LiveKit secret the operator just typed. Names of the failing keys are the useful half anyway.
 */
const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  const keys = [...new Set(parsedEnv.error.issues.map((i) => i.path.join('.') || 'unknown'))];
  console.error(`config invalid: ${keys.join(', ')} — values are not printed`);
  process.exit(1);
}
export const env = parsedEnv.data;

// Hardening (Phase 1б) + Part 4б + task 2в: the production-only env adjustments live in
// lib/prodConfig.ts (one place, unit-tested in both modes, and asserted again by
// test/integration/prod-config.test.ts against a production-shaped app).
//   • the refresh-reuse grace window is capped at 5 s in production — a browser that
//     aborts a rotation response (instant reload mid-boot) replays the just-rotated
//     token, and without the window that trips the reuse-theft kill and logs a real
//     user out; the integration tests proved a 3-s stall kills the session at 2 s;
//   • PUBLIC_WEB_ORIGIN keeps the vite dev origin outside production and stays EMPTY
//     inside it, so localhost can never enter the CORS list or the CSRF/WS allowlist
//     of a real deployment by default.
env.REFRESH_REUSE_GRACE_MS = effectiveRefreshGrace(env.REFRESH_REUSE_GRACE_MS, env.NODE_ENV);
env.PUBLIC_WEB_ORIGIN = effectiveWebOrigin(process.env.PUBLIC_WEB_ORIGIN, env.NODE_ENV);

// Part 4а: floor the LiveKit lesson-token TTL at 2 h in production, so a
// mistyped small value can never drop a mid-lesson participant.
env.RTC_TOKEN_TTL = String(effectiveTokenTtl(env.RTC_TOKEN_TTL, env.NODE_ENV));

export type Env = typeof env;

/** Client-facing LiveKit WebSocket address: LIVEKIT_URL (Cloud/demo) wins over LIVEKIT_WS_URL (self-host via Caddy). */
export function livekitPublicWsUrl(): string {
  return effectiveLiveKitWs({ livekitUrl: env.LIVEKIT_URL, livekitWsUrl: env.LIVEKIT_WS_URL });
}

/** RoomService REST base: wss→https / ws→http; falls back to LIVEKIT_INTERNAL_URL for self-hosted LAN access. */
export function livekitRoomApiUrl(): string {
  return effectiveLiveKitApiBase({ livekitUrl: env.LIVEKIT_URL, livekitInternalUrl: env.LIVEKIT_INTERNAL_URL });
}
