CREATE TYPE "public"."tg_draft_status" AS ENUM('selecting', 'collecting', 'formatting', 'needs_clarification', 'preview', 'publishing', 'published', 'failed', 'publish_unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tg_group_kind" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."tg_group_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."tg_item_kind" AS ENUM('text', 'link', 'photo', 'document');--> statement-breakpoint
CREATE TYPE "public"."tg_publication_status" AS ENUM('sending', 'sent', 'failed', 'uncertain');--> statement-breakpoint
CREATE TABLE "tg_bind_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tg_callback_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"once" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_draft_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"kind" "tg_item_kind" NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"url" text,
	"file_id" text,
	"file_unique_id" text,
	"file_name" text,
	"mime_type" text,
	"file_size" bigint,
	"caption" text DEFAULT '' NOT NULL,
	"source_message_id" bigint NOT NULL,
	"forwarded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_draft_items_source_key" UNIQUE("draft_id","source_message_id")
);
--> statement-breakpoint
CREATE TABLE "tg_draft_targets" (
	"draft_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tg_draft_targets_draft_id_group_id_pk" PRIMARY KEY("draft_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "tg_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" "tg_draft_status" DEFAULT 'selecting' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"formatted_text" text DEFAULT '' NOT NULL,
	"ai_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_provider" text DEFAULT '' NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tg_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" "tg_group_kind" DEFAULT 'offline' NOT NULL,
	"status" "tg_group_status" DEFAULT 'active' NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_groups_owner_chat_key" UNIQUE("owner_id","telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "tg_operators" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_operators_chat_key" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "tg_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"group_title" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"status" "tg_publication_status" DEFAULT 'sending' NOT NULL,
	"telegram_message_id" bigint,
	"error" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_publications_draft_group_key" UNIQUE("draft_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "tg_bind_tokens" ADD CONSTRAINT "tg_bind_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_callback_tokens" ADD CONSTRAINT "tg_callback_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_draft_items" ADD CONSTRAINT "tg_draft_items_draft_id_tg_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."tg_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_draft_targets" ADD CONSTRAINT "tg_draft_targets_draft_id_tg_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."tg_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_draft_targets" ADD CONSTRAINT "tg_draft_targets_group_id_tg_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_drafts" ADD CONSTRAINT "tg_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_groups" ADD CONSTRAINT "tg_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_operators" ADD CONSTRAINT "tg_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_publications" ADD CONSTRAINT "tg_publications_draft_id_tg_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."tg_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_publications" ADD CONSTRAINT "tg_publications_group_id_tg_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tg_bind_tokens_expiry_idx" ON "tg_bind_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tg_callback_tokens_expiry_idx" ON "tg_callback_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tg_draft_items_draft_idx" ON "tg_draft_items" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX "tg_drafts_owner_status_idx" ON "tg_drafts" USING btree ("owner_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tg_groups_owner_status_idx" ON "tg_groups" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "tg_publications_draft_idx" ON "tg_publications" USING btree ("draft_id");--> statement-breakpoint
/*
 * Telegram homework assistant (2026-10-22): новые таблицы получают ту же позу, что 0019–0032 —
 * ROW LEVEL SECURITY БЕЗ политик, PUBLIC/anon/authenticated теряют все привилегии. Приложение
 * ходит владельцем и RLS обходит, поэтому существующие запросы не меняются. Здесь лежат тексты
 * материалов и черновиков, поэтому это не формальность: Data API Supabase не должен их видеть.
 */
ALTER TABLE "tg_operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_bind_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_draft_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_draft_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_callback_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tg_operators','tg_groups','tg_bind_tokens','tg_drafts','tg_draft_targets','tg_draft_items','tg_publications','tg_callback_tokens'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
    -- anon/authenticated создаёт только Supabase; на обычном Postgres их нет (SQLSTATE 42704).
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;