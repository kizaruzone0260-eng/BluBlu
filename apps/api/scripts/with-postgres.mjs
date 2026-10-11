/**
 * Dev/test helper (no admin, no Docker): runs a real PostgreSQL server via
 * embedded-postgres (MIT; server binaries under PostgreSQL License) on port 5433,
 * then executes the given command with DATABASE_URL_TEST set.
 *
 * Usage: node scripts/with-postgres.mjs vitest run
 */
import EmbeddedPostgres from 'embedded-postgres';
import { initUtf8Cluster } from './pg-init-utf8.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = process.cwd();
const dataDir = path.join(cwd, '.pgdata');

// Windows: a postmaster orphaned by a crashed previous run keeps the shared
// memory block; kill stale instances before starting ours.
if (process.platform === 'win32') {
  try { execSync('taskkill /IM postgres.exe /F', { stdio: 'ignore' }); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 1500));
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'klass',
  password: 'klass',
  port: 5433,
  persistent: true,
});

const needInit = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (needInit) {
  console.log('[with-postgres] initialise (first run)…');
  if (!await initUtf8Cluster(import.meta.url, dataDir)) await pg.initialise();
}
await pg.start();
try { await pg.createDatabase('klass'); } catch { /* exists */ }
console.log('[with-postgres] ready: postgres://klass:klass@127.0.0.1:5433/klass');

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.log('[with-postgres] no command given; server left running. Ctrl+C to stop.');
} else {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL_TEST: 'postgres://klass:klass@127.0.0.1:5433/klass' },
  });
  /*
   * Обёрка обязана отдать наружу ровно тот же исход, что у команды внутри. Прежний вариант
   * `process.exit(code ?? 0)` превращал смерть по сигналу в успех: у Node при этом code === null,
   * и весь API-набор получал exit 0, даже если vitest был убит извне. Второй дырой был
   * необработанный 'error': если команда не нашлась, 'exit' не приходит вовсе, и обёрка висела
   * с поднявшимся Postgres вместо того, чтобы упасть.
   */
  const finish = (code) => {
    pg.stop().finally(() => process.exit(code));
  };
  child.on('error', (e) => {
    console.error(`[with-postgres] не удалось запустить «${cmd}»: ${e.message}`);
    finish(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[with-postgres] команда умерла по сигналу ${signal} (code=${String(code)}) — это не успех`);
      finish(1);
      return;
    }
    finish(code === null ? 1 : code);
  });
}
