-- Lesson comments (task 2, 2026-10-09).
--  * `lesson_comments` — what people write WHILE a lesson runs. It hangs off the session, not the
--    class, so a finished lesson keeps its own transcript and access is decided through that
--    session's class (a foreign session and a nonexistent one answer identically — 404).
--    Deletion is SOFT (`deleted_at`): the moderation view keeps the fact that something was
--    removed, the text itself is filtered out of every read. `eraseAccount` deletes rows
--    physically, because a soft delete would keep the person's words in the table.
--  * `lesson_comment_mutes` — «заглушить ученика на урок». Keyed by the session, so a mute cannot
--    leak into the next lesson; the class chat keeps its own, longer-lived `chat_mutes`.
--  * `lesson_comment_reads` — per-user «last read», so the unread counter survives a reload and
--    follows the person to another device (same shape as `chat_reads`).
--  * `lesson_sessions.comments_mode` — on | off | slow for THIS lesson, teacher-switchable.
--  * The `users.locale` default restated below is drizzle-kit's own doing: the 0024 snapshot
--    recorded the column without its literal default, so the diff re-emits the `SET DEFAULT 'en'`
--    that 0024 already applied. Re-running it is a no-op.
--  * RLS: every new table gets ROW LEVEL SECURITY with NO policies, and PUBLIC / anon /
--    authenticated lose every table privilege (the standing rule; 0019/0021 posture). The
--    application connects as the table OWNER, which bypasses RLS, so no app query changes.
CREATE TYPE "public"."comments_mode" AS ENUM('on', 'off', 'slow');--> statement-breakpoint
CREATE TABLE "lesson_comment_mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"muted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_comment_reads" (
	"user_id" uuid NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_comment_reads_user_id_lesson_session_id_pk" PRIMARY KEY("user_id","lesson_session_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "comments_mode" "comments_mode" DEFAULT 'on' NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_comment_mutes" ADD CONSTRAINT "lesson_comment_mutes_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comment_mutes" ADD CONSTRAINT "lesson_comment_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comment_mutes" ADD CONSTRAINT "lesson_comment_mutes_muted_by_users_id_fk" FOREIGN KEY ("muted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comment_reads" ADD CONSTRAINT "lesson_comment_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comment_reads" ADD CONSTRAINT "lesson_comment_reads_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comments" ADD CONSTRAINT "lesson_comments_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_comments" ADD CONSTRAINT "lesson_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_comment_mutes_session_user_idx" ON "lesson_comment_mutes" USING btree ("lesson_session_id","user_id");--> statement-breakpoint
CREATE INDEX "lesson_comments_session_idx" ON "lesson_comments" USING btree ("lesson_session_id","created_at");--> statement-breakpoint
-- RLS + privileges: enabled with no policies, and every non-owner role shut out.
ALTER TABLE "lesson_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lesson_comment_mutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lesson_comment_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "lesson_comments" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "lesson_comment_mutes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "lesson_comment_reads" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TYPE "public"."comments_mode" FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "lesson_comments" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "lesson_comment_mutes" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "lesson_comment_reads" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TYPE "public"."comments_mode" FROM anon, authenticated';
  END IF;
END $$;
