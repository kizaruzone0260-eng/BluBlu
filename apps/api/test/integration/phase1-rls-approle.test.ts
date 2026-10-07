/**
 * RLS posture guard — the 0020 regression test, TRANSFORMED for migration 0021
 * (the file is intentionally kept, not deleted, so the history reads continuously).
 *
 * What changed and why:
 *   0019 enabled RLS on every public table with no policies. 0020 then added one
 *   permissive `app_trusted_access ... TO PUBLIC USING (true)` policy per table, out of
 *   a hypothesis that the cloud outage came from a NON-owner application role being
 *   filtered. That hypothesis was measured and refuted (apps/api/scripts/rls-audit.mjs):
 *   in every configuration this app runs in — local embedded cluster, CI's
 *   postgres:16-alpine (POSTGRES_USER=klass, a superuser) and production Supabase
 *   (`postgres`, owner of 35/35 tables with rolbypassrls) — the application role cannot
 *   be filtered by RLS at all, and no table is FORCE ROW LEVEL SECURITY. A policy whose
 *   only reachable audience is a role that already bypasses RLS grants nothing, so 0021
 *   removes those policies while leaving RLS ENABLED everywhere.
 *
 * What this file now proves, in the order of the incident it guards:
 *   1. the deployment invariant that makes policies unnecessary — the connecting role
 *      owns the tables (or bypasses RLS) and nothing is FORCE-set, so a future move to
 *      a filtered role fails HERE instead of silently in production;
 *   2. NO permissive policy for PUBLIC exists on any public table (this assertion fails
 *      on the 0020 state and passes on 0021 — the before/after proof for the removal);
 *   3. the closure that 0019 established is still complete: `anon` and `authenticated`
 *      hold no privilege on ANY public table and read zero rows from the tables the API
 *      uses, so removing the policies did not open anything;
 *   4. the documented consequence for a future non-owner role: it is filtered to 0 rows
 *      by policy-less RLS (the opposite of what 0020 assumed was a bug) and a role with
 *      no privileges is refused outright.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const APP_ROLE = 'rls_app_role_test';   // non-owner role WITH grants
const NOGRANT = 'rls_nogrant_role';     // non-owner role WITHOUT grants
const WEB_ROLES = ['anon', 'authenticated']; // the Supabase PostgREST roles
const API_TABLES = ['users', 'classes', 'chat_messages', 'posts', 'files', 'teacher_notes'];

suite('RLS posture after 0021: no PUBLIC policies, closure intact', () => {
  let t: TestDB;

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL); // applies every migration, incl. 0021
    // The Supabase web roles do not exist on an embedded cluster; create them (NOLOGIN,
    // no grants) so the closure assertions are real in CI too, not skipped.
    for (const r of WEB_ROLES) {
      const exists = await t.sql`select 1 from pg_roles where rolname = ${r}`;
      if (!exists.length) await t.sql.unsafe(`create role "${r}" nologin nosuperuser nocreatedb nobypassrls`);
    }
    for (const r of [APP_ROLE, NOGRANT]) {
      const exists = await t.sql`select 1 from pg_roles where rolname = ${r}`;
      if (!exists.length) await t.sql.unsafe(`create role "${r}" login nosuperuser nocreatedb nobypassrls`);
    }
    await t.sql.unsafe(`grant usage on schema public to ${APP_ROLE}`);
    await t.sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`);
    await t.sql.unsafe(`grant usage, select on all sequences in schema public to ${APP_ROLE}`);
  });

  afterAll(async () => {
    for (const r of [APP_ROLE, NOGRANT]) {
      try { await t?.sql.unsafe(`drop role if exists "${r}"`); } catch { /* in use */ }
    }
    await t?.sql.end();
  });

  // ── 1. the invariant that makes permissive policies unnecessary ───────────────
  it('the connecting role owns every public table (or bypasses RLS) and nothing is FORCE-set', async () => {
    const [me] = await t.sql`
      select current_user as role,
             (select rolsuper     from pg_roles where rolname = current_user) as is_super,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`;
    const [own] = await t.sql`
      select count(*)::int as total,
             count(*) filter (where r.rolname = current_user)::int as owned_by_app,
             count(*) filter (where relrowsecurity)::int as rls_on,
             count(*) filter (where relforcerowsecurity)::int as rls_forced
      from pg_class c
      join pg_roles r on r.oid = c.relowner
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')`;
    expect(own.total, 'this suite must run against a migrated database').toBeGreaterThan(0);
    expect(own.rls_on, 'RLS stays ENABLED on every table — 0021 removed policies, not RLS').toBe(own.total);
    expect(own.rls_forced, 'FORCE would defeat owner bypass and silently filter the app').toBe(0);
    const unreachable = me.is_super === true || me.bypassrls === true || own.owned_by_app === own.total;
    expect(unreachable,
      `the application role must be superuser/BYPASSRLS or the table owner (role=${me.role}, ` +
      `owned=${own.owned_by_app}/${own.total}) — otherwise it is filtered to 0 rows and needs explicit policies`)
      .toBe(true);
  });

  // ── 2. what 0021 removed, and the proof it is gone ────────────────────────────
  it('no permissive policy for PUBLIC exists on any public table', async () => {
    const all = await t.sql`
      select tablename, policyname, permissive, cmd, roles, qual
      from pg_policies where schemaname = 'public'`;
    expect(all.length, `expected zero policies in public, found: ${all.map((p) => `${p.tablename}/${p.policyname}`).join(', ')}`)
      .toBe(0);
    // belt-and-braces at pg_policy level: `polroles = '{}'` is exactly what `TO PUBLIC`
    // stores (an empty role list means "every role"), so this catches a
    // permissive-for-everyone policy even without the friendly view.
    const allRoles = await t.sql`
      select c.relname, p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and cardinality(p.polroles) = 0`;
    expect(allRoles.length, 'no policy may apply to every role (TO PUBLIC)').toBe(0);
  });

  // ── 3. the 0019 closure survives the removal ─────────────────────────────────
  it('anon / authenticated hold no privilege on ANY public table', async () => {
    for (const role of WEB_ROLES) {
      const [g] = await t.sql`
        select count(*)::int as total,
               count(*) filter (where has_table_privilege(${role}, c.oid, 'SELECT'))::int as sel,
               count(*) filter (where has_table_privilege(${role}, c.oid, 'INSERT'))::int as ins,
               count(*) filter (where has_table_privilege(${role}, c.oid, 'UPDATE'))::int as upd,
               count(*) filter (where has_table_privilege(${role}, c.oid, 'DELETE'))::int as del,
               count(*) filter (where has_schema_privilege(${role}, 'public', 'USAGE'))::int as schema_usage_any
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')`;
      expect(g.total).toBeGreaterThan(0);
      expect(g.sel, `${role} must not SELECT any table`).toBe(0);
      expect(g.ins, `${role} must not INSERT any table`).toBe(0);
      expect(g.upd, `${role} must not UPDATE any table`).toBe(0);
      expect(g.del, `${role} must not DELETE any table`).toBe(0);
      void g.schema_usage_any; // informational: privilege, not schema usage, is what 0019 revoked
    }
  });

  it('anon / authenticated read not a single row from the tables the API uses', async () => {
    await makeTeacher(t.sql, `rls-closure-${Date.now()}@x.io`); // the app role can write…
    const [baseline] = await t.sql`select count(*)::int as n from public.users`;
    expect(baseline.n).toBeGreaterThanOrEqual(1);
    for (const role of WEB_ROLES) {
      for (const table of API_TABLES) {
        let denied = false, rows = -1;
        try {
          await t.sql.begin(async (tx) => {
            await tx.unsafe(`set local role "${role}"`);
            const res = await tx.unsafe(`select count(*)::int as n from public.${table}`);
            rows = Number(res[0].n);
          });
        } catch { denied = true; }
        expect(denied || rows === 0,
          `${role} must be refused or see zero rows in ${table} (saw ${rows})`).toBe(true);
      }
    }
  });

  // ── 4. the documented consequence for a future non-owner application role ─────
  it('a NON-owner role with grants is filtered to 0 rows by policy-less RLS (0021 contract)', async () => {
    await makeTeacher(t.sql, `rls-nonowner-${Date.now()}@x.io`);
    const [asOwner] = await t.sql`select count(*)::int as n from public.users`;
    expect(asOwner.n, 'the application role sees its own rows').toBeGreaterThanOrEqual(1);
    const asApp = await t.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      const [who] = await tx`select current_user as u`;
      const rows = await tx`select count(*)::int as n from public.users`;
      return { who: who.u, n: rows[0].n };
    });
    expect(asApp.who).toBe(APP_ROLE);
    // THIS is why the app must keep connecting as the owner/BYPASSRLS role: switching
    // DATABASE_URL to a non-owner role without writing explicit per-table policies
    // reproduces the exact "0 rows → 401 on /api/me → bounced to Sign In" shape.
    expect(asApp.n, 'a non-owner role is filtered by RLS with no policies — by design').toBe(0);
  });

  it('a role WITHOUT any grant is refused outright (privilege check precedes RLS)', async () => {
    let denied = false;
    try {
      await t.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${NOGRANT}`);
        await tx`select count(*)::int as n from public.users`;
      });
    } catch { denied = true; }
    expect(denied, 'a privilege-less role must be denied before RLS is even consulted').toBe(true);
  });
});
