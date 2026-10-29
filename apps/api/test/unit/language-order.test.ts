/**
 * Часть A (2026-10-17): порядок языков один, и он один везде.
 *
 * Раньше список был написан вручную в двух местах (`Nav.tsx` для меню и `Profile.tsx` для
 * селекта) и оба в порядке `ru, uz, en`. Требуется `Oʻzbekcha, English, Русский`, поэтому
 * порядок вынесен в `LANGUAGE_CHOICES` в shared, а здесь проверяется и сам порядок, и то, что
 * ни один переключатель не остался с собственным списком: второй пункт — отрицательный контроль,
 * он падает ровно тогда, когда кто-то снова впишет родные названия в компонент.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LANGUAGE_CHOICES, SUPPORTED_LOCALES } from '@klass/shared';

// apps/api/test/unit → репозиторий: test(1) → api(2) → apps(3) → корень(4)
const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src');

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/** комментарии вырезаются: в них по-русски пишут и «Русский», и «English», а список — только код */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** путь от apps/web/src вперёд, в прямо́й косой черте — чтобы ожидаемое в тесте не зависело от Windows */
function rel(file: string): string {
  return file.slice(webSrc.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

describe('языки: один порядок и один источник (часть A)', () => {
  const codes = LANGUAGE_CHOICES.map((l) => l.code);
  const natives = LANGUAGE_CHOICES.map((l) => l.native);

  it('порядок — Oʻzbekcha, English, Русский', () => {
    expect(codes).toEqual(['uz', 'en', 'ru']);
    expect(natives).toEqual(["Oʻzbekcha", 'English', 'Русский']);
  });

  it('каждый поддерживаемый язык предлагается ровно один раз', () => {
    expect(codes.length).toBe(SUPPORTED_LOCALES.length);
    expect([...codes].sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('значение по умолчанию осталось английским и оно в списке', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(codes).toContain(DEFAULT_LOCALE);
    // первая строка меню — это видность, а не фолбэк: английский сознательно второй
    expect(codes[0]).not.toBe(DEFAULT_LOCALE);
  });

  it('подписи непустые и не повторяются', () => {
    for (const n of natives) expect(n.trim(), n).toBe(n);
    expect(new Set(natives).size).toBe(natives.length);
  });

  it('ни один компонент не держит свой список языков', () => {
    const hard: string[] = [];
    for (const file of sources(webSrc)) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      for (const label of natives) {
        if (src.includes(`'${label}'`) || src.includes(`"${label}"`) || src.includes(`>${label}<`)) {
          hard.push(`${rel(file)} ← ${label}`);
        }
      }
    }
    expect(hard).toEqual([]);
  });

  it('переключатели читают именно константу', () => {
    const users = sources(webSrc)
      .filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('LANGUAGE_CHOICES'))
      .map(rel)
      .sort();
    // сайдбар + мобильная шапка + входы/регистрация идут через Nav, профиль — своим селектом,
    // а переключатель Mini App (Task G) — тем же списком из shared, а не своей копией
    expect(users).toEqual(['components/Nav.tsx', 'pages/Profile.tsx', 'pages/mini/controls.tsx']);
  });
});
