-- Part 1(е): the original (pre-hardening) migrations created most tables WITHOUT
-- enabling Row Level Security or closing the Supabase anon/authenticated roles, so
-- only the tables added in later phases were protected. This closes the gap for
-- EVERY base table in the public schema, current and future-proof via the loop.
--
-- The application connects as the table OWNER (Render/Supabase service role), which
-- BYPASSES RLS unless FORCE is set — so enabling RLS here does not change any app
-- query. anon/authenticated (the only roles PostgREST can act as) get every table
-- privilege revoked and, with RLS on and no policies, can read no rows at all.
DO $$
DECLARE
  r RECORD;
  has_anon BOOLEAN;
  has_auth BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          INTO has_anon;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') INTO has_auth;

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%s ENABLE ROW LEVEL SECURITY', quote_ident(r.relname));
    EXECUTE format('REVOKE ALL ON TABLE public.%s FROM PUBLIC', quote_ident(r.relname));
    IF has_anon THEN EXECUTE format('REVOKE ALL ON TABLE public.%s FROM anon', quote_ident(r.relname)); END IF;
    IF has_auth THEN EXECUTE format('REVOKE ALL ON TABLE public.%s FROM authenticated', quote_ident(r.relname)); END IF;
  END LOOP;
END $$;
