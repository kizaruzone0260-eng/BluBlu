CREATE TABLE "login_attempts" (
	"email" text PRIMARY KEY NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Login lockout (part 2): RLS on the new table + the Data-API roles shut.
ALTER TABLE "login_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "login_attempts" FROM anon, authenticated';
  END IF;
END $$;
