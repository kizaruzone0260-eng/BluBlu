# Klass — платформа онлайн-уроков (self-hosted)

Аналог Google Classroom со встроенными видеоуроками (свой LiveKit SFU), доской
учителя (Excalidraw), личными листками учеников и Telegram-уведомлениями.
Один Docker Compose на ARM64 VM. Только свободные лицензии (MIT/Apache-2.0/BSD/ISC),
единственная внешняя зависимость — Telegram Bot API. Интерфейс: русский и узбекский.

## Структура

```
apps/web       React SPA (Vite, FullCalendar, Tiptap, Excalidraw, livekit-client, PWA)
apps/api       Fastify: auth (argon2id + JWT/refresh-ротация), классы, коды, материалы,
               календарь+ICS, уроки+LiveKit-токены+RoomService-модерация, доска-WS,
               листки, Telegram-бот (grammY) + очередь pg-boss, pino, healthcheck
apps/e2e       Playwright e2e (свой стек: embedded Postgres + api + собранный web)
packages/shared Zod-схемы, константы, локали ru/uz
deploy/        docker-compose.yml, Caddyfile, livekit.yaml, scripts/backup|restore.sh
docs/          DEPLOY.md · STAGE0_SPIKE.md · MIGRATION.md · SECURITY_CHECKLIST.md
               PROGRESS.md · DECISIONS.md · BLOCKERS.md · MORNING_REPORT.md
```

## Быстрый старт (dev, без Docker)

```bash
npm i -g pnpm
cp .env.example .env      # как минимум поменяйте JWT_SECRET/пароли
pnpm install && pnpm -r build

# 1) поднять локальный Postgres (без Docker, порт 5433) и оставить его висеть:
node apps/api/scripts/with-postgres.mjs
# 2) в другом терминале — миграции и seed-учитель:
DATABASE_URL=postgres://klass:klass@127.0.0.1:5433/klass pnpm --filter @klass/api db:migrate
DATABASE_URL=postgres://klass:klass@127.0.0.1:5433/klass pnpm seed:teacher
# 3) запуск:
DATABASE_URL=postgres://klass:klass@127.0.0.1:5433/klass pnpm dev:api   # + pnpm dev:web
```

## Тесты

```bash
pnpm --filter @klass/api test:unit          # юниты (без БД)
pnpm --filter @klass/api test:integration   # + реальный Postgres (embedded, порт 5433)
pnpm --filter @klass/e2e test               # Playwright (нужен `pnpm -r build`)
pnpm audit --prod                            # лицензионно-безопасностный минимум
```

Сейчас: **71 unit+integration, 4 e2e — все зелёные; audit: 0 уязвимостей.**

## Продакшен-деплой

См. `docs/DEPLOY.md` (порты Oracle Security List + ufw, TURN-сертификат, seed,
webhook бота, cron бэкапов, мониторинг) и `docs/STAGE0_SPIKE.md` (приёмка звонка
между двумя сетями — обязательный первый шаг на сервере).

## Модель доступа (кратко)

- Учителей создаёт владелец инстанса (seed); публичной регистрации учителей нет.
- Ученики входят в класс только по одноразовому 8-символьному коду (в БД — SHA-256,
  показ один раз, срок 1–30 дней, атомарный redeem, блок перебора).
- Чужой класс/объект отвечает 404 (не 403), чтобы не раскрывать существование.

## Что не проверено локально (утренний чеклист)

Живой звонок/TURN/нагрузка (нет Docker+домена), фактический Bot API (нет токена),
открытие ICS в Google/Apple, шрифты Excalidraw для oʻ/gʻ, иконки PWA — плейсхолдеры.
Полный список: `docs/MORNING_REPORT.md`.
