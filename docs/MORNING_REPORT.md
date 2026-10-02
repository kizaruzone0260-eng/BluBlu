# Утренний отчёт — ночь 2026-10-02 → 03:00

Ветка `overnight` в `Desktop/BluBlu` (отдельный git-репозиторий; main не тронут).
9 коммитов по этапам. Работал по правилам ночного задания: без вопросов, простые
варианты по ТЗ, всё решение — в DECISIONS.md, блокеры — в BLOCKERS.md.

## 1. Готовность по этапам

| Этап | Код | Чем подтверждён |
| --- | --- | --- |
| 0 каркас+спайк | ✅ (приёмка перенесена вами на «позже») | livekit.yaml сверен с официальным config-sample (выкинут мой выдуманный `static_user`, подтверждён rtc.udp_port/turn.*); compose с лимитами 4G/2G/1G/512M |
| 1 основа | ✅ | гонка 20 redeem на живом Postgres: ровно 1 победитель; права 404/403; ротация refresh + kill family; 429 троттлинг |
| 2 материалы | ✅ | magic-bytes (exe-под-.pdf → 415), Range 206, nosniff, квота 507, feed/scope, Tiptap-заметки, publish в ленту |
| 3 календарь | ✅ | RRULE wall-clock через DST (NY тест), scopes this/following/all, ICS-токены (UTC DTSTART), FullCalendar |
| 4 видеоурок | ✅ (медиа-плоскость — на сервере) | гранты LiveKit проверены живым декодером SDK (учитель admin; ученик camera+mic без screen; lecture-mode запрещает publish; после конца 404); WS started/ended; unauthorized 4401 |
| 5 доска+листки | ✅ | прямой WebSocket-клиент: правка учителя долетела ученику, правка ученика проигнорирована сервером, поздно вошедший получил полный снимок, страницы, снапшот в БД, SVG не inline |
| 6 Telegram | ✅ (без живого токена) | не-привязанный не получает ничего; напоминание 1 раз (идемпотентный скан); 429 retry_after; 403 блокирует; группа/личка без дублей; /link только админу; webhook с секретом |
| 7 укрепление | ✅ | см. ниже |

## 2. Что реально проверено (финальный чистый прогон)

Перед прогоном стёрты тестовые БД (`apps/api/.pgdata`, `apps/e2e/e2edata`):

```
pnpm install --frozen-lockfile   → Done
pnpm -r typecheck                → 0 ошибок
pnpm -r build                    → apps/api: migrations copied to dist
                                  apps/web: ✓ built in 1m 4s
pnpm --filter @klass/api test:integration (реальный Postgres 18.4, embedded):
  Test Files  14 passed (14)
       Tests  71 passed (71)
pnpm --filter @klass/e2e test    → 4 passed (Edge-канал, fake media флаги)
pnpm audit --prod  → No known vulnerabilities found
pnpm audit         → No known vulnerabilities found  (после апгрейдов
   drizzle-orm ^0.45, @fastify/static ^10, react-router-dom ^7, vite 7, vitest 4,
   overrides lodash-es 4.18.1, nanoid 3.3.19/5.1.16, esbuild ^0.28)
CJK-скан исходников → чисто (иероглифы в apps/web/dist — только встроенные i18n-чанки
   библиотек Excalidraw/Tiptap, в git не попадает: dist в .gitignore)
```

Бэкап-цикл прогнан локально целиком: сид → backup.sh (шифрование openssl) → restore.sh
в чистую БД `klass_r` → сверка счётчиков 7 таблиц — все MATCH; дешифрованный архив
файлов содержит UUID-номера файлов. Выводы — в PROGRESS.md (этап 7).

Лицензии: все добавленные ночью пакеты (embedded-postgres, fastify-plugin,
@fastify/multipart, @fastify/websocket, ws, rrule, grammy, pg-boss, @tiptap/*,
@excalidraw/excalidraw, @fullcalendar/*, livekit клиент/сервер-sdk, playwright) —
MIT/Apache-2.0/BSD-3/ISC; ни одной AGPL/source-available.

## 3. Что НЕ проверено и почему

1. **docker compose up / сборка образов arm64** — Docker не поставлен: два elevated-
   запуска `wsl --install` зависли без клика UAC (я не мог подтвердить). Команда на утро ниже.
2. **Живой RTC-звонок, TURN, mute/permission в реальном RoomService, lk load-test** —
   бинарник livekit-server скачать нельзя было в авто-режиме (классификатор), на
   сервере приёмка и запланирована (STAGE0_SPIKE.md).
3. **Доставка через настоящий Telegram Bot API** — токена нет (правило ночи: без внешних
   аккаунтов). Транспорт переключаемый: `TELEGRAM_TRANSPORT=telegram` + токен → всё
   заработает; логический транспорт протестирован.
4. **ICS в Google/Apple Calendar** — файл формата RFC 5545 (DTSTART UTC) отдается,
   но «открыть и увидеть» я проверить не мог.
5. **Кириллица и oʻ/gʻ в шрифте Virgil (Excalidraw)** — риск из ТЗ: тестов на рендер
   шрифта нет, нужна глазами проверка в браузере (2 минуты утром).
6. Ручная матрица устройств (iPhone/Android/слабая сеть) — по определению на сервере.
7. PWA-иконки — программные заглушки; sw/манифест — мои.

(Ничего из «Вне v1» не добавлял: записи уроков, ДЗ, чата, «поднять руку» и т.д. нет.)

## 4. Проблемы и обходы (из BLOCKERS.md)

- WSL/Docker без UAC → реальный Postgres для всех БД-тестов через embedded-postgres
  (порт 5433, совместим с `deploy/docker-compose.test.yml`).
- Нет pg_dump/psql в embedded-сборке → в backup/restore добавлен второй путь
  «логический дамп» (проверен), на сервере основной — pg_dump из контейнера.
- Скачивание playwright-chromium заблокировано → e2e на канале msedge.
- `rrule` CJS под ESM-рантаймом падал на проде-сборке → поправлен импорт (упало бы на
  сервере — поймано e2e-запуском dist, а не vitest-транформацией).
- Две гонки, найденные тестами и исправленные: удаление board-комнаты до окончания
  записи в БД; `addHook('onRoute')` после регистрации маршрутов (лимиты не применялись).

## 5. Что сделать утром (по важности)

1. **UAC-клик** (2 минуты): `wsl --install -d Ubuntu` → Docker Desktop →
   `docker compose -f deploy/docker-compose.test.yml up -d` (тот же DATABASE_URL_TEST),
   затем `cd deploy && docker compose up -d --build` — первая реальная проверка compose/arm64.
2. **Сервер + домен** → пройти `docs/STAGE0_SPIKE.md` (критерий этапа 0: звонок из двух
   сетей + экран со звуком; TURN-сертификат по разделу). Без этого шага платформа не принята.
3. Telegram: создать бота у @BotFather, вписать токен/секрет в `.env`, `TELEGRAM_TRANSPORT=telegram`,
   пересоздать контейнер api — проверить привязку/напоминание/группу.
4. Глазами 2 минуты: доска в Chrome — нарисовать текст «Привет, oʻ gʻ» (проверка шрифта Virgil);
   ICS-ссылка из профиля → Google Calendar.
5. Открытые вопросы ТЗ §12 (ученики до 18 — политика; количество учителей) — ответы влияют
   только на политику данных, код их переживёт.
6. Решения по вкусу: свои PWA-иконки (сейчас заглушки), дизайн-полировка.

Полезные команды: `pnpm --filter @klass/api test:integration`, `pnpm --filter @klass/e2e test`,
`bash deploy/scripts/backup.sh` / `restore.sh`. Весь журнал изменений ночи — git log ветки overnight.
