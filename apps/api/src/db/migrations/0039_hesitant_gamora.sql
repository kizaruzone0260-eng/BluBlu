CREATE TABLE "lesson_guest_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lesson_guest_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
ALTER TABLE "lesson_guest_links" ADD CONSTRAINT "lesson_guest_links_session_id_lesson_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_guest_links" ADD CONSTRAINT "lesson_guest_links_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_guest_links" ADD CONSTRAINT "lesson_guest_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_guest_requests" ADD CONSTRAINT "lesson_guest_requests_link_id_lesson_guest_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."lesson_guest_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_guest_requests" ADD CONSTRAINT "lesson_guest_requests_session_id_lesson_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_guest_requests" ADD CONSTRAINT "lesson_guest_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_guest_links_token_idx" ON "lesson_guest_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "lesson_guest_links_session_idx" ON "lesson_guest_links" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_guest_requests_key_idx" ON "lesson_guest_requests" USING btree ("link_id","key_hash");--> statement-breakpoint
CREATE INDEX "lesson_guest_requests_session_idx" ON "lesson_guest_requests" USING btree ("session_id","created_at");--> statement-breakpoint
-- 2026-10-28, SEC-06: новые таблицы рождаются закрытыми, как и все прежние (0019/0021/0025/0038).
-- Без этого шага гостевая ссылка и заявки оказались бы единственными таблицами без RLS и с
-- дефолтными правами Supabase-ролей — «забыли» вместо «запрещено». Цикл ниже идемпотентен и
-- намеренно не трогает политики: приложение ходит владельцем таблиц, владелец RLS обходит
-- (решение 2026-10-07 в docs/DECISIONS.md). REVOKE выполняется только если роль существует:
-- на embedded-postgres и в CI ролей `anon`/`authenticated` нет, а REVOKE на несуществующую роль
-- — ошибка 42704, которая уронила бы всю миграцию (та же защита, что в 0030/0032/0034/0038).
ALTER TABLE "lesson_guest_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lesson_guest_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.lesson_guest_links FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE public.lesson_guest_requests FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.lesson_guest_links FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE public.lesson_guest_requests FROM authenticated';
  END IF;
END $$;