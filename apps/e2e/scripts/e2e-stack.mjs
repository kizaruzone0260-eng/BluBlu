/**
 * E2E stack: embedded Postgres (port 5455) + api server (port 3123, serving the
 * built web bundle) + seeded teacher. Playwright webServer launches this.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { initUtf8Cluster } from '../../api/scripts/pg-init-utf8.mjs';
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const dataDir = path.join(ROOT, 'apps/e2e/e2edata');
const PORT = 3123;
const PGPORT = 5455;

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

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
    LIVEKIT_API_KEY: 'e2ekey',
    LIVEKIT_API_SECRET: 'e2esecrete2esecrete2esecrete2esecret',
    LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
    TELEGRAM_TRANSPORT: 'log',
    PUBLIC_WEB_ORIGIN: `http://127.0.0.1:${PORT}`,
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
    insert into users (id, role, name, email, password_hash, locale, tz, created_at)
    values ('${teacherId}', 'teacher', 'E2E Teacher', 'owner@e2e.io', '${teacherHash}', 'ru', 'Asia/Tashkent', now())
    on conflict do nothing`);
}
writeFileSync(path.join(ROOT, 'apps/e2e/.stack.json'), JSON.stringify({
  port: PORT, teacherEmail: 'owner@e2e.io', teacherPassword: 'Passw0rd123',
}));
console.log('[e2e-stack] ready on', PORT);

process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
async function shutdown() {
  api.kill();
  await pg.stop().catch(() => undefined);
  process.exit(0);
}
