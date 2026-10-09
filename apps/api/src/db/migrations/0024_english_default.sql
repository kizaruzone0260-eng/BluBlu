-- Language default + persistence (task 1, 2026-10-09).
--  * locale_explicit — «did this person ever choose a language themselves?». Without it the
--    server cannot tell "English, because nobody cared" from "English, because that is what they
--    clicked", and the second one is the only value allowed to override the browser.
--  * the column default becomes 'en' (DROP DEFAULT first: drizzle emits only the drop), so a raw
--    SQL insert that names no locale gets English too, not the old 'ru'.
--  * ONE-TIME data step: every existing account gets 'en'. The flag did not exist before this
--    migration, so nobody's locale was ever recorded as chosen — which is exactly the case the
--    task says to move. Anyone who really picked a language keeps it: the sidebar switch and the
--    profile page have always PATCHed /api/me/profile, and that request is what sets the flag
--    from now on. Recorded in docs/DECISIONS.md.
--  * RLS: no new table, no GRANT, no policy. `users` keeps the posture proven by 0019/0021
--    (backend role owns it; anon/authenticated hold nothing) — asserted in
--    test/integration/locale-default.test.ts, which reads pg_class and has_table_privilege for
--    the NEW column specifically.
ALTER TABLE "users" ADD COLUMN "locale_explicit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
UPDATE "users" SET "locale" = 'en' WHERE "locale_explicit" = false;
