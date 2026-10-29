-- 2026-10-28, аудит SEC-06 (CWE-1188). До этой миграции защита Supabase
-- (`custom/secure-public.sql`) жила только в ручном скрипте `pnpm db:secure`: файла не было в
-- журнале, `Dockerfile` и `server.ts` его не звали, поэтому таблица, созданная после последнего
-- ручного прогона, оставалась без RLS и с дефолтными правами `anon`/`authenticated`, пока
-- владелец снова не вспомнит про скрипт. Обещание, а не свойство. Теперь те же операторы — шаг
-- журнала, а журнал применяется при каждом старте (`server.ts` → `migrate()`).
--
-- Почему с проверкой ролей: `anon` и `authenticated` создаёт только Supabase. На локальном
-- embedded-postgres и в CI (`postgres:16-alpine`) их нет, а `REVOKE` на несуществующую роль —
-- ошибка 42704, которая роняет всю миграцию (и установку, и проигрывание журнала с 0000).
-- Та же защита уже стоит в 0030/0032/0034; здесь она распространена на операции уровня схемы.
-- Там, где роли есть, поведение ровно то же, что у ручного скрипта, — он успешно прогонялся на
-- боевой базе (замер: `cloud-verify`, фазы 2-3).
--
-- Почему ENABLE RLS циклом, а не только на «своих» таблицах: 0019 включил RLS на всех таблицах,
-- существовавших тогда, и каждая следующая миграция включает его на своих. Цикл — страховка от
-- «забыли» и идемпотентен. Поведение приложения не меняется: оно ходит владельцем таблиц, а
-- владелец RLS обходит (`FORCE` не ставится — решение 2026-10-07 в docs/DECISIONS.md).
--
-- Чего эта миграция НЕ делает: не создаёт ролей, не выдаёт грантов, не меняет данные, не ставит
-- `FORCE ROW LEVEL SECURITY` и не трогает `DATABASE_URL`. USAGE на схему `public` может остаться
-- действующим через псевдороль PUBLIC (так устроен Supabase) — это не путь к данным, пока у
-- `anon`/`authenticated` нет ни одной привилегии на таблицы, последовательности и функции.
--
-- Откат: git revert этого файла и записи в журнале. Сам SQL разрушающих действий не содержит:
-- `REVOKE` снимает лишнее, `ENABLE RLS` — поза, а не данные. Повторный прогон безопасен.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;--> statement-breakpoint

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
