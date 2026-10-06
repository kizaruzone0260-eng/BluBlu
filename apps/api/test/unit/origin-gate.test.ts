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
import { originAllowed, configuredOrigins, normalizeOrigin } from '../../src/lib/origin.js';
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
