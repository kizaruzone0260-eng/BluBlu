/**
 * Часть B (2026-10-17): разбор и форматирование полей даты и времени.
 *
 * Это чистые функции из `@klass/shared`, поэтому проверка без браузера возможна и нужна: поле
 * должно ПРИНИМАТЬ то, что показывает человек на своём языке, и ОТДАВАТЬ то же каноническое
 * значение, что отдавало нативное `datetime-local` (иначе поменялся бы и трафик на сервер).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addMonths, applyDayPick, dayLabel, dayNamesShort, formatDateFieldValue, intlTag, monthCells,
  monthLabel, monthNames, parseDateFieldValue, readFieldParts, todayParts,
} from '@klass/shared';

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

function rel(file: string): string {
  return file.slice(webSrc.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

/** комментарии вырезаются: сам компонент описывает в шапке, от чего он спасает, словами `type="date"` */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ok = (text: string, kind: 'date' | 'datetime' = 'datetime') => {
  const r = parseDateFieldValue(text, kind);
  if (!r.ok) throw new Error(`разбор должен был принять «${text}»: ${r.reason}`);
  return r.value;
};
const bad = (text: string, kind: 'date' | 'datetime' = 'datetime') => {
  const r = parseDateFieldValue(text, kind);
  if (r.ok) throw new Error(`разбор должен был отвергнуть «${text}»: ${r.value}`);
  return r.reason;
};

describe('разбор текста поля', () => {
  it('косая черта, точка и дефис — один и тот же порядок день-месяц-год', () => {
    expect(ok('20/10/2026 15:04')).toBe('2026-10-20T15:04');
    expect(ok('20.10.2026 15:04')).toBe('2026-10-20T15:04');
    expect(ok('20-10-2026 9:5')).toBe('2026-10-20T09:05');
  });

  it('канонический порядок тоже принимается: его подают форма и автоматизация', () => {
    expect(ok('2026-10-20T15:04')).toBe('2026-10-20T15:04');
    expect(ok('2026-10-20 15:04')).toBe('2026-10-20T15:04');
    expect(ok('2026-10-20', 'date')).toBe('2026-10-20');
    // отрицательный контроль к порядку: 21 — день, а не месяц (месяца с номером 21 не бывает,
    // и если разбор перепутает их местами, эта же строка упадёт с ошибкой дня)
    expect(ok('21.10.2026', 'date')).toBe('2026-10-21');
    expect(ok('21/12/2026 23:59')).toBe('2026-12-21T23:59');
  });

  it('поля только даты не требуют времени, поле со временем — требует', () => {
    expect(ok('05.03.2027', 'date')).toBe('2027-03-05');
    expect(bad('05.03.2027', 'datetime')).toBe('time');
    expect(bad('05.03.2027 25:10', 'datetime')).toBe('time');
    expect(bad('05.03.2027 12:61', 'datetime')).toBe('time');
  });

  it('несуществующие даты — это ошибка про день, а не про формат', () => {
    expect(bad('31.02.2026')).toBe('day');
    expect(bad('30.02.2027', 'date')).toBe('day');
    expect(bad('20.13.2026')).toBe('day');
    expect(bad('32.10.2026')).toBe('day');
    expect(bad('2026-02-30', 'date')).toBe('day');
  });

  it('мусор, пустота и двузначный год — ошибка формата с внятной причиной', () => {
    expect(bad('завтра')).toBe('format');
    expect(bad('20 10 26')).toBe('format');
    expect(bad('20.10.2026 15:04 extra')).toBe('format');
    expect(bad('', 'date')).toBe('empty');
    expect(bad('   ')).toBe('empty');
  });

  it('високосный год проходит, а невисокосный — нет', () => {
    expect(ok('29.02.2028', 'date')).toBe('2028-02-29');
    expect(bad('29.02.2027', 'date')).toBe('day');
  });
});

describe('форматирование значения на язык интерфейса', () => {
  it('порядок день-месяц-год и 24-часовое время во всех трёх языках', () => {
    expect(formatDateFieldValue('2026-10-20T15:04', 'en', 'datetime')).toBe('20/10/2026 15:04');
    expect(formatDateFieldValue('2026-10-20T15:04', 'ru', 'datetime')).toBe('20.10.2026 15:04');
    expect(formatDateFieldValue('2026-10-20T15:04', 'uz', 'datetime')).toBe('20.10.2026 15:04');
    expect(formatDateFieldValue('2026-10-20', 'ru', 'date')).toBe('20.10.2026');
    expect(formatDateFieldValue('2026-01-05T09:07', 'en', 'datetime')).toBe('05/01/2026 09:07');
  });

  it('пустое и нераспознанное значение не превращается в выдуманное', () => {
    expect(formatDateFieldValue('', 'ru', 'datetime')).toBe('');
    expect(formatDateFieldValue('later', 'ru', 'date')).toBe('later');
  });

  it('round trip: то, что показали, обратно разбирается в то же значение', () => {
    for (const lng of ['ru', 'en', 'uz']) {
      for (const v of ['2026-10-20T15:04', '2027-01-01T00:00', '2028-02-29T23:59']) {
        expect(ok(formatDateFieldValue(v, lng, 'datetime'))).toBe(v);
        const d = v.slice(0, 10);
        expect(ok(formatDateFieldValue(d, lng, 'date'), 'date')).toBe(d);
      }
    }
  });
});

describe('названия месяцев и дней — через Intl по языку интерфейса', () => {
  it('месяцев двенадцать, дней семь, и языки не подменяют друг друга', () => {
    expect(monthNames('en')).toHaveLength(12);
    expect(new Set(monthNames('ru')).size).toBe(12);
    expect(monthNames('en')[0]).toBe('January');
    expect(monthNames('ru')[0]).toBe('январь');
    expect(monthNames('uz')[0]).not.toBe(monthNames('en')[0]);
    // узбекская латиница: не кириллица и не пустая строка
    expect(monthNames('uz')[0]).toMatch(/^[A-Za-z]/);
  });

  it('неделя начинается с понедельника', () => {
    expect(dayNamesShort('en')[0]).toBe('Mon');
    expect(dayNamesShort('ru')[0]).toBe('пн');
    expect(dayNamesShort('uz')).toHaveLength(7);
    expect(dayNamesShort('uz')[0]).toMatch(/^[A-Za-z]/);
  });

  it('invariant сетки: номер строки соответствует дню недели этого дня', () => {
    for (const [y, m] of [[2026, 10], [2026, 11], [2027, 2], [2028, 2]] as const) {
      const cells = monthCells(y, m);
      expect(cells.length % 7).toBe(0);
      const days = cells.filter((c): c is number => c !== null);
      const last = new Date(y, m, 0).getDate();
      expect(days).toEqual(Array.from({ length: last }, (_, i) => i + 1));
      days.forEach((day, i) => {
        const index = cells.indexOf(day);
        const mondayBased = (new Date(y, m - 1, day).getDay() + 6) % 7;
        expect(index % 7, `${y}-${m}, день ${day}`).toBe(mondayBased);
        expect(i).toBe(day - 1);
      });
    }
  });

  it('месяцы считаются через границу года', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2027, 1, -1)).toEqual({ year: 2026, month: 12 });
    expect(addMonths(2026, 6, -18)).toEqual({ year: 2024, month: 12 });
  });

  it('подписи для экранного диктора на языке поля', () => {
    expect(monthLabel(2026, 10, 'ru')).toContain('2026');
    expect(monthLabel(2026, 10, 'ru').toLowerCase()).toContain('октябрь');
    expect(dayLabel(2026, 10, 20, 'en')).toContain('20');
    expect(dayLabel(2026, 10, 20, 'en')).toContain('October');
    expect(dayLabel(2026, 10, 20, 'ru')).toContain('октября');
  });
});

describe('выбор дня в календаре и привязка к языку', () => {
  it('время сохраняется, а у пустого поля становится нулевым и видимым', () => {
    expect(applyDayPick('2026-10-20T15:04', 2026, 11, 3, 'datetime')).toBe('2026-11-03T15:04');
    expect(applyDayPick('', 2026, 11, 3, 'datetime')).toBe('2026-11-03T00:00');
    expect(applyDayPick('2026-10-20T15:04', 2026, 11, 3, 'date')).toBe('2026-11-03');
    // и выбранное сразу проходит разбор — клетка не может выдать значение, который поле отвергнет
    expect(ok(applyDayPick('2026-10-20T15:04', 2027, 2, 28, 'datetime'))).toBe('2027-02-28T15:04');
  });

  it('части значения читаются, а у пустоты их нет', () => {
    expect(readFieldParts('2026-10-20T15:04')).toEqual({ year: 2026, month: 10, day: 20 });
    expect(readFieldParts('2026-10-20')).toEqual({ year: 2026, month: 10, day: 20 });
    expect(readFieldParts('')).toBeNull();
    expect(readFieldParts('20.10.2026')).toBeNull();
  });

  it('BCP-47: uz — латиница, en — британский (он даёт dd/mm и 24 часа), ru — русский', () => {
    expect(intlTag('uz')).toBe('uz-Latn');
    expect(intlTag('en')).toBe('en-GB');
    expect(intlTag('ru')).toBe('ru-RU');
    expect(intlTag('ru-RU')).toBe('ru-RU');
    expect(intlTag('de')).toBe('en-GB');   // неизвестный язык интерфейса → дефолт продукта
  });

  it('сегодняшнее значение разворачивается в корректное каноническое', () => {
    const t = todayParts();
    expect(monthCells(t.year, t.month)).toContain(t.day);
    expect(formatDateFieldValue(`${applyDayPick('', t.year, t.month, t.day, 'datetime')}`, 'ru', 'datetime'))
      .toContain(String(t.day).padStart(2, '0'));
  });
});

/**
 * «Заменить ВСЕ места» — проверяется по исходникам, а не по памяти автора правки. До части B этот
 * тест был красным на трёх файлах (`Calendar.tsx` — начало события и «повторять до», `MaterialNew.tsx` —
 * отложенная публикация), и красным он остаётся, если в приложение вернётся нативное поле.
 */
describe('нативных полей даты в приложении не осталось', () => {
  const files = sources(webSrc);
  const native = files
    .filter((f) => /type=["'](date|time|datetime-local)["']/.test(codeOnly(readFileSync(f, 'utf8'))))
    .map(rel);

  it('ни одного input type=date / type=time / datetime-local', () => {
    expect(native).toEqual([]);
  });

  it('скан не пустой: поля на DateTimeField он видит', () => {
    const used = files
      .filter((f) => readFileSync(f, 'utf8').includes('<DateTimeField'))
      .map(rel)
      .sort();
    // событие (начало и «повторять до»), отложенная публикация материала и срок в Mini App
    expect(used).toEqual(['pages/Calendar.tsx', 'pages/MaterialNew.tsx', 'pages/Mini.tsx']);
  });

  it('строки про «формат поля как в браузере» нет ни в коде, ни в словарях', () => {
    const dicts = ['ru', 'uz', 'en'].map((lng) => readFileSync(
      resolve(webSrc, '../../../packages/shared/src/locales', `${lng}.json`), 'utf8'));
    expect(dicts.join('').includes('dtFormatHint')).toBe(false);
    expect(files.some((f) => readFileSync(f, 'utf8').includes('dtFormatHint'))).toBe(false);
  });
});
