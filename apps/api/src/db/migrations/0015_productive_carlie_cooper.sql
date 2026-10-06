CREATE TYPE "public"."attachment_kind" AS ENUM('file', 'link', 'youtube', 'drive');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'scheduled', 'published');--> statement-breakpoint
CREATE TABLE "post_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"url" text,
	"title" text DEFAULT '' NOT NULL,
	"file_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_audience" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "post_audience_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "status" "post_status" DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_audience" ADD CONSTRAINT "post_audience_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_audience" ADD CONSTRAINT "post_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_attachments_post_idx" ON "post_attachments" USING btree ("post_id","position");--> statement-breakpoint
CREATE INDEX "post_audience_user_idx" ON "post_audience" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topics_class_idx" ON "topics" USING btree ("class_id","position");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Material task A: old free-text topics become real topics (one per class+name,
-- ordered by first appearance), and existing uploads become file attachments so
-- the feed reads a single table. Nothing is lost: rows only ADD.
INSERT INTO "topics" ("class_id", "name", "position")
SELECT "class_id", "topic", 0 FROM "posts" WHERE "topic" IS NOT NULL AND "topic" <> ''
GROUP BY "class_id", "topic" ORDER BY min("created_at");--> statement-breakpoint
UPDATE "posts" p SET "topic_id" = t."id"
 FROM "topics" t WHERE t."class_id" = p."class_id" AND t."name" = p."topic";--> statement-breakpoint
INSERT INTO "post_attachments" ("post_id", "kind", "title", "file_id", "position", "created_at")
SELECT f."post_id", 'file', f."original_name", f."id", 0, f."created_at" FROM "files" f;--> statement-breakpoint
-- Material task A: RLS on every new table + the Data-API roles shut.
ALTER TABLE "topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_audience" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "topics" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "post_attachments" FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON TABLE "post_audience" FROM anon, authenticated';
  END IF;
END $$;
