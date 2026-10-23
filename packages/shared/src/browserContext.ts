/**
 * Where the app is actually being opened from (task B, 2026-10-23).
 *
 * The login/registration screens are opened inside Telegram's and Instagram's built-in browser
 * as often as in a real one, and those WebViews differ in one thing that matters here: the
 * refresh cookie. The session itself is fine while the page stays open (the access token is in
 * memory), but Safari ITP and several in-app browsers drop a first-party cookie after a while or
 * refuse to keep it across a reload — so the pupil is asked to sign in again, which reads exactly
 * like «the site is broken».
 *
 * Nothing here can fix a browser that will not store cookies. What it CAN do is say so in one
 * sentence, in three languages, with the address to open in a real browser. Both functions are
 * pure and take their input as an argument, which is what makes them unit-testable without a
 * browser.
 */

/** UAs of the in-app browsers pupils actually arrive from. Not a fingerprint — a label. */
const WEBVIEW_MARKERS = [
  'Telegram', 'Instagram', 'FBAN', 'FBAV', 'FacebookWebView', 'Twitter', 'Snapchat',
  'Line/', 'GoogleApp', 'MIC Messenger', 'UCBrowser', 'wv', // Android WebView marks itself «wv»
];

export function isLikelyWebView(userAgent: string): boolean {
  if (!userAgent) return false;
  return WEBVIEW_MARKERS.some((marker) => userAgent.includes(marker));
}

/**
 * Can this browser keep a cookie at all? `navigator.cookieEnabled` is optimistic in several
 * private modes, so a real write-and-read-back is the only honest answer. The caller supplies
 * both sides of the cookie jar (`read`/`write`), which keeps this function pure enough to test
 * without a document — in a browser they are `document.cookie` get/set, and a browser does
 * reflect a just-written cookie in the very next read.
 *
 * The probe carries no data about the person and is removed immediately.
 */
export function cookiesUsable(read: () => string, write: (next: string) => void): boolean {
  try {
    write('blublu-cookie-probe=1; path=/; samesite=lax; max-age=30');
    const ok = /blublu-cookie-probe=1/.test(read());
    write('blublu-cookie-probe=; path=/; max-age=0');
    return ok;
  } catch {
    return false;
  }
}

/** The live decision, with every input passed in so a test can supply its own browser. */
export function shouldSuggestBrowser(opts: {
  userAgent: string;
  cookieEnabled: boolean;
  read: () => string;
  write: (next: string) => void;
}): boolean {
  if (!isLikelyWebView(opts.userAgent)) return false;
  if (!opts.cookieEnabled) return true;
  return !cookiesUsable(opts.read, opts.write);
}
