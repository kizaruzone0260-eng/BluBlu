/**
 * BluBlu demo launcher (docs/DEMO.md) — one command, no Docker, no Caddy:
 *
 *   pnpm demo            (from repo root; or: pnpm --filter @klass/api demo)
 *
 * Pipeline:
 *   1. embedded-postgres (MIT, same engine as integration tests) on port 5434,
 *      data in apps/api/.pgdata-demo (gitignored);
 *   2. cloudflared quick tunnel → public https://xxxx.trycloudflare.com
 *      (address printed large and injected into the API as PUBLIC_URL);
 *   3. API (tsx) with NODE_ENV=development serving the built web bundle
 *      (apps/web/dist — built on demand if missing) from the same origin;
 *   4. demo seed: teacher + student + class + materials + notes + calendar +
 *      a FRESH one-time invite code every run.
 *
 * Secrets live in the root .env (never committed); nothing secret is printed.
 * Ctrl+C stops tunnel, API and database.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));      // apps/api/scripts
const apiDir = path.join(here, '..');                            // apps/api
const repoRoot = path.join(apiDir, '..', '..');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist');

const args = new Set(process.argv.slice(2));
const noTunnel = args.has('--no-tunnel');
const rebuild = args.has('--rebuild');

const API_PORT = Number(process.env.DEMO_PORT ?? 3000);
const DB_PORT = 5434;

// ── .env (root) — parsed manually; real env vars win ─────────────────────────
function loadDotenv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}
const dotenv = loadDotenv(path.join(repoRoot, '.env'));
const cfg = (k, d = '') => process.env[k] ?? dotenv[k] ?? d;

if (!fs.existsSync(path.join(repoRoot, '.env'))) {
  console.log('[demo] ⚠ .env not found — copying .env.example → .env (fill LiveKit Cloud keys, item 7 of the demo task)');
  fs.copyFileSync(path.join(repoRoot, '.env.example'), path.join(repoRoot, '.env'));
}

const livekitUrl = cfg('LIVEKIT_URL');
if (!livekitUrl) {
  console.log('[demo] ⚠ LIVEKIT_URL is empty in .env — video will not connect (self-hosted LIVEKIT_WS_URL fallback: %s)', cfg('LIVEKIT_WS_URL', 'ws://localhost:7880'));
}

// ── Windows: clear orphaned postgres from a crashed previous run ─────────────
if (process.platform === 'win32') {
  try { execSync('taskkill /IM postgres.exe /F', { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1200));
}

// ── 1. database ──────────────────────────────────────────────────────────────
console.log('[demo] starting embedded PostgreSQL (port %d)…', DB_PORT);
const demoDataDir = path.join(apiDir, '.pgdata-demo');

/**
 * embedded-postgres.initialise() lets initdb pick the Windows ANSI codepage
 * (WIN1251 here) — emoji and any other non-ANSI characters then fail to insert.
 * Init the fresh cluster ourselves with the same native binary, forcing the
 * production encoding (UTF8). Falls back to the library default on any error.
 */
async function initUtf8Cluster(dataDir) {
  if (process.platform !== 'win32') return false;
  try {
    const reqApi = createRequire(import.meta.url);
    const reqNative = createRequire(reqApi.resolve('embedded-postgres'));
    const nativeEntry = reqNative.resolve('@embedded-postgres/windows-x64');
    const { initdb } = await import(pathToFileURL(nativeEntry).href);
    const pwFile = path.join(apiDir, '.pgdemo-pw.tmp');
    fs.writeFileSync(pwFile, 'klass');
    console.log('[demo] initialising UTF-8 data directory (first run, ~20s)…');
    execFileSync(initdb, [
      '-D', dataDir, '-U', 'klass', '-A', 'password', '--pwfile', pwFile,
      '--locale=C', '-E', 'UTF8',
    ], { stdio: 'inherit' });
    fs.rmSync(pwFile, { force: true });
    return true;
  } catch (e) {
    console.warn('[demo] UTF-8 initdb failed (%s) — falling back to embedded-postgres default', (e && e.message) || e);
    return false;
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: demoDataDir,
  user: 'klass', password: 'klass', port: DB_PORT, persistent: true,
});
if (!fs.existsSync(path.join(demoDataDir, 'PG_VERSION'))) {
  if (!await initUtf8Cluster(demoDataDir)) await pg.initialise();
}
await pg.start();
try { await pg.createDatabase('klass'); } catch { /* exists */ }
const DATABASE_URL = `postgres://klass:klass@127.0.0.1:${DB_PORT}/klass`;

const children = [];
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[demo] stopping…');
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  try { await pg.stop(); } catch { /* already stopped */ }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// ── 2. cloudflared quick tunnel ─────────────────────────────────────────────
function haveCloudflared() {
  try { execSync('cloudflared --version', { stdio: 'ignore' }); return true; } catch { return false; }
}
// the tunnel address is fresh on every run — it always wins over a stale
// PUBLIC_URL in .env; an explicit PUBLIC_URL in the real environment is honored.
let publicUrl = process.env.PUBLIC_URL ?? '';
let tunnel = null;
if (!noTunnel) {
  if (!haveCloudflared()) {
    console.log(`
[demo] cloudflared не найден в PATH. Установите (без админ-прав не обойтись для winget,
       либо скачайте cloudflared-windows-amd64.exe из GitHub Releases и положите в PATH):
           winget install --id Cloudflare.cloudflared -e
       Демо без туннеля: pnpm demo -- --no-tunnel (только localhost, видео всё равно через Cloud).
`);
    await shutdown(1);
  }
  console.log('[demo] starting Cloudflare quick tunnel → http://127.0.0.1:%d …', API_PORT);
  tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${API_PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(tunnel);
  tunnel.stdout.on('data', (b) => captureUrl(String(b)));
  tunnel.stderr.on('data', (b) => captureUrl(String(b)));
  tunnel.on('exit', (c) => { if (!shuttingDown) { console.error('[demo] cloudflared exited, code', c); void shutdown(1); } });
}
let captured = '';
function captureUrl(text) {
  captured += text;
  const m = captured.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !publicUrl) publicUrl = m[0];
}
if (!noTunnel) {
  const deadline = Date.now() + 60_000;
  while (!publicUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (!publicUrl) {
    console.error('[demo] tunnel URL not seen in 60s (check cloudflared output)');
    await shutdown(1);
  }
} else {
  publicUrl = `http://localhost:${API_PORT}`;
}

// ── web bundle ───────────────────────────────────────────────────────────────
if (rebuild || !fs.existsSync(path.join(webDist, 'index.html'))) {
  console.log('[demo] building web bundle (pnpm --filter @klass/web build)…');
  await new Promise((res) => {
    const b = spawn('pnpm', ['--filter', '@klass/web', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    b.on('exit', (c) => { if (c) { console.error('[demo] web build failed'); process.exit(1); } res(); });
  });
}

// ── 3. API (also serves the web bundle from the same origin) ─────────────────
const apiEnv = {
  ...process.env, ...dotenv,
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  DATABASE_URL,
  WEB_DIST: webDist,
  STORAGE_DIR: path.join(apiDir, '.demo-files'),
  PUBLIC_URL: publicUrl,
  // cloudflared is a reverse proxy → per-IP limits must read X-Forwarded-For
  TRUST_PROXY: '1',
  TELEGRAM_MODE: cfg('TELEGRAM_MODE', 'polling'),
};
// never let a stale test URL from the shell leak in
delete apiEnv.DATABASE_URL_TEST;
console.log('[demo] starting API on 127.0.0.1:%d (PUBLIC_URL=%s)…', API_PORT, publicUrl);
const api = spawn('pnpm', ['exec', 'tsx', 'src/server.ts'], { cwd: apiDir, env: apiEnv, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
children.push(api);
api.on('exit', (c) => { if (!shuttingDown) { console.error('[demo] API exited, code', c); void shutdown(1); } });

{
  let up = false;
  const deadline = Date.now() + 90_000;
  while (!up && Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health/live`);
      up = r.ok;
    } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) { console.error('[demo] API did not become healthy in 90s'); await shutdown(1); }
}

// ── 4. seed ──────────────────────────────────────────────────────────────────
console.log('[demo] seeding demo data…');
let seed = '';
try {
  seed = await new Promise((res, rej) => {
    const s = spawn('pnpm', ['exec', 'tsx', 'src/scripts/seed-demo.ts'], {
      cwd: apiDir, env: apiEnv, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32',
    });
    let out = '';
    s.stdout.on('data', (b) => { out += String(b); });
    s.on('exit', (c) => (c === 0 ? res(out) : rej(new Error(`seed exited ${c}`))));
  });
} catch (e) {
  console.error('[demo] seed failed:', e?.message ?? e, '— stopping (fix the seed and rerun)');
  await shutdown(1);
}
const demo = JSON.parse(seed.slice(seed.indexOf('{'), seed.lastIndexOf('}') + 1));

// ── banner ───────────────────────────────────────────────────────────────────
const line = '─'.repeat(64);
console.log(`
╭${line}╮
│  BLUBLU DEMO ONLINE${' '.repeat(45)}│
│  Адрес: ${publicUrl.padEnd(55)}│
╰${line}╯

  Учитель:   ${demo.teacherEmail}  /  ${demo.teacherPassword}   (база пустая — всё создаёте вживую)

  Сценарий показа: «Создать класс» → «+ Событие» → «Начать урок» → «Создать код» →
  ученик на другом устройстве: адрес выше → «Присоединиться» → код.
  Ctrl+C — остановить демо.
`);

// keep alive; children stream their own logs
await new Promise((res) => { api.on('exit', res); });
await shutdown(0);
