CREATE TABLE "bot_sessions" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_blocklist" (
	"sender_chat_id" text PRIMARY KEY NOT NULL,
	"blocked_by" uuid,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_chat_id" text NOT NULL,
	"sender_user_id" uuid,
	"name" text NOT NULL,
	"class_hint" text NOT NULL,
	"class_id" uuid,
	"message" text NOT NULL,
	"teacher_user_id" uuid,
	"teacher_chat_id" text,
	"delivered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "bot_public_schedule" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_blocklist" ADD CONSTRAINT "contact_blocklist_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reports" ADD CONSTRAINT "contact_reports_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reports" ADD CONSTRAINT "contact_reports_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_reports" ADD CONSTRAINT "contact_reports_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- bot task: RLS on every new table + the Data-API roles shut (anon/authenticated).
ALTER TABLE "bot_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bot_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_blocklist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "classes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "bot_sessions" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "bot_updates" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "contact_reports" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "contact_blocklist" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "classes" FROM anon, authenticated';
  END IF;
END $$;
