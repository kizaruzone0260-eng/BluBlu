-- 'en' for the locale enum. Idempotent on purpose: 0000 now creates the type WITH 'en', because
-- drizzle replays the whole journal in a single transaction on a fresh database and PostgreSQL
-- refuses to let a migration USE an enum value added in that same transaction (SQLSTATE 55P04) —
-- which is exactly how 0024 (`users.locale` DEFAULT 'en') failed in CI on a fresh Postgres.
-- Existing databases already applied this migration and never replay it.
ALTER TYPE "public"."app_locale" ADD VALUE IF NOT EXISTS 'en';
