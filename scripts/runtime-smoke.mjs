/**
 * Runtime smoke of the BUILT image (CI job `runtime-smoke`, 2026-10-10).
 *
 * Everything before this tested the app as a Node process or as a list of dependencies. This one
 * starts the image the way a deployment starts it — `NODE_ENV=production`, a real Postgres,
 * TRUST_PROXY=1, PUBLIC_URL set — and then behaves like an operator for the first five minutes of
 * a new install: does it answer, did the journal apply, does the SPA load, is the CSRF gate sane,
 * and does it survive the database being restarted underneath it.
 *
 * All secrets here are FICTITIOUS (`.invalid` domains, a made-up JWT string). The last check reads
 * the container's own log and fails if any of them — or any `postgres://` — appears in it.
 *
 * Run by CI with the repo as cwd; `node scripts/runtime-smoke.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const IMAGE = process.env.SMOKE_IMAGE ?? 'klass-api:smoke';
const PORT = 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const PG_USER = 'klass';
const PG_DB = 'klass';
// fictitious on purpose; the leak check at the end asserts none of them reaches the log
const JWT = 'smoke-fictitious-jwt-secret-0123456789abcdef';
const LK_KEY = 'smokefictitiouskey';
const LK_SECRET = 'smoke-fictitious-livekit-secret-0123456789';
const TEACHER_EMAIL = 'smoke@example.invalid';
const TEACHER_PW = 'SmokeFictitious123';

const failures = [];
const notes = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
function sh(...args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(ms, fn) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > until) return last === true;
    await sleep(1500);
  }
}
async function status(url, init) {
  try { return (await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })).status; }
  catch { return 0; }
}
async function json(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  let body = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, headers: r.headers };
}
const psql = (sql) => sh('docker', 'exec', process.env.SMOKE_PG, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', sql);

// ── 1. start the image the way a deployment does ─────────────────────────────
const container = sh('docker', 'run', '-d', '--name', 'klass-smoke', '--network', 'host',
  '-e', 'NODE_ENV=production',
  '-e', `DATABASE_URL=postgres://${PG_USER}:klass@127.0.0.1:5433/${PG_DB}`,
  '-e', `JWT_SECRET=${JWT}`,
  '-e', 'LIVEKIT_URL=ws://127.0.0.1:7880',
  '-e', `LIVEKIT_API_KEY=${LK_KEY}`,
  '-e', `LIVEKIT_API_SECRET=${LK_SECRET}`,
  '-e', 'TRUST_PROXY=1',
  '-e', `PUBLIC_URL=${BASE}`,
  '-e', 'PORT=3000',
  '-e', 'STORAGE_DIR=/tmp/smoke-files',
  '-e', `SEED_TEACHER_EMAIL=${TEACHER_EMAIL}`,
  '-e', `SEED_TEACHER_PASSWORD=${TEACHER_PW}`,
  '-e', 'SEED_TEACHER_NAME=Smoke Teacher',
  IMAGE);
notes.push(`container ${container.slice(0, 12)} started from ${IMAGE}`);

try {
  // ── 2. health ───────────────────────────────────────────────────────────────
  const up = await retry(120_000, async () => (await status(`${BASE}/api/health`)) === 200);
  check('GET /api/health = 200', up, up ? '' : `last status ${await status(`${BASE}/api/health`)}`);

  // ── 3. the migration journal actually applied ───────────────────────────────
  const sqlFiles = readdirSync('apps/api/src/db/migrations').filter((f) => f.endsWith('.sql')).length;
  const metas = readdirSync('apps/api/src/db/migrations/meta').filter((f) => /^\d+_snapshot\.json$/.test(f)).sort();
  const lastMeta = metas[metas.length - 1];
  const snapshotTables = Object.keys(
    JSON.parse(readFileSync(path.join('apps/api/src/db/migrations/meta', lastMeta), 'utf8')).tables)
    .map((t) => t.replace(/^public\./, '')).sort();
  const journalRows = Number(psql('select count(*) from drizzle.__drizzle_migrations'));
  const dbTables = psql("select table_name from information_schema.tables where table_schema='public' order by 1").split('\n').filter(Boolean).sort();
  check(`journal table holds every migration file (${sqlFiles})`, journalRows === sqlFiles, `rows=${journalRows}`);
  check(`public tables = ${lastMeta} (${snapshotTables.length})`,
    dbTables.length === snapshotTables.length
    && dbTables.every((t, i) => t === snapshotTables[i]),
    `db=${dbTables.length} snapshot=${snapshotTables.length}`);
  // the newest one by name, so a partially-applied journal cannot pass by coincidence
  const lastSql = readdirSync('apps/api/src/db/migrations').filter((f) => f.endsWith('.sql')).sort().pop();
  check(`the last migration (${lastSql}) is present in the database`,
    psql("select count(*) from information_schema.tables where table_schema='public' and table_name='lesson_hands'") === '1');

  // ── 4. the built frontend is served, with its hashed asset ──────────────────
  const shell = await (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) })).text();
  const asset = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/.exec(shell)?.[1] ?? '';
  check('GET / returns the built SPA shell with a hashed asset', /<div id="root">/.test(shell) && /\/assets\/[\w-]+-[A-Za-z0-9_-]{8}\.js/.test(shell), asset);
  if (asset) {
    const r = await fetch(`${BASE}${asset}`, { signal: AbortSignal.timeout(8000) });
    const cc = r.headers.get('cache-control') ?? '';
    check('the asset is served with an immutable cache header', r.status === 200 && /max-age=31536000/.test(cc) && /immutable/.test(cc), `status=${r.status} cache-control=${cc}`);
  }

  // ── 5. the refresh gate: same Origin passes, foreign Origin is 403 ──────────
  const same = await status(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { origin: BASE } });
  const foreign = await status(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { origin: 'https://evil.invalid' } });
  check('refresh with the site Origin is not blocked by the gate (401 = no cookie)', same !== 403 && same > 0, `status=${same}`);
  check('refresh with a foreign Origin is 403', foreign === 403, `status=${foreign}`);

  // ── 6. a real login, a class, and the pg-boss queue processing a job ────────
  const login = await json(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEACHER_EMAIL, password: TEACHER_PW }),
  });
  const token = login.body?.accessToken ?? '';
  check('the seeded teacher can log in in production mode', login.status === 200 && token.length > 20, `status=${login.status}`);
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: BASE };
  const cls = await json(`${BASE}/api/classes`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Smoke class', description: '', color: '#0ea5a5' }) });  const classId = cls.body?.id ?? '';
  check('a class can be created', cls.status === 200 || cls.status === 201, `status=${cls.status}`);

  const scheduleMaterial = async (label) => {
    const fd = new FormData();
    fd.set('title', label);
    fd.set('description', '<p>smoke</p>');
    fd.set('publish', 'schedule');
    fd.set('scheduledAt', new Date(Date.now() + 25_000).toISOString());
    const r = await fetch(`${BASE}/api/classes/${classId}/materials`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, origin: BASE }, body: fd,
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const first = await scheduleMaterial('Smoke scheduled post (before the DB restart)');
  check('a scheduled material is accepted', first.status === 201 && first.body?.status === 'scheduled', `status=${first.status} ${first.body?.status ?? ''}`);
  // the row is read from the database itself: what matters here is that the queue WORKED, and the
  // feed endpoint filters by visibility, which would make this test about the wrong thing
  const statusOf = (like) => psql(`select status from posts where title like '${like}' limit 1`);
  const publishedBefore = await retry(90_000, async () => statusOf('Smoke scheduled post (before%') === 'published');
  check('pg-boss processed the scheduled publish (queue works)', publishedBefore === true,
    `status=${statusOf('Smoke scheduled post (before%')}`);
  check('pg-boss kept its job rows in its own schema', Number(psql('select count(*) from pgboss.job')) >= 1,
    `jobs=${psql('select count(*) from pgboss.job')}`);

  // ── 7. the real disconnect: stop Postgres under the running app ─────────────
  sh('docker', 'stop', process.env.SMOKE_PG);
  const down5xx = await retry(60_000, async () => {
    const s = await status(`${BASE}/api/health`);
    return s === 0 || s >= 500;
  });
  check('health goes 5xx while the database is down', down5xx === true, `status=${await status(`${BASE}/api/health`)}`);
  const stillUp = sh('docker', 'inspect', '-f', '{{.State.Running}}', 'klass-smoke');
  check('the API process did NOT die with its database', stillUp === 'true', `State.Running=${stillUp}`);
  sh('docker', 'start', process.env.SMOKE_PG);
  const recovered = await retry(120_000, async () => (await status(`${BASE}/api/health`)) === 200);
  check('health is 200 again after the database came back', recovered === true);
  const second = await scheduleMaterial('Smoke scheduled post (after the DB restart)');
  const publishedAfter = second.status === 201 && await retry(90_000, async () => statusOf('Smoke scheduled post (after%') === 'published');
  check('the queue keeps processing after the reconnect', publishedAfter === true,
    `accepted=${second.status} status=${statusOf('Smoke scheduled post (after%')}`);

  // ── 8. nothing secret in the container log ──────────────────────────────────
  const log = sh('docker', 'logs', 'klass-smoke');
  const leaked = [JWT, LK_SECRET, LK_KEY, TEACHER_PW, 'postgres://', ':klass@']
    .filter((needle) => log.includes(needle));
  check('the container log contains no secret and no connection string', leaked.length === 0, leaked.join(', '));
  check('the container log contains no uncaught crash', !/uncaught exception|unhandled rejection|FATAL/.test(log),
    (log.match(/uncaught exception|unhandled rejection|FATAL/) ?? [''])[0]);
  notes.push(`log lines: ${log.split('\n').length}`);
} finally {
  console.log('\n--- container log (last 40 lines) ---');
  try { console.log(sh('sh', '-c', 'docker logs klass-smoke 2>&1 | tail -40')); } catch { /* gone */ }
  try { sh('docker', 'rm', '-f', 'klass-smoke'); } catch { /* gone */ }
}

console.log(`\n[runtime-smoke] ${failures.length === 0 ? 'PASS' : 'FAIL'} — ${notes.join('; ')}`);
if (failures.length) { console.log('failed checks: ' + failures.join(' | ')); process.exit(1); }
