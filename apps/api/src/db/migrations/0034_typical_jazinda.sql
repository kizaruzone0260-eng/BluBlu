CREATE TYPE "public"."tg_material_kind" AS ENUM('book', 'workbook', 'other');--> statement-breakpoint
CREATE TYPE "public"."tg_material_status" AS ENUM('active', 'archived');--> statement-breakpoint
ALTER TYPE "public"."tg_draft_status" ADD VALUE 'choosing_materials' BEFORE 'collecting';--> statement-breakpoint
ALTER TYPE "public"."tg_draft_status" ADD VALUE 'awaiting_instruction' BEFORE 'collecting';--> statement-breakpoint
CREATE TABLE "tg_draft_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"material_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"kind" "tg_material_kind" DEFAULT 'other' NOT NULL,
	"telegram_file_id" text NOT NULL,
	"file_unique_id" text,
	"file_name" text DEFAULT '' NOT NULL,
	"mime_type" text DEFAULT '' NOT NULL,
	"file_size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_draft_materials_draft_file_key" UNIQUE("draft_id","telegram_file_id")
);
--> statement-breakpoint
CREATE TABLE "tg_material_groups" (
	"material_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tg_material_groups_material_id_group_id_pk" PRIMARY KEY("material_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "tg_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "tg_material_kind" DEFAULT 'other' NOT NULL,
	"telegram_file_id" text NOT NULL,
	"file_unique_id" text NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"mime_type" text DEFAULT '' NOT NULL,
	"file_size" bigint,
	"status" "tg_material_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "tg_materials_owner_file_key" UNIQUE("owner_id","file_unique_id")
);
--> statement-breakpoint
ALTER TABLE "tg_drafts" ADD COLUMN "instruction" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ADD CONSTRAINT "tg_draft_materials_draft_id_tg_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."tg_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ADD CONSTRAINT "tg_draft_materials_material_id_tg_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."tg_materials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_material_groups" ADD CONSTRAINT "tg_material_groups_material_id_tg_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."tg_materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_material_groups" ADD CONSTRAINT "tg_material_groups_group_id_tg_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tg_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_materials" ADD CONSTRAINT "tg_materials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tg_draft_materials_draft_idx" ON "tg_draft_materials" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX "tg_material_groups_group_idx" ON "tg_material_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "tg_materials_owner_status_idx" ON "tg_materials" USING btree ("owner_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tg_materials_owner_used_idx" ON "tg_materials" USING btree ("owner_id","status","last_used_at");
--> statement-breakpoint
/*
 * Библиотека материалов (2026-10-22, часть B): те же требования к доступу, что у 0033.
 * В `tg_materials` лежит название, которое преподавательница набрала сама, и `file_id`
 * Telegram — это всё ещё данные одного учителя, поэтому Data API их видеть не должен.
 * Приложение ходит владельцем и RLS обходит, существующие запросы не меняются.
 */
ALTER TABLE "tg_materials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_material_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tg_draft_materials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tg_materials','tg_material_groups','tg_draft_materials'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
    -- anon/authenticated создаёт только Supabase; на обычном Postgres их нет (SQLSTATE 42704).
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;