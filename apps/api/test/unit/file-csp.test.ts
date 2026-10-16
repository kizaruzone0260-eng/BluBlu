/**
 * Часть C1 (2026-10-16): карта CSP для отдачи пользовательских файлов — чистая логика.
 *
 * Живые заголовки проверяет `phase1-uploads.test.ts` (он читает реальный ответ Fastify);
 * здесь — правило, по которому эти заголовки выбираются, на всех типах из белого списка
 * детектора и на том, чего в списке быть не может. Разделение не для количества тестов:
 * правило «инлайн без sandbox — только PDF» должно падать, если его кто-то расширит,
 * даже когда ни один маршрут ещё не тронут.
 */
import { describe, it, expect } from 'vitest';
import { isInlineSafe, fileCsp } from '../../src/lib/magic.js';

const SANDBOX = "sandbox; default-src 'none'";
const NO_INLINE_PREVIEW = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'text/javascript'];

describe('C1: какие типы можно показывать инлайн и какой CSP им ставится', () => {
  it('инлайн разрешён картинкам (кроме SVG), PDF, аудио, видео и тексту', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'video/mp4', 'text/plain', 'application/pdf']) {
      expect(isInlineSafe(m), m).toBe(true);
    }
    // документ OOXML — самый частый файл в классе: его скачивают, а не показывают
    expect(isInlineSafe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
  });

  it('типы, способные исполнять скрипт в документе, не инлайнятся никогда — и в верхнем регистре тоже', () => {
    for (const m of NO_INLINE_PREVIEW) {
      expect(isInlineSafe(m), m).toBe(false);
      expect(isInlineSafe(m.toUpperCase()), m).toBe(false);
    }
  });

  it('sandbox стоит на всех ответах, кроме инлайн-PDF', () => {
    expect(fileCsp('application/pdf', false)).toBe(SANDBOX);            // загрузка PDF
    expect(fileCsp('application/pdf', true)).toBe("default-src 'none'"); // просмотр PDF
    for (const m of ['image/png', 'text/plain', 'audio/mpeg', 'video/mp4']) {
      expect(fileCsp(m, true), m).toBe(SANDBOX);
      expect(fileCsp(m, false), m).toBe(SANDBOX);
    }
    // чужеродный тип, которого в белом списке нет, тоже уходит в sandbox
    expect(fileCsp('text/html', true)).toBe(SANDBOX);
  });

  it('ни один из вариантов не открывает ни script-src, ни same-origin', () => {
    for (const csp of [fileCsp('application/pdf', true), fileCsp('application/pdf', false), fileCsp('image/png', true)]) {
      expect(csp).not.toMatch(/script-src|unsafe|'self'/);
    }
  });
});
