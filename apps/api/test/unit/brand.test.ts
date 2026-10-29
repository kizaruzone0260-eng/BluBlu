import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';
import { APP_NAME } from '@klass/shared';

/**
 * Brand guard (rebrand task): the product name shown to users is BluBlu and it
 * comes from ONE constant. The word «Klass» must not survive in user-visible
 * sources: locale dictionaries and the built HTML. Internal identifiers
 * (@klass/* packages, `klass` DB, container/env names, localStorage keys,
 * ICS UIDs "@klass") intentionally keep the old name.
 */
describe('brand: BluBlu everywhere the user can see', () => {
  it('shared constant is the single source', () => {
    expect(APP_NAME).toBe('BluBlu');
  });

  it('dictionaries carry the brand unchanged and never say «Klass»', () => {
    for (const dict of [ru, uz, en]) {
      expect(dict.app.name).toBe('BluBlu');
      expect(JSON.stringify(dict)).not.toMatch(/Klass/);
    }
  });

  const distIndex = path.resolve('../web/dist/index.html');
  const built = fs.existsSync(distIndex);
  it(built ? 'built index.html has no «Klass»' : 'web dist not built — HTML check skipped', () => {
    if (!built) return; // `pnpm -r build` runs before tests in CI; keep this honest, not noisy
    const html = fs.readFileSync(distIndex, 'utf8');
    expect(html).not.toMatch(/Klass/);
  });

  it('manifest and favicon ship the brand', () => {
    const manifest = JSON.parse(fs.readFileSync('../web/public/manifest.webmanifest', 'utf8'));
    expect(manifest.name).toBe('BluBlu');
    expect(manifest.short_name).toBe('BluBlu');
    expect(fs.existsSync('../web/public/favicon.svg')).toBe(true);
  });

  it('iOS gets a real home-screen icon, not a page snapshot', () => {
    // аудит 2026-10-28, пункт 14: без apple-touch-icon «На экран Домой» рисует снимок страницы
    const html = fs.readFileSync('../web/index.html', 'utf8');
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/icon-192\.png"/);
    expect(fs.existsSync('../web/public/icon-192.png')).toBe(true);
  });

  it('noindex is said by three switches at once: meta, header, robots.txt', () => {
    // пункт 7 аудита: тело robots.txt не сверялось ни одним тестом — набор из трёх
    // независимых запретов должен ломаться заметно; заголовок проверяет phase1-headers.
    const html = fs.readFileSync('../web/index.html', 'utf8');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" \/>/);
    const robots = fs.readFileSync('../web/public/robots.txt', 'utf8');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Disallow: \/$/m);
  });
});
