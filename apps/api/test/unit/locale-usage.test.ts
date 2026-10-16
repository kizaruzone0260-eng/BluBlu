import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ru from '@klass/shared/locales/ru.json';

/*
 * A5 (2026-10-16). Паритет трёх словарей держит `locale-keys.test.ts`, но он не знает, какие
 * ключи вообще существуют: опечатка в `t('lesson.miniTitle')` даёт человеку сырой ключ вместо
 * слова, и ровно так уже бывало (`lesson.screenShareFailed` печатался untranslated). Поэтому
 * проверяем НЕ функцию перевода, а её потребителей: каждый буквальный ключ из `apps/web` обязан
 * быть в словаре.
 */

// apps/api/test/unit → репозиторий: test(1) → api(2) → apps(3) → корень(4)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src');

function flat(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.add(key);
    else for (const inner of flat(v, key)) out.add(inner);
  }
  return out;
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/** `t('a.b')` — только буквальные ключи; шаблонные `t(\`a.${x}\`)` проверяются своими тестами. */
const LITERAL = /(?:^|[^\w$.])t\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi;

describe('каждый буквальный ключ перевода существует в словаре', () => {
  const keys = flat(ru);
  const missing: string[] = [];
  for (const file of sources(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(LITERAL)) {
      const key = m[1];
      // вызов с `defaultValue` обязан найти и отсутствующий ключ: это осознанный фолбэк, а не опечатка
      const tail = src.slice(m.index, m.index + 200);
      if (!keys.has(key) && !tail.includes('defaultValue')) {
        missing.push(`${key} ← ${file.replace(root, 'apps/web/src')}`);
      }
    }
  }

  it('в apps/web нет обращений к несуществующим ключам', () => {
    expect(missing).toEqual([]);
  });

  it('проверка не пустая: скан видит десятки ключей урока', () => {
    // отрицательный контроль по построению: если регэксп сломается, массив станет пустым,
    // и первый тест пройдёт «в пустоту» — поэтому число проверяется явно
    const lessonOnly = sources(join(root, 'pages'))
      .filter((f) => f.endsWith('Lesson.tsx'))
      .map((f) => readFileSync(f, 'utf8'))
      .reduce((n, src) => n + [...src.matchAll(LITERAL)].length, 0);
    expect(lessonOnly).toBeGreaterThan(20);
  });

  it('ключи мини-окна и возврата на месте', () => {
    for (const k of [
      'lesson.miniTitle', 'lesson.miniBack', 'lesson.miniCollapse', 'lesson.miniExpand',
      'lesson.miniNoVideo', 'lesson.endConfirm', 'lesson.rejoin', 'lesson.rejoinHint',
      'lesson.dupIdentity',
    ]) expect(keys.has(k), k).toBe(true);
  });
});
