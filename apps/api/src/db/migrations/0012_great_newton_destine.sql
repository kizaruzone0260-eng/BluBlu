ALTER TABLE "lesson_sessions" ADD COLUMN "mute_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- task 3: every migration keeps RLS on and the Data-API roles shut.
ALTER TABLE "lesson_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "lesson_sessions" FROM anon, authenticated';
  END IF;
END $$;
