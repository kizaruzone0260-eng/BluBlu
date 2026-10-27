/*
 * 2026-10-27: алфавит, длина и сроки ВОСЬМИЗНАЧНОГО кода класса (INVITE_ALPHABET,
 * INVITE_CODE_LENGTH, INVITE_DEFAULT/MIN/MAX_TTL_DAYS) удалены вместе с самим способом приёма в
 * класс. Одноразовые ссылки-приглашения живут в `inviteLinks.ts` и своими числами
 * (`INVITE_LINK_TTL_DAYS`, `INVITE_LABEL_MAX`); `CODE_ATTEMPTS_PER_MIN` / `CODE_BLOCK_MINUTES`
 * остались, потому что это свойства привратника (`lib/throttle.ts`), а не кода: тем же числом
 * попыток мерится и перебор токена приглашения.
 */

/** Code entry: max 5 attempts per minute per account+IP, then block 15 minutes. */
export const CODE_ATTEMPTS_PER_MIN = 5;
export const CODE_BLOCK_MINUTES = 15;

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;

export const MAX_FILE_MB = 100;
export const TEACHER_QUOTA_GB = 5;
export const MAX_CLASS_PARTICIPANTS_V1 = 25;

export const DEFAULT_TIMEZONE = 'Asia/Tashkent';
export const SUPPORTED_LOCALES = ['ru', 'uz', 'en'] as const;

/**
 * Language (task 1, 2026-10-09). The product default is English: a visitor who never picked a
 * language gets English whatever `navigator.language` says, and so does an account whose owner
 * never picked one (`users.locale` defaults here, `users.locale_explicit` says whether the
 * choice was ever made). Russian and Uzbek stay fully available — they are just no longer the
 * silent fallback for someone who never asked for them.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Part A (2026-10-17): the ONE order in which a human is offered languages — everywhere a
 * language is pickable (sidebar menu, mobile bar, sign-in, registration, profile).
 *
 * It is deliberately NOT `SUPPORTED_LOCALES`: that array is the validation domain (its order
 * feeds `z.enum` and the `app_locale` enum), this one is presentation. `DEFAULT_LOCALE` stays
 * `'en'` and does not move to the front — the first row is the most prominent choice, not the
 * fallback for someone who never chose anything.
 */
export const LANGUAGE_CHOICES = [
  { code: 'uz', native: "Oʻzbekcha" },
  { code: 'en', native: 'English' },
  { code: 'ru', native: 'Русский' },
] as const satisfies readonly { readonly code: Locale; readonly native: string }[];

/**
 * Legal/consent (Hardening Phase 2). One version string covers the privacy
 * policy + terms bundle shown at registration and on first login. Bump it (and
 * the texts) whenever the legal documents change; every user is then asked to
 * re-accept ONCE on next login because their stored version differs.
 */
export const POLICY_VERSION = '2026-10-16';

/**
 * Product name shown to users. NOT translated (BluBlu in all three languages)
 * and NOT to be confused with internal identifiers (pnpm @klass/* packages,
 * the `klass` database, container/volume names, env vars, localStorage keys,
 * ICS event UIDs) which intentionally stay as they are.
 */
export const APP_NAME = 'BluBlu';

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type UserRole = 'teacher' | 'student';
