/**
 * The production configuration matrix, proved in BOTH modes.
 *
 * Background: the video-lesson outage was a branch that only production takes
 * (NODE_ENV/PUBLIC_URL), which no local run could reach — dev, CI and e2e were green
 * while the deployed app bounced every user to Sign In. Every `NODE_ENV === 'production'`
 * or "is this variable set" behaviour therefore now lives in lib/prodConfig.ts and is
 * asserted here as a pair: the permissive non-production value and the strict production
 * value. test/integration/prod-config.test.ts then exercises the same matrix over real
 * HTTP/WS against a production-shaped app.
 */
import { describe, it, expect } from 'vitest';
import {
  DEV_WEB_ORIGIN,
  cookieIsSecure,
  effectiveAccessTokenTtl,
  effectiveArgon2Costs,
  effectiveCodeMax,
  effectiveCorsOrigins,
  effectiveLiveKitApiBase,
  effectiveLiveKitWs,
  effectiveLoginMax,
  effectiveMigrationsFolder,
  effectiveRefreshGrace,
  effectiveSiteBase,
  effectiveWebhookBase,
  effectiveWebOrigin,
  PROD_ACCESS_TOKEN_TTL_FLOOR_SEC,
  PROD_ARGON2_MEMORY_FLOOR,
  PROD_ARGON2_PARALLELISM_FLOOR,
  PROD_ARGON2_TIME_FLOOR,
  PROD_CODE_MAX,
  PROD_LOGIN_MAX,
  PROD_REFRESH_GRACE_CEILING_MS,
  productionSecretProblems,
  rtcSpikeEnabled,
  webhookRegistration,
} from '../../src/lib/prodConfig.js';

// the shipped defaults env.ts refuses to boot on in production (values, not secrets: these
// are the literals in the repository)
const DEV_JWT = 'dev-only-secret-change-me-0123456789abcdefgh';
const DEV_LK = 'devsecretdevsecretdevsecret123456';

const NODE_ENVS = ['development', 'test', 'production'] as const;

describe('PUBLIC_WEB_ORIGIN (task 2в)', () => {
  it('keeps the vite dev origin for development and test — unset', () => {
    expect(effectiveWebOrigin(undefined, 'development')).toBe(DEV_WEB_ORIGIN);
    expect(effectiveWebOrigin('', 'test')).toBe(DEV_WEB_ORIGIN);
  });

  it('is EMPTY in production when unset: localhost never enters a real allowlist', () => {
    expect(effectiveWebOrigin(undefined, 'production')).toBe('');
    expect(effectiveWebOrigin('   ', 'production')).toBe('');
  });

  it('honours an explicit value in every mode (the operator always wins)', () => {
    for (const e of NODE_ENVS) {
      expect(effectiveWebOrigin('https://school.example', e)).toBe('https://school.example');
    }
  });
});

describe('refresh-reuse grace (Part 4б)', () => {
  it('production caps the window at 5 s', () => {
    expect(effectiveRefreshGrace(30_000, 'production')).toBe(PROD_REFRESH_GRACE_CEILING_MS);
    expect(effectiveRefreshGrace(5001, 'production')).toBe(PROD_REFRESH_GRACE_CEILING_MS);
    expect(PROD_REFRESH_GRACE_CEILING_MS).toBe(5000);
  });

  it('production keeps anything already within the cap', () => {
    expect(effectiveRefreshGrace(5000, 'production')).toBe(5000);
    expect(effectiveRefreshGrace(2000, 'production')).toBe(2000);
    expect(effectiveRefreshGrace(0, 'production')).toBe(0); // 0 = strict §4 theft behaviour
  });

  it('non-production does not clamp (tests must be able to widen it)', () => {
    expect(effectiveRefreshGrace(30_000, 'test')).toBe(30_000);
    expect(effectiveRefreshGrace(30_000, 'development')).toBe(30_000);
  });
});

describe('auth rate limits (Phase 1г) — production ignores the relaxations', () => {
  it('login: production is always the strict cap, whatever RATE_LOGIN_MAX says', () => {
    expect(effectiveLoginMax('production', 99_999)).toBe(PROD_LOGIN_MAX);
    expect(effectiveLoginMax('production', 0)).toBe(PROD_LOGIN_MAX);
    expect(PROD_LOGIN_MAX).toBe(10);
  });

  it('login: non-production honours the env override the e2e suite needs', () => {
    expect(effectiveLoginMax('test', 500)).toBe(500);
    expect(effectiveLoginMax('development', 1000)).toBe(1000);
  });

  it('code probes: production is always the strict cap, non-production is configurable', () => {
    expect(effectiveCodeMax('production', 99_999)).toBe(PROD_CODE_MAX);
    expect(PROD_CODE_MAX).toBe(8);
    expect(effectiveCodeMax('test', 400)).toBe(400);
  });
});

describe('CORS allowlist', () => {
  it('production with no DOMAIN and no explicit web origin asks for nothing cross-origin', () => {
    // the shipped shape: the API serves the SPA, so every call is same-origin
    expect(effectiveCorsOrigins({ nodeEnv: 'production', publicWebOrigin: '', publicUrl: '' })).toEqual([]);
  });

  it('production accepts an explicit web origin instead of dropping it', () => {
    // a split deployment (separate front-end host) could not authenticate at all under
    // the previous rule, which read only DOMAIN in production
    expect(effectiveCorsOrigins({
      nodeEnv: 'production', publicWebOrigin: 'https://school.example', publicUrl: 'https://api.example',
    })).toContain('https://school.example');
  });

  it('production still maps DOMAIN to its https origin', () => {
    expect(effectiveCorsOrigins({ nodeEnv: 'production', domain: 'school.example', publicWebOrigin: '', publicUrl: '' }))
      .toEqual(['https://school.example']);
  });

  it('non-production keeps the dev origin plus PUBLIC_URL', () => {
    expect(effectiveCorsOrigins({ nodeEnv: 'development', publicWebOrigin: DEV_WEB_ORIGIN, publicUrl: 'https://abc.trycloudflare.com' }))
      .toEqual([DEV_WEB_ORIGIN, 'https://abc.trycloudflare.com']);
  });

  it('never emits an empty entry (an empty string in the list would be a bug, not a no-op)', () => {
    expect(effectiveCorsOrigins({ nodeEnv: 'development', publicWebOrigin: '', publicUrl: '' })).toEqual([]);
  });
});

describe('refresh cookie and the stage-0 spike route', () => {
  it('the refresh cookie is Secure only in production (https-only deployment)', () => {
    expect(cookieIsSecure('production')).toBe(true);
    expect(cookieIsSecure('development')).toBe(false);
    expect(cookieIsSecure('test')).toBe(false);
  });

  it('the spike token endpoint exists outside production and is gone inside it', () => {
    expect(rtcSpikeEnabled('development')).toBe(true);
    expect(rtcSpikeEnabled('test')).toBe(true);
    expect(rtcSpikeEnabled('production')).toBe(false);
  });
});

describe('address resolution from the presence of a variable', () => {
  it('link base: PUBLIC_URL wins, then DOMAIN, then PUBLIC_WEB_ORIGIN; slashes trimmed', () => {
    expect(effectiveSiteBase({ publicUrl: 'https://abc.trycloudflare.com/', domain: 'school.example', publicWebOrigin: 'https://ui.example' }))
      .toBe('https://abc.trycloudflare.com');
    expect(effectiveSiteBase({ publicUrl: '', domain: 'school.example', publicWebOrigin: 'https://ui.example' }))
      .toBe('https://school.example');
    expect(effectiveSiteBase({ publicUrl: '', domain: '', publicWebOrigin: 'https://ui.example' }))
      .toBe('https://ui.example');
    // nothing configured → empty, and never a silent localhost link in a user's message
    expect(effectiveSiteBase({ publicUrl: '', domain: '', publicWebOrigin: '' })).toBe('');
    // a DOMAIN pasted with a scheme does not become https://https://…
    expect(effectiveSiteBase({ publicUrl: '', domain: 'https://school.example', publicWebOrigin: '' }))
      .toBe('https://school.example');
  });

  it('webhook base: PUBLIC_URL then DOMAIN only — it never falls back to the CSRF origin', () => {
    expect(effectiveWebhookBase({ publicUrl: 'https://api.example', domain: undefined })).toBe('https://api.example');
    expect(effectiveWebhookBase({ publicUrl: '', domain: 'school.example' })).toBe('https://school.example');
    // the case that matters: an operator who set only PUBLIC_WEB_ORIGIN must not have the
    // live bot's webhook silently pointed at it
    expect(effectiveWebhookBase({ publicUrl: '', domain: undefined })).toBe('');
  });

  it('LiveKit: LIVEKIT_URL overrides both the client ws and the RoomService base', () => {
    expect(effectiveLiveKitWs({ livekitUrl: 'wss://x.livekit.cloud', livekitWsUrl: 'ws://localhost:7880' }))
      .toBe('wss://x.livekit.cloud');
    expect(effectiveLiveKitWs({ livekitUrl: '', livekitWsUrl: 'ws://localhost:7880' }))
      .toBe('ws://localhost:7880');
    expect(effectiveLiveKitApiBase({ livekitUrl: 'wss://x.livekit.cloud', livekitInternalUrl: 'http://localhost:7880' }))
      .toBe('https://x.livekit.cloud');
    expect(effectiveLiveKitApiBase({ livekitUrl: '', livekitInternalUrl: 'http://127.0.0.1:7880' }))
      .toBe('http://127.0.0.1:7880');
  });

  it('migrations come from dist/ in production and src/ everywhere else', () => {
    expect(effectiveMigrationsFolder('production', '/repo')).toBe('/repo/dist/db/migrations');
    expect(effectiveMigrationsFolder('development', '/repo')).toBe('/repo/src/db/migrations');
    expect(effectiveMigrationsFolder('test', '/repo')).toBe('/repo/src/db/migrations');
  });
});

describe('production refuses to boot on shipped defaults (never echoing a value)', () => {
  const base = {
    jwtSecret: 'a-real-secret-of-its-own-0123456789abcdef', devJwtSecret: DEV_JWT,
    livekitApiKey: 'api-key-set', devLiveKitKey: 'devkey',
    livekitApiSecret: 'a-real-livekit-secret-0123456789abcdef', devLiveKitSecret: DEV_LK,
  };

  it('production with the shipped dev secrets reports both problems', () => {
    const p = productionSecretProblems({
      ...base, nodeEnv: 'production', jwtSecret: DEV_JWT, livekitApiKey: 'devkey', livekitApiSecret: DEV_LK,
    });
    expect(p.map((x) => x.path).sort()).toEqual(['JWT_SECRET', 'LIVEKIT_API_KEY']);
    // the messages name the variable only — never a value
    expect(JSON.stringify(p)).not.toMatch(DEV_JWT);
  });

  it('production with real values reports nothing', () => {
    expect(productionSecretProblems({ ...base, nodeEnv: 'production' })).toEqual([]);
  });

  it('a lone default LiveKit key is still a problem (the other secret being real is not enough)', () => {
    const p = productionSecretProblems({ ...base, nodeEnv: 'production', livekitApiKey: 'devkey' });
    expect(p.map((x) => x.path)).toEqual(['LIVEKIT_API_KEY']);
  });

  it('development and test are not blocked (they ship with the dev defaults)', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(productionSecretProblems({
        ...base, nodeEnv, jwtSecret: DEV_JWT, livekitApiKey: 'devkey', livekitApiSecret: DEV_LK,
      })).toEqual([]);
    }
  });
});

describe('SEC-15: production floors for password hashing and access-token TTL', () => {
  it('cheap Argon2 parameters are raised to the floors in production', () => {
    expect(effectiveArgon2Costs({ memoryCost: 1024, timeCost: 1, parallelism: 1 }, 'production'))
      .toEqual({
        memoryCost: PROD_ARGON2_MEMORY_FLOOR,
        timeCost: PROD_ARGON2_TIME_FLOOR,
        parallelism: PROD_ARGON2_PARALLELISM_FLOOR,
      });
  });

  it('stronger parameters are kept as the operator set them', () => {
    const strong = { memoryCost: 65_536, timeCost: 3, parallelism: 2 };
    expect(effectiveArgon2Costs(strong, 'production')).toEqual(strong);
  });

  it('development and test keep cheap parameters on purpose (the suite would take hours)', () => {
    const cheap = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
    expect(effectiveArgon2Costs(cheap, 'test')).toEqual(cheap);
    expect(effectiveArgon2Costs(cheap, 'development')).toEqual(cheap);
  });

  it('access-token TTL: invalid or sub-minute values become 60 s in production only', () => {
    expect(effectiveAccessTokenTtl('5s', 'production')).toBe(`${PROD_ACCESS_TOKEN_TTL_FLOOR_SEC}s`);
    expect(effectiveAccessTokenTtl('nonsense', 'production')).toBe(`${PROD_ACCESS_TOKEN_TTL_FLOOR_SEC}s`);
    expect(effectiveAccessTokenTtl('0', 'production')).toBe(`${PROD_ACCESS_TOKEN_TTL_FLOOR_SEC}s`);
    // the shipped default and longer deliberate values are untouched
    expect(effectiveAccessTokenTtl('15m', 'production')).toBe('15m');
    expect(effectiveAccessTokenTtl('2h', 'production')).toBe('2h');
    // tests deliberately use short-lived tokens (expiry/rotation specs)
    expect(effectiveAccessTokenTtl('5s', 'test')).toBe('5s');
    expect(effectiveAccessTokenTtl('nonsense', 'development')).toBe('nonsense');
  });
});

// ─── audit item 1: the webhook registration arguments ─────────────────────────
//
// getWebhookInfo does not report secret_token, so nothing on the Telegram side can prove the
// registration was authenticated. The only proof is this object, which is why the decision moved
// out of server.ts and into prodConfig.ts.
describe('webhookRegistration (аудит бота, п.1)', () => {
  const HOOK = 'fictitious-hook-secret-0123456789';
  const ok = { publicUrl: 'https://klass.example', secret: HOOK, mode: 'webhook', hasBot: true };

  it('registers against PUBLIC_URL with the configured secret and keeps the queue', () => {
    expect(webhookRegistration(ok)).toEqual({
      url: 'https://klass.example/webhook/telegram', secret_token: HOOK, drop_pending_updates: false,
    });
  });

  it('DOMAIN is the fallback, and the trailing slash never becomes //webhook', () => {
    expect(webhookRegistration({ ...ok, publicUrl: '', domain: 'klass.example/' }))
      ?.toEqual({ url: 'https://klass.example/webhook/telegram', secret_token: HOOK, drop_pending_updates: false });
  });

  it('no secret ⇒ NO registration at all — a webhook without a shared secret is never installed', () => {
    expect(webhookRegistration({ ...ok, secret: '' })).toBeNull();
  });

  it('no address ⇒ NO registration (a CSRF-only origin must not become the bot endpoint)', () => {
    expect(webhookRegistration({ ...ok, publicUrl: '', domain: '' })).toBeNull();
  });

  it('polling mode and a bot-less process register nothing', () => {
    expect(webhookRegistration({ ...ok, mode: 'polling' })).toBeNull();
    expect(webhookRegistration({ ...ok, hasBot: false })).toBeNull();
  });

  it('the result object contains the secret under exactly the key Telegram reads', () => {
    // the class of bug this guards: the code sets a key the library does not read, so the webhook
    // is registered WITHOUT a secret and every delivery arrives unauthenticated.
    const reg = webhookRegistration(ok);
    expect(reg && Object.keys(reg).sort()).toEqual(['drop_pending_updates', 'secret_token', 'url']);
    expect(reg?.secret_token).toBe(HOOK);
  });
});
