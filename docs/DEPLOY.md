# Деплой на Oracle Cloud Free (и любой другой VPS)

Целевая машина: ARM64 (aarch64), 2 OCPU, 12 ГБ RAM, Ubuntu 24.04, диск 100–150 ГБ.
Все образы в `deploy/docker-compose.yml` multi-arch (проверены tags: postgres:16-alpine,
caddy:2.9-alpine, livekit/livekit-server:v1.8.2, node:22 для сборки api).

## 1. Раз

```bash
# docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

git clone <ваш-репозиторий> klass && cd klass
cp .env.example .env && nano .env     # DOMAIN, пароли, ключи LiveKit, JWT_SECRET
cd deploy && docker compose up -d --build
docker compose ps                     # все healthy
```

Домен должен заранее указывать на публичный IP (A-запись). Caddy сам получит
сертификат Let's Encrypt.

## 2. Порты (дважды!)

- Oracle Cloud Console → VCN → Security List → Ingress: 80/TCP, 443/TCP, 7881/TCP,
  7882/UDP, 3478/UDP, 5349/TCP.
- На самой VM: `sudo ufw allow 80/tcp 443/tcp 7881/tcp 7882/udp 3478/udp 5349/tcp && sudo ufw enable`.

## 3. Учитель-владелец

```bash
docker compose exec api node dist/scripts/seed-teacher.js \
  || docker compose exec api sh -c "node dist/scripts/seed-teacher.js"
```
(скрипт читает SEED_TEACHER_* из .env; альтернатива с хоста:
`docker compose exec -T api node /repo/apps/api/dist/scripts/seed-teacher.js` —
при необходимости поправьте путь под ваш образ; seed идемпотентен.)

## 4. Telegram (этап 6)

1. Создать бота у @BotFather, взять токен → `.env: TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_BOT_NAME`, `TELEGRAM_WEBHOOK_SECRET` (любая длинная строка).
2. `docker compose up -d api` — при старте api зарегистрирует webhook сам.
3. Инструкция привязки в интерфейсе (профиль + карточка класса).

## 5. TURN-сертификат

См. `docs/STAGE0_SPIKE.md`, раздел «TURN/TLS: сертификат».

## 6. Бэкапы

```bash
# /etc/cron.d/klass-backup
17 3 * * * root BACKUP_DIR=/var/lib/klass-backup BACKUP_PASSPHRASE=... \
  PATH=/usr/bin:/bin bash /opt/klass/deploy/scripts/backup.sh >> /var/log/klass-backup.log 2>&1
```
Копию складывать ВНЕ сервера (домашний ПК / бесплатное объектное хранилище).
Восстановление одной командой (например, после того как Oracle прибил простаивающий
инстанс и вы подняли новую VM с тем же репозиторием и .env):

```bash
cd klass/deploy && docker compose up -d postgres
LATEST=$(ls -1t ../deploy/backups/klass-*-logical.tar.gz ../deploy/backups/klass-*.sql.gz 2>/dev/null | head -1)
BACKUP="$LATEST" FILES_BACKUP="$(ls -1t ../deploy/backups/klass-files-*.tar.gz* | head -1)" \
  BACKUP_PASSPHRASE=... bash scripts/restore.sh && docker compose up -d
```

## 7. Мониторинг доступности

```bash
# once/min cron:
curl -sf -m 10 https://<домен>/api/health | grep -q '"db":"up"' \
  || echo "$(date -Is) DOWN" >> /var/log/klass-uptime.log
```
Простейший внешний вариант — любой бесплатный uptime-бот (например, self-hosted
Uptime Kuma, MIT) — при недоступности >5 мин. Лог контейнеров: `docker compose logs
--tail 200 api livekit caddy`. Логи api структурные (pino, stdout docker).

## 8. Проверка после КАЖДОГО деплоя

```bash
pnpm cloud:smoke -- --base https://<домен> --env <путь к cloud.env>
```

Скрипт (`apps/api/scripts/cloud-smoke.mjs`) ничего не пишет в данные: проверяет `/api/health`
и заголовки, Origin-гейт (свой адрес ≠ 403, чужой адрес и похожий на домен — 403,
`Sec-Fetch-Site: cross-site` — 403, `localhost` — 403), атрибуты cookie входа
(`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`), цепочку `/api/me` →
`/api/classes` → `/api/lessons/active`, состояние билета WS (404 на чужой session — значит
авторизация проходит, данных не создано), закрытый spike-эндпоинт (404), анонимный доступ
(401) и в конце отзывает собственную сессию через `/api/auth/logout`. Секреты, токены и
значения cookie в вывод не попадают.

Живой WebSocket урока проверяется только если урок уже идёт (запускать урок ради проверки
— это запись данных). Если открытой сессии нет, скрипт печатает `SKIP` и причину.

`403` на «refresh с OWN Origin» — это ровно тот сбой, из-за которого видеоурок выбрасывал
на вход: он означает, что адрес, с которого открывают интерфейс, не совпадает с
настроенным `PUBLIC_URL`/`PUBLIC_WEB_ORIGIN`. После фикса 896d355 такие запросы всё равно
проходят (совпадение Origin и Host запроса), но правильная конфигурация — `PUBLIC_URL` =
`PUBLIC_WEB_ORIGIN` = адрес, по которому реально открывают сайт; итог видно в логе старта
(`origins: allowed=[…] sameHost=on`).

Каталог безопасности базы (роли, владельцы, политики, привилегии `anon`/`authenticated`,
что реально видит приложение):

```bash
pnpm db:audit -- <путь к cloud.env> --require-data
```

## 9. Приёмочный чеклист после установки

1. `https://домен` → страница входа, HSTS в заголовках, замок в браузере.
2. Пройти `docs/STAGE0_SPIKE.md` (звонок из двух сетей + демонстрация экрана).
3. Регистр по коду, материалы (pdf/docx/mp4 Range), календарь + ICS в Google Calendar,
   доска (поздно вошедший ученик видит текущий рисунок), листки, Telegram-тесты.
4. Бэкап-цикл прогнан и восстановление проверено на копии.
