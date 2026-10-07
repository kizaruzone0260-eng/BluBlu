/**
 * The production configuration matrix — every behaviour that changes with
 * `NODE_ENV === 'production'` or with the presence of a variable, in ONE place, as
 * pure functions.
 *
 * Why this file exists: the video-lesson outage was a production-only branch that no
 * local run could reach (dev/CI/e2e simply run with different env). Keeping the
 * branches here means each one is (a) listed in one place, (b) unit-testable in both
 * modes, and (c) covered again by test/integration/prod-config.test.ts against a
 * production-shaped app. When you add a production-only behaviour, add it here and
 * add its pair of assertions there — do not inline a new `if (NODE_ENV === …)`.
 */

export type NodeEnv = 'development' | 'test' | 'production';

/** The vite dev-server origin — a DEV convenience, never a production default. */
export const DEV_WEB_ORIGIN = 'http://localhost:5173';

/**
 * PUBLIC_WEB_ORIGIN: the origin the UI is opened from. In production an unset value
 * stays EMPTY (so localhost cannot silently enter the CORS list or the CSRF/WS Origin
 * allowlist); outside production it keeps the dev default for convenience.
 */
export function effectiveWebOrigin(configured: string | undefined, nodeEnv: NodeEnv): string {
  const value = (configured ?? '').trim();
  if (nodeEnv === 'production') return value;
  return value || DEV_WEB_ORIGIN;
}

/**
 * Refresh-reuse grace window (§4 + Part 4б). A browser that aborts a rotation response
 * replays the just-rotated token; without a grace window that trips the reuse-theft kill
 * and logs a real user out. Production is capped at 5 s (enough for a 3 s stalled
 * rotation, small blast radius); a non-production run may raise it for tests.
 */
export const PROD_REFRESH_GRACE_CEILING_MS = 5000;
export function effectiveRefreshGrace(ms: number, nodeEnv: NodeEnv): number {
  return nodeEnv === 'production' ? Math.min(ms, PROD_REFRESH_GRACE_CEILING_MS) : ms;
}

/**
 * Login / code-probe rate limits. Production ALWAYS uses the strict caps and IGNORES
 * the env relaxations — a deployment must not be able to loosen its own brute-force
 * defence by accident. Non-production runs (the e2e suite logs in far more than a real
 * user does) may raise them via RATE_LOGIN_MAX / RATE_CODE_MAX.
 */
export const PROD_LOGIN_MAX = 10;
export const PROD_CODE_MAX = 8;
export function effectiveLoginMax(nodeEnv: NodeEnv, rateLoginMax: number): number {
  return nodeEnv === 'production' ? PROD_LOGIN_MAX : rateLoginMax;
}
export function effectiveCodeMax(nodeEnv: NodeEnv, rateCodeMax: number): number {
  return nodeEnv === 'production' ? PROD_CODE_MAX : rateCodeMax;
}

/**
 * CORS allowlist. Same-origin is the shipped shape (the API serves the SPA bundle), so
 * production needs NO cross-origin entry unless the operator splits the deployment:
 * then it is exactly `https://DOMAIN` (and an explicit PUBLIC_WEB_ORIGIN is honoured
 * too, instead of being silently dropped — the previous behaviour ignored it in
 * production, so a split deployment could not authenticate at all).
 */
export function effectiveCorsOrigins(opts: {
  nodeEnv: NodeEnv; domain?: string; publicWebOrigin: string; publicUrl: string;
}): string[] {
  const { nodeEnv, domain, publicWebOrigin, publicUrl } = opts;
  if (nodeEnv !== 'production') {
    return [publicWebOrigin, ...(publicUrl ? [publicUrl] : [])].filter((o) => o.length > 0);
  }
  return [
    ...(domain ? [`https://${domain}`] : []),
    ...(publicWebOrigin ? [publicWebOrigin] : []),
  ];
}

/**
 * The refresh cookie. It is the one credential that must survive a page reload, so its
 * attributes are part of the auth flow, not decoration: `Secure` is mandatory in
 * production (a cloud deploy is https-only), and `SameSite=Lax` is what stops a
 * cross-site POST from carrying it at all.
 */
export function cookieIsSecure(nodeEnv: NodeEnv): boolean {
  return nodeEnv === 'production';
}

/**
 * The stage-0 LiveKit spike endpoints (`/api/rtc/*`) are a media-server smoke test, not
 * a product surface: they mint unrestricted tokens, so production must not expose them.
 */
export function rtcSpikeEnabled(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== 'production';
}

/**
 * The base every user-facing link is built from (Telegram messages, calendar and lesson
 * URLs): PUBLIC_URL → https://DOMAIN → PUBLIC_WEB_ORIGIN, trailing slash removed. An empty
 * result means the operator configured nothing: links degrade rather than sending a user to a
 * dev localhost, and the boot summary warns (task 2г).
 */
export function effectiveSiteBase(opts: { publicUrl: string; domain?: string; publicWebOrigin: string }): string {
  const strip = (s: string) => s.trim().replace(/\/+$/, '');
  if (opts.publicUrl.trim()) return strip(opts.publicUrl);
  if (opts.domain?.trim()) return `https://${strip(opts.domain).replace(/^https?:\/\//, '')}`;
  return strip(opts.publicWebOrigin);
}

/**
 * Telegram webhook registration base: PUBLIC_URL → https://DOMAIN → none. It deliberately
 * does NOT fall back to PUBLIC_WEB_ORIGIN: registering a webhook against a CSRF-only origin
 * (or a dev host) silently points the live bot somewhere that cannot receive it.
 */
export function effectiveWebhookBase(opts: { publicUrl: string; domain?: string }): string {
  if (opts.publicUrl.trim()) return opts.publicUrl.trim().replace(/\/+$/, '');
  if (opts.domain?.trim()) return `https://${opts.domain.trim().replace(/^https?:\/\//, '')}`;
  return '';
}

/**
 * LiveKit addressing. LIVEKIT_URL (Cloud / demo tunnel) overrides both the client WebSocket
 * and the server-side RoomService base; wss/ws map to https/http for the REST call.
 */
export function effectiveLiveKitWs(opts: { livekitUrl: string; livekitWsUrl: string }): string {
  return opts.livekitUrl || opts.livekitWsUrl;
}
export function effectiveLiveKitApiBase(opts: { livekitUrl: string; livekitInternalUrl: string }): string {
  const base = opts.livekitUrl || opts.livekitInternalUrl;
  return base.replace(/^wss/, 'https').replace(/^ws/, 'http');
}

/**
 * Secrets that must not stay at their shipped defaults in production. `env.ts` refuses to boot
 * on these; extracted so both branches are testable without spawning a process and without
 * ever echoing a value.
 */
export function productionSecretProblems(opts: {
  nodeEnv: NodeEnv;
  jwtSecret: string; devJwtSecret: string;
  livekitApiKey: string; devLiveKitKey: string;
  livekitApiSecret: string; devLiveKitSecret: string;
}): Array<{ path: string; message: string }> {
  if (opts.nodeEnv !== 'production') return [];
  const out: Array<{ path: string; message: string }> = [];
  if (opts.jwtSecret === opts.devJwtSecret) {
    out.push({ path: 'JWT_SECRET', message: 'JWT_SECRET must be set in production' });
  }
  if (opts.livekitApiSecret === opts.devLiveKitSecret || opts.livekitApiKey === opts.devLiveKitKey) {
    out.push({ path: 'LIVEKIT_API_KEY', message: 'LiveKit keys must be set in production' });
  }
  return out;
}

/**
 * Where versioned migrations are read from. Production runs the compiled image, everything
 * else the sources. Getting this wrong means the app boots and silently skips a migration, so
 * it is stated once and asserted in the real: the e2e stack starts a NODE_ENV=production
 * process against an EMPTY database (klass_prod), and the deployed-configuration spec can only
 * pass if that boot created the schema from dist/db/migrations.
 */
export function effectiveMigrationsFolder(nodeEnv: NodeEnv, cwd = process.cwd()): string {
  return nodeEnv === 'production'
    ? `${cwd}/dist/db/migrations`
    : `${cwd}/src/db/migrations`;
}
