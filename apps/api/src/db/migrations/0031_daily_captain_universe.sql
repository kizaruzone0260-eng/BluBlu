-- Часть A (2026-10-16): очередь уведомлений бота — атомарный захват ряда, срок годности,
-- потолок попыток в ветке 429; вебхук — быстрый 200 и переобработка незавершённых.
--  * `notification_status` получает два значения: `sending` (ряд захвачен одним проходом и
--    больше никому не виден) и `expired` (ряд просрочен, отправлять его нельзя).
--    Значения добавляются ДО any use: drizzle проигрывает весь журнал одним транзакционным
--    прогоном, а PostgreSQL запрещает ИСПОЛЬЗОВАТЬ значение enum, добавленное в той же
--    транзакции (SQLSTATE 55P04 — так упал CI 2026-10-09 на 0024, см. 0007). Здесь значений
--    никто не использует, поэтому журнал с 0000 проходит целиком.
--  * `notifications.locked_at` — момент захвата; зависший `sending` старше 5 минут
--    возвращается в `pending` (процесс умер между отправкой в Telegram и записью итога).
--  * `notifications.starts_at` — начало события, ради которого поставлено напоминание.
--    Нужен для проверки свежести: «напоминание за 10 минут», отправленное спустя полчаса,
--    сообщает про уже идущий урок.
--  * `bot_updates.payload` + `processed_at` — журнал доставок знает не только «такое видела»,
--    но и что именно, и выполнено ли действие. Это то, что делает возможным ответ 200 сразу
--    после записи и переобработку на старте процесса.
--  * RLS: новых таблиц нет, новые колонки добавлены в две существующие. Поза доказана
--    тестом миграций с нуля: `relrowsecurity`, `relacl` без выдачи не-владельцу и
--    `has_column_privilege` для `locked_at` / `starts_at` / `payload` / `processed_at`.
ALTER TYPE "public"."notification_status" ADD VALUE 'sending' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."notification_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "bot_updates" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "bot_updates" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "starts_at" timestamp with time zone;
--> statement-breakpoint
-- Belt-and-braces: колонки унаследовали позу таблиц (0019/0021 — RLS без политик, владельцем
-- состоит только выдача через схему), но отзыв повторяется явно, чтобы «закрыть anon и
-- authenticated» относилось и к ним.
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bot_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "notifications" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "bot_updates" FROM PUBLIC;--> statement-breakpoint
/*
 * Роли `anon` и `authenticated` создаёт Supabase — на обычном Postgres (CI, локальный
 * embedded-postgres) их нет, а REVOKE на несуществующую роль это ошибка 42704, которая роняет
 * всю миграцию. Поза 0025/0030.
 */
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "notifications", "bot_updates" FROM anon, authenticated';
  END IF;
END $$;
