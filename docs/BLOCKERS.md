# Блокеры и обходы

## B-1. Docker Desktop не устанавливается без действий пользователя
- Пробовал: (1) elevated `wsl --install --no-distribution --web-download` через UAC —
  подтверждения не было (заказчик спал); (2) повтор после финализации — то же;
  (3) обход: настоящий PostgreSQL поднят локально через embedded-postgres (MIT, без
  админ-прав) — все интеграционные тесты прогнаны против живой БД.
- Наблюдение: `docker: command not found`; HypervisorPresent=True — после утреннего
  подтверждения UAC `wsl --install -d Ubuntu` + Docker Desktop должны встать без перезагрузки.
- Предположение о причине: не хватает только клика «Да» в UAC.
- Обход в коде: `apps/api/scripts/with-postgres.mjs` + `pnpm --filter @klass/api test:integration`
  совместимы с `deploy/docker-compose.test.yml` (тот же порт 5433 и креды klass/klass).

## B-2. Нет домена/публичного IP для TURN — звонок «две сети» невозможен локально
- Обход частичный: контракт урока (сессии, LiveKit-токены с проверкой грантов SDK,
  права, WS-статус) закрыт интеграционными тестами. Медиа-плоскость — на сервере
  (docs/STAGE0_SPIKE.md).

## B-3. Скачивание playwright-chromium и livekit-бинарников заблокировано политикой авто-режима
- Пробовал: `pnpm exec playwright install chromium` → Download failure, code=1;
  curl-загрузка portable PostgreSQL-утилит → остановлено классификатором (внешние
  исполняемые); загрузка релизного livekit-server (windows) — тот же запрет.
- Обход: e2e идут на канале msedge (системный Chromium) — 4/4 зелёные.
- Следствие утром: реальная RTC-публикация/mute на живом LiveKit и lk load-test
  не прогонялись. Решение: разрешить загрузку вручную (github.com/livekit/livekit
  releases) и запустить `livekit-server --config deploy/livekit.yaml` с LIVEKIT_KEYS —
  локальный полный звонок станет возможен; иначе приёмка на сервере.
- Также из-за отсутствия pg_dump/psql в embedded-сборке резервный путь бэкапа —
  логический дамп (см. DECISIONS, этап 7); на сервере основной путь — pg_dump из контейнера.

## B-4. Итог по средам
- Локально доказано: 71/71 unit+integration, 4/4 e2e, audit 0 (prod и dev),
  pnpm -r typecheck/build ✓, backup→шифрование→restore→сверка счётчиков ✓.
- Не покрыто объективно (нужны сервер/токены/браузеры): compose-поднятие, TURN,
  живой Bot API, ICS в Google/Apple, шрифты Excalidraw oʻ/gʻ, ручная матрица
  устройств, lk load-test.

## B-5. cloudflared отсутствует, загрузка внешнего бинарника заблокирована
- Пробовал: `curl` официальный релиз cloudflared-windows-amd64.exe из GitHub —
  авто-режим заблокировал скачивание/исполнение внешнего бинарника (классификатор).
- Обход: demo-лончер определяет `cloudflared` в PATH; без него печатает инструкцию
  и умеет `pnpm demo -- --no-tunnel` (всё локально, включая WS-проверки — 14/14 PASS).
- РЕШЕНО (2026-10-04): заказчик установил `winget install --id Cloudflare.cloudflared -e`
  (MSI кладёт бинарник в «C:\Program Files (x86)\cloudflared»); `pnpm demo` поднял живой
  https://….trycloudflare.com, `demo:check` сквозь туннель — 14/14 PASS
  (HTTP+SPA, WS урока, WS доски, одноразовые билеты, токен LiveKit с адресом из .env).
- Инструкция для новых машин: `winget install --id Cloudflare.cloudflared -e`
  (или cloudflared.exe из GitHub Releases в PATH).
