/**
 * RLS / role audit — READ ONLY. Prints catalog facts that decide whether the
 * application needs permissive row policies at all:
 *   • who the backend role is, is it the table OWNER, does it have BYPASSRLS;
 *   • every policy in `public` (name, command, roles, USING expression);
 *   • privleges held by the Supabase web roles (anon / authenticated) on EVERY table;
 *   • how many rows the application role actually sees in the tables the API reads.
 *
 *   node scripts/rls-audit.mjs                      # local/CI embedded cluster shape
 *   node scripts/rls-audit.mjs <path-to-cloud.env>  # production (DATABASE_URL from the file)
 *
 * Never prints secrets: all output is redacted, no connection strings, no values.
 */
import fs from 'node:fs';
import postgres from 'postgres';

const envFile = process.argv[2];
if (envFile) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i <= 0) continue;
    const k = line.slice(0, i).trim(); if (/^[A-Z0-9_]+$/.test(k)) process.env[k] = line.slice(i + 1).trim();
  }
}
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_TEST
  || 'postgres://klass:klass@127.0.0.1:5433/klass';
const pass = (() => { try { return decodeURIComponent(new URL(url).password); } catch { return ''; } })();
const redact = (s) => String(s).replace(/postgres(ql)?:\/\/[^\s"']*/g, 'postgres://***').replaceAll(pass || '\u0000', '***');
const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : x)));
log('target:', envFile ? 'production DATABASE_URL (redacted)' : 'local/CI embedded cluster (redacted)');

const sql = postgres(url, { max: 1, connect_timeout: 30 });
let failures = 0;
const ok = (name, good, extra = '') => { log(`${good ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${redact(extra)}` : ''}`); if (!good) failures++; };

const safe = async (label, fn) => { try { return await fn(); } catch (e) { log(`  (${label}: unavailable — ${redact(String(e?.message ?? e)).slice(0, 120)})`); return null; } };

// 1 — who are we, and can RLS even apply to us?
const meRes = await safe('identity', () => sql`
  select current_user as role,
         (select rolsuper      from pg_roles where rolname = current_user) as is_super,
         (select rolbypassrls  from pg_roles where rolname = current_user) as bypassrls,
         (select rolcreaterole from pg_roles where rolname = current_user) as createrole`);
const me = meRes ? meRes[0] : null; log('backend role:', meRes && meRes[0]);

const ownedRes = await safe('ownership', () => sql`
  select count(*)::int as total,
         count(*) filter (where pg_has_role(c.relowner, current_user, 'MEMBER')
                            or r.rolname = current_user)::int as owned_by_backend,
         count(*) filter (where relrowsecurity)::int as rls_on,
         count(*) filter (where relforcerowsecurity)::int as rls_forced
  from pg_class c
  join pg_roles r on r.oid = c.relowner
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p')`);
const owned = ownedRes ? ownedRes[0] : null; log('public tables:', ownedRes && ownedRes[0]);

if (me && owned) {
  ok('the backend role owns EVERY table in public (so RLS is bypassed by ownership)',
    owned.total > 0 && owned.owned_by_backend === owned.total,
    `owned ${owned.owned_by_backend}/${owned.total}`);
  ok('no table is FORCE ROW LEVEL SECURITY (owner bypass is not defeated anywhere)',
    owned.rls_forced === 0, `forced=${owned.rls_forced}`);
  ok('RLS is enabled on every table (posture kept)', owned.rls_on === owned.total,
    `rls_on ${owned.rls_on}/${owned.total}`);
  log(`bypass: role is super=${me.is_super}, rolBypassRls=${me.bypassrls} → RLS cannot filter this role's reads`);
}

// 2 — every policy present
const polsRes = await safe('policies', () => sql`
  select tablename, policyname, permissive, cmd, roles, qual, with_check
  from pg_policies where schemaname = 'public' order by policyname, tablename`);
const pols = polsRes || []; if (pols.length >= 0) {
  const byName = {};
  for (const p of pols) (byName[p.policyname] ??= []).push(p);
  log(`policies in public: ${pols.length} rows across ${Object.keys(byName).length} name(s): ${Object.keys(byName).join(', ') || '—'}`);
  for (const [name, rows] of Object.entries(byName)) {
    const roles = new Set(rows.flatMap((r) => r.roles ?? []));
    const quals = new Set(rows.map((r) => r.qual));
    log(`  ${name}: ${rows.length} table(s), roles=[${[...roles].join(',')}], USING=[${[...quals].join(' | ')}]`);
  }
}

// 3 — the Supabase web roles: privileges on EVERY table, and rows actually visible
const webRolesRes = await safe('web roles', () => sql`
  select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated')`);
const webRoles = webRolesRes || []; if (webRoles.length) {
  for (const r of webRoles) {
    const grantedRes = await safe('privileges', () => sql`
      select count(*) filter (where has_table_privilege(r.rolname, c.oid, 'SELECT'))::int as sel,
             count(*) filter (where has_table_privilege(r.rolname, c.oid, 'INSERT'))::int as ins,
             count(*) filter (where has_table_privilege(r.rolname, c.oid, 'UPDATE'))::int as upd,
             count(*) filter (where has_table_privilege(r.rolname, c.oid, 'DELETE'))::int as del,
             count(*)::int as total
      from pg_class c
      cross join (select ${r.rolname} as rolname) r
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')`);
    const granted = grantedRes ? grantedRes[0] : null;
    log(`role ${r.rolname} (bypassrls=${r.rolbypassrls}) privileges over ${granted?.total} tables:`, granted);
    ok(`${r.rolname} holds NO table privilege on any public table`,
      !!granted && granted.sel === 0 && granted.ins === 0 && granted.upd === 0 && granted.del === 0,
      `sel=${granted?.sel}`);
  }
  // rows a non-privileged role can actually read (must be zero — denied at privileges)
  for (const t of ['users', 'classes', 'chat_messages', 'posts', 'files', 'teacher_notes']) {
    for (const role of ['anon', 'authenticated']) {
      let denied = false, rows = -1;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role "${role}"`);
          const res = await tx.unsafe(`select count(*)::int as n from public.${t}`);
          rows = Number(res[0].n);
        });
      } catch { denied = true; }
      ok(`${role} cannot read ${t}`, denied || rows === 0,
        denied ? 'denied at the privilege layer' : `rows=${rows}`);
    }
  }
} else {
  log('anon/authenticated roles are absent here (embedded cluster) — Supabase REST check applies to production only');
}

// 4 — what the application itself sees (the check that a policy-less RLS would break)
const seenRes = await safe('app visibility', () => sql`
  select (select count(*)::int from public.users where deleted_at is null) as users_live,
         (select count(*)::int from public.classes) as classes,
         (select count(*)::int from public.lesson_sessions) as sessions,
         (select count(*)::int from public.refresh_tokens) as refresh_tokens`);
const seen = seenRes ? seenRes[0] : null; log('rows visible to the backend role:', seenRes && seenRes[0]);
// A dev/CI cluster is normally truncated by the test suite, so zero rows is not a
// failure there. With --require-data (the production run) zero users means the app
// really cannot read its own data.
const requireData = process.argv.includes('--require-data');
if (requireData) {
  ok('the application role reads non-zero application data (users exist)', !!seen && seen.users_live >= 1,
    `users_live=${seen?.users_live}`);
} else {
  log(`(informational) users_live=${seen?.users_live} — pass --require-data on a live database`);
}

// 5 — PostgREST with the PUBLIC (publishable) key must not read anything. Only runs
// when the Supabase REST coordinates are configured; the key is public by design and
// is still never printed.
const restBase = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const pubKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
if (restBase && pubKey) {
  log('--- REST check via {SUPABASE_URL}/rest/v1 (publishable key, value never printed) ---');
  for (const t of ['users', 'classes', 'chat_messages', 'posts', 'files', 'teacher_notes']) {
    let status = 0, rows = null, detail = '';
    try {
      const res = await fetch(`${restBase}/rest/v1/${t}?select=*&limit=5`, {
        headers: { apikey: pubKey, Authorization: `Bearer ${pubKey}`, accept: 'application/json' },
      });
      status = res.status;
      const text = await res.text();
      try { const j = JSON.parse(text); rows = Array.isArray(j) ? j.length : null; } catch { detail = text.slice(0, 60); }
      detail = redact(detail);
      ok(`REST ${t} denied to the public key (401/403/404, never a row)`,
        [401, 403, 404].includes(status) || rows === 0, `status=${status} rows=${rows} ${detail}`);
    } catch (e) {
      log(`  (REST ${t}: request failed — ${redact(String(e?.message ?? e)).slice(0, 80)})`);
      failures++;
    }
  }
} else {
  log('(REST check skipped: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not configured here)');
}

await sql.end({ timeout: 5 });
log(failures ? `AUDIT: ${failures} check(s) FAILED` : 'AUDIT: all checks PASS');
process.exit(failures ? 1 : 0);
