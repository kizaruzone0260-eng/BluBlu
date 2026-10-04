import { z } from 'zod';

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
  // Demo: public origin of this deployment (e.g. https://xxxx.trycloudflare.com).
  // Used for notification links and same-origin checks. Empty ⇒ production logic (DOMAIN).
  PUBLIC_URL: z.string().default(''),
  STORAGE_DIR: z.string().default('./files-store'),
  MAX_FILE_MB: z.coerce.number().default(100),
  TEACHER_QUOTA_GB: z.coerce.number().default(5),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DOMAIN: z.string().optional(),
  WEB_DIST: z.string().optional(),
  // trust X-Forwarded-For for client IP (rate limits, logs): '1' behind Caddy/
  // cloudflared/Render, '0' (default) when the API socket IS the client address.
  TRUST_PROXY: z
    .union([z.enum(['0', '1', 'true', 'false']), z.boolean()])
    .default('0')
    .transform((v) => v === true || v === '1' || v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_NAME: z.string().default('klass_bot'),
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
})
  .superRefine((v, ctx) => {
    if (v.SEED_TEACHER_EMAIL && !v.SEED_TEACHER_PASSWORD) {
      ctx.addIssue({ code: 'custom', message: 'SEED_TEACHER_PASSWORD is required when SEED_TEACHER_EMAIL is set', path: ['SEED_TEACHER_PASSWORD'] });
    }
    if (v.NODE_ENV === 'production' && v.JWT_SECRET === DEV_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'JWT_SECRET must be set in production', path: ['JWT_SECRET'] });
    }
    if (v.NODE_ENV === 'production' && (v.LIVEKIT_API_SECRET === 'devsecretdevsecretdevsecret123456' || v.LIVEKIT_API_KEY === 'devkey')) {
      ctx.addIssue({ code: 'custom', message: 'LiveKit keys must be set in production', path: ['LIVEKIT_API_KEY'] });
    }
  });

export const env = envSchema.parse(process.env);
export type Env = typeof env;

/** Client-facing LiveKit WebSocket address: LIVEKIT_URL (Cloud/demo) wins over LIVEKIT_WS_URL (self-host via Caddy). */
export function livekitPublicWsUrl(): string {
  return env.LIVEKIT_URL || env.LIVEKIT_WS_URL;
}

/** RoomService REST base: wss→https / ws→http; falls back to LIVEKIT_INTERNAL_URL for self-hosted LAN access. */
export function livekitRoomApiUrl(): string {
  const base = env.LIVEKIT_URL || env.LIVEKIT_INTERNAL_URL;
  return base.replace(/^wss/, 'https').replace(/^ws/, 'http');
}
