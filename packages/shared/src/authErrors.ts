/**
 * Every error code the auth screens can be answered with (task B, 2026-10-23).
 *
 * One list, three users of it:
 *  • the API answers with one of these codes (`lib/requestId.errorBody` + the routes), and an
 *    unknown code is folded to `invalidInput` instead of leaking a library's own text;
 *  • the web layer translates `auth.<code>` and falls back to the generic sentence;
 *  • a unit test (`test/unit/locale-keys.test.ts`) fails if any code here has no key in ANY of
 *    the three locales — which is exactly how «Too Many Requests» ended up as a dead end for a
 *    whole class registering behind one school IP.
 *
 * `networkError` is client-only (fetch itself failed: offline, DNS, aborted) and `errorGeneric`
 * stays where it is (`common.errorGeneric`), so neither is a server code.
 *
 * `unauthorized` and `forbidden` are deliberately NOT here: they answer an expired session in the
 * background (the refresh call, a stale access token) and the app signs the person out quietly
 * rather than showing a red sentence for something they did not do.
 */
export const AUTH_ERROR_CODES = [
  // step 1 — class code, and the register call itself
  'invalidInput', 'invalidCode', 'emailTaken',
  // password policy (three distinct reasons, one screen)
  'passwordTooShort', 'passwordTooSimple', 'passwordTooCommon', 'passwordTooWeak', 'wrongPassword',
  'passwordChangeRequired', 'passwordsMismatch',
  // email confirmation (часть F)
  'emailCodeRequired', 'emailCodeInvalid', 'emailUnavailable', 'emailCooldown',
  // login and sessions
  'invalidCredentials',
  // limits — the two shapes differ on purpose: 429 from the shared-IP ceiling is a one-minute
  // wait, `codeRateLimited` is the credential-scoped block that lasts longer
  'tooManyRequests', 'codeRateLimited',
  // last resorts that must still say something useful
  'serverError', 'policyVersionStale',
] as const satisfies readonly string[];

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Client-side additions: a request that never reached the server at all. */
export const CLIENT_ERROR_CODES = ['networkError'] as const;

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && (AUTH_ERROR_CODES as readonly string[]).includes(value);
}

/** The i18n key of a code, in the flat `auth.*` namespace the screens already use. */
export function authErrorKey(code: string): string {
  return `auth.${isAuthErrorCode(code) ? code : 'invalidInput'}`;
}
