ALTER TABLE "invite_codes" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "kind" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;