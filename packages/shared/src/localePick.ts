import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from './constants.js';

/**
 * Which language a screen is shown in (task 1, 2026-10-08/09).
 *
 * The rule the task asks for is `profile (only if the user ever chose) > localStorage > en`.
 * It lives here, pure, because the bug was exactly this order being spread over three files:
 * `i18n.ts` fell back to 'ru', `App.tsx` applied the profile unconditionally, and the profile
 * itself said 'ru' for every account because registration never carried a choice.
 */
export interface LocaleSources {
  /** `users.locale` — what the account says */
  profileLocale?: string | null;
  /** `users.locale_explicit` — did this user ever pick a language themselves? */
  profileExplicit?: boolean | null;
  /** `localStorage.klass_locale` — a choice made on THIS device, before or after login */
  storedLocale?: string | null;
}

const known = (v: string | null | undefined): v is Locale =>
  typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);

/**
 * The language to apply, in the documented order. An un-explicit profile value is deliberately
 * ignored: it is the database default, not a decision anybody made, and honouring it is what
 * silently overwrote the user's own choice.
 */
export function resolveLocale(s: LocaleSources): Locale {
  if (s.profileExplicit && known(s.profileLocale)) return s.profileLocale;
  if (known(s.storedLocale)) return s.storedLocale;
  return DEFAULT_LOCALE;
}

/**
 * Should a device choice be pushed into the account? Only when the account has never had an
 * explicit choice of its own — otherwise the profile wins, per the order above, and writing it
 * back would let one browser silently change every other device.
 */
export function shouldCarryStoredChoice(s: LocaleSources): boolean {
  return !s.profileExplicit && known(s.storedLocale) && s.storedLocale !== s.profileLocale;
}
