# Облачное демо BluBlu: Render + Supabase (+ LiveKit Cloud)

Цель: публичный адрес для показа клиенту без своего сервера. Бесплатно:
Render web service (free) + Supabase Free (Postgres) + LiveKit Cloud Build
(5000 participant-minutes/мес, дальше видео останавливается).

## Ограничения бесплатных тарифов — прочитать до демонстрации
- **Render free:** контейнер засыпает после ~15 минут простоя → первый запрос
  прогревается 30–60 с (покажите клиенту один раз заранее). **Постоянного диска
  нет**: загруженные файлы лежат в `/tmp` и исчезают при redeploy/перезапуске —
  для демо это нормально, для прода — нет (см. docs/DEPLOY.md: volume/S3).
  WebSocket реконнект в клиенте встроен (backoff до 10 с, свежий одноразовый
  билет), поэтому перезапуск Render ощущается как короткая переподписка.
- **Supabase Free:** 500 МБ, проект засыпает через 1 неделю без активности
  (будит консоль/первое подключение; при засыпании API отвечает 503 — redeploy
  не нужен, достаточно открыть проект).
- **Supabase Data API (PostgREST):** приложение ходит в Postgres напрямую и
  REST API не использует. Скрипт `pnpm --filter @klass/api db:secure`
  (SQL: `src/db/migrations/custom/secure-public.sql`, идемпотентен) включает
  RLS на всех таблицах схемы public без политик + отзывает привилегии у
  `anon`/`authenticated` (и по default privileges — новые таблицы тоже
  закрываются после повторного запуска). Роль `postgres` (владелец таблиц,
  DATABASE_URL приложения) RLS обходит — это ожидаемо.

## Пошагово
1. **Supabase.** Создать проект (регион ближайший к вам), Settings → Database:
   скопировать **Session pooler** host (`aws-0-<region>.pooler.supabase.com`),
   port 5432, user `postgres.<project_ref>`. Пароль — тот, что задан при
   создании проекта (латиница/цифры иначе URL-encode). Заполнить
   `DATABASE_URL` в `cloud.env` (файл вне репозитория, см. ниже).
2. **Миграции.** Два способа: локально `pnpm --filter @klass/api db:migrate`
   с DATABASE_URL из cloud.env, либо просто первый деплой — приложение
   применяет миграции при старте само.
3. **Render.** Запушить ветку в приватный GitHub-репозиторий → New → Blueprint →
   выбрать репозиторий → render.yaml подхватится (`repo:`/`region:` уже указаны;
   `autoDeploy: false` — пуши не перезапускают сервис, деплой вручную через
   Manual Deploy). В dashboard вписать значения для `sync: false`
   переменных из cloud.env (никогда не коммитить!).
4. После первого деплоя: скопировать `https://<name>.onrender.com` в
   `PUBLIC_URL` (ссылки уведомлений, CORS/CSRF, webhook Telegram) →
   Environment → Publish.
5. **Telegram (опционально):** @BotFather → токен в `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_MODE=webhook`, `TELEGRAM_TRANSPORT=telegram`; приложение само
   зарегистрирует `https://<PUBLIC_URL>/webhook/telegram` с секретом при старте.
6. **Учитель:** задать `SEED_TEACHER_EMAIL`/`SEED_TEACHER_PASSWORD` в
   cloud.env → вписать в Render → при старте на пустой базе создастся аккаунт
   (пароль в логи не попадает). Не задан — сид молчит.
7. **LiveKit Cloud:** значения `LIVEKIT_URL/KEY/SECRET` из cloud.env; клиент
   получает адрес от API (join/active/WS), в коде он не зашит.

## Файл секретов
`%USERPROFILE%\blublu-secrets\cloud.env` — вне репозитория, в git не попадает.
Имена переменных совпадают с render.yaml. После показа клиенту: удалить
тестовые данные или пересоздать базу в Supabase.

## Проверка после деплоя
- `GET https://<host>/api/health` → `{"status":"ok"}` (без версий/секретов).
- Вход учителем → создать класс → код → ученик с телефона → урок: видео идёт,
  доска открывается, обрыв WiFi → WS переподключается сам.
- Проверка RLS: `curl https://<ref>.supabase.co/rest/v1/users?select=id -H
  "apikey: <anon>" -H "authorization: Bearer <anon>"` → пустой массив `[]`.
