# Решения по ходу работы

## 2026-10-03 (этап 0–1)

- **Docker Desktop не установлен (нет ответа на UAC ночью).** Для реальных интеграционных
  тестов подняли PostgreSQL через пакет `embedded-postgres` (MIT; серверные бинарники —
  PostgreSQL License, BSD-подобная) на порту 5433, скрипт `apps/api/scripts/with-postgres.mjs`,
  команда `pnpm --filter @klass/api test:integration`. Тесты идут против настоящего Postgres
  18.4 (в проде по ТЗ — 16; SQL-возможности, используемые тестами, идентичны).
  При появлении Docker тесты совместимы с `deploy/docker-compose.test.yml` (порт 5433).
- **Лицензии:** все новые зависимости проверены: embedded-postgres MIT, fastify-plugin MIT,
  остальные изначальные — MIT/Apache-2.0/BSD/ISC. AGPL/SSPL/source-available не добавляны.
- **Refresh-ротация:** повторное предъявление заменённого токена удаляет всю family
  (все сессии пользователя) — стандартная защита от клонирования cookie; реализовано
  атомарным `UPDATE … WHERE replaced_at IS NULL RETURNING`.
- **Троттлинг кодов:** счётчик попыток свой (in-memory, `lib/throttle.ts`), т.к.
  @fastify/rate-limit не умеет «5/мин → блок 15 мин» одним конфигом; поверх стоит
  rate-limit 8/мин на login/register как страховка от перебора.
- **onRoute-хук с config.rateLimit регистрируется до подключения маршрутов** (найдено
  интеграционным тестом: после — лимиты маршрутов не применялись).
- **Spike-комнаты** LiveKit: `/^spike-[a-z0-9-]+$/` доступны авторизованным; lesson-комнаты
  появятся на этапе 4 (заглушка 501, чтобы раньше времени не выдавать права).
- **Гит:** рабочее дерево `Desktop/BluBlu` не было в репозитории (сверху лежал пустой репо
  Desktop) — инициализирован отдельный репозиторий в BluBlu, вся работа в ветке `overnight`.

## 2026-10-03 (проверка livekit.yaml, этап 0)

- **livekit.yaml сверен с official config-sample.yaml (master, 2026-10-03):** `rtc.udp_port`
  — одиночный UDP mux-порт (7882) существует; встроенный TURN настраивается ключами
  `rtc.turn.{enabled,udp_port,tls_port,domain,cert_file,key_file,external_tls}`;
  ключа `static_user` НЕ существует (я его придумал на этапе каркаса — удалён):
  TURN-креды участникам сервер выдаёт сам (HMAC от API-ключа, RFC 7065).
  `room.auto_create: false` — комнаты создаёт только наш API (права по членству).
  Конфиг переопределяется env по конвенции LIVEKIT_<YAML_PATH> (LIVEKIT_KEYS,
  LIVEKIT_RTC_TURN_DOMAIN, сертификаты — путями файлов в монтированном deploy/turn-certs).
- **Healthcheck livekit-контейнера** (`--health-check` флаг) оставлен по community-примеру —
  подтвердить при приёмке на сервере; если флаг не поддержан образом — заменить на TCP-probe 7880.

## 2026-10-03 (этап 6, Telegram)

- **pg-boss 12 (MIT) + grammY (MIT)** — лицензии проверены. pg-boss поднимает схему
  `pgboss` в той же БД; обработчик очереди только вызывает flush — вся идемпотентность
  в уникальном `notifications.dedupe_key`, поэтому дубль «heartbeat 30 c + очередь»
  безопасен.
- **Транспорт переключаемый:** `TELEGRAM_TRANSPORT=log|telegram`. Без токена работает
  LogTransport — система запускается и тестируется без внешних сервисов (ночное
  правило). Реальный Bot API включается одной переменной окружения.
- **Права /link:** админ группы проверяется getChatMember; дополнительно требующется,
  чтобы у инициатора был личный привязанный Telegram (связь tg-user↔аккаунт через
  chat_id личного чата == user id) — иначе непонятно, чей класс привязывать.
- **Тихие часы** считаются по локальному часу пользователя; `lessonStarted` — всегда
  сразу (§3.9).
- **FullCalendar закреплён на v6** (react v7 несовместим с плагинами v6).
- **scanReminders:** события сканируются на 48 ч вперёд, но строки создаются только
  когда момент срабатывания попадает в окно ближайших получаса — иначе
  24-часовые напоминания событий дальше 24 ч терялись бы (найдено тестом).

## 2026-10-03 (этап 7, финализация)

- **Обновления безопасности вместо «известных уязвимостей»:** drizzle-orm ^0.45,
  @fastify/static ^10, react-router-dom ^7, vite 7 / vitest 4, overrides lodash-es
  ^4.18.1, nanoid 3.3.19/5.x, esbuild ^0.28 — `pnpm audit` и `pnpm audit --prod`
  теперь «No known vulnerabilities found»; после каждого шага прогон 71 тест + 4 e2e зелёные. Все пакеты остаются
  MIT/Apache/BSD/ISC.
- **e2e без скачивания браузера:** канал msedge (Chromium-браузер системы); скачивание
  playwright-chromium и livekit-бинарника заблокировано политикой авто-режима —
  записано в BLOCKERS.
- **Бэкап-смол на dev-машине:** в embedded-postgres нет pg_dump/psql; скрипты имеют
  форк «логический дамп» (JSONL через драйвер + миграции при восстановлении),
  проверен циклом backup→openssl-шифрование→restore в чистую БД→сверка счётчиков.
  На сервере основной путь остаётся pg_dump из контейнера.
- **Доска не зависит от RTC:** рендерим при активной сессии даже до подключения к
  медиа-серверу (WS-статус/доска работают без WebRTC; видео — отдельная кнопка Join).
- **rrule-импорт:** rrule — CJS, в node-ESM именованный импорт падает → namespace-import.
- **PWA-иконки** — сгенерированные заглушки (scripts/gen-icons.mjs); дизайнерские —
  на усмотрение заказчика.

## 2026-10-03 (после аудита прав)

- **H2 закрыт билетам:** POST /api/ws/ticket → одноразовый SHA-256-хранимый билет
  (user+session, 30 c, атомарный consume UPDATE…RETURNING); WS принимают только
  ?ticket=; ?token= удалён из кода и тестов. Логи: pino-сериализатор режет query и
  redact-ит authorization/cookie; Caddyfile — фильтр log format (request>uri_query
  delete + request>uri>query delete; синтаксис из офиц. доков, проверить
  'caddy validate' при первом деплое).
- **CI:** .githooks/pre-commit (typecheck+unit, core.hooksPath включён локально) и
  .github/workflows/ci.yml (build+typecheck+unit+integration на postgres:16 service,
  отдельный job e2e с playwright chromium). Локальные интеграционные тесты в CI идут
  против service-PG через DATABASE_URL_TEST — тот же контракт, что with-postgres.mjs.

## 2026-10-04 (редизайн UI + три языка)

- **Шрифт Inter — self-hosted (SIL Open Font License 1.1).** OFL не входит в базовый
  whitelist TZ (MIT/Apache/BSD/ISC), поэтому фиксируется здесь: шрифт распространяется
  как данные (woff2 подмножества latin/latin-ext/cyrillic/cyrillic-ext в
  `apps/web/public/fonts/`, лицензия — `LICENSE.txt` рядом), модификаций нет,
  имя сохранено. Альтернатив под тем же требованием «кириллица + oʻ/gʻ (U+02BB),
  без Google CDN на рантайме» среди MIT/Apache-шрифтов немного (Noto Sans тоже OFL).
- **Третьий язык (en):** `app_locale` расширяется `ALTER TYPE ... ADD VALUE 'en'`
  (миграция 0007) — PG12+ разрешит это в транзакции мигратора.
- **FullCalendar локаль:** у @fullcalendar нет узбекского бандла — объект локали
  строится из Intl.DateTimeFormat (браузерный ICU: ru/uz/en) + i18n-ключи fc.* для
  кнопок; неделя с понедельника, 24-часовой формат.
- **Переключатель языка:** теперь дропдаун с ТЕКУЩИМ языком; смена сразу пишет
  и в localStorage, и в профиль (PATCH /api/me/profile) — прежняя подпись кнопки
  («следующий язык») и откат к профильному языку после refresh больше не конфликтуют.
- **Seed демо** ужат до одного учителя + пустой базы; demo-check строит все
  фикстуры сам через API (seed и тесты независимы).

## 2026-10-04 (проверка A–E)

- **Глобальный rate-limit поднят 300→1000 запросов/мин/IP**: загрузка SPA — ~30
  статических чанков + десятки API-вызовов на каждый hard-reload, живая прокладка
  e2e упиралась в лимит. Строгие лимиты auth (login 10/мин, register/join 8/мин,
  троттлинг кодов 5/мин) не тронуты — safety-net остался сетью от флуда.
- **restoreSession() через общий single-flight** с api()-обработчиком 401: два
  параллельных POST /api/auth/refresh с одним cookie = reuse → family-kill.
- **Автосохранение заметок копит pending-поля** (title+body за один дебаунс),
  иначе быстрая правка двух полей теряла первое.
- **UTF8 для всех embedded-кластеров** (with-postgres, e2e-stack, demo): нативный
  initdb от embedded-postgres с `-E UTF8 --locale=C`; на сервере PostgreSQL из
  официального образа и так UTF8.

## 2026-10-04 (ребрендинг BluBlu + rate-limit)

- **Бренд = одна константа:** `APP_NAME='BluBlu'` в packages/shared (+ overrides
  через `VITE_APP_NAME` для web). Видимые места берут её; внутренние идентификаторы
  НЕ трогали: пакеты @klass/*, БД `klass`, контейнеры/тома, env-переменные,
  ключи localStorage (klass_locale/klass_theme — иначе выкинули бы пользователей),
  UID событий ICS (`@klass` — иначе задвоятся в подписках). Тест brand.test.ts
  запрещает слово «Klass» в локалях, манифесте и собранном index.html.
- **Rate-limit (замена решения 300→1000 того же дня):** глобальный лимит вернулся
  к 300/мин/IP, но распространяется только на /api и /webhook — раздача статики
  исключена (`exclude` в @fastify/rate-limit). Всплески SPA-ассетов больше не
  сжигают квоту, API под сетью как было.
- **trustProxy — по env TRUST_PROXY (0/1), по умолчанию 0.** За Caddy (compose
  ставит TRUST_PROXY=1), cloudflared (demo-лончер) и Render заголовок
  X-Forwarded-For доверяется и auth-лимиты считают реальный IP клиента; без
  прокси заголовок не принимается (нельзя обойти лимит подделкой). Тест
  rate-limit.test.ts проверяет оба режима.

## 2026-10-04 (облачный деплой: Render + Supabase)

- **Grace-окно переиспользования refresh-токена (REFRESH_REUSE_GRACE_MS, по
  умолчанию 5 с, максимум 30 с):** браузер, отменивший запрос ротации
  (мгновенный reload во время бутстрапа), повторяет «съеденный» токен — раньше
  это считалось кражей и убивало family (нестабильность входа). Теперь повтор
  в пределах окна и при нетронутом преемнике молча выдаёт новую сессию;
  поздний повтор по-прежнему убивает family (тест с grace=0 сохраняет строгое
  поведение §4).
- **Supabase Data API закрывается скриптом db:secure** (RLS на все таблицы
  public + REVOKE anon/authenticated + default privileges), а не миграцией
  drizzle — приложение ходит в Postgres напрямую; владелец таблиц `postgres`
  RLS обходит по определению.
- **Render free:** постоянного диска нет → STORAGE_DIR=/tmp (файлы живут до
  перезапуска; для прода — volume/S3-совместимый провайдер), health-check
  GET /api/health без версий/секретов, WS-клиенты переподключаются с новым
  одноразовым билетом (backoff до 10 с).
