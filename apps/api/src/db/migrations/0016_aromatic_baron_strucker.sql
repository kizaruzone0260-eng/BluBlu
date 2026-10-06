CREATE TABLE "policy_acceptances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Legal task (Phase 2): RLS on the new table + the Data-API roles shut.
ALTER TABLE "policy_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "policy_acceptances" FROM anon, authenticated';
  END IF;
END $$;