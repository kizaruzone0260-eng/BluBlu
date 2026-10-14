-- Часть 4 (2026-10-14): архив уроков.
--  * `classes.board_archive_public` — переключатель «показывать архив досок ученикам», по
--    умолчанию ВЫКЛЮЧЕН. Архив — записи про завершённый урок: видит ли их класс, решает учитель.
--    Ученику при включённом переключателе отдаются только доски (ни комментариев, ни участников).
--  * `lesson_attendance` — минимальная запись присутствия «приход и уход»: одна строка на
--    (сессия, человек), joined_at + left_at. Ровно факт, без времени у микрофона и без того, что
--    говорилось. Нужна потому, что список участников LiveKit живёт только во время урока, а
--    «сколько человек было на занятии» архив обязан отвечать и после.
--  * RLS: новая таблица получает ROW LEVEL SECURITY БЕЗ политик, и PUBLIC / anon / authenticated
--    теряют на ней все привилегии (posture 0019/0021/0025). Приложение ходит владельцем, который
--    RLS обходит, поэтому ни один запрос не меняется. Проверяется тестом миграций с нуля
--    (pg_class + has_table_privilege + has_column_privilege).
CREATE TABLE "lesson_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "lesson_attendance_session_user_key" UNIQUE("lesson_session_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "board_archive_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_attendance" ADD CONSTRAINT "lesson_attendance_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_attendance" ADD CONSTRAINT "lesson_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_attendance_session_idx" ON "lesson_attendance" USING btree ("lesson_session_id");--> statement-breakpoint
ALTER TABLE "lesson_attendance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "lesson_attendance" FROM PUBLIC;--> statement-breakpoint
/*
 * Роли `anon` и `authenticated` создаёт Supabase — на обычном Postgres (CI, локальный
 * embedded-postgres) их нет, а REVOKE на несуществующую роль это ошибка 42704, которая роняет
 * всю миграцию. Поза 0025: отзыв выполняется только тогда, когда роли есть.
 */
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "lesson_attendance" FROM anon, authenticated';
  END IF;
END $$;
