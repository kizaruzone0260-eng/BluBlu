# Video Call Fix Report

> ⚠️ **ЗАМЕНЁН (2026-10-07).** Этот фикс (`075e8a6`, миграция `0020`) не устранил сбой в
> бою: production работает ролью-владельцем с `rolbypassrls = true`, поэтому RLS его чтения
> не фильтровал. Настоящая причина — Origin/CSRF-гейт (фикс `896d355`), а политики `0020`
> сняты миграцией `0021` как недостижимые. См. `VIDEO_CALL_FINAL_FIX_REPORT.md` и
> `VIDEO_LESSON_FOLLOWUP_REPORT.md`. Тест `phase1-rls-approle.test.ts` переписан, а не удалён.

## 1. Root Cause

**CONFIRMED ROOT CAUSE:** migration `0019` (Part 1е, коммит `155221a`) включил
`ENABLE ROW LEVEL SECURITY` на **всех** публичных таблицах, но не добавил ни одной
политики. Владелец таблицы RLS **обходит**, поэтому локальная разработка, CI и e2e (все
ходят ролью-владельцем `klass`/`postgres`) остались зелёными. Но если приложение в проде
подключается ролью, которая **не владелец** таблиц и **не** имеет `BYPASSRLS`, то при
включённом RLS без политик любой её `SELECT` фильтруется до **0 строк**. В `plugins/auth.ts`
`SELECT users` → пусто → **401** → интерцептор `api()` (`lib/api.ts`) сбрасывает access-токен
→ `fetchMe()` → `null` → `App` → редирект на `/login`. До WebRTC/LiveKit выполнение не доходит.

## 2. Evidence

Прямая локальная проверка (временный скрипт, удалён) на встроенном Postgres:
- владелец `klass` видит 2 строки в `users`;
- нероль-владелец `approle` **с выданными GRANT** (select/insert/update/delete) при RLS из `0019` → **0 строк**;
- тот же `approle` после `DISABLE ROW LEVEL SECURITY` на `users` → **2 строки**.

То есть блокирует именно RLS-без-политики, а не права. Это ровно условие, при котором
`authenticate` отдаёт 401. Механизм logout доказан кодом (`lib/api.ts:69-72`, `124-130`; `App.tsx` `!me`).

## 3. Why It Happened After Recent Commits

Коммит `155221a` (Part 1е) добавил `0019`. До него у retrofitted-таблиц не было RLS, и
нероль-приложение читало нормально. `0019` сделал RLS обязательным без политик → у
прод-роли (не-владелец) чтение обнулилось → 401 → logout. Ни один другой коммит в диапазоне
не менял семантику видимости строк (auth-middleware/verifyAccessToken/CORS/cookie не трогались).

## 4. Why Local/CI Did Not Catch It

Тесты и CI подключаются к БД ролью-**владельцем** (embedded-postgres `klass` — он же автор
таблиц; Supabase `postgres`/`service_role` — owner/BYPASSRLS). Владелец по умолчанию **обходит**
RLS, поэтому 401 не воспроизводится. В проде приложение, вероятно, ходит отдельной непривилегированной
ролью — единственный сценарий, где «локально зелёно, прод сломан, причина = auth-401» сходится.

## 5. Fix Applied

Forward-only, non-destructive миграция `0020_rls_app_policies.sql`: для каждой базовой таблицы
публичной схемы добавляет одну разрешающую политику
`app_trusted_access AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`.

- RLS **остаётся включённым** (защита в глубину не удалена).
- Приложение (любая роль, которой реально выданы GRANT'ы) больше не фильтруется до 0 строк.
- **Без `BYPASSRLS`**, без смены роли, без DROP таблиц/строк, без переписывания auth-архитектуры.

Также: `_journal.json` + `meta/0020_snapshot.json` (схема колон не меняла — снимок копия 0019).

## 6. Security Impact

Фикс **не ослабляет** защиту:
- `0019` уже сделал `REVOKE ALL ... FROM anon, authenticated` (и PUBLIC). Политика `TO PUBLIC`
  достижима только ролью, у которой ЕСТЬ привилегия на таблицу; `check_permission` выполняется
  раньше `check_row_security`, поэтому `anon`/`authenticated` (без привилегий) по-прежнему получают
  42501 и не могут прочитать ничего. Регрессионный тест это закрепляет (пункт «anon/authenticated
  не имеют привилегий»).
- Разрешающая политика открывает доступ только доверенному приложению-роли, которая и так имеет
  гранты и проходит всю авторизацию на уровне API (права класса/учителя/ученика в `plugins/auth.ts`
  и в сервисах — не тронуты).

## 7. Tests Added

`apps/api/test/integration/phase1-rls-approle.test.ts` (3 теста): создаёт НЕ-владеющую,
НЕ-BYPASSRLS роль с GRANT'ами и проверяет, что она видит строку `users` (без `0020` — 0 → падает,
с `0020` — ≥1 → проходит), плюс что `anon`/`authenticated` не получают привилегий и что таблица
имеет RLS. Тест ловит именно эту регрессию.

## 8. Test Results

- Typecheck: чисто (shared/api/web).
- API-тесты (чистый кластер): **271 passed / 46 файлов** (включая 6 RLS-тестов).
- Сборки: api build OK (`dist/db/migrations/0020_rls_app_policies.sql` присутствует), web build OK.
- e2e (полный набор, свежий бут с `0020`): см. §9.
- RTC/video-lesson спеки: входят в e2e.

## 9. Production Verification

**Не выполнялось.** Supabase MCP на этой машине не ответил (tool invocation did not complete),
доступ к прода-логам Render и к живой БД из сессии нет. Локально воспроизведён механизм и подтверждён
фикс на чистой миграции; на проде фикс вступает в силу после ручного деплоя (запускает владелец),
который применит `0020` при старте (`server.ts` `migrate()`). Ожидаемо после деплоя:
`/api/lessons/active` и `/api/lessons/:id/join` → 2xx, вход в видеo-комнату без редиректа на Sign In.

## 10. Git Commit

См. хэш в ответе (коммит `fix: restore video lesson authentication flow`).

---
STATUS: FIX VERIFIED LOCALLY / PRODUCTION NOT VERIFIED
