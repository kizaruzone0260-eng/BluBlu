/**
 * Item 7 — one date/time formatter for the whole app.
 * Previously cells used bare toLocaleString(): the BROWSER locale decided the
 * format (10/04 vs 04.10 vs «11.10.2026» confusion) and it ignored the app
 * language. Now every visible date goes through these helpers with the active
 * i18n locale, in the device timezone.
 */
const LOCALE_MAP: Record<string, string> = {
  ru: 'ru-RU',
  uz: 'uz-Latn-UZ',
  en: 'en-GB', // day-first, 24 h — matches the platform's audience defaults
};

export function appLocaleToIntl(lang: string): string {
  return LOCALE_MAP[lang] ?? lang;
}

/** 'dd.mm.yyyy, чч:мм' style, localized by the APP language (not the browser one). */
export function fmtDateTime(iso: string | Date, lang: string, timeZone?: string): string {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(appLocaleToIntl(lang), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(new Date(iso));
}

export function fmtDate(iso: string | Date, lang: string, timeZone?: string): string {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(appLocaleToIntl(lang), {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz,
  }).format(new Date(iso));
}
