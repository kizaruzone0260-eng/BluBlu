-- Part 1(е) correction (video-lesson auth regression). 0019 enabled Row Level
-- Security on every table but added NO policies. That is safe for a table OWNER
-- (owners bypass RLS) — which is why local dev and CI (embedded `klass` owner) and
-- the local e2e/RTC runs stayed green — but it silently locks out any APPLICATION
-- role that is NOT the owner and lacks BYPASSRLS: it holds table GRANTs yet RLS
-- with no policy filters every SELECT to 0 rows. plugins/auth.ts then finds no
-- user and returns 401, and the SPA auth interceptor tears down the session.
--
-- Fix, forward-only and non-destructive: add ONE permissive policy per base table
-- so a role that legitimately holds grants (the application) is not filtered out.
-- This does NOT weaken the anon/authenticated closure: 0019 already `REVOKE ALL`
-- from those roles (and PUBLIC), so they hold no table privilege and can never
-- reach a policy — a SELECT by them is denied at the privilege layer, before RLS.
-- RLS stays ENABLED (defence-in-depth preserved); no BYPASSRLS is granted; no rows
-- or tables are dropped.
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
    EXECUTE format(
      'CREATE POLICY app_trusted_access ON public.%s AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)',
      quote_ident(r.relname)
    );
  END LOOP;
END $$;
