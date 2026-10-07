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
  effectiveCodeMax,
  effectiveCorsOrigins,
  effectiveLoginMax,
  effectiveRefreshGrace,
  effectiveWebOrigin,
  PROD_CODE_MAX,
  PROD_LOGIN_MAX,
  PROD_REFRESH_GRACE_CEILING_MS,
  rtcSpikeEnabled,
} from '../../src/lib/prodConfig.js';

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
