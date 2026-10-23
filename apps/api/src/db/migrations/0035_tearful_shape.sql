CREATE TYPE "public"."tg_media_type" AS ENUM('photo', 'document');--> statement-breakpoint
ALTER TABLE "tg_draft_items" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "tg_draft_items" ADD COLUMN "source_media_group_id" text;--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ADD COLUMN "media_type" "tg_media_type";--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ADD COLUMN "source_message_id" bigint;--> statement-breakpoint
ALTER TABLE "tg_materials" ADD COLUMN "media_type" "tg_media_type";--> statement-breakpoint
ALTER TABLE "tg_materials" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "tg_materials" ADD COLUMN "source_message_id" bigint;--> statement-breakpoint
ALTER TABLE "tg_publications" ADD COLUMN "parts" jsonb DEFAULT '[]'::jsonb NOT NULL;