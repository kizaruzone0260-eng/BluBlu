# Klass — платформа онлайн-уроков (self-hosted)

ТЗ: `docs/` + исходный документ заказчика. Стек: React/Vite + Fastify/Drizzle/Postgres + LiveKit + Caddy,
один Docker Compose на ARM64 VM. Только MIT/Apache-2.0/BSD/ISC зависимости.

## Структура

```
apps/web      React SPA (ru/uz i18n с первого дня)
apps/api      Fastify: auth, классы, одноразовые коды, LiveKit токены
packages/shared  Zod-схемы, константы, локали ru/uz
deploy/       docker-compose.yml, Caddyfile, livekit.yaml, тестовый compose для Postgres
docs/         STAGE0_SPIKE.md — проверка звонка на сервере (этап 0)
```

## Локальная разработка (Windows/Linux)

```bash
corepack enable || npm i -g pnpm
cp .env.example .env      # в .env поменяйте JWT_SECRET и пароли
pnpm install
pnpm --filter @klass/shared build
pnpm db:generate          # миграции уже сгенерированы (0000_…)
# нужен Postgres (Docker Desktop/WSL):
docker compose -f deploy/docker-compose.test.yml up -d
pnpm --filter @klass/api db:migrate
pnpm seed:teacher         # создаёт учителя-владельца из .env
pnpm dev:api & pnpm dev:web
```

Без Docker на машине прогоняются только юнит-тесты:

```bash
pnpm --filter @klass/api test        # 14 unit + 7 integration (skipped без DATABASE_URL_TEST)
```

Интеграционные испытания (атомарность кода — гонка 20 параллельных, права доступа,
ротация refresh):

```bash
DATABASE_URL_TEST=postgres://klass:klass@localhost:5433/klass pnpm --filter @klass/api test
```

## Деплой (Oracle Cloud Free ARM64)

1. Ubuntu 24.04 aarch64, домен → IP сервера; заполнить `.env`.
2. Открыть порты в Security List **и** в ufw: 80/TCP, 443/TCP, 7881/TCP, 7882/UDP, 3478/UDP, 5349/TCP.
3. `cd deploy && docker compose up -d --build`
4. Пройти чеклист `docs/STAGE0_SPIKE.md` (звонок из двух сетей) — без этого дальше не идти.

## Статус этапов

| Этап | Что | Код | Проверка |
| --- | --- | --- | --- |
| 0 | каркас, compose, Caddy, LiveKit+TURN, spike-страница `/spike` | ✅ | ждёт сервера с доменом |
| 1 | аккаунты, классы, одноразовые коды, участники | ✅ | unit ✅ 14/14; race/права — нужен Postgres |
| 2–7 | материалы, календарь, урок, доска, листки, Telegram, укрепление | в работе | — |

Роли: учителя публичной регистрации нет — только seed или приглашение владельцем инстанса;
ученики — только по одноразовому коду. Коды: 8 символов без 0/O/1/I/L, в БД только SHA-256,
показ один раз, 5 попыток/мин → блок 15 мин, одинаковая ошибка для неверного/использованного/истёкшего.
