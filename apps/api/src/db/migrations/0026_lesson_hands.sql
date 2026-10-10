-- «Поднять руку» + «дать слово» (task 2Б, 2026-10-10).
--  * `lesson_hands` — one row per person per RUNNING lesson. Lowering a hand deletes the row: the
--    queue is live state, and a finished lesson must not keep a list of who wanted to speak. The
--    key is the session (not the class) for the same reason as `lesson_comment_mutes` — a hand
--    cannot leak into the next lesson.
--  * `granted_at` is the teacher's «дать слово». It stores only the fact; the LiveKit publish
--    permission of that ONE participant is derived from it (`floorPermission` in
--    services/lessons.ts), because LiveKit refuses a remote unmute (412, measured in CI) and
--    because ending the lesson, lowering the hand or taking the floor back must be able to put the
--    baseline permission back. No token and no other participant's rights change.
--  * RLS: enabled with NO policies, and PUBLIC / anon / authenticated lose every privilege —
--    the standing rule (0019/0021 posture). The app connects as the table OWNER, which bypasses
--    RLS, so no app query changes.
CREATE TABLE "lesson_hands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	CONSTRAINT "lesson_hands_session_user_key" UNIQUE("lesson_session_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "lesson_hands" ADD CONSTRAINT "lesson_hands_lesson_session_id_lesson_sessions_id_fk" FOREIGN KEY ("lesson_session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_hands" ADD CONSTRAINT "lesson_hands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_hands_session_idx" ON "lesson_hands" USING btree ("lesson_session_id","raised_at");
--> statement-breakpoint
-- RLS + privileges: enabled with no policies, and every non-owner role shut out.
ALTER TABLE "lesson_hands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "lesson_hands" FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "lesson_hands" FROM anon, authenticated';
  END IF;
END $$;
