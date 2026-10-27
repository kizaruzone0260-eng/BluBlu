# Аудит прав доступа (§7 ТЗ) — 2026-10-03

Метод: перечислили все 64 HTTP-эндпоинта и 2 WS-обработчика, каждый сверен с тремя
требованиями §7 — членство в классе, роль, владение ресурсом; на каждый написан
тест-попытка доступа к чужим данным (`apps/api/test/integration/rights.test.ts`,
18 тестов: аноним → 401, чужой учитель/ученик → 404, ученик на teacher-маршруте → 403,
владение ресурсом → 404 для чужого id). Все тесты + прежние 71 зелёные (89/89),
e2e 4/4, typecheck/build чистые.

## Найденные дыры (исправлены в этот же проход)

### AUDIT-H1 · чужое событие можно было привязать к уроку своего класса
`POST /api/lessons/start {classId, eventId}` проверял владение классом, но **не** то,
что `eventId` принадлежит этому же классу. Эффект: сессия с чужим event ломала
навигацию «Войти в урок» (поиск активной сессии по eventId возвращала сессию чужого
класса → постоянный 404 для легитимных учеников) и позволяла «засорять» события
чужого класса ссылками на свои сессии. Данных это не раскрывало (join всё равно
проверяет членство), но это нарушение «владения ресурсом».
Фикс: `routes/lessons.ts` — сверка `event.classId === classId`, иначе 400.
Тест: «lesson session cannot bind an event of ANOTHER class» (ожидался 400, было 201).

### AUDIT-H3 · модерация завершённой сессии
`/end`, `/lecture-mode`, `/mute`, `/kick`, `/grant-screen`, `/layout` проверяли только
владение классом — по **завершённой** сессии учитель мог слать бессмысленные вызовы
RoomService (502) и широковещать WS-события «ended»-комнаты.
Фикс: `teacherSession()` теперь трактует `endedAt` как 404 (как несуществующую),
помимо прочего это делает `end` идемпотентным-без-эха.
Тесты: «moderation of an ENDED session → 404» + «self-kick 400» (учитель не может
выгнать самого себя из активной сессии — проверка была и ранее).

## Принятые решения (не дыры, но зафиксировано)

### AUDIT-H2 · токен в query WebSocket → заменён одноразовыми билетами (исправлено)
Раньше WS-URLы содержали access-JWT (`?token=…`): он переживает 15 минут, попадает в
access-лог Caddy (`request.uri_query`), в любые логи обратного прокси и в историю URL
браузера не бывает, но в логи Fastify (pino сериализует url с query) — да.
Реализовано: `POST /api/ws/ticket {sessionId}` (обычный Bearer-auth) выдаёт
**одноразовый билет TTL 30 с**, привязанный к (user, session); хранится только
SHA-256(hash(JWT_SECRET.билет)); consume — атомарный
`UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING` (тот же паттерн,
что и коды приглашений). Выдача билета требует членства и активной сессии.
Оба WS-обработчика принимают **только** `?ticket=` (поддержка `?token=` удалена).
Дополнительно: pino-сериализатор Fastify обрезает query у url и redact-ит
authorization/cookie-заголовки (`sanitizeRequestUrl`, юнит-тест); Caddyfile —
фильтр доступа-лога `request>uri_query delete` (+ `request>uri>query delete` для
новых Caddy) — синтаксис по официальной документации, проверить `caddy validate`
при первом деплое. Тесты: one-time (повтор → 4401), expired → 4401, чужой
session-scoped билет → 4401, выдача чужому классу → 404, «нет ни байта до auth»
сообщений сохранён.

### ICS-токен в URL (принято осознанно)
Длинные подписные ссылки Google/Apple Calendar требуют секрет в URL — так устроено
повсеместно. Токен попадает в path-часть и останется в access-логе сервера (видно
только владельцу сервера). Ротация — кнопка «Получить личную ссылку» (старая
ссылка инвалидируется: в БД один аккаунт = один хэш).

### Прочее
- **Чужой класс/ресурс = 404, не 403** — выдержано на всех маршрутах с :id; единое
  сообщение `{error:'notFound'}`.
- `/api/events?classId=<чужой>` возвращает `[]` (не 404) — маршрут не «по классу»,
  а «мои события с фильтром»; существование класса не раскрывается пустым ответом.
- **Прямое добавление ученика учителем без кода** (§3.2): учитель B может добавить
  любого существующего ученика (по uuid) в **свой** класс — само наличие uuid 128 бит,
  перебору не подвержено; добавление учителя/удалённого аккаунта отвергается (400).
- **ICS-токен в URL** — секрет в пути, HTTPS + HSTS; ротация инвалидирует старую
  ссылку (уникальный user_id, upsert по SHA-256).
- **LiveKit-токен**: выдаётся только члену класса и только активной сессии; гранты
  по роли (`canPublishSources` ученика исключает экран; admin только у учителя);
  identity=uuid пользователя — спутать участников нельзя; `kick`/`mute` обходят
  создателя.
- **Доска**: серверный гейт — сообщения вида `edits/newpage/switch/delpage`
  принимаются только от владельца класса (сверка `claims.sub` с owner сессии +
  resolveClass); ученики физически не могут писать (тестом доказано: сообщение
  ученика игнорируется сервером).
- **Листки/заметки**: все запросы фильтруются `WHERE user_id/teacher_id = проситель`,
  чужой id → 404; список листков учителям всегда `[]`.
- **telegram-эндпоинты профиля** — только свои; групповые настройки класса — только
  её учителю.
- **register/login/refresh** — публичные по смыслу; refresh дополнительно защищён
  SameSite=Lax + POST + проверкой Origin (CSRF-тест этапа 7).
- **auth-хук** перечитывает пользователя из БД на каждый запрос → удалённый аккаунт
  теряет доступ в пределах жизни 15-минутного access-JWT (принято; refresh отзывается
  мгновенно).

## Матрица маршрутов (проверка → чем подтверждено)

| Группа | Проверка | Тест |
| --- | --- | --- |
| /api/classes (+/:id PATCH, archive) | teacher=владелец, иначе 404 | rights: attack-loop 404 |
| /api/classes/:id/members (+lookup/add/remove/move/reset-password) | teacher-владелец; move: оба класса его; lookup — только чтение (2026-10-27, см. DECISIONS) | rights + stage1 + member-add-email |
| /api/classes/:id/invites (+revoke) | teacher-владелец | rights (14 атак 404) |
| /api/join-by-code, /classes/:id/leave | student-член | rights 403 teacher |
| /api/classes/:id/feed, materials, announcements, /api/posts/:id | членство/владение | rights + stage2 |
| /api/files/:id[/inline] | членство класса поста; outsider 404 | rights + stage2 |
| /api/notes[/id][/publish] | только автор, класс его | rights (B-атаки 404) |
| /api/events, /classes/:id/events (POST/PATCH/DELETE) | владение классом | rights + stage3 |
| /api/me/ical-token, /api/ical/:token | секрет-токен; изоляция tenant | rights ICS |
| /api/lessons/* (start/end/join/layout/lecture/mute/kick/grant) | членство+активность+роль; H1/H3 фиксы | rights + stage4 |
| /api/ws/lesson/:id, /api/ws/board/:id | одноразовый 30-с билет (user+session-bound) вместо токена; 4401/4404; 0 данных чужаку | rights WS tickets |
| /api/ws/ticket | Bearer-auth + членство + активная сессия; 404 чужому | rights WS tickets |
| /api/lessons/:id/board GET/PUT/publish | член/владелец+активность не требуется (off-lesson правка) | rights board |
| /api/student-notes CRUD | owner-only | rights sheets + stage5 |
| /api/me/telegram-link, notify-prefs, /api/classes/:id/telegram, link-token, notify-channel | свои/владелец | rights + stage6 |
| /webhook/telegram | секрет в заголовке, иначе 403 | stage6 |
| /api/rtc/token (spike) | авторизован; lesson-комнаты 501 | rights misc |
| /api/auth/* | публичные+CSRF | stage1 + stage7 CSRF |
| /api/health[/live] | публичные без данных | — |

Итог: три реальные проблемы (H1, H2 токены в логах, H3) исправлены; тесты на чужие
данные — постоянные (регрессия не пройдёт).

## CI / проверка на коммитах

- **pre-commit хук** (`.githooks/pre-commit`, включён локально
  `git config core.hooksPath .githooks` — на новом клоне выполнить один раз):
  `pnpm -r typecheck` + юнит-тесты api; падение = коммит не проходит.
- **GitHub Actions** (`.github/workflows/ci.yml`): push/PR →
  typecheck, build, vitest unit+integration (реальный Postgres 16 как service-контейнер,
  DATABASE_URL_TEST), затем job e2e (Playwright chromium, свой embedded-PG стек).
  Пакеты в CI: node 22, pnpm из packageManager-поля, `--frozen-lockfile`.
- **Аудит зависимостей — блокирующий с 2026-10-27.** Шаг `node scripts/audit-gate.mjs`
  в job `build-test` до этого нёс `continue-on-error: true` (с 2026-10-16), то есть ровно то,
  против чего шаг был написан: high-находка печаталась, джоба оставалась зелёной. Флаг снят
  после того, как находки закрыты по существу (zod 4.6.7, dompurify 3.4.17, fast-uri 3.1.9 и
  4.2.3, fastify 5.12.7), а не после того, как их стало неудобно замечать. Из списка известных
  удалена и устаревшая запись `braces` — в lock-файле 3.0.3 (запатченная версия), находка
  больше не выдаётся, а мёртвая строка в allowlist молча приняла бы следующий удар по этому
  пакету. Остаётся одна запись: `katex` (low — гейт на high/critical её не блокирует;
  патчер требует mermaid 12, это отдельная работа). Непрочитанный аудит по-прежнему exit 2:
  «не посмотрели» ≠ «чисто».
