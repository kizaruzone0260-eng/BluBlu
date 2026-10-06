# Video Call Regression Report

> Статус: **только диагностика**. Ничего не исправлено/изменено/закоммичено/запушено.
> Никаких правок кода, миграций, конфигов или зависимостей.
> Ветки: `overnight`. Прод: Render + Supabase, `autoDeploy:false` (деплои ручные).

---

## 1. Executive Summary

Проблема **не в WebRTC/LiveKit**. Приложение даже не доходит до `RTCPeerConnection`.
После нажатия «Video Lesson» пользователь оказывается на `!me` ветке роутера (Sign In),
потому что `POST /api/...` → **401** на авторизованном запросе → интерцептор `api()`
обнуляет access-токен → `App.refresh()` → `fetchMe()` → `null` → редирект на `/login`.

Наиболее вероятная первопричина — **миграция `0019` (коммит `155221a`, Part 1е)**: она включает
`ENABLE ROW LEVEL SECURITY` на **всех** таблицах публичной схемы. Если роль, под которой
приложение ходит в Supabase, **не является владельцем таблиц и не имеет `BYPASSRLS`**, то
`SELECT` из `users` начинает возвращать 0 строк, и `authenticate` отдаёт **401** на любом
защищённом запросе. Локально/CI этого не видно, потому что там приложение работает под ролью-
**владельцем** (`klass`/`postgres` owner), которая по умолчанию обходит RLS — поэтому весь набор
API (268) и e2e (41) зелёные, а прод ломается.

CONFIRMED (механизм) / LIKELY (конкретный триггер — требует одного SELECT на проде).

## 2. Reproduction Path

Login (валидная сессия) → открыть курс/класс → «Video Lesson» → SPA рендерит `/lesson` →
первый авторизованный запрос `GET /api/lessons/active?classId=…` (poll каждые 10 с) или
`POST /api/lessons/start` → **401** → `api()` (`apps/web/src/lib/api.ts:69-72`) вызывает
`tryRefresh()` → `/api/auth/refresh` не удаётся → `setAccessToken(null)` → срабатывает
`onAuthChange` → `App.refresh()` → `fetchMe()` (`apps/web/src/lib/api.ts:124-130`, ловит ЛЮБУЮ
ошибку и возвращает `null`) → в `App.tsx` `me===null` → блок `!me` → `<Routes>` → `Navigate to /login`.
Видео-комната/WebRTC не инициализируются вообще.

## 3. Architecture

- Frontend: `apps/web` React 18 + Vite, роутер react-router v6, TanStack Query.
- API client: `apps/web/src/lib/api.ts` (обёртка над `fetch`, single-flight refresh, 401-интерцептор).
- Backend: `apps/api` Fastify 5, Drizzle + postgres.js, `@fastify/rate-limit`, `@fastify/compress`, `@fastify/websocket`.
- Auth: собственные JWT access (15m, только в памяти JS) + httpOnly refresh-cookie с ротацией (`apps/api/src/services/auth.ts`, `plugins/auth.ts`, `lib/tokens.ts`).
- Router/guards: `apps/web/src/App.tsx` — состояние `me` (загружается из `/api/me`), ветки `policyAccepted`/`profileCompleted`/`mustChangePassword`/`Shell`/`!me`.
- Video: `apps/api/src/services/lessons.ts::buildJoinToken` (LiveKit `AccessToken`), `/api/lessons/:id/join`.
- WebRTC: `livekit-client` (`apps/web/src/pages/Lesson.tsx::joinRoom`).
- DB/auth provider: Supabase Postgres (роль в DATABASE_URL — на проде по ответу владельца `postgres`).

## 4. Auth Flow (execution chain)

1. `App` boot: `restoreSession()` → `POST /api/auth/refresh` (cookie) → новый `accessToken` → `setAccessToken`.
2. `refresh()` → `fetchMe()` → `GET /api/me` → `me`.
3. Любой защищённый запрос: `preHandler: app.authenticate` → `onRequest` читает Bearer → `verifyAccessToken` → затем `plugins/auth.ts:34-38`: `db.select().from(users).where(... and isNull(deletedAt))` → **если пусто → 401**.
4. Ответ 401 → `api()` → `tryRefresh()` → повтор; если refresh не прошёл → `setAccessToken(null)`.
5. `null` access → `App` рендерит `!me` → Login.

## 5. Video Lesson Flow (execution chain)

1. `/lesson?classId=` монтирует `Lesson.tsx`.
2. `status = useQuery(GET /api/lessons/active?classId=…, refetchInterval 10_000)` (`Lesson.tsx:143-150`) — **первый бэкенд-запрос пути**.
3. `joinRoom()` → `POST /api/lessons/:id/join` (`Lesson.tsx:355`) → токен LiveKit → `room.connect()` (только здесь начинается WebRTC).
4. WS-статус: `POST /api/ws/ticket` → `wss …/api/ws/lesson/:id?ticket=` (`Lesson.tsx:161-199`).
Execution обрывается на шаге 2/3 (401) — до шага 3 `room.connect` дело не доходит.

## 6. First Failure Point

- **Файл/функция:** `apps/api/src/plugins/auth.ts:30-45 loadAndCheck()` (используется `authenticate`/`authenticateTeacher`, т.е. всем путём lesson).
- **Код:** `const [u] = await opts.db.select().from(users).where(and(eq(users.id, req.user.id), isNull(users.deletedAt)))... ; if (!u) return reply.code(401).send({error:'unauthorized'})`.
- **Ожидаемо:** при валидном Bearer `u` находится → 200.
- **Фактически (прод):** `SELECT users` возвращает 0 строк → 401. Причина 0 строк — см. §7/§13 (RLS без политик для нероль-владельца).
- Это НЕ изменение кода auth-плагина (см. §12: `plugins/auth.ts` не менялся) — поведение изменилось из-за **DDL** миграции `0019`.

## 7. Authentication Analysis

- Логика `authenticate`/`verifyAccessToken`/`refreshCookieOpts` **не менялась** в `0d39641..HEAD`.
- Изменился только контракт `/api/me` (+`mustChangePassword`) — это не вызывает 401.
- `login()` теперь трогает `login_attempts` (Part 2) и `must_change_password` (Part 3) — это может ломать **вход**, но не «уже авторизован → logout на lesson». (Если бы 0017/0018 не применились, `server.ts` упал бы на boot — приложение работает, значит применились.)

## 8. Router / Guard Analysis

`App.tsx` — нет отдельного `<Guard>`; защита = условие `me ? … : (!me → /login)`.
Новая ветка `me.mustChangePassword ? <ChangePasswordGate/> : <Shell/>` (добавлена `6ad0341`) — **инертна**, пока флаг `true`; для обычного учителя `false`. Это НЕ логин (отдельный экран смены пароля), поэтому маловероятно как причина «редиректа на Sign In» — но проверяется одним SELECT (§18). Условие `!me` → `/login` — и есть точка, куда приводит цепочка §2.

## 9. API / Interceptor Analysis

`apps/web/src/lib/api.ts`:
```
if (res.status === 401 && accessToken) { if (await tryRefresh()) retry; else setAccessToken(null); }
```
Это и есть `handleUnauthorized()`-аналог. Любое 401 на авторизованном запросе (не важно,
lesson это или иной) сносит сессию. Запросы идут с Bearer (rawFetch добавляет) и
`credentials:'include'` — то есть запрос **с** токеном; 401 значит сервер не опознал юзера
(§6), а не «забыл заголовок». Отдельная проверка: ни один урок-запрос не утратил заголовок/cookie
в моих коммитах (diff `lib/api.ts` добавил только `changePassword`/`logoutAll`, их урок не дёргает).

## 10. Backend Analysis

- `/api/lessons/start` — `preHandler: app.authenticateTeacher` (не менялся).
- `/api/lessons/:id/join` — `authenticate` (не менялся); в diff затронут только `services/lessons.ts:61` (`ttl: env.RTC_TOKEN_TTL` вместо `'3h'`) — на валидность/права не влияет.
- Реальный backend «не опознаёт юзера» = §6 (RLS-фильтр), а не middleware-правку.

## 11. WebRTC Analysis

RULED OUT как первопричина: выполнение не доходит до `room.connect()`/`RTCPeerConnection`.
Приложение вылетает на auth-запросе пути. (LiveKit Cloud/TURN/ICE не трогались; e2e-RTC-спеки
`zz-camera`/`zz2`/`zz4` зелёные локально с реальным RTC, что подтверждает: media-слой рабочий.)

## 12. Git Regression Analysis (`0d39641..HEAD`)

| Commit | Файлы (релевантные) | Суть | Возможное влияние | Confidence |
|---|---|---|---|---|
| `9a95bd7` | `app.ts` | `/api/auth/*`+token/ticket вне сжатия; `compress` перенесён после `rateLimit` | Компрессия/стриминг. Не влияет на 401. WS-апгрейд до/после compress менялся порядком регистрации — проверить на проде (низкий риск) | POSSIBLE |
| `b159640` (Part2) | `login_attempts`+миграция 0017 | локаут по аккаунту | ломает ВХОД при проблемах с 0017, не «сессия→logout на lesson» | RULED OUT (для симптома) |
| `6ad0341` (Part3) | `App.tsx`,`/api/me`,`routes/auth`,`lib/api.ts` | гейт смены пароля, `/api/me`+mustChangePassword | гейт инертен при false; контракт не даёт 401 | POSSIBLE (гейт, см. §8/§18) |
| `57a55f3` (Part4) | `env.ts`,`lessons.ts`,`Lesson.tsx` | TTL через env; grace→5s; reconnect/heartbeat re-join | TTL/heartbeat не дают 401; grace лишь мягче | LOW |
| `155221a` (Part1) | миграция `0019`, `services/account.ts` | **RLS на ВСЕХ таблицах** + REVOKE | **если app-роль не owner/BYPASSRLS → SELECT пусто → 401 везде** | **PRIMARY (LIKELY)** |

Прямых правок auth-middleware в диапазоне нет — регресс идёт через **DDL/состояние данных**, а не код.

## 13. Root Cause Candidates

### Candidate A — миграция 0019 ломает чтение для непривилегированной app-роли (PRIMARY)
Evidence: `0019` выполняет `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY` по всем таблицам;
политик нет → нероль-владелец без `BYPASSRLS` видит 0 строк. `plugins/auth.ts:34-40` при пустом
результате → 401. Локально/CI владелец `klass` обходит RLS → зелёные (точное расхождение «локально
работает, прод нет»). Совпадает с «уже авторизован → через короткое время (poll `/api/lessons/active`) на логин».
Confidence: **HIGH на механизм 401→logout (CONFIRMED кодом)**; **MEDIUM на то, что именно роль на проде не owner/BYPASSRLS** (нужен один SELECT).

### Candidate B — прод-образ рассинхронизирован с БД из-за `autoDeploy:false`
Evidence: `render.yaml:16` `autoDeploy:false`; миграции применяются только при старте `dist/server.js`
(`server.ts:18-19`, fail-fast). Если запущен СТАРЫЙ образ, а фронт пересобран/или наоборот — контракты
`/api/me` (mustChangePassword) и таблицы 0017 могут не совпасть. Но fail-fast на `migrate()` ограничивает
это (несовпадение → 500, а не 401). Confidence: **MEDIUM/POSSIBLE**.

### Candidate C — Part3 гейт must_change_password=true на аккаунте учителя
Evidence: если `reset-teacher`/сброс учителем выставил флаг, `App` покажет экран смены пароля
(не логин, но визуально «карточка»). Confidence: **LOW** (это не «/login», и блокировал бы все экраны).

## 14. Confirmed Root Cause

CONFIRMED: **механизм** — 401 на авторизованном запросе пути урока → `api()`-интерцептор
(`lib/api.ts:70-72`) обнуляет токен → `fetchMe()` (`lib/api.ts:124-130`) → `null` → `App` редирект
на `/login`. WebRTC не достигается.
ПЕРВОПРИЧИНА (наиболее подтверждённая): DDL миграции `0019` (Part 1е) + роль прод-приложения без
полного обхода RLS. Требует одного read-only SELECT для перевода в CONFIRMED (§18).

## 15. Ruled Out Causes

- Логика backend-auth / verifyAccessToken / refreshCookieOpts / CORS / credentials / `Bearer`-заголовки — не менялись в диапазоне (см. diff).
- Refresh-reuse grace (Part 4б) — стал **мягче** (2s→5s), не можетcause ложный logout.
- RTC TTL (Part 4а) — токен остаётся валидным; не даёт 401.
- WebRTC/LiveKit/TURN/ICE — до инициализации не доходит; e2e-RTC зелёные.
- Локаут Part 2 — влияет на вход, не на «сессия→logout на lesson».

## 16. Recommended Fix (НЕ применён — только рекомендация)

Порядок действий для инженера, который будет чинить:
1. **Сначала диагностировать роль (см. §18).** Если app-роль не owner и не `BYPASSRLS`, миграция 0019
   блокирует чтение. Безопасные варианты:
   - выдать app-роли `ALTER ROLE <approle> BYPASSRLS;` (или ходить владельцем таблиц), ЛИБО
   - ограничить `0019` только закрытием `anon`/`authenticated` (PostgREST-роли) без тотального
     `ENABLE RLS` на таблицах, которые читает нероль-владелец, ЛИБО
   - добавить на каждую таблицу политику-разрешение для app-роли (по сути эквивалент owner-обхода).
2. Убрать `REVOKE ALL ON TABLE ... FROM PUBLIC`, если приложение полагается на гранты через PUBLIC.
3. Регресс-тест на проде (или на Supabase-стенде с НЕ-owner app-ролью) — сейчас этого покрытия нет:
   интеграционные/e2e-тесты ходят владельцем и не ловят RLS-блокировку. Добавить тест «app-роль не owner →
   authenticated-запрос 200».

## 17. Exact Files Likely Requiring Changes

- `apps/api/src/db/migrations/0019_rls_on_every_table.sql` (и, при необходимости, новый `0020` для коррекции).
- `apps/api/src/db/migrations/meta/_journal.json` + `meta/0019_snapshot.json` (если переписывать миграцию).
- Опционально: гранты/роли Supabase (вне репозитория) либо `plugins/auth.ts` — но код auth менять не нужно, править надо DDL/роли.

## 18. Verification Plan (после фикса)

Один read-only запрос на проде (не меняет данных):
```sql
select current_user,
       (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls,
       (select rolname from pg_class c join pg_roles r on r.oid=c.relowner
          where c.relname='users' and c.relnamespace='public'::regnamespace) as users_owner;
select count(*) as visible_users from users where deleted_at is null; -- если 0 при непустой БД → RLS блокирует
```
Ожидание: `bypassrls=true` ИЛИ `users_owner=current_user` (иначе Candidate A подтверждён).

Затем:
1. e2e: под `NODE_ENV=production` (Secure-cookie) прогнать `flow.spec`/`zz-camera` — «start lesson → joinRoom».
2. API-тест с НЕ-owner app-ролью: `GET /api/lessons/active` → 200 (не 401).
3. Полный набор (API/e2e/typecheck/build/security-scan) — как сейчас (268/41/чисто/0).
4. На живом проде: открыть video lesson, DevTools→Network — `/api/lessons/active` и `/join` должны быть 2xx.

## 18b. The single live datum that makes it CONFIRMED

Открыть прод-сайт, DevTools→Network→Preserve log, нажать Video Lesson и сказать статус
**первого не-2xx** перед редиректом (URL+код):
- `GET /api/lessons/active → 401` (body `{error:"unauthorized"}`) → Candidate A (RLS) подтверждён.
- `→ 500` → Candidate B (рассинхрон build/DB).
- экран смены пароля вместо урока → Candidate C.

## 19. Conclusion

Это **auth/session-редирект регресс, а не WebRTC**. Механизм доказан кодом (401→интерцептор→`fetchMe`
null→`/login`). Первичная причина, наиболее согласующаяся с «локально/CI зелёно, прод сломан», — тотальный
`ENABLE RLS` из миграции `0019` (Part 1е) при том, что локальные тесты и CI ходят ролью-владельцем (обходят
RLS), а прод-роль Supabase, вероятно, owner-обхода не имеет → `authenticate` получает 0 строк → 401 на пути
`/api/lessons/active` → редирект на Sign In. WebRTC-слой не трогается и не является причиной.

---

PRIMARY SUSPECT: `apps/api/src/db/migrations/0019_rls_on_every_table.sql` (коммит `155221a`) — `ENABLE ROW LEVEL SECURITY` на всех таблицах ломает `SELECT` для прод-роли приложения без `BYPASSRLS` → `authenticate` (`plugins/auth.ts:34-40`) → 401.
SECONDARY SUSPECTS: рассинхрон прод-образ/БД из-за `render.yaml autoDeploy:false` (Candidate B); Part3 гейт `must_change_password` (Candidate C, low).
RULED OUT: WebRTC/LiveKit/TURN; backend-auth логика (не менялась); refresh-grace (мягче); RTC TTL; Bearer/credentials/CORS; локаут Part2.
FIRST FAILURE: `plugins/auth.ts::loadAndCheck` возвращает 401 на первом lesson-запросе `GET /api/lessons/active?classId=…` (poll 10с) — интерцептор `apps/web/src/lib/api.ts:70-72` обнуляет токен → `App` → `/login`.
AFFECTED COMMITS: `155221a` (главный); `6ad0341`/`57a55f3`/`9a95bd7` — второстепенно.
AFFECTED FILES: `apps/api/src/db/migrations/0019_rls_on_every_table.sql` (+ meta journal/snapshot); опционально гранты/роли Supabase. Код приложения менять не требуется.
RECOMMENDED FIX: не применять вслепую — сначала §18 (один SELECT роли) и §18b (статус первого запроса на проде). Затем либо дать app-роли `BYPASSRLS`/ходьбу владельцем, либо сузить `0019` до закрытия только `anon`/`authenticated` без тотального `ENABLE RLS` для нероль-владельца, либо добавить разрешающие политики для app-роли. Убрать `REVOKE … FROM PUBLIC`, если он блокирует app-роль.
