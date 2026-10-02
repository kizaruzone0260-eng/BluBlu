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
  ARGON2_MEMORY_COST: z.coerce.number().default(19456),
  ARGON2_TIME_COST: z.coerce.number().default(2),
  ARGON2_PARALLELISM: z.coerce.number().default(1),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecretdevsecretdevsecret123456'),
  LIVEKIT_WS_URL: z.string().default('ws://localhost:7880'),
  STORAGE_DIR: z.string().default('./files-store'),
  MAX_FILE_MB: z.coerce.number().default(100),
  TEACHER_QUOTA_GB: z.coerce.number().default(5),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DOMAIN: z.string().optional(),
  WEB_DIST: z.string().optional(),
})
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && v.JWT_SECRET === DEV_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'JWT_SECRET must be set in production', path: ['JWT_SECRET'] });
    }
    if (v.NODE_ENV === 'production' && (v.LIVEKIT_API_SECRET === 'devsecretdevsecretdevsecret123456' || v.LIVEKIT_API_KEY === 'devkey')) {
      ctx.addIssue({ code: 'custom', message: 'LiveKit keys must be set in production', path: ['LIVEKIT_API_KEY'] });
    }
  });

export const env = envSchema.parse(process.env);
export type Env = typeof env;
