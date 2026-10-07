import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * Single source of truth for the "may this Origin drive our credentialed calls?"
 * gate — used by the refresh/logout CSRF check (routes/auth.ts) AND the WebSocket
 * upgrade gate (lib/wsOrigin.ts). Keeping ONE implementation is deliberate: the two
 * copies drifted once and it broke production (see HISTORY below).
 *
 * A request passes when EITHER:
 *  (1) its Origin is one of the explicitly configured deployment origins
 *      (PUBLIC_WEB_ORIGIN / PUBLIC_URL / https://DOMAIN, plus the dev vite origin), OR
 *  (2) its Origin is the very host the request arrived on (Origin.host === Host) —
 *      a genuinely same-origin call from the deployed page.
 *
 * (2) is not a weakening: for a cookie-authenticated cross-site request the attacker
 * needs the VICTIM'S BROWSER, and a browser sets both `Origin` (the initiator) and
 * `Host` (the URL it contacted) itself — page script can override neither. So
 * `Origin.host === Host` can only ever be true for a page served by this same host,
 * which is exactly the traffic we must not block. A raw-socket client that forges
 * `Host` gains nothing: it would already have to hold the victim's httpOnly cookie,
 * and a stolen token is a different (and already handled — rotation + reuse kill)
 * problem, not CSRF.
 *
 * HISTORY — why (2) must stay:
 *  • fe50ec8 "cloud lesson fix": added (2) after a LIVE Render incident — the page's
 *    own origin was not in env, refresh answered 403, the SPA dropped the access
 *    token and /lesson bounced to Sign In.
 *  • 9573faa "security(Phase1)": removed (2) whenever PUBLIC_URL/DOMAIN were set,
 *    which re-created the same incident on any deploy whose configured origin ≠ the
 *    host the UI is actually served from (e.g. PUBLIC_URL points at a tunnel/older
 *    address, or PUBLIC_WEB_ORIGIN was never set). Local dev, CI and e2e stayed
 *    green because they run with no PUBLIC_URL/DOMAIN, so (2) was still reachable.
 *  • The current gate keeps strict exact-matching as (1) and restores (2) as a
 *    same-origin fallback, so config drift can never log real users out again.
 */

/** Trim, drop trailing slashes and lowercase: `https://host/` must equal `https://host`. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * The origins the operator explicitly configured. In production the dev vite origin is
 * NOT part of the list (PUBLIC_WEB_ORIGIN defaults to empty there — see lib/prodConfig),
 * so a deployed app never accepts a localhost page. Duplicates collapse, because
 * PUBLIC_URL and PUBLIC_WEB_ORIGIN are the same address in the shipped shape (the API
 * serves the SPA).
 */
export function configuredOrigins(): string[] {
  return [...new Set([
    env.PUBLIC_WEB_ORIGIN,
    ...(env.PUBLIC_URL ? [env.PUBLIC_URL] : []),
    ...(env.DOMAIN ? [`https://${env.DOMAIN}`] : []),
  ].map(normalizeOrigin).filter((o) => o.length > 0))];
}

/**
 * Pure decision — no env, no request — so every branch is unit-testable.
 * `host` is the request's own Host header value (bare host[:port], no scheme).
 */
export function originAllowed(origin: string, host: string, configured: string[]): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  if (configured.includes(o)) return true;
  try {
    const u = new URL(o);
    const h = normalizeOrigin(host);
    // Only a real http(s) origin can be "same host", and only when we actually have
    // a Host to compare to: `about:blank` / `null` must never match an empty Host.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return h.length > 0 && u.host === h;
  } catch {
    return false; // malformed Origin ⇒ never trusted
  }
}

/**
 * Gate for credentialed POSTs (refresh/logout) and WS upgrades.
 * A missing Origin (curl, non-browser clients, fastify.inject tests) is allowed:
 * browsers always send it for POST/WS, and those endpoints carry their own real
 * gate (one-time ticket / rotating refresh token).
 *
 * Second layer (task 2б): `Sec-Fetch-Site` is a browser-managed header that cannot be
 * set by script. When a browser explicitly says the request came from a DIFFERENT site,
 * the request is refused even if its Origin happens to be on the allowlist — a cheap,
 * unforgeable cross-check against a mis-configured or over-wide allowlist. `same-site`
 * is deliberately not refused: our own deployment can legitimately be reached through a
 * sibling origin, and the refresh cookie is SameSite=Lax, which already blocks
 * cross-site POSTs from carrying it.
 */
export function requestOriginAllowed(req: FastifyRequest): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return originAllowed(origin, req.headers.host ?? '', configuredOrigins());
}

/**
 * Operator-facing summary, computed at boot and written to the log (task 2г).
 * Origins are public host names — nothing here is a secret, and no env VALUE is
 * echoed beyond the origin addresses themselves.
 */
export function originBootSummary(): { allowed: string[]; sameHostFallback: boolean; warnings: string[] } {
  const allowed = configuredOrigins();
  const warnings: string[] = [];
  if (!env.PUBLIC_URL && !env.DOMAIN) {
    warnings.push(
      'PUBLIC_URL and DOMAIN are both empty: only the request\'s own Host is trusted as an origin. ' +
      'Set PUBLIC_URL to the exact https address the UI is served from.',
    );
  }
  if (env.PUBLIC_URL && !/^https:\/\//i.test(env.PUBLIC_URL)) {
    warnings.push(`PUBLIC_URL is not an https origin ("${env.PUBLIC_URL}") — a real deployment must be https.`);
  }
  if (env.PUBLIC_URL?.trim().endsWith('/')) {
    warnings.push('PUBLIC_URL has a trailing slash; it is normalised for Origin checks but should be stored without one.');
  }
  if (env.NODE_ENV === 'production' && !env.PUBLIC_WEB_ORIGIN) {
    warnings.push('PUBLIC_WEB_ORIGIN is unset (production default is empty): notification links fall back to PUBLIC_URL/DOMAIN.');
  }
  return { allowed, sameHostFallback: true, warnings };
}
