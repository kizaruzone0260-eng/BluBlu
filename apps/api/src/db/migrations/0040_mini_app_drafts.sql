ALTER TABLE "tg_draft_items" ALTER COLUMN "source_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_drafts" ADD COLUMN "origin" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_drafts" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tg_drafts_owner_origin_idx" ON "tg_drafts" USING btree ("owner_id","origin","status","updated_at");