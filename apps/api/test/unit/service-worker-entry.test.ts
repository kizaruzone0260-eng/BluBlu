/**
 * Task G.2 (2026-11-04): service worker больше не может подменить точку входа.
 *
 * Проверка по исходнику, а не по поведению браузера, — ровно так же, как `date-time-field.test.ts`
 * читает исходники веба: тут важен НЕИЗМЫНЯЕМЫЙ инвариант, а не гадание по таймингам, и ломается
 * он именно текстом worker'а. Живое подтверждение (второй заход под управлением SW больше не даёт
 * `net::ERR_FAILED` на SDK) — в постановочном прогоне и в e2e-спеке `mini-mode.spec.ts`.
 *
 * Почему это вообще тест: прежний worker перехватывал ВСЕ GET, включая cross-origin
 * `telegram-web-app.js`. Перехват означал повторный запрос от имени SW, а CSP документа
 * (`connect-src 'self' blob:`) подключения к telegram.org не разрешает → запрос отклонялся →
 * `caches.match()` без копии → `respondWith(undefined)` → `net::ERR_FAILED` → экран «Telegram did
 * not load». Тот же механизм работал и на HTML-копиях: закешированный `/` со строгой политикой
 * мог пережить несколько деплоев, потому что имя кеша никогда не менялось.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const swPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/web/public/sw.js',
);
const src = readFileSync(swPath, 'utf8');

describe('G.2: точка входа не отдаётся из кеша', () => {
  it('навигации и документы не перехватываются', () => {
    expect(src).toMatch(/request\.mode\s*===\s*'navigate'/);
    expect(src).toMatch(/request\.destination\s*===\s*'document'/);
    // и precache документа тоже: addAll(['/']) — это и был «устаревший вход»
    expect(src).not.toMatch(/addAll\(/);
    expect(src).not.toMatch(/caches\.open\([^)]*\)\.then\(\s*\(?c\)?\s*=>\s*c\.put\(\s*'\/'/);
  });

  it('чужие домены не перехватываются — именно там умирал SDK', () => {
    expect(src).toMatch(/url\.origin\s*!==\s*self\.location\.origin/);
    // единственный fetch в worker'е — это повторение исходного запроса, а не новый адрес
    const fetches = src.match(/fetch\(/g) ?? [];
    expect(fetches).toHaveLength(1);
    expect(src).toMatch(/fetch\(request\)/);
  });

  it('API не кешируется (приватные ответы — никогда)', () => {
    expect(src).toMatch(/pathname\.startsWith\('\/api'\)/);
    expect(src).toMatch(/pathname\.startsWith\('\/webhook'\)/);
  });

  it('отказ сети не превращается в `respondWith(undefined)`', () => {
    // прежний `.catch(() => caches.match(...))` отдавал undefined при промахе — то есть ERR_FAILED
    expect(src).toMatch(/caches\.match\(request\)\.then\(\s*\(hit\)\s*=>\s*hit \?\? Response\.error\(\)/);
  });

  it('имя кеша поднято: копии прежнего воркера вычищаются при activate', () => {
    expect(src).toContain("klass-shell-v2");
    expect(src).toMatch(/keys\.filter\(\(k\) => k !== CACHE\)/);
  });

  it('размер кеша ограничен — один деплой не оставляет вечный мусор', () => {
    expect(src).toMatch(/MAX_ENTRIES/);
    expect(src).toMatch(/async function trim/);
  });
});
