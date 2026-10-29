-- SEC-11 (2026-10-28): у класса не может быть двух активных уроков.
--
-- Инвариант держит частичный уникальный индекс ниже. Но прежде чем его создавать, нужно убрать
-- уже существующие нарушения: до этой правки `startLesson` делал SELECT и INSERT двумя запросами,
-- и два одновременных «Начать урок» оставляли в базе две строки с `ended_at IS NULL`. Индекс на
-- такой базе просто не создался бы, то есть миграция падала бы у всех, у кого гонка уже случилась.
--
-- Что делает UPDATE: для каждого класса оставляет активной САМУЮ НОВУЮ сессию (по `started_at`,
-- при равенстве — по `id`), а остальные аккуратно ЗАВЕРШАЕТ (`ended_at = now()`). Ничего не
-- удаляется и не переписывается: завершённый урок остаётся в истории ровно так же, как если бы
-- учитель нажал «Завершить». Это разовая уборка последствий гонки, а не изменение модели данных.
UPDATE "lesson_sessions" AS s
SET "ended_at" = now()
WHERE s."ended_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "lesson_sessions" AS newer
    WHERE newer."class_id" = s."class_id"
      AND newer."ended_at" IS NULL
      AND (newer."started_at", newer."id") > (s."started_at", s."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_sessions_one_active_per_class" ON "lesson_sessions" USING btree ("class_id") WHERE "lesson_sessions"."ended_at" is null;
