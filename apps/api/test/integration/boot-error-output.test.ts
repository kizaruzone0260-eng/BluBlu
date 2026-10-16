/**
 * The two crash paths that have no logger in front of them — a failed boot and a rejection nobody
 * caught — proven the same way as the access log: by the text the process actually prints. Each test
 * starts a real process (`dist/server.js`, or `node -e` with the guards installed) and reads its
 * output; the last one starts a process WITHOUT the guards, which is the leak being prevented.
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
import { pathToFileURL } from 'node:url';

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

/**
 * A child process running an arbitrary script — the only honest way to test a process handler is
 * to make a process reject and read what it prints. `script` is evaluated by `node -e`, so it must
 * not contain anything but fictitious values.
 */
function runScript(script: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const kill = setTimeout(() => child.kill(), 20_000);
    child.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out: `spawn failed: ${e.message}` }); });
  });
}

const GUARDS = JSON.stringify(pathToFileURL(path.resolve('dist/lib/crashGuards.js')).href);
// one fictitious payload for both crash shapes: a connection string AND a bot token in the message
const BOOM = "Object.assign(new Error('connect postgres://user:fakepass@db.invalid:5432/db"
  + " via /bot123456789:AAfaketokenfaketokenfaketoken12/sendMessage'), { code: 'ECONNREFUSED' })";

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

  /*
   * Часть F (2026-10-16): половина конфигурации почты. Проверка та же, что у JWT: процесс обязан
   * назвать ОТСУТСТВУЮЩИЕ ключи и не напечатать то, что для них дали. `BREVO_API_KEY` и
   * `SMTP_PASS` — именно те значения, которые человек только что вставил в env и которые
   * обычно и есть чужой пароль.
   */
  it('a half-configured email provider names the keys and prints no values', async () => {
    const SMTP_USER = 'fictitious-smtp-user';
    const { out, code } = await boot(FAKE_URL, { EMAIL_PROVIDER: 'smtp', SMTP_USER });
    expect(code, 'такой конфиг не должен стартовать').not.toBe(0);
    expect(out).toContain('config invalid');
    for (const key of ['EMAIL_FROM', 'SMTP_HOST', 'SMTP_PASS']) {
      expect(out, `ключ ${key} назван`).toContain(key);
    }
    expect(out, 'значение не печатается').not.toContain(SMTP_USER);
    expect(out).not.toContain('fakepass');
  }, 40_000);

  it('brevo без ключа и resend без ключа — те же отказ и те же имена', async () => {
    const BRE = await boot(FAKE_URL, { EMAIL_PROVIDER: 'brevo', EMAIL_FROM: 'noreply@x.io' });
    expect(BRE.out).toContain('BREVO_API_KEY');
    const RES = await boot(FAKE_URL, { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'noreply@x.io' });
    expect(RES.out).toContain('RESEND_API_KEY');
  }, 80_000);

  /*
   * The crash guards themselves, in a real process: install them, reject with a message that holds
   * a fictitious connection string and a fictitious bot token, and read what the process prints.
   */
  it('an unhandled rejection prints class and code, and the process still dies', async () => {
    const { code, out } = await runScript(
      `import(${GUARDS}).then((m) => { m.installCrashGuards(); Promise.reject(${BOOM}); });`);
    expect(out).toContain('unhandled rejection: Error (ECONNREFUSED)');
    expect(out).not.toContain('fakepass');
    expect(out).not.toContain('db.invalid');
    expect(out).not.toContain('AAfaketokenfaketokenfaketoken12');
    expect(code, 'Node’s own semantics are kept: a rejection ends the process').not.toBe(0);
  }, 40_000);

  it('an uncaught exception prints class and code, not the query parameters', async () => {
    const { code, out } = await runScript(
      `import(${GUARDS}).then((m) => { m.installCrashGuards();`
      + ` setTimeout(() => { throw ${BOOM}; }, 0); });`);
    expect(out).toContain('uncaught exception: Error (ECONNREFUSED)');
    expect(out).not.toContain('fakepass');
    expect(out).not.toContain('AAfaketokenfaketokenfaketoken12');
    expect(code).not.toBe(0);
  }, 40_000);

  /**
   * The "before" of the same experiment, kept as a test on purpose: without the guards Node prints
   * the message and the stack itself. If anybody ever removes `installCrashGuards()`, this is the
   * line that shows what the leak actually looks like — and the two tests above go red with it.
   */
  it('without the guards Node prints the message and the stack (the leak being prevented)', async () => {
    const { code, out } = await runScript(`Promise.reject(${BOOM});`);
    expect(out).toContain('fakepass');
    expect(out).toContain('AAfaketokenfaketokenfaketoken12');
    expect(out).not.toContain('unhandled rejection: Error (ECONNREFUSED)');
    expect(code).not.toBe(0);
  }, 40_000);
});
