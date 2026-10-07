/**
 * Video-lesson production regression — the Origin gate (lib/origin.ts).
 *
 * Live incident: on Render the page's own origin was NOT in the configured allowlist
 * (PUBLIC_URL pointed elsewhere / PUBLIC_WEB_ORIGIN unset), so POST /api/auth/refresh
 * answered 403 before any token logic, the SPA dropped the access token, /api/me
 * answered 401 and Video Lesson bounced to Sign In. Root commit: 9573faa dropped the
 * same-host fallback that fe50ec8 had added after the identical earlier incident.
 *
 * These cases pin BOTH halves of the rule: config drift must never log a real,
 * same-origin user out (fails on the pre-fix code), and a genuinely cross-site
 * Origin must still be refused (the security property must not regress).
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  originAllowed, configuredOrigins, normalizeOrigin, requestOriginAllowed, originBootSummary,
} from '../../src/lib/origin.js';
import { wsOriginAllowed } from '../../src/lib/wsOrigin.js';
import { env } from '../../src/env.js';

const RENDER_HOST = 'blublu-api.onrender.com';
const RENDER_ORIGIN = `https://${RENDER_HOST}`;

describe('origin gate: pure decision', () => {
  it('accepts an explicitly configured origin', () => {
    expect(originAllowed(RENDER_ORIGIN, RENDER_HOST, [RENDER_ORIGIN])).toBe(true);
  });

  it('accepts a configured origin written with a trailing slash (copy-paste drift)', () => {
    const configured = configuredOriginsFor('https://blublu-api.onrender.com/');
    expect(originAllowed(RENDER_ORIGIN, 'irrelevant-host', configured)).toBe(true);
  });

  it('REGRESSION: accepts the page\'s own origin when PUBLIC_URL is a DIFFERENT host', () => {
    // exactly the production shape: allowlist knows only some other address
    const configured = ['https://old-demo-tunnel.example', 'http://localhost:5173'];
    expect(originAllowed(RENDER_ORIGIN, RENDER_HOST, configured)).toBe(true);
  });

  it('still refuses a genuinely cross-site Origin', () => {
    const configured = ['https://some-other-host.example', 'http://localhost:5173'];
    expect(originAllowed('https://evil.example', RENDER_HOST, configured)).toBe(false);
    expect(originAllowed('https://blublu-api.onrender.com.attacker.example', RENDER_HOST, configured)).toBe(false);
  });

  it('compares the HOST, not the scheme: same host is same site (fe50ec8 semantics)', () => {
    // An http:// page on the SAME host is not a cross-site request — there is no
    // attacker origin here, so the gate stays on host identity (port still counts).
    expect(originAllowed('http://blublu-api.onrender.com', RENDER_HOST, ['https://other.example'])).toBe(true);
    expect(originAllowed('https://blublu-api.onrender.com', 'blublu-api.onrender.com:8443', [])).toBe(false);
  });

  it('matches a host with a port precisely', () => {
    expect(originAllowed('http://127.0.0.1:3999', '127.0.0.1:3999', ['http://localhost:5173'])).toBe(true);
    expect(originAllowed('http://127.0.0.1:4000', '127.0.0.1:3999', ['http://localhost:5173'])).toBe(false);
  });

  it('refuses a malformed Origin, an empty one, and non-http origins', () => {
    expect(originAllowed('not a url', RENDER_HOST, [RENDER_ORIGIN])).toBe(false);
    expect(originAllowed('', RENDER_HOST, [RENDER_ORIGIN])).toBe(false);
    // `about:blank`/sandboxed `null` have no host — they must never match a missing Host header
    expect(originAllowed('about:blank', '', [])).toBe(false);
    expect(originAllowed('null', '', [])).toBe(false);
    expect(originAllowed('https://blublu-api.onrender.com', '', [])).toBe(false);
  });

  it('normalizeOrigin trims, lowercases and drops trailing slashes', () => {
    expect(normalizeOrigin(' HTTPS://Host.Example/// ')).toBe('https://host.example');
  });
});

// helper: same normalization the real configuredOrigins() applies, without env games
function configuredOriginsFor(publicUrl: string): string[] {
  return [publicUrl, 'http://localhost:5173'].map(normalizeOrigin);
}

describe('origin gate: the headers a browser controls (tasks 2а, 2б, 2в, 2г)', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as never;

  it('compares the RAW Host header — a spoofed X-Forwarded-Host cannot widen or narrow the gate', () => {
    // trustProxy is irrelevant here: the code reads req.headers.host, never
    // req.hostname / req.host (Fastify builds those from X-Forwarded-Host when
    // trustProxy is on, which is exactly what Render sets).
    expect(requestOriginAllowed(req({
      host: RENDER_HOST, 'x-forwarded-host': 'evil.example', origin: 'https://evil.example',
    }))).toBe(false);
    expect(requestOriginAllowed(req({
      host: RENDER_HOST, 'x-forwarded-host': 'evil.example', origin: RENDER_ORIGIN,
    }))).toBe(true); // the spoof must not break the real page either
    expect(requestOriginAllowed(req({
      host: 'service-internal:10000', 'x-forwarded-host': RENDER_HOST, origin: RENDER_ORIGIN,
    }))).toBe(false); // only the raw Host is trusted as "same host"
  });

  it('rejects Sec-Fetch-Site: cross-site even when the Origin is allowlisted (second layer)', () => {
    const prev = env.PUBLIC_URL;
    env.PUBLIC_URL = RENDER_ORIGIN;
    try {
      expect(requestOriginAllowed(req({ host: 'other-host.example', origin: RENDER_ORIGIN, 'sec-fetch-site': 'cross-site' })))
        .toBe(false);
      // the same allowlisted Origin without the cross-site verdict still passes (1)
      expect(requestOriginAllowed(req({ host: 'other-host.example', origin: RENDER_ORIGIN, 'sec-fetch-site': 'same-origin' })))
        .toBe(true);
      // same-site (a sibling origin of our own site) is deliberately NOT refused
      expect(requestOriginAllowed(req({ host: 'other-host.example', origin: RENDER_ORIGIN, 'sec-fetch-site': 'same-site' })))
        .toBe(true);
      // header absent (older/Safari-less, curl) → the Origin rule alone decides
      expect(requestOriginAllowed(req({ host: 'other-host.example', origin: RENDER_ORIGIN }))).toBe(true);
      expect(requestOriginAllowed(req({ host: 'other-host.example', origin: 'https://evil.example' }))).toBe(false);
      // the WS handshake gate shares the verdict
      expect(wsOriginAllowed(req({ host: 'other-host.example', origin: RENDER_ORIGIN, 'sec-fetch-site': 'cross-site' })))
        .toBe(false);
    } finally { env.PUBLIC_URL = prev; }
  });

  it('production allowlist has no localhost entry and an unset PUBLIC_WEB_ORIGIN stays empty (2в)', () => {
    const prev = {
      NODE_ENV: env.NODE_ENV, web: env.PUBLIC_WEB_ORIGIN, url: env.PUBLIC_URL, domain: env.DOMAIN };
    try {
      env.NODE_ENV = 'production';
      env.PUBLIC_WEB_ORIGIN = '';
      env.PUBLIC_URL = RENDER_ORIGIN;
      env.DOMAIN = undefined;
      const origins = configuredOrigins();
      expect(origins).toEqual([RENDER_ORIGIN]);
      expect(origins).not.toContain('http://localhost:5173');
      // a page served from the dev vite origin is therefore refused in production
      expect(requestOriginAllowed(req({ host: 'service.internal:10000', origin: 'http://localhost:5173' }))).toBe(false);
      // …and accepted in development, where the vite origin is the default config
      env.NODE_ENV = 'development';
      env.PUBLIC_WEB_ORIGIN = 'http://localhost:5173';
      expect(requestOriginAllowed(req({ host: 'service.internal:10000', origin: 'http://localhost:5173' }))).toBe(true);
    } finally {
      env.NODE_ENV = prev.NODE_ENV; env.PUBLIC_WEB_ORIGIN = prev.web;
      env.PUBLIC_URL = prev.url; env.DOMAIN = prev.domain;
    }
  });

  it('boot summary reports the effective allowlist and the drift that broke production (2г)', () => {
    const prev = { NODE_ENV: env.NODE_ENV, web: env.PUBLIC_WEB_ORIGIN, url: env.PUBLIC_URL, domain: env.DOMAIN };
    try {
      env.NODE_ENV = 'production';
      env.DOMAIN = undefined;
      env.PUBLIC_WEB_ORIGIN = '';
      env.PUBLIC_URL = '';
      let s = originBootSummary();
      expect(s.allowed).toEqual([]);
      expect(s.sameHostFallback).toBe(true);
      expect(s.warnings.join(' ')).toMatch(/PUBLIC_URL and DOMAIN are both empty/);

      env.PUBLIC_URL = 'http://insecure.example';
      s = originBootSummary();
      expect(s.warnings.join(' ')).toMatch(/not an https origin/);

      env.PUBLIC_URL = 'https://host.example/';
      s = originBootSummary();
      expect(s.allowed).toEqual(['https://host.example']); // normalised for the check
      expect(s.warnings.join(' ')).toMatch(/trailing slash/);

      env.PUBLIC_URL = RENDER_ORIGIN;
      env.PUBLIC_WEB_ORIGIN = RENDER_ORIGIN;
      s = originBootSummary();
      expect(s.warnings).toEqual([]);
      expect(s.allowed).toEqual([RENDER_ORIGIN]);
    } finally {
      env.NODE_ENV = prev.NODE_ENV; env.PUBLIC_WEB_ORIGIN = prev.web;
      env.PUBLIC_URL = prev.url; env.DOMAIN = prev.domain;
    }
  });
});

describe('origin gate: env-driven paths (the deployed shape)', () => {
  const prevPublicUrl = env.PUBLIC_URL;
  const prevDomain = env.DOMAIN;
  const prevWeb = env.PUBLIC_WEB_ORIGIN;
  afterAll(() => {
    env.PUBLIC_URL = prevPublicUrl;
    env.DOMAIN = prevDomain;
    env.PUBLIC_WEB_ORIGIN = prevWeb;
  });

  it('PUBLIC_URL set to another host ⇒ the served page origin is still trusted, evil is not', () => {
    env.PUBLIC_URL = 'https://stale-demo-tunnel.example';
    env.DOMAIN = undefined;
    env.PUBLIC_WEB_ORIGIN = 'http://localhost:5173';
    const origins = configuredOrigins();
    expect(origins).toContain('https://stale-demo-tunnel.example');
    expect(originAllowed(RENDER_ORIGIN, RENDER_HOST, origins)).toBe(true);
    expect(originAllowed('https://evil.example', RENDER_HOST, origins)).toBe(false);
  });

  it('wsOriginAllowed shares the same decision (lesson/board/chat sockets)', () => {
    env.PUBLIC_URL = 'https://stale-demo-tunnel.example';
    env.DOMAIN = undefined;
    const req = (origin: string | undefined, host: string) =>
      ({ headers: { ...(origin ? { origin } : {}), host } }) as never;
    expect(wsOriginAllowed(req(RENDER_ORIGIN, RENDER_HOST))).toBe(true);  // drift must not kill the socket
    expect(wsOriginAllowed(req('https://evil.example', RENDER_HOST))).toBe(false);
    expect(wsOriginAllowed(req(undefined, RENDER_HOST))).toBe(true);       // non-browser client: ticket is the gate
  });

  it('no PUBLIC_URL/DOMAIN (dev/e2e) keeps working as before', () => {
    env.PUBLIC_URL = '';
    env.DOMAIN = undefined;
    expect(wsOriginAllowed({ headers: { origin: 'http://localhost:5173', host: 'localhost:5173' } } as never)).toBe(true);
    expect(wsOriginAllowed({ headers: { origin: 'https://evil.example', host: 'localhost:5173' } } as never)).toBe(false);
  });
});
