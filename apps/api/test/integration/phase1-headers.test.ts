/**
 * Part 1(а) — the response-header table. Asserts the full security header set on
 * the four surfaces the task names — the SPA shell `/`, `/api/health`, a private
 * API response (unauthenticated `/api/me` → 401) and (in the uploads test) a file
 * download — plus that NO source map is ever served and the health/API replies
 * never leak a version. Values are the ones @fastify/helmet + the app onSend hook
 * actually emit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Every response must carry these (helmet defaults + the app onSend additions). */
const COMMON_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self)',
  'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
};

suite('Part 1(а): response headers', () => {
  let t: TestDB; let app: FastifyInstance;
  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'hdr-dist-'));
    writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>t</title><p>shell</p>');
    (env as { WEB_DIST?: string }).WEB_DIST = d; // enable the static/SPA branch
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
  });
  afterAll(async () => { (env as { WEB_DIST?: string }).WEB_DIST = undefined; await app?.close(); await t?.sql.end(); });

  function expectCommon(h: Record<string, string | string[] | undefined>) {
    for (const [k, v] of Object.entries(COMMON_HEADERS)) expect(String(h[k]), k).toBe(v);
    const csp = String(h['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  }

  it('SPA shell /: full header set + no-cache for the HTML', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/html');
    expectCommon(r.headers);
    expect(String(r.headers['cache-control'])).toBe('no-cache');
  });

  it('/api/health: full header set, no-store, and NO version/stack in the body', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expectCommon(r.headers);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    // never expose a version or library text (baseline rule)
    expect(r.body).not.toMatch(/version|fastify|drizzle|postgres|node/i);
  });

  it('private API (401 /api/me): full header set + no-store, no leak', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r.statusCode).toBe(401);
    expectCommon(r.headers);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    expect(String(r.headers['pragma'])).toBe('no-cache');
    expect(r.json().error).toBe('unauthorized');
  });

  it('no source map is ever served (SPA fallback, never a .map payload)', async () => {
    for (const u of ['/index.js.map', '/assets/hash.js.map', '/deep/nested.chunk.js.map']) {
      const r = await app.inject({ method: 'GET', url: u });
      // the static root only has index.html; a .map request must NOT return a map —
      // it falls through to the SPA shell (HTML) or a plain 404, never JS w/ sourcemap.
      const ct = String(r.headers['content-type'] ?? '');
      const isHtmlShell = ct.includes('text/html');
      const is404 = r.statusCode === 404;
      expect(isHtmlShell || is404, `${u} -> ${r.statusCode} ${ct}`).toBe(true);
      if (r.statusCode === 200) expect(r.body).not.toContain('sourceMappingURL');
    }
    // filesystem proof: the built web bundle (when present in this checkout) has zero .map files
    const webDist = path.resolve(process.cwd(), '../web/dist');
    if (existsSync(webDist)) {
      const maps: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d)) {
          const p = path.join(d, e);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.map')) maps.push(p);
        }
      };
      walk(webDist);
      expect(maps, `source maps found: ${maps.join(', ')}`).toEqual([]);
    }
  });
});
