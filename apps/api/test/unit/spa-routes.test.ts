import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SPA_ROUTE_TEMPLATES, isSpaRoute, looksLikeStaticFile } from '../../src/lib/spaRoutes.js';

/*
 * LOW-07 (аудит 2026-10-28). Сервер отдавал оболочку с кодом 200 на любой не-API путь. Теперь
 * 200 получают только настоящие маршруты SPA. Список маршрутов не копируется вручную: тест
 * читает `App.tsx` и требует равенства — добавленный экран без записи в API-список сразу валит
 * проверку, а не превращается в «404 на рабочей ссылке» в проде.
 *
 * Гостевая страница урока (2026-10-28, часть 3) живёт вне `<Routes>` — ранним рендером до ворот
 * аккаунта, — поэтому её адрес объявлен в `STANDALONE_PATHS`. Читаются оба списка: и JSX-маршруты,
 * и константа, иначе `/guest` пришлось бы либо держать без серверной записи (404), либо
 * дублировать мёртвым `<Route>`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src');

function routePathsFromApp(): string[] {
  const src = readFileSync(resolve(root, 'App.tsx'), 'utf8');
  const routes = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!);
  const standalone = [...src.matchAll(/STANDALONE_PATHS\s*=\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((p) => p[1]!));
  return [...new Set([...routes, ...standalone].filter((p) => p !== '*'))].sort();
}

describe('SPA-маршруты и soft 404 (LOW-07)', () => {
  it('список API совпадает с маршрутами App.tsx', () => {
    expect([...SPA_ROUTE_TEMPLATES].sort()).toEqual(routePathsFromApp());
  });

  it('рабочие глубокие ссылки остаются 200-путями', () => {
    for (const p of [
      '/', '/privacy', '/terms', '/login', '/register', '/join',
      '/profile', '/notes', '/classes', '/classes/2f0c-aa', '/classes/2f0c-aa/archive',
      '/classes/2f0c-aa/material/new', '/calendar', '/lesson', '/sheets',
      '/chat', '/chat/9b1d', '/spike', '/guest', '/mini',
    ]) expect(isSpaRoute(p), p).toBe(true);
    // хвостовой слэш и регистр — как у React Router (caseSensitive по умолчанию false)
    expect(isSpaRoute('/profile/')).toBe(true);
    expect(isSpaRoute('/Profile')).toBe(true);
    expect(isSpaRoute('/chat/9b1d?x=1')).toBe(true);
  });

  it('неизвестные страницы и чужие пути — не SPA', () => {
    for (const p of [
      '/this-page-does-not-exist-xyz', '/admin', '/en', '/classes/abc/extra',
      '/classes/abc/material', '/api/me', '/webhook/telegram', '/assets/app.js',
    ]) expect(isSpaRoute(p), p).toBe(false);
  });

  it('файловые запросы отличаются от страниц, даже если у страницы есть точка', () => {
    for (const p of ['/assets/index-abc.js', '/index.js.map', '/fonts/inter.woff2', '/icon-192.png']) {
      expect(looksLikeStaticFile(p), p).toBe(true);
    }
    for (const p of ['/', '/classes/abc', '/this-page-does-not-exist-xyz', '/classes/a.b']) {
      expect(looksLikeStaticFile(p), p).toBe(false);
    }
  });
});
