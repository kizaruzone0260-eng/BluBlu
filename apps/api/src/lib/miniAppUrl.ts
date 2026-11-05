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
  const base = publicBase();
  if (!/^https:\/\//i.test(base)) return null;
  return `${base}/mini`;
}

/**
 * Task G.2 (2026-11-04): веб-дверь того же Mini App — `/web`.
 *
 * Она существует потому, что «уместна ли кнопка web_app» — свойство КЛИЕНТА, а не наш: Telegram
 * Desktop и Android её открывают, WebA/WebK — обычно да, сторонние клиенты и встроенные браузеры
 * моста не дают вовсе, и тогда нажатие на web_app не даёт человеку ничего. Обычный URL работает
 * везде: там, где нет моста, `/web` рисует ту же страницу с обычным входом BluBlu.
 *
 * HTTPS не требуется: это ссылка в тексте сообщения, а не `web_app`-кнопка. Поэтому ответ
 * возвращается всегда — иначе http-развёртывание (демо-туннель, школьный сервер) оставалось бы
 * вообще без двери, что и было прежним поведением.
 */
export function browserEntryUrl(): string {
  return `${publicBase()}/web`;
}

/** Есть ли смысл предлагать `web_app`-кнопку рядом со ссылкой. */
export function canOfferWebAppButton(): boolean {
  return miniAppUrl() !== null;
}

function publicBase(): string {
  return siteUrl().replace(/\/+$/, '');
}
