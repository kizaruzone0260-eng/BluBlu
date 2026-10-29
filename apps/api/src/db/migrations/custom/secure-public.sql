-- Supabase hardening (idempotent). The app connects DIRECTLY to Postgres as
-- `postgres` (table owner → owner bypasses RLS) and never uses the PostgREST
-- Data API. This closes the public REST surface anyway, belt-and-braces:
--   1) RLS enabled on every table in `public` (no policies → anon/authenticated
--      read nothing);
--   2) privileges revoked from anon/authenticated on schema, tables, sequences;
--   3) default privileges so tables created LATER are covered too.
--
-- 2026-10-28, аудит SEC-06: те же операторы теперь ЕСТЬ В ЖУРНАЛЕ
-- (`0038_secure_public.sql`), поэтому применяются при каждом старте приложения, а не
-- только когда владелец вспомнит про этот скрипт. Файл оставлен как «применить НЕМЕДЛЕННО,
-- без деплоя» (cloud-verify использует его) — и тест `db-secure-posture.test.ts` сверяет
-- набор операторов здесь и в миграции, чтобы два пути не разошлись.
--
-- Проверка ролей: `anon`/`authenticated` создаёт только Supabase. На локальном
-- embedded-postgres и в CI их нет, а REVOKE на несуществующую роль — ошибка 42704, которая
-- роняет весь файл. Раньше скрипт на такой базе падал; теперь он, как и миграция, ничего не
-- делает там, где ролей нет (и делает всё, где они есть).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated';
  END IF;
END $$;
