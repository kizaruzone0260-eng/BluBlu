/**
 * E2E stack: embedded Postgres (port 5455) + api server (port 3123, serving the
 * built web bundle) + seeded teacher. Playwright webServer launches this.
 *
 * Task 3 also creates a second database (klass_prod) for the DEPLOYED shape
 * (NODE_ENV=production + TRUST_PROXY=1 + PUBLIC_URL = its own page address). The process that
 * uses it is started by tests/zz9-prod-shape.spec.ts itself (scripts/prod-shape-api.mjs), not
 * here: production IGNORES the relaxed auth rate caps (by design, lib/prodConfig.ts) and the
 * suite logs in far more than 10 times a minute, so 3123 stays non-production for the rest.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { initUtf8Cluster } from '../../api/scripts/pg-init-utf8.mjs';
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const dataDir = path.join(ROOT, 'apps/e2e/e2edata');
const PORT = 3123;
const PROD_PORT = 3124; // the DEPLOYED shape: NODE_ENV=production + TRUST_PROXY=1
const PGPORT = 5455;

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
// Stale hand-off file: readers must wait for THIS run, not reuse the previous one.
try { rmSync(path.join(ROOT, 'apps/e2e/.stack.json'), { force: true }); } catch { /* none */ }

/**
 * One stack per dataDir (traced 2026-10-09). Both `taskkill /IM postgres.exe` below and
 * embedded-postgres' `pg.stop()` act on whatever postmaster owns `e2edata`, so two overlapping
 * runs destroy each other's database: the API then answers ECONNRESET and Playwright workers
 * abort with `code=3221226091` — nine different spec files lost one test each, files this task
 * never touched. Refuse to start while a live stack holds the lock.
 */
const lockFile = path.join(ROOT, 'apps/e2e/.e2e-stack.lock');
function liveHolder() {
  let pid;
  try {
    pid = Number(readFileSync(lockFile, 'utf8'));
  } catch { return null; } // no lock file — nobody is running
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try { process.kill(pid, 0); return pid; } catch (e) { return e?.code === 'EPERM' ? pid : null; }
}
const holder = liveHolder();
if (holder) {
  console.error(`[e2e-stack] another stack (pid ${holder}) owns ${dataDir} — wait for it, or delete ${lockFile} if it is a leftover`);
  process.exit(1);
}
writeFileSync(lockFile, String(process.pid));
process.on('exit', () => { try { rmSync(lockFile, { force: true }); } catch { /* none */ } });

// Windows: an orphaned postmaster from a failed run keeps the shm block; clear it.
if (process.platform === 'win32') {
  const { execSync } = await import('node:child_process');
  try { execSync('taskkill /IM postgres.exe /F', { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1500));
}

// e2e-only: hash the known test password with the api's own argon2id implementation
const { hashPassword } = await import(pathToFileURL(path.join(ROOT, 'apps/api/dist/lib/password.js')).href);
const teacherHash = await hashPassword('Passw0rd123');

const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'klass', password: 'klass', port: PGPORT, persistent: true,
});
const needInit = !existsSync(path.join(dataDir, 'PG_VERSION'));
if (needInit) {
  // WIN1251 default breaks oʻ/emoji writes — force UTF8 like production (§B fonts test)
  if (!await initUtf8Cluster(import.meta.url, dataDir)) await pg.initialise();
}
await pg.start();
try { await pg.createDatabase('klass'); } catch { /* exists */ }
try { await pg.createDatabase('klass_prod'); } catch { /* exists */ }
// the separate database for the production-shaped server (task 3) — see prodEnv below
try { await pg.createDatabase('klass_prod'); } catch { /* exists */ }

const url = `postgres://klass:klass@127.0.0.1:${PGPORT}/klass`;
const admin = postgres(url, { max: 2 });
const teacherId = '00000000-0000-4000-8000-00000000e2e1';

const api = spawn('node', ['dist/server.js'], {
  cwd: path.join(ROOT, 'apps/api'),
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATABASE_URL: url,
    WEB_DIST: path.join(ROOT, 'apps/web/dist'),
    STORAGE_DIR: path.join(ROOT, 'apps/e2e/files'),
    JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    // RTC e2e (camera.spec): when a real media server is available it is passed
    // via env (LIVEKIT_URL/API_KEY/API_SECRET/WS_URL); the defaults stay inert so
    // every other test only needs the token-issuing API, never a live room.
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? 'e2ekey',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? 'e2esecrete2esecrete2esecrete2esecret',
    LIVEKIT_WS_URL: process.env.LIVEKIT_WS_URL ?? 'ws://127.0.0.1:7880',
    ...(process.env.LIVEKIT_URL ? { LIVEKIT_URL: process.env.LIVEKIT_URL } : {}),
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
    TELEGRAM_TRANSPORT: 'log',
    PUBLIC_WEB_ORIGIN: `http://127.0.0.1:${PORT}`,
    // The suite logs in far more than a real user from one IP (127.0.0.1), so
    // relax the auth brute-force caps for e2e only. The HTTP rate-limit unit
    // test builds its own app (default caps) and is unaffected.
    RATE_LOGIN_MAX: '500',
    RATE_CODE_MAX: '500',
  },
});

// wait for health + migrations, then seed
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    up = res.ok;
  } catch { /* not yet */ }
}
if (!up) { console.error('api did not become healthy'); process.exit(1); }

const [t0] = await admin`select id from users limit 1`;
if (!t0) {
  await admin.unsafe(`
    insert into users (id, role, name, last_name, email, password_hash, locale, locale_explicit, tz, created_at, profile_completed_at)
    values ('${teacherId}', 'teacher', 'E2E Teacher', 'E2E', 'owner@e2e.io', '${teacherHash}', 'ru', true, 'Asia/Tashkent', now(), now())
    on conflict do nothing`);
}
// name-screen spec (task 2): accounts WITHOUT a completed name pair — they must
// hit the «Имя и фамилия» gate on first login. profile_completed_at stays NULL.
await admin.unsafe(`
  insert into users (role, name, last_name, email, password_hash, locale, tz, created_at)
  values ('teacher', 'Teacher', '', 'gate@e2e.io', '${teacherHash}', 'ru', 'Asia/Tashkent', now()),
         ('teacher', 'Shot', '', 'shot@e2e.io', '${teacherHash}', 'ru', 'Asia/Tashkent', now()),
         ('student', 'Старый', '', 'old@e2e.io', '${teacherHash}', 'ru', 'Asia/Tashkent', now()),
         ('student', 'Луп', '', 'loop@e2e.io', '${teacherHash}', 'ru', 'Asia/Tashkent', now())
  -- every column this fixture declares is reset, not just the two the test happens to read:
  -- leaving name stale is how a run inherits the previous run's «Гат»
  on conflict (email) do update set
    name = excluded.name, last_name = '', profile_completed_at = null,
    locale = 'ru', locale_explicit = false, tz = 'Asia/Tashkent'`);
// persistent e2edata across runs: the main teacher must ALWAYS be name-complete
// (every other spec logs in as them and expects the app, not the gate)
await admin.unsafe(`
  update users set last_name = 'E2E', profile_completed_at = coalesce(profile_completed_at, now())
  where email = 'owner@e2e.io'`);
// Legal gate (Phase 2): seed every boot-time fixture account as having accepted
// the current policy version, so specs that log in reach the app (and the name
// gate for the intentionally-incomplete accounts) instead of the policy gate.
// Accounts REGISTERED during a run accept via the register-step-2 checkbox.
await admin.unsafe(`
  insert into policy_acceptances (user_id, version, accepted_at)
  select id, '2026-10-06', now() from users
  on conflict (user_id) do update set version = '2026-10-06', accepted_at = now()`);
// The DEPLOYED-shape API (NODE_ENV=production) is NOT started here: it belongs to the single spec
// that needs it (tests/zz9-prod-shape.spec.ts → scripts/prod-shape-api.mjs). Two API processes with
// their own pg-boss workers for the whole suite cost enough CPU on a small dev box to push the
// timing-tight scheduled-post spec past its timeout.
writeFileSync(path.join(ROOT, 'apps/e2e/.stack.json'), JSON.stringify({
  port: PORT, teacherEmail: 'owner@e2e.io', teacherPassword: 'Passw0rd123',
  prodPort: PROD_PORT,
}));
console.log('[e2e-stack] ready on', PORT, '(deployed-shape api is started by zz9-prod-shape itself on', PROD_PORT, ')');

process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
async function shutdown() {
  api.kill();
  await pg.stop().catch(() => undefined);
  process.exit(0);
}
