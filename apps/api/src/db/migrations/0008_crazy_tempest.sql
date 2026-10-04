ALTER TABLE "teacher_notes" ALTER COLUMN "class_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_notes" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "teacher_notes" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;