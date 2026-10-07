-- Part 1(е) follow-up: remove the permissive `app_trusted_access` policies that 0020
-- added. They turned out to be unnecessary for EVERY configuration this app runs in,
-- and they were never the production fix (the video-lesson outage was the Origin gate,
-- see lib/origin.ts and VIDEO_CALL_FINAL_FIX_REPORT.md).
--
-- Evidence (apps/api/scripts/rls-audit.mjs — read-only, prints catalog facts only):
--   • local / CI embedded cluster: backend role `klass` is a superuser AND owns 35/35
--     public tables, 0 tables FORCE ROW LEVEL SECURITY → RLS cannot filter it;
--   • production Supabase: backend role `postgres` is the owner of 35/35 public tables
--     with rolbypassrls = true, is Superuser = false, 0 tables FORCE ROW LEVEL
--     SECURITY → RLS cannot filter it either (users_live = 1, classes = 4 were visible
--     all along, and /api/me + /api/lessons/active answered 200);
--   • `anon` / `authenticated` hold 0 privileges on all 35 tables, so a policy was
--     unreachable to them anyway (privilege check precedes RLS), and PostgREST with the
--     public key answers 401 on users/classes/chat_messages/posts/files/teacher_notes.
-- A policy that only ever applies to a role which bypasses RLS grants nothing.
--
-- SECURITY POSTURE IS NOT CHANGED: this migration touches policies only. Row Level
-- Security stays ENABLED on every table (0019 is not reverted), no privilege is
-- granted or revoked, no role is created or dropped, no data or table is touched, and
-- nothing is destructive — re-running 0020 afterwards would restore the exact prior
-- state. Forward-only, wrapped in one DO block (one implicit transaction).
--
-- WHY THIS IS SAFE TO SHIP, AND WHAT IT MEANS FOR THE FUTURE: the application keeps
-- connecting as the table owner (or a role with BYPASSRLS). If an operator ever moves
-- DATABASE_URL to a NON-owner role without BYPASSRLS, that role will see 0 rows from
-- every table and the API will answer 401 on /api/me — i.e. RLS with no policies does
-- what it is designed to do. That switch must then come with explicit, per-table
-- policies written for the actual role (test/integration/phase1-rls-approle.test.ts
-- proves both halves of this and fails loudly if the invariant changes).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_trusted_access ON public.%s', quote_ident(r.relname));
  END LOOP;
END $$;
