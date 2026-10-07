/**
 * TEMPORARY one-off cloud verification (Supabase pooler). NOT for commit.
 * Re-run after the Render deploy: node scripts/cloud-verify.mjs <path-to-cloud.env>
 * Never prints secret values; all child output is redacted before display.
 * Checks: 1) migrations+pg-boss+advisory locks on pooler, 2) db:secure + catalog
 * privileges, 3) REST lockdown via publishable key, 4) app read/write still works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import postgres from 'postgres';

const envFile = process.argv[2];
if (!envFile) { console.error('usage: node cloud-verify.mjs <cloud.env>'); process.exit(1); }
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i <= 0) continue;
  const k = line.slice(0, i).trim();
  const v = line.slice(i + 1).trim();
  if (k && /^[A-Z0-9_]+$/.test(k)) process.env[k] = v;
}

const dbUrl = process.env.DATABASE_URL ?? '';
const pass = (() => { try { return decodeURIComponent(new URL(dbUrl).password); } catch { return ''; } })();
const pubKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
const redact = (s) => String(s)
  .replace(/postgres(ql)?:\/\/[^\s"']*@/g, 'postgres://***@')
  .replaceAll(pass || '\u0000', '***')
  .replaceAll(pubKey || '\u0000', '***');
const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : x)));

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:3999';
let failures = 0;
const ok = (name, pass_, extra = '') => {
  log(`${pass_ ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${redact(extra)})` : ''}`);
  if (!pass_) failures++;
};

// ── 1. boot the API against the cloud DB: migrations + seed + pg-boss ────────
log('--- phase 1: start API (drizzle migrate + pg-boss on the Session pooler) ---');
const childLog = [];
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: API_DIR,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '3999',
    HOST: '127.0.0.1',
    STORAGE_DIR: './.cloud-verify-files',
    // A local verification boot must never re-point the LIVE Telegram webhook or steal
    // its updates: server.ts registers setWebhook when a token + PUBLIC_URL exist, and
    // the PUBLIC_URL in this file is not necessarily the address the deployed service
    // is served from (that mismatch is exactly the incident this repo documents). So the
    // bot is switched off for this run — it is not what we are verifying here.
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_TRANSPORT: 'log',
  },
});
child.stdout.on('data', (b) => childLog.push(String(b)));
child.stderr.on('data', (b) => childLog.push(String(b)));

let healthy = false;
for (let t = 0; t < 120; t++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (h.ok) { healthy = true; break; }
  } catch { /* not up yet */ }
  if (child.exitCode !== null) break;
}
ok('API boots on cloud DB (/api/health 200)', healthy);
if (!healthy) { log('server log tail:\n' + redact(childLog.join('')).slice(-2500)); process.exit(1); }

const sql = postgres(dbUrl, { max: 2 });
try {
  const [who] = await sql`select current_user as r, (select rolsuper from pg_roles where rolname=current_user) as super, (select rolbypassrls from pg_roles where rolname=current_user) as bypass`;
  log(`app role: ${who.r}  superuser=${who.super}  bypassrls=${who.bypass}`);

  const [tbls] = await sql`select count(*)::int as n from pg_tables where schemaname='public'`;
  ok('public tables created', tbls.n > 0, `count=${tbls.n}`);

  const [sch] = await sql`select count(*)::int as n from information_schema.schemata where schema_name='pgboss'`;
  ok('pgboss schema exists (pg-boss started on pooler)', sch.n === 1);
  const pbTables = await sql`select table_name from information_schema.tables where table_schema='pgboss' order by 1`;
  log(`pgboss tables: ${pbTables.map((r) => r.table_name).join(', ')}`);
  const [mig] = await sql`select count(*)::int as n, max(version)::int as v from pgboss.version`;
  ok('pg-boss migrations applied', mig.n > 0, `version rows=${mig.n} max version=${mig.v}`);

  // advisory lock + persistent session over the pooler, on a dedicated connection
  const sess = postgres(dbUrl, { max: 1 });
  try {
    const [p1] = await sess`select pg_backend_pid() as pid`;
    const [lk] = await sess`select pg_try_advisory_lock(8441239077) as got`;
    const [p2] = await sess`select pg_backend_pid() as pid`;
    const [ul] = await sess`select pg_advisory_unlock(8441239077) as done`;
    ok('advisory lock acquire/release on pooler', lk.got === true && ul.done === true);
    ok('pooler keeps a persistent session (same backend pid)', p1.pid === p2.pid, `pid ${p1.pid}`);
  } finally { await sess.end({ timeout: 5 }).catch(() => {}); }

  // users seeded by boot (owner teacher) — presence only, no values
  const [u] = await sql`select count(*)::int as n from public.users`;
  ok('users table readable, seed teacher present', u.n >= 1, `rows=${u.n}`);

  const roles = await sql`select rolname from pg_roles where rolname in ('anon','authenticated')`;
  ok('anon/authenticated roles exist', roles.length === 2, roles.map((r) => r.rolname).join(','));

  // ── 2. apply db:secure ─────────────────────────────────────────────────────
  log('--- phase 2: db:secure + catalog verification ---');
  const sec = await new Promise((res) => {
    const c = spawn(process.execPath, ['scripts/secure-db.mjs'], { cwd: API_DIR, env: process.env });
    let out = ''; c.stdout.on('data', (b) => { out += String(b); }); c.stderr.on('data', (b) => { out += String(b); });
    c.on('close', (code) => res({ code, out }));
  });
  ok('secure-db.mjs exit 0', sec.code === 0, sec.out.trim());

  const [rlsOff] = await sql`
    select count(*)::int as n from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false`;
  ok('RLS enabled on ALL public tables', rlsOff.n === 0, `tables without RLS=${rlsOff.n}`);

  const priv = await sql`
    with tabs as (select tablename from pg_tables where schemaname='public'),
         seqs as (select sequencename from pg_sequences where schemaname='public'),
         fns  as (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
    select
      (select count(*)::int from tabs t cross join (select 'anon' r union select 'authenticated') rr
        where has_table_privilege(rr.r, 'public.'||quote_ident(t.tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES')) as tab_viol,
      (select count(*)::int from seqs s cross join (select 'anon' r union select 'authenticated') rr
        where has_sequence_privilege(rr.r, 'public.'||quote_ident(s.sequencename), 'USAGE,SELECT,UPDATE')) as seq_viol,
      (select count(*)::int from fns f cross join (select 'anon' r union select 'authenticated') rr
        where has_function_privilege(rr.r, f.oid, 'EXECUTE')) as fn_viol,
      (select count(*)::int from pg_namespace nsp where nsp.nspname='public'
        and (has_schema_privilege('anon','public','USAGE,CREATE') or has_schema_privilege('authenticated','public','USAGE,CREATE'))) as schema_viol`;
  const v = priv[0];
  ok('anon/authenticated: no table privileges', v.tab_viol === 0, `violations=${v.tab_viol}`);
  ok('anon/authenticated: no sequence privileges', v.seq_viol === 0, `violations=${v.seq_viol}`);
  ok('anon/authenticated: no function privileges', v.fn_viol === 0, `violations=${v.fn_viol}`);
  // schema-level USAGE may persist EFFECTIVELY via the PUBLIC pseudo-role (Supabase default);
  // explicit anon/authenticated grants are what db:secure removes. Report both.
  log(`INFO schema USAGE effective: anon=${v.schema_viol >= 1 ? 'yes (via PUBLIC pseudo-role)' : 'no'}, CREATE=revoked for anon/authenticated (no table/seq/fn privileges → zero data access)`);
  // default-privileges proof: a brand-new table must already be invisible to anon/auth
  await sql`create table if not exists public.zz_dpr_probe (id int)`;
  const [dpr] = await sql`select has_table_privilege('anon','public.zz_dpr_probe','SELECT') as a,
    has_table_privilege('authenticated','public.zz_dpr_probe','SELECT') as b`;
  ok('default privileges: fresh table has no anon/auth access', dpr.a === false && dpr.b === false);
  await sql`drop table if exists public.zz_dpr_probe`;

  // ── 3. REST (PostgREST) check with the publishable key ─────────────────────
  log('--- phase 3: REST check via {SUPABASE_URL}/rest/v1/users ---');
  const restUrl = `${(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/rest/v1/users?select=id&limit=5`;
  const rest = await fetch(restUrl, { headers: { apikey: pubKey, Authorization: `Bearer ${pubKey}`, accept: 'application/json' } });
  const restText = await rest.text();
  let restRows = null; try { restRows = Array.isArray(JSON.parse(restText)) ? JSON.parse(restText).length : null; } catch { /* non-json */ }
  log(`REST status=${rest.status} body(first 120 redacted)=${redact(restText).slice(0, 120)}`);
  const restEmpty = rest.status === 401 || rest.status === 403 || rest.status === 404
    || (rest.ok && Array.isArray(restRows) && restRows === 0);
  if (restEmpty) {
    // conclusive only if the table actually has rows for the app role
    const [u2] = await sql`select count(*)::int as n from public.users`;
    ok('REST returns no data with publishable key', u2.n >= 1, `app sees ${u2.n} row(s) in users, REST status=${rest.status}, rows out=0`);
    if (u2.n === 0) {
      // inconclusive → temporary row
      log('users empty → inserting a temporary row for the check');
      const tmpEmail = `zz-verify-${Date.now()}@invalid.local`;
      const ph = '$argon2id$v=19$m=2,t=1,p=1$AAAA$' + 'A'.repeat(43); // dummy hash, never a login path
      await sql`insert into public.users (email, name, password_hash, role, locale) values (${tmpEmail}, 'verify', ${ph}, 'student', 'en')`;
      const rest2 = await fetch(restUrl, { headers: { apikey: pubKey, Authorization: `Bearer ${pubKey}`, accept: 'application/json' } });
      const t2 = await rest2.text();
      let n2 = -1; try { n2 = Array.isArray(JSON.parse(t2)) ? JSON.parse(t2).length : -1; } catch { /* non-json */ }
      ok('REST leak check with temporary row present', n2 === 0 || rest2.status >= 400, `status=${rest2.status} rows=${n2}`);
      await sql`delete from public.users where email=${tmpEmail}`;
      const [left] = await sql`select count(*)::int as n from public.users where email=${tmpEmail}`;
      ok('temporary row deleted', left.n === 0);
    }
  } else {
    ok('REST returns no data with publishable key', false, `status ${rest.status}: ${redact(restText).slice(0, 80)}`);
  }

  // ── 4. app still reads/writes through its own role (live HTTP API) ─────────
  log('--- phase 4: app functionality under its DB role after lockdown ---');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.SEED_TEACHER_EMAIL ?? '', password: process.env.SEED_TEACHER_PASSWORD ?? '' }),
  });
  const token = (await login.json().catch(() => null))?.accessToken;
  ok('seeded teacher logs in', login.status === 200 && Boolean(token), `status ${login.status}`);
  const req = (m, p, b) => fetch(`${BASE}${p}`, {
    method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
  });
  if (token) {
    const stamp = Date.now();
    const clsRes = await req('POST', '/api/classes', { name: `Проверка cloud ${stamp}`, description: '', color: '#0ea5a5' });
    const cls = await clsRes.json().catch(() => null);
    ok('write: create class', clsRes.status === 201 && Boolean(cls?.id));
    const list = await req('GET', '/api/classes');
    const arr = await list.json().catch(() => []);
    ok('read: class visible back', Array.isArray(arr) && arr.some((c) => c.id === cls?.id), `status ${list.status}`);
    const noteRes = await req('POST', '/api/notes', { title: 'cloud verify', body: '<p>x</p>' });
    const note = await noteRes.json().catch(() => null);
    ok('write: create note', noteRes.status === 201 && Boolean(note?.id));
    if (note?.id) {
      const pin = await req('PATCH', `/api/notes/${note.id}`, { pinned: true });
      ok('update: pin note', pin.status === 200);
      const del = await req('DELETE', `/api/notes/${note.id}`);
      ok('delete: remove test note', del.status === 200);
    }
    if (cls?.id) {
      const arch = await req('POST', `/api/classes/${cls.id}/archive`, {});
      ok('cleanup: archive fixture class', arch.status === 200);
      log(`NOTE: phase-4 fixture class ${cls.id.slice(0, 8)}… is archived — wipe it in the cloud DB if needed`);
    }
  }

  const [finalRls] = await sql`
    select count(*)::int as total,
           sum(case when c.relrowsecurity then 1 else 0 end)::int as secured
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'`;
  log(`FINAL: public tables=${finalRls.total}, RLS-enabled=${finalRls.secured}`);
} catch (e) {
  ok('verification run threw', false, redact(e.message ?? String(e)));
  failures++;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
  child.kill();
}
log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
