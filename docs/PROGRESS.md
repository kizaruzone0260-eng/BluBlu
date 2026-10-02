# Прогресс по этапам ТЗ

Формат: что сделано / что проверено (реальный вывод команд) / что не работает или не проверено.

## Этап 1 — основа (ГОТОВ, тесты зелёные)

Сделано: монорепозиторий (pnpm workspaces), схемы БД + миграция 0000, аккаунты (argon2id,
JWT 15 мин + refresh httpOnly SameSite=Lax с ротацией и обрывом family при переиспользовании,
seed-учитель), классы (CRUD/архив/участники/перенос), одноразовые коды (8 символов без
0/O/1/I/L, SHA-256+pepper в БД, показ один раз, TTL 1–30 дней, атомарный redeem
`UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`,
блок 15 мин после 5 попыток, одинаковая ошибка invalidCode), web-UI (login, регистрация по
коду, классы, панель кодов, участники, профиль), i18n ru/uz.

Проверено (реальный вывод, `pnpm --filter @klass/api test:integration`, Postgres 18.4 локально):

```
Test Files  6 passed (6)
     Tests  21 passed (21)
```

в их составе: гонка 20 параллельных redeem → ровно 1 успех; истёкший и отозванный код не
срабатывают; 404 для чужого класса; 403 ученику на teacher-маршруте; ротация refresh и
kill family; 429 codeRateLimited после 5 попыток; юниты генерации/хэша кода, argon2, JWT.

Не проверено: docker-окружение (нет Docker на машине, см. BLOCKERS.md).

## Этап 0 — спайк (код есть, приёмка на сервере)

Сделано: deploy/docker-compose.yml (caddy/livekit/postgres/api, лимиты памяти 4G/2G/1G/512M,
healthcheck, restart unless-stopped), Caddyfile (TLS, HSTS, /rtc прокси, /webhook/telegram),
livekit.yaml (проверен против официальной документации — см. ниже), страница /spike
(livekit-client, симулкаст/adaptiveStream/dynacast, экран+звук), выдача короткоживущего
серверного токена POST /api/rtc/token, docs/STAGE0_SPIKE.md с портами Oracle Security List + ufw.

Проверено: конфигурация livekit сверена с docs.livekit.io (см. DECISIONS от 2026-10-03, секция
этапа 0); токен-эндпоинт покрыт тестом? — нет, добавляется на этапе 4 (право доступа по членству).
Не проверено локально: фактический звонок между двумя сетями, TURN за NAT — требует сервера
с доменом. Это и есть критерий приёмки этапа 0, он осознанно отложен заказчиком («приёмка на
сервере будет позже»).
