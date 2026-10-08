-- Chat replies (task 2, 2026-10-08).
--  * reply_to_id — the FK the task specifies: ON DELETE SET NULL, so deleting a quoted message
--    physically never fails and never takes the answer with it;
--  * reply_ref_id — the same id WITHOUT a constraint. Deletion of chat messages is physical (it
--    belongs to eraseAccount), and after the SET NULL nothing in the row would say a quote was
--    ever there: this column is what makes `replyTo.deleted = true` representable. It holds an id
--    only — no author name and no text of the deleted message are kept.
--  * RLS: no new table, no GRANT, no policy — chat_messages keeps the posture proven by
--    0019/0021 (the backend role owns it; `anon` / `authenticated` hold no privileges).
ALTER TABLE "chat_messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "reply_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_reply_to_idx" ON "chat_messages" USING btree ("reply_to_id");--> statement-breakpoint
CREATE INDEX "chat_messages_reply_ref_idx" ON "chat_messages" USING btree ("reply_ref_id");