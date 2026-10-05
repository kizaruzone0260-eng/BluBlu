ALTER TABLE "users" ADD COLUMN "profile_completed_at" timestamp with time zone;--> statement-breakpoint
-- Name screen (task 2): an EXISTING account counts as complete iff both the
-- given and the family name are non-empty; everything else (seed teacher with
-- an empty family name included) must pass the «Имя и фамилия» screen once.
UPDATE "users" SET "profile_completed_at" = now()
 WHERE "name" <> '' AND "last_name" <> '' AND "profile_completed_at" IS NULL;--> statement-breakpoint
-- users stays RLS-protected; the new column inherits the table policy, and the
-- Data-API roles keep zero privileges on the table (mirrors db:secure).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "users" FROM anon, authenticated';
  END IF;
END $$;
