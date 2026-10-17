/**
 * Часть B (2026-10-17): поля даты и времени на языке интерфейса.
 *
 * Нативный `type="datetime-local"` рисует ФОРМАТ БРАУЗЕРА: на одном аккаунте то `10/20/2026`,
 * то `20.10.2026`, и подпись «формат поля — как в браузере» была признанием этого, а не решением. Здесь
 * разбор и форматирование вынесены в чистые функции — их видно юнит-тестами на трёх языках без
 * браузера, а компонент остаётся тонкой обёрткой над ними.
 *
 * Формат ЗНАЧЕНИЯ не изменился: `YYYY-MM-DD` и `YYYY-MM-DDTHH:mm` (местное время устройства) —
 * ровно то, что лежало в нативном поле и что уходит на сервер. Поэтому же разбор терпит и
 * канонический порядок (год-месяц-день), который передают существующие вызывающие места и
 * автоматизация: `2026-10-20T15:04` — корректное значение, а не ошибка.
 */
import { DEFAULT_LOCALE, type Locale } from './constants.js';

export type DateFieldKind = 'date' | 'datetime';

/** `'format'` — не похоже на дату; `'day'` — такой даты не бывает; `'time'` — нет или не годится время. */
export type DateFieldError = 'format' | 'day' | 'time';

export type DateFieldParse =
  | { ok: true; value: string }
  | { ok: false; reason: DateFieldError | 'empty' };

/** BCP-47: узбекский — латиница, английский — британский (он даёт и `dd/mm`, и 24 часа). */
const TAG: Record<Locale, string> = { uz: 'uz-Latn', en: 'en-GB', ru: 'ru-RU' };
/** Разделители даты: en — косая черта, ru и uz — точка (совпадают с подсказками формата). */
const SEPARATOR: Record<Locale, string> = { uz: '.', en: '/', ru: '.' };

function localeOf(language: string): Locale {
  const two = (language ?? '').slice(0, 2).toLowerCase();
  return two === 'uz' || two === 'ru' || two === 'en' ? two : DEFAULT_LOCALE;
}

export function intlTag(language: string): string {
  return TAG[localeOf(language)];
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Полные названия месяцев, январь → декабрь, на языке интерфейса. */
export function monthNames(language: string): string[] {
  const f = new Intl.DateTimeFormat(intlTag(language), { month: 'long' });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(2024, i, 15)));
}

/** Короткие названия дней недели, ПОНЕДЕЛЬНИК первый — как неделя во всём продукте. */
export function dayNamesShort(language: string): string[] {
  const f = new Intl.DateTimeFormat(intlTag(language), { weekday: 'short' });
  // 2024-09-09 — понедельник
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 8, 9 + i)));
}

const CANON = /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})(?:T(?<hh>\d{2}):(?<mm>\d{2}))?$/;
/**
 * То, что печатает человек: `дд.мм.гггг[ чч:мм]`, через точку, слэш или дефис, и то же в каноническом
 * порядке (`2026-10-20`, `2026-10-20T15:04`) — его приносят существующие места формы и Playwright.
 */
const LOOSE = /^(?<a>\d{1,4})[.\/\- ](?<b>\d{1,2})[.\/\- ](?<c>\d{1,4})(?:[ T]+(?<h>\d{1,2})(?::(?<mi>\d{1,2}))?)?$/;

/** Каноническое значение → текст на языке интерфейса. Нераспознанное возвращается как есть: поле не должно молчать. */
export function formatDateFieldValue(value: string, language: string, kind: DateFieldKind): string {
  if (!value) return '';
  const g = CANON.exec(value)?.groups;
  if (!g?.y || !g.m || !g.d) return value;
  const date = `${g.d}${SEPARATOR[localeOf(language)]}${g.m}${SEPARATOR[localeOf(language)]}${g.y}`;
  if (kind === 'date' || !g.hh || !g.mm) return date;
  return `${date} ${g.hh}:${g.mm}`;
}

/** Текст поля → каноническое значение. Пустая строка — `'empty'` (обязательность поля решает вызывающий код). */
export function parseDateFieldValue(text: string, kind: DateFieldKind): DateFieldParse {
  const s = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { ok: false, reason: 'empty' };
  const g = LOOSE.exec(s)?.groups;
  if (!g?.a || !g.b || !g.c) return { ok: false, reason: 'format' };
  const isoFirst = g.a.length === 4;
  const year = Number(isoFirst ? g.a : g.c);
  const month = Number(g.b);
  const day = Number(isoFirst ? g.c : g.a);
  if (!Number.isInteger(year) || year < 1000 || year > 2999) return { ok: false, reason: 'format' };
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: 'day' };
  }
  // 31.02 и 30.02 — не ошибка формата, а дата, которой нет: это разные подсказки человеку
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { ok: false, reason: 'day' };
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (kind === 'date') return { ok: true, value: date };
  if (!g.h) return { ok: false, reason: 'time' };
  const hour = Number(g.h);
  const minute = g.mi === undefined ? 0 : Number(g.mi);
  if (hour > 23 || minute > 59) return { ok: false, reason: 'time' };
  return { ok: true, value: `${date}T${pad(hour)}:${pad(minute)}` };
}

/** Ячейки месяца: `null` — пустое место до первого дня и после последнего, неделя с понедельника. */
export function monthCells(year: number, month: number): (number | null)[] {
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7;   // getDay(): 0 — воскресенье
  const days = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 };
}

export function todayParts(now = new Date()): { year: number; month: number; day: number } {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** Части канонического значения — чтобы календарь открылся на месяце поля, а не на сегодняшнем. */
export function readFieldParts(value: string): { year: number; month: number; day: number } | null {
  const g = CANON.exec(value || '')?.groups;
  if (!g?.y || !g.m || !g.d) return null;
  return { year: Number(g.y), month: Number(g.m), day: Number(g.d) };
}

/** Выбор дня в календаре: дата берётся из клетки, время — из текущего значения. Для `datetime` без
 * времени получается `00:00`: поле показывает его явно, и человек видит, что время ещё не выбрано.
 */
export function applyDayPick(value: string, year: number, month: number, day: number, kind: DateFieldKind): string {
  const g = CANON.exec(value || '')?.groups;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (kind === 'date') return date;
  return g?.hh && g.mm ? `${date}T${g.hh}:${g.mm}` : `${date}T00:00`;
}

/** Подпись клетки для экранного диктора: «Пятница, 20 октября 2026» на языке интерфейса. */
export function dayLabel(year: number, month: number, day: number, language: string): string {
  return new Intl.DateTimeFormat(intlTag(language), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

/** Заголовок открытого месяца: «октябрь 2026». */
export function monthLabel(year: number, month: number, language: string): string {
  const names = monthNames(language);
  return `${names[month - 1]} ${year}`;
}
