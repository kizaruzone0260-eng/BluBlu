-- Task G (2026-10-29). Additive only: no existing column is dropped or rewritten in place,
-- and the backfill makes the two new NOT NULL versions truthful for rows that predate them.
ALTER TABLE "policy_acceptances" ADD COLUMN "privacy_version" text;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "context" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
-- An old row agreed to the bundle tag of its day; naming it as both versions is the only
-- honest reading. It is NOT equal to the current versions, so those people are asked again.
UPDATE "policy_acceptances" SET "privacy_version" = "version", "terms_version" = "version";--> statement-breakpoint
ALTER TABLE "policy_acceptances" ALTER COLUMN "privacy_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ALTER COLUMN "terms_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_bind_tokens" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_bind_tokens" ADD COLUMN "used_chat_id" text;--> statement-breakpoint
ALTER TABLE "tg_bind_tokens" ADD CONSTRAINT "tg_bind_tokens_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "tg_materials" ADD COLUMN "storage_key" text;--> statement-breakpoint
-- Existing rows have no stored bytes: NULL is the honest state and the send path keeps
-- working through the Telegram message coordinates it already has.
