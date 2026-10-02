CREATE TABLE IF NOT EXISTS "lesson_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"event_id" uuid,
	"room_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"lecture_mode" boolean DEFAULT false NOT NULL,
	"layout_state" jsonb DEFAULT '{"layout":"gallery"}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "lesson_sessions_room_name_unique" UNIQUE("room_name")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_class_idx" ON "lesson_sessions" USING btree ("class_id","started_at");