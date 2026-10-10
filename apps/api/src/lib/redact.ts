/**
 * What is allowed to leave the process as text when something fails.
 *
 * An error message is the one string in this app that we do not control: postgres-js puts the
 * connection string in it, grammY puts the Bot API URL (which IS a token) in it, LiveKit's SDK
 * puts the server URL in it, and any of them can put a bearer token there. So every path that
 * prints or logs an exception goes through here first.
 *
 * The patterns are deliberately wide: a redaction list that only matches yesterday's exact format
 * is the bug we already had with the access log (a sanitizer that was correct and never called).
 * Values below are the shapes, not real credentials — see `test/unit/redact.test.ts`, which uses
 * fictitious ones only.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // postgres://user:pass@host:5432/db?sslmode=require   (and the postgresql:// spelling)
  [/postgres(?:ql)?:\/\/\S+/gi, 'postgres://[redacted]'],
  // ws://host and wss://host — a LiveKit address is configuration, not log content
  [/wss?:\/\/\S+/gi, 'ws://[redacted]'],
  // Authorization: Bearer …
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  // https://api.telegram.org/bot123456:AA…/sendMessage  → the URL carries the token
  [/\/bot\d+:[A-Za-z0-9_-]+/gi, '/bot[redacted]'],
  // a bare Telegram bot token: <digits>:<34 url-safe chars>
  [/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, 'bot[redacted]'],
  // …?password=x / &token=x / "token": "x"  (the separators and quotes of real config text vary)
  [/\b(password|pass|secret|token|api_?key|authorization)(["']?\s*[=:]\s*["']?)[^\s,&"'}]+/gi,
    '$1$2[redacted]'],
];

/** Any thrown value → a string with the credential shapes removed. */
export function redactSecrets(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : String(value ?? '');
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * What a boot line or a console warning is allowed to say about an exception: its class and its
 * code (`ECONNREFUSED`, `28P01`, `401`), never the message. The message is where the credential
 * lives, and at boot there is no log pipeline left to redact it with — this function is the
 * difference between "we hope the driver is quiet" and "we never print it".
 *
 * The chain matters more than it looks. Measured with drizzle over postgres-js on a fictitious
 * URL: the thrown object is a `DrizzleQueryError` whose `name` is the plain string "Error" and
 * whose message is `Failed query: <SQL>\nparams: <bound values>`; the network code (`ENOTFOUND`)
 * and the connection string are one level deeper, on `.cause`. So the class comes from the
 * constructor when `name` is useless, and codes are collected down the cause chain.
 */
export function describeError(err: unknown): string {
  // a thrown primitive has no class worth naming — say what it is and nothing more
  if (err === null || typeof err !== 'object') return typeof err;
  const codes = new Set<string>();
  let current: unknown = err;
  let className: string | undefined;
  for (let depth = 0; depth < 3 && current; depth++) {
    const e = current as {
      name?: string; constructor?: { name?: string }; code?: string | number; errno?: string | number;
      sqlstate?: string; status?: string | number; statusCode?: string | number;
      cause?: unknown; errors?: unknown;
    };
    if (!className) {
      // `name` wins when it says something (LiveKitError, PostgresError); drizzle's query error
      // leaves it as the plain "Error", so the constructor name is the fallback that carries the
      // information.
      const named = typeof e.name === 'string' && e.name !== '' && e.name !== 'Error' ? e.name : undefined;
      const ctor = typeof e.constructor?.name === 'string' && e.constructor.name !== 'Error'
        ? e.constructor.name : undefined;
      className = named ?? ctor;
    }
    for (const key of ['code', 'errno', 'sqlstate', 'status', 'statusCode'] as const) {
      const v = e[key];
      if (v !== undefined && v !== null && v !== '') codes.add(String(v));
    }
    // ECONNREFUSED usually hides inside an AggregateError; the child codes are the useful part
    if (Array.isArray(e.errors)) {
      for (const child of (e.errors as unknown[]).slice(0, 3)) {
        const c = (child as { code?: string | number })?.code;
        if (c !== undefined && c !== null) codes.add(String(c));
      }
    }
    current = e.cause;
  }
  const name = className ?? (err instanceof Error ? 'Error' : typeof err);
  return codes.size ? `${name} (${[...codes].join(', ')})` : name;
}

/**
 * A message that is safe for the log. Two things are removed, for two different reasons:
 *  - credential shapes (connection strings, tokens, bearer values) — see `SECRET_PATTERNS`;
 *  - everything after drizzle's `params:` marker. A `DrizzleQueryError` prints the failing query
 *    and then the BOUND VALUES, which in this app means email addresses, note text and chat
 *    bodies. The SQL is diagnosis; the parameters are somebody's data.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = typeof err === 'string'
    ? err
    : (err as { message?: string })?.message ?? String(err ?? '');
  const cut = raw.split(/\n?params:/i)[0];
  return redactSecrets(cut).trim();
}
