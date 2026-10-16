-- Часть F (2026-10-16): подтверждение почты при регистрации — код из письма.
--  * `email_verifications` — ОДНА активная строка на нормализованный адрес (PK = email, как в
--    `login_attempts`): повторный запрос замещает код, а не плодит их, иначе «пять попыток»
--    превращаются в «пять попыток на каждое из шести отправленных писем».
--  * хранится соль+SHA-256 кода, не сам код: дамп всей школы (docs/BACKUP.md) не должен отдавать
--    рабочий набор кодов для чужой регистрации;
--  * `used_at` вместо удаления: списанный код обязан остаться различимым, чтобы второй прогон
--    того же кода дал «уже использован», а не «не найдено» — то же решение, что у invite-кодов;
--  * RLS: новая таблица получает ROW LEVEL SECURITY БЕЗ политик, и PUBLIC / anon / authenticated
--    теряют на ней все привилегии (поза 0019/0021/0025/0030). Приложение ходит владельцем,
--    который RLS обходит, поэтому ни один запрос не меняется. Проверяется тестом миграций с нуля
--    (pg_class.relrowsecurity + has_table_privilege + has_column_privilege).
CREATE TABLE "email_verifications" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "email_verifications" FROM PUBLIC;
--> statement-breakpoint
/*
 * Роли `anon` и `authenticated` создаёт Supabase — на обычном Postgres (CI, локальный
 * embedded-postgres) их нет, а REVOKE на несуществующую роль это ошибка 42704, которая роняет
 * всю миграцию. Поэтому отзыв выполняется только тогда, когда роли есть.
 */
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "email_verifications" FROM anon, authenticated';
  END IF;
END $$;
