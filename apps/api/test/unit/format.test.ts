import { describe, it, expect } from 'vitest';
import { appLocaleToIntl, fmtDate, fmtDateTime } from '../../../web/src/lib/format';

/** item 7 — deterministic date formatting for ru/uz/en (UTC so the host TZ can't drift). */
describe('date formatting (lib/format)', () => {
  const iso = '2026-10-04T10:30:00Z';

  it('maps app languages to day-first locales', () => {
    expect(appLocaleToIntl('ru')).toBe('ru-RU');
    expect(appLocaleToIntl('uz')).toBe('uz-Latn-UZ');
    expect(appLocaleToIntl('en')).toBe('en-GB');
  });

  it('ru: dd.mm.yyyy + 24h', () => {
    expect(fmtDate(iso, 'ru', 'UTC')).toBe('04.10.2026');
    expect(fmtDateTime(iso, 'ru', 'UTC')).toContain('04.10.2026');
    expect(fmtDateTime(iso, 'ru', 'UTC')).toContain('10:30');
  });

  it('uz and en also render the 4th of October as the 4th (no 11.10-style surprises)', () => {
    expect(fmtDate(iso, 'uz', 'UTC')).toBe('04/10/2026'); // uz-Latn uses slashes
    expect(fmtDate(iso, 'en', 'UTC')).toBe('04/10/2026');
  });

  it('never emits month>12 confusion: the day segment is 04 everywhere', () => {
    for (const l of ['ru', 'uz', 'en']) {
      const out = fmtDate(iso, l, 'UTC');
      expect(out).toMatch(/04/);
      expect(out.startsWith('11')).toBe(false);
    }
  });
});
