/**
 * The boot path, proven the same way as the access log: by the text the process actually prints.
 *
 * A failed connection is where the message is MOST likely to carry the connection string — measured
 * on a fictitious URL: postgres-js puts `postgres://user:pass@host/db` straight into `err.message`,
 * and drizzle wraps it in a `DrizzleQueryError` whose own message is the failing SQL plus its bound
 * parameters. At boot there is no logger left to redact that, so `main().catch` prints class and
 * code only. This test starts the real compiled server with a FICTITIOUS database URL (`.invalid`
 * is a reserved TLD that can never resolve; `fakepass` is not anybody's password) and reads output.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ENTRY = path.resolve('dist/server.js');
const FAKE_URL = 'postgres://klass:fakepass@db.invalid:5432/klass_boot_test';

function boot(url: string, extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // DELETED, not set to "": an empty TELEGRAM_MODE is a config error, and the point of this file
    // is to see the two different failure messages apart.
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'development', // the logger is on in development, exactly like a real boot
      DATABASE_URL: url,
      PORT: '0',
      ...extra,
    };
    for (const k of ['STORAGE_DIR', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_MODE', 'TELEGRAM_CHAT_ID']) delete env[k];
    const child = spawn(process.execPath, [ENTRY], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const kill = setTimeout(() => child.kill(), 25_000);
    child.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out: `spawn failed: ${e.message}` }); });
  });
}

const suite = existsSync(ENTRY) ? describe : describe.skip;

suite('boot failure output (task 5)', () => {
  it('refuses to print the connection string it could not use', async () => {
    const { out } = await boot(FAKE_URL);
    expect(out, 'the process says what failed, in words we chose').toContain('boot failed:');
    expect(out, 'the password never appears').not.toContain('fakepass');
    expect(out, 'nor the host it tried to reach').not.toContain('db.invalid');
    expect(out, 'the class and/or the code are there for the operator')
      .toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Error|Postgres|Drizzle|Aggregate/);
  }, 40_000);

  it('does not print a raw value it cannot parse either', async () => {
    const { out } = await boot('not-a-url-at-all');
    expect(out).toContain('boot failed:');
    expect(out, 'a malformed URL is echoed back no further than its class').not.toContain('not-a-url-at-all');
  }, 40_000);

  /*
   * The other crash that happens BEFORE main() runs: a rejected config. A ZodError carries the
   * offending input as `received`, so an unguarded `.parse` at import time would let Node's crash
   * printer put the operator's secret into the log. Only the NAMES of the failing keys may appear.
   */
  it('names a rejected config key without echoing its value', async () => {
    const FAKE_SECRET = 'short-fake-secret-do-not-print';
    const { out } = await boot(FAKE_URL, { JWT_SECRET: FAKE_SECRET });
    expect(out).toContain('config invalid');
    expect(out, 'the key is named, that is the diagnosis').toContain('JWT_SECRET');
    expect(out, 'the value is not').not.toContain(FAKE_SECRET);
    expect(out, 'and neither is the database URL from the same environment').not.toContain('fakepass');
  }, 40_000);
});
