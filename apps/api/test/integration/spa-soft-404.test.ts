/**
 * LOW-07 + SEC-30 (аудит 2026-10-28).
 *
 * LOW-07: неизвестная страница и отсутствующий файл получали HTML-оболочку со статусом 200 —
 * soft 404. Рабочие глубокие ссылки при этом обязаны остаться 200: исправление не имеет права
 * ломать закладки на /classes/:id, /chat/:id и архив.
 *
 * SEC-30: `/fonts` и `/excalidraw-assets` (736 KB и 14 MB) отдавались без max-age. Проверяем не
 * «заголовок есть», а конкретную политику: неделя + stale-while-revalidate для нехэшированных
 * имён, год+immutable для content-hashed `/assets`, no-cache для HTML и service worker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, preparedDb, type TestDB } from './util.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/env.js';
import type { FastifyInstance } from 'fastify';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('SPA-маршруты: soft 404 и кэш статики', () => {
  let t: TestDB; let app: FastifyInstance;

  beforeAll(async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'spa-dist-'));
    writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>t</title><p id="shell">shell</p>');
    mkdirSync(path.join(d, 'fonts'));
    writeFileSync(path.join(d, 'fonts', 'inter.woff2'), 'font');
    mkdirSync(path.join(d, 'excalidraw-assets'));
    writeFileSync(path.join(d, 'excalidraw-assets', 'Virgil.woff2'), 'font');
    mkdirSync(path.join(d, 'assets'));
    writeFileSync(path.join(d, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(path.join(d, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    (env as { WEB_DIST?: string }).WEB_DIST = d;
    t = await preparedDb(TEST_DATABASE_URL);
    app = await buildApp(t.db);
  });
  afterAll(async () => { (env as { WEB_DIST?: string }).WEB_DIST = undefined; await app?.close(); await t?.sql.end(); });

  it('глубокие ссылки SPA отдают оболочку с 200', async () => {
    for (const url of [
      '/classes/2f0c-aa', '/classes/2f0c-aa/archive', '/classes/2f0c-aa/material/new',
      '/chat/9b1d', '/lesson', '/privacy', '/terms',
    ]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(String(r.headers['content-type']), url).toContain('text/html');
      expect(r.body, url).toContain('shell');
    }
  });

  it('неизвестная страница — та же оболочка, но 404 (soft 404 больше нет)', async () => {
    const r = await app.inject({ method: 'GET', url: '/this-page-does-not-exist-xyz' });
    expect(r.statusCode).toBe(404);
    expect(String(r.headers['content-type'])).toContain('text/html');
    expect(r.body).toContain('shell');
  });

  it('отсутствующий файл — 404 без HTML-оболочки', async () => {
    for (const url of ['/assets/missing-abc.js', '/index.js.map', '/fonts/nope.woff2', '/icon-404.png']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(String(r.headers['content-type']), url).not.toContain('text/html');
    }
  });

  it('API и webhook по-прежнему дают JSON 404', async () => {
    for (const url of ['/api/definitely-not-a-route', '/webhook/unknown']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error, url).toBe('notFound');
    }
  });

  it('SEC-30: шрифты и ассеты Excalidraw кэшируются, но не «immutable на год»', async () => {
    const expected = 'public, max-age=604800, stale-while-revalidate=86400';
    for (const url of ['/fonts/inter.woff2', '/excalidraw-assets/Virgil.woff2']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(String(r.headers['cache-control']), url).toBe(expected);
    }
    const hashed = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(String(hashed.headers['cache-control'])).toBe('public, max-age=31536000, immutable');
    for (const url of ['/', '/sw.js']) {
      const r = await app.inject({ method: 'GET', url });
      expect(String(r.headers['cache-control']), url).toBe('no-cache');
    }
  });
});
