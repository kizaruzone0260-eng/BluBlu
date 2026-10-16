# Бэкап и восстановление

Один экран, который раньше был размазан по `DEPLOY.md`, `HARDENING.md` и `PROGRESS.md`.

## Что есть в репозитории

| Файл | Что делает |
|---|---|
| `deploy/scripts/backup.sh` | ежедневный дамп: `pg_dump` (compose или напрямую), при отсутствии `pg_dump` — `apps/api/scripts/logical-backup.mjs`; тар файлов хранилища; ротация `KEEP_DAYS` (7 по умолчанию) |
| `deploy/scripts/restore.sh` | расшифровка (если нужно) → `psql` с `ON_ERROR_STOP=1` или логическое восстановление из `*-logical.tar.gz` |
| `apps/api/scripts/logical-backup.mjs` | дамп/ресторе через драйвер: таблицы берутся из `pg_class` (новую вручную дописывать не надо), порядок FK — `session_replication_role='replica'` с тихим пропуском при непривилегированной роли, миграции применяются самим рестором |
| Шифрование | `openssl enc -aes-256-cbc -pbkdf2 -salt`, только если задан `BACKUP_PASSPHRASE`; оригинал после шифрования удаляется |

**Проверено тестом** `apps/api/test/integration/phase1-backup.test.ts`: дамп → шифрование →
неверная фраза НЕ восстанавливает → верная фраза даёт побайтовое совпадение → восстановление в
новую пустую базу → сверка счётников всех базовых таблиц и конкретного засеянного ряда.

**Не проверено ничем** (и это надо знать): сами shell-скрипты. Тест воспроизводит рецепт
openssl и вызывает логический путь напрямую, поэтому ветки `pg_dump`, compose, ротация и
тар файлов не исполнялись. На машине разработчика `pg_dump`/`psql` отсутствуют (в переносном
Postgres лежат только `postgres/initdb/pg_ctl`), так что эти ветки проверяются только там,
где они запускаются.

## Настройки

```
BACKUP_DEST=/var/backups/klass      # куда писать архивы
KEEP_DAYS=7                         # сколько хранить
BACKUP_PASSPHRASE=…                 # БЕЗ него архивы остаются открытым текстом
```

`BACKUP_PASSPHRASE` — единственное, что отделяет читаемый дамп всей школы (почта, имена,
тексты чата и заметок) от зашифрованного архива. Фраза не хранится в репозитории и не
выводится в логи; потерять её = потерять резервные копии.

## Cron на сервере

```
17 3 * * * klass BACKUP_PASSPHRASE=… /srv/klass/deploy/scripts/backup.sh >> /var/log/klass-backup.log 2>&1
```

В `render.yaml` cron-задачи нет: бэкап существует ровно настолько, насколько он поставлен на
сервере. Отдельный шаг, который никто не автоматизировал: **скопировать архив за пределы
сервера** (скрипт печатает об этом напоминание).

## Восстановление на пустую базу (учебный прогон, не аварийный)

```
createdb klass_restore_test
psql -d klass_restore_test -c 'drop schema public cascade; create schema public;'
BACKUP_PASSPHRASE=… node deploy/scripts/restore.sh /var/backups/klass/klass-<stamp>.sql.gz.enc \
  --database-url postgres://…/klass_restore_test
```

Дальше — минимум, который стоит посмотреть глазами: число строк в `users`, `classes`,
`class_members`, `whiteboards`; наличие `__drizzle_migrations` с тем же количеством
применённых записей, что в источнике; и то, что у новых таблиц включён RLS (`pg_class.relrowsecurity`),
потому что именно это приложение полагается на политики, а роль бэкенда их обходит.

## Supabase: шаги для владельца

`pg_dump` и `psql` на Supabase работают через connection string пула, но выполнять их должен
владелец со своей машины — у агента ни доступа, ни клиента:

1. Дамп:
   `pg_dump "postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres" | gzip -9 > klass-$(date +%Y%m%d).sql.gz`
   (порт 6543 — пулер; для `pg_dump` лучше прямой 5432, если он разрешён).
2. Шифрование той же командой, что в `backup.sh`:
   `openssl enc -aes-256-cbc -pbkdf2 -salt -in klass-<stamp>.sql.gz -out klass-<stamp>.sql.gz.enc -pass pass:"$BACKUP_PASSPHRASE"`.
3. Проверка расшифровки вслепую: `openssl enc -d … | gzip -t` — должно вернуть 0.
4. Тренировочное восстановление в **отдельную пустую базу** (не в продакшн): `createdb`
   → `restore.sh` → сверки из списка выше.
5. Отдельно проверить, что восстановленная база не отдаёт данные по `anon`/`authenticated`
   (тот же аудит, что делает `pnpm db:audit -- cloud.env`), потому что ресторе через
   сервис-роль политики не пересоздаёт, а переносит.

Живого `pg_dump`-бэкапа и восстановления на Supabase в этом отчёте нет: это действие владельца,
и оно не может быть доказано офлайн.
