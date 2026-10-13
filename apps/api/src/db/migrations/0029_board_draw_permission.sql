-- Часть 3 (2026-10-14): «разрешить ученику рисовать на доске».
--  * `lesson_sessions.board_draw_all` — «разрешить всем», `board_draw_students` — множество
--    `userId → true`. Право живёт на СЕССИИ, а не в сокете и не в клиенте: ученик обновляет
--    страницу, переподключается, приходит позже лекции — разрешение должно остаться тем, каким
--    его сделал учитель, а отзыв — подействовать сразу (проверка на каждом сообщении доски).
--  * `whiteboards.authors` — карта `id элемента → userId` автора. Её пишет ТОЛЬКО сервер, из
--    идентичности сокета: поле `authorId` в теле сообщения не читается вообще, иначе «поддельный
--    автор» обходил бы запрет править чужое. Нужна для «ученик правит только своё» и для
--    учительского «удалить рисунки ученика».
--  * Новых таблиц нет, обе — существующие, posture RLS на них выставлен раньше (0019/0021:
--    приложение работает владельцем, anon и authenticated лишены прав). Поэтому политика здесь
--    не добавляется; это проверяет тест миграций с нуля: `pg_class` (relrowsecurity, relacl) и
--    `has_column_privilege` на каждую новую колонку.
ALTER TABLE "lesson_sessions" ADD COLUMN "board_draw_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD COLUMN "board_draw_students" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "authors" jsonb DEFAULT '{}'::jsonb NOT NULL;
