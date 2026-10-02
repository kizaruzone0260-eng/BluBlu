# Блокеры и обходы

## B-1. Docker Desktop не устанавливается без действий пользователя
- Пробовал: (1) `wsl --install --no-distribution --web-download` через elevated-процесс —
  UAC никто не подтвердил (заказчик спит), процесс остался висеть; (2) проверка статуса —
  «WSL не установлен»; (3) обход: поднял настоящий PostgreSQL локально через
  embedded-postgres (MIT, без админ-прав) — интеграционные тесты этапа 1 прогнаны зелёными.
- Наблюдение: `docker: command not found`; HypervisorPresent=True — после утреннего
  подтверждения UAC `wsl --install -d Ubuntu` + установка Docker Desktop заработают без
  перезагрузки в 99 % случаев.
- Предположение о причине: единственное, чего не хватает, — клик «Да» в UAC.
- Обход в коде: `apps/api/scripts/with-postgres.mjs` + `pnpm --filter @klass/api test:integration`
  совместимы с `deploy/docker-compose.test.yml` (тот же порт 5433 и креды).

## B-2. Нет домена/публичного IP для TURN — полный звонок «две сети» невозможен локально
- Обход: частичная проверка LiveKit на localhost возможна (без TURN) — план на этапе 4:
  поднять livekit-server (windows-бинарник из релизов) и соединить два ws-клиента через
  Playwright. Полная приёмка — на сервере (STAGE0_SPIKE.md).
