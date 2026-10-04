import { describe, it, expect } from 'vitest';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

/** B.4 — i18n parity: RU/UZ/EN expose exactly the same key tree, no empty values. */
function flat(obj: unknown, prefix = ''): string[] {
  if (typeof obj === 'string') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => flat(v, prefix ? `${prefix}.${k}` : k));
}
function empties(obj: unknown, prefix = ''): string[] {
  if (typeof obj === 'string') return obj.trim() === '' ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => empties(v, prefix ? `${prefix}.${k}` : k));
}

describe('locale dictionaries parity (ru/uz/en)', () => {
  const keysRu = flat(ru).sort();
  const keysUz = flat(uz).sort();
  const keysEn = flat(en).sort();

  it('all three languages have the identical set of keys', () => {
    expect(keysUz).toEqual(keysRu);
    expect(keysEn).toEqual(keysRu);
  });

  it('no empty translation values', () => {
    expect(empties(ru)).toEqual([]);
    expect(empties(uz)).toEqual([]);
    expect(empties(en)).toEqual([]);
  });

  it('dictionaries are non-trivial (>100 keys)', () => {
    expect(keysRu.length).toBeGreaterThan(100);
  });
});
