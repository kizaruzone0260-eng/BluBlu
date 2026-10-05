ALTER TABLE "chat_messages" ADD COLUMN "edited_at" timestamp with time zone;
--> statement-breakpoint
-- chat item 7: the new editable column rides on chat_messages, which already
-- carries RLS. Re-assert it idempotently and keep the Data-API roles shut.
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "chat_messages" FROM anon, authenticated';
  END IF;
END $$;
