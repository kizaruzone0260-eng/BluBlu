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
 * Auth rate limits — three layers, sized for a school (task B, 2026-10-23).
 *
 * The old shape had ONE relevant number: 10 logins and 8 code attempts per MINUTE per IP.
 * A class logging in from the school Wi-Fi (or 30 phones on one carrier NAT) presents as one
 * IP, so students 11+ were refused by design — and refused with a body the interface could not
 * name, which is why they read «Something went wrong». The numbers below keep the brute-force
 * defence where it belongs (a credential) and move the shared-address ceiling above real
 * traffic. Production ALWAYS uses these values and ignores the env relaxations; non-production
 * may raise them (the e2e suite logs in far more than a real user does).
 *
 * The arithmetic, so it can be checked rather than trusted:
 *  • real class size assumed 30; requests per student in the worst realistic minute 3
 *    (check-code + register, or a login + a mistyped retry) ⇒ 90 requests;
 *  • shared-IP ceiling 120 per 10 MINUTES per auth route ⇒ 33 % headroom over 90, and still
 *    ~1 request every 5 s sustained minute after minute — no legitimate person needs more;
 *  • the same-IP budget is only reachable with ~40 successful actions per student, so it is a
 *    flood ceiling, not a brute-force ceiling;
 *  • brute force stays capped much lower, per credential: 5 failed CODE attempts per minute for
 *    one (IP + code) and 10 failed LOGIN attempts per minute for one (IP + email), each followed
 *    by the existing 15-minute block on that pair; plus 20 failed auth attempts of ANY kind per
 *    minute from one IP before that address is blocked for 15 minutes (credential-stuffing);
 *  • and per ACCOUNT the progressive Postgres lockout is untouched: 5 consecutive failures ⇒ 30 s
 *    doubling to a 15-minute cap. Successes never count toward any failure counter.
 */
export const PROD_LOGIN_MAX = 10;
export const PROD_CODE_MAX = 8;
/** Requests per IP per window on each auth route family (see the class-size arithmetic above). */
export const PROD_IP_WINDOW_MAX = 120;
/** The window `PROD_IP_WINDOW_MAX` is measured over — a minute would still wall a big class. */
export const PROD_IP_WINDOW_MS = 10 * 60_000;
export function effectiveLoginMax(nodeEnv: NodeEnv, rateLoginMax: number): number {
  return nodeEnv === 'production' ? PROD_LOGIN_MAX : Math.max(rateLoginMax, PROD_LOGIN_MAX);
}
export function effectiveCodeMax(nodeEnv: NodeEnv, rateCodeMax: number): number {
  return nodeEnv === 'production' ? PROD_CODE_MAX : Math.max(rateCodeMax, PROD_CODE_MAX);
}
export function effectiveIpWindowMax(nodeEnv: NodeEnv, rateIpMax: number): number {
  return nodeEnv === 'production' ? PROD_IP_WINDOW_MAX : Math.max(rateIpMax, PROD_IP_WINDOW_MAX);
}
/**
 * The window as milliseconds — @fastify/rate-limit takes a number of ms or a string like
 * `'10 minutes'`; one source for the number keeps the cap and the window from drifting apart.
 */
export function effectiveIpWindowMs(): number {
  return PROD_IP_WINDOW_MS;
}
/**
 * Failed auth attempts per minute from ONE address, of any kind, before that address is blocked
 * for 15 minutes (credential-stuffing). Successes never count, so a class signing in together
 * costs nothing here. Outside production the ceiling is much higher on purpose: the test and e2e
 * suites deliberately produce dozens of failures per minute from `127.0.0.1`.
 */
export const PROD_IP_FAILURE_MAX_PER_MIN = 20;
export const NON_PROD_IP_FAILURE_MAX_PER_MIN = 500;
export function effectiveIpFailMax(nodeEnv: NodeEnv, rateIpFailMax: number): number {
  return nodeEnv === 'production'
    ? PROD_IP_FAILURE_MAX_PER_MIN
    : Math.max(rateIpFailMax, NON_PROD_IP_FAILURE_MAX_PER_MIN);
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
  const strip = (s: string) => s.trim().replace(/\/+$/, '');
  if (opts.publicUrl.trim()) return strip(opts.publicUrl);
  // the DOMAIN branch must strip too: `DOMAIN=school.example/` used to produce
  // `https://school.example//webhook/telegram`, which Fastify does not route — the bot would
  // report a registered webhook while every update 404s.
  if (opts.domain?.trim()) return `https://${strip(opts.domain.replace(/^https?:\/\//, ''))}`;
  return '';
}

/**
 * The exact arguments `setWebhook` is called with, in one testable place.
 *
 * Why this is not left inline in server.ts: the webhook is the only credential in the product
 * that is registered by the app itself, and the Bot API never reports it back — `getWebhookInfo`
 * does not expose `secret_token`. So the only proof that deliveries are authenticated is THIS
 * object, and an inline literal could not be asserted on its final output. A missing secret or a
 * missing base returns null, which means "do not register at all" — never a webhook without a
 * secret.
 */
export function webhookRegistration(opts: {
  publicUrl: string; domain?: string; secret: string; mode: string; hasBot: boolean;
}): { url: string; secret_token: string; drop_pending_updates: false } | null {
  if (!opts.hasBot || opts.mode !== 'webhook') return null;
  const base = effectiveWebhookBase({ publicUrl: opts.publicUrl, domain: opts.domain });
  if (!base || !opts.secret) return null;
  return { url: `${base}/webhook/telegram`, secret_token: opts.secret, drop_pending_updates: false };
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
