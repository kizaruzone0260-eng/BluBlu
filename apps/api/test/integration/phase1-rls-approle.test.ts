/**
 * Regression guard for the video-lesson auth outage. 0019 enabled RLS on every
 * table with NO policies — invisible to the table OWNER (dev/CI/e2e all connect as
 * the owner, which bypasses RLS) but it filters every SELECT to 0 rows for a
 * NON-owner application role that nonetheless holds legitimate table GRANTs. The
 * API's `authenticate` (plugins/auth.ts) then finds no user and 401s, and the SPA
 * interceptor logs the user out — exactly "open video lesson → bounced to Sign In".
 *
 * This test switches to a non-owner role (with GRANTs) and asserts it can still
 * SELECT a seeded row. It FAILS on the 0019-only state (0 rows) and PASSES once
 * 0020 adds the permissive policy — without weakening the anon/authenticated
 * closure (those roles hold no privilege, so the policy is unreachable to them).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, preparedDb, makeTeacher, type TestDB } from './util.js';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('Part 1(е) regression: non-owner app role can read under RLS', () => {
  let t: TestDB;
  const APP_ROLE = 'rls_app_role_test';

  beforeAll(async () => {
    t = await preparedDb(TEST_DATABASE_URL); // runs all migrations incl. 0020
    // a NON-owner, non-BYPASSRLS login role, granted the tables the app needs
    const exists = await t.sql`select 1 from pg_roles where rolname = ${APP_ROLE}`;
    if (!exists.length) {
      await t.sql.unsafe(`create role ${APP_ROLE} login nosuperuser nocreatedb nobypassrls`);
    }
    await t.sql.unsafe(`grant usage on schema public to ${APP_ROLE}`);
    await t.sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`);
    await t.sql.unsafe(`grant usage, select on all sequences in schema public to ${APP_ROLE}`);
  });
  afterAll(async () => {
    try { await t?.sql.unsafe(`drop role if exists ${APP_ROLE}`); } catch { /* in use */ }
    await t?.sql.end();
  });

  it('the app role is neither the owner nor BYPASSRLS (so RLS really applies to it)', async () => {
    const [u] = await t.sql`select c.relname, r.rolname as owner from pg_class c
      join pg_roles r on r.oid = c.relowner
      where c.relnamespace = 'public'::regnamespace and c.relname = 'users'`;
    expect(u.owner).not.toBe(APP_ROLE); // tables owned by the migration role, not the app role
    const [b] = await t.sql`select rolbypassrls from pg_roles where rolname = ${APP_ROLE}`;
    expect(b.rolbypassrls).toBe(false);
  });

  it('non-owner app role can SELECT users (401 root-cause guard)', async () => {
    await makeTeacher(t.sql, `rls-app-${Date.now()}@x.io`);
    // switch to the unprivileged role inside a transaction (SET LOCAL reverts at end)
    const tx = await t.sql.begin(async (txsql) => {
      await txsql.unsafe(`set local role ${APP_ROLE}`);
      const [who] = await txsql`select current_user as u`;
      const rows = await txsql`select count(*)::int as n from public.users`;
      return { who: who.u, n: rows[0].n };
    });
    expect(tx.who).toBe(APP_ROLE);
    // WITHOUT the 0020 policy this is 0 (RLS filters everything) → the exact
    // condition that made `authenticate` return 401. WITH it, the row is visible.
    expect(tx.n).toBeGreaterThanOrEqual(1);
  });

  it('anon / authenticated still hold no table privilege (fix does not widen the hole)', async () => {
    const roles = await t.sql`select 1 from pg_roles where rolname = 'anon'`;
    if (!roles.length) return; // embedded cluster has no Supabase web roles
    for (const r of ['anon', 'authenticated']) {
      const [p] = await t.sql`select has_table_privilege(${r}, 'public.users'::regclass, 'SELECT') as p`;
      expect(p.p, `${r} must not SELECT users`).toBe(false);
    }
  });

  it('a role WITHOUT any grant is still DENIED despite the TO PUBLIC policy', async () => {
    // Security proof: the permissive policy only helps roles that ALREADY hold a
    // table privilege. A privilege-less role (like anon/authenticated after 0019's
    // REVOKE) is rejected at the privilege layer, BEFORE RLS is consulted — so the
    // policy cannot widen access to an untrusted role.
    const NOGRANT = 'rls_nogrant_role';
    const exists = await t.sql`select 1 from pg_roles where rolname = ${NOGRANT}`;
    if (!exists.length) await t.sql.unsafe(`create role ${NOGRANT} login nosuperuser nocreatedb nobypassrls`);
    // deliberately NO table grant for this role
    let denied = false;
    try {
      await t.sql.begin(async (txsql) => {
        await txsql.unsafe(`set local role ${NOGRANT}`);
        await txsql`select count(*)::int as n from public.users`;
      });
    } catch {
      denied = true; // permission denied for users
    }
    expect(denied, 'privilege-less role must be denied even with the PUBLIC policy').toBe(true);
    try { await t.sql.unsafe(`drop role if exists ${NOGRANT}`); } catch { /* ignore */ }
  });
});
