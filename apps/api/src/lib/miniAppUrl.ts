import { siteUrl } from '../services/notify.js';

/**
 * Task F (2026-10-28): the public Mini App entry.
 *
 * Telegram accepts a `web_app` button only for an HTTPS URL — it refuses to open a Mini App from
 * `http://`, and a refused button is worse than no button (the teacher taps and nothing happens).
 * So the URL is DERIVED from the same public base the rest of the bot links to (`siteUrl()`:
 * PUBLIC_URL → DOMAIN → dev origin) and returned only when that base is https. In local
 * development the base is usually http, and the bot then simply sends no button — the app itself
 * is still reachable at /mini, and the API answers `miniUnavailable` honestly.
 *
 * No env var of its own: a second place to configure the site's address is a second place to
 * get it wrong, and every other bot link already trusts `siteUrl()`.
 */
export function miniAppUrl(): string | null {
  const base = siteUrl().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  return `${base}/mini`;
}
