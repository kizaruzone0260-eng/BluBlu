#!/usr/bin/env bash
# Часть D2 (2026-10-16): прогон НАСТОЯЩИХ deploy/scripts/backup.sh и restore.sh против
# настоящего Postgres — не «модель формата», а обе команды целиком: дамп, шифрование,
# расшифровка, восстановление в пустую базу, сверка счётчиков и состояния RLS.
#
# Почему отдельным прогоном, а не тестом в наборе API: проверяются shell-скрипты, их формат
# файлов и отказ без пароля. Прежний набор (`shots-restore`, integration-тесты) трогал только
# логический путь через драйвер и никогда не звал сами скрипты — то есть «бэкап есть, а
# восстанавливать им нечем» оставалось не проверенным.
#
# Запуск (CI, job `backup-restore`, Postgres как сервис):
#   PGHOST=127.0.0.1 PGPORT=5433 PGUSER=klass PGPASSWORD=klass \
#     bash deploy/scripts/test-backup-restore.sh
# Локально — то же самое против своего Postgres.
#
# Выход: 0 — цикл прошёл; 1 — расхождение (что именно разошлось, видно из сообщения);
# 2 — проверка не состоялась (нет клиента, нет баз) и зелёным это быть не должно.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PGHOST:?PGHOST required (real Postgres)}"
PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-klass}"; PGPASSWORD="${PGPASSWORD:-klass}"
export PGHOST PGPORT PGUSER PGPASSWORD
SRC="${SOURCE_DB:-klass_backup_src}"
DST="${TARGET_DB:-klass_backup_dst}"
PASS="${TEST_BACKUP_PASSPHRASE:-fictitious-backup-passphrase-0123456789}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# backup.sh всегда тарит хранилище — каталог должен существовать; в шаге 6 он свой.
mkdir -p "$WORK/files-store"
export STORAGE_DIR="$WORK/files-store"

fail() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "FAIL: нужен '$1' (проверка не состоялась)" >&2; exit 2; }; }
need psql; need pg_dump; need openssl; need sha256sum

q() { psql -d "$1" -Atqc "$2"; }
quiet() { psql -q -v ON_ERROR_STOP=1 -d "$1" -c "$2" >/dev/null; }

echo "== 0. чистые базы и роли Supabase (чтобы ветки REVOKE в миграциях реально исполнялись)"
quiet postgres "DROP DATABASE IF EXISTS $SRC WITH (FORCE)"
quiet postgres "DROP DATABASE IF EXISTS $DST WITH (FORCE)"
for r in anon authenticated; do
  q postgres "select 1 from pg_roles where rolname='$r'" | grep -q 1 || quiet postgres "CREATE ROLE $r NOLOGIN"
done
quiet postgres "CREATE DATABASE $SRC"

echo "== 1. журнал миграций целиком (той же последовательностью файлов, что и приложение)"
n=0
for f in "$ROOT"/apps/api/src/db/migrations/[0-9]*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$SRC" -f "$f" >/dev/null
  n=$((n+1))
done
echo "   миграций применено: $n"
[ "$n" -ge 30 ] || fail "журнал короче ожидаемого ($n файлов)"

echo "== 2. сидим данные"
quiet "$SRC" "insert into users (id, role, name, last_name, email, password_hash, locale, locale_explicit, tz)
  values ('11111111-1111-4111-8111-111111111111','teacher','Backup','Owner','backup-owner@x.invalid','x','ru',true,'Asia/Tashkent'),
         ('22222222-2222-4222-8222-222222222222','student','Backup','Pupil','backup-pupil@x.invalid','x','ru',true,'Asia/Tashkent')"
quiet "$SRC" "insert into classes (id, teacher_id, name) values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','Класс бэкапа')"
quiet "$SRC" "insert into class_members (class_id, user_id) values ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222')"
quiet "$SRC" "insert into posts (class_id, author_id, kind, title, body) values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','material','Материал','тело')"
quiet "$SRC" "insert into notifications (kind, class_id, user_id, chat_id, payload, dedupe_key, send_at)
  values ('materialNew','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','9000000000',
          '{\"text\":\"дамп должен доехать\"}','backup-dedupe-1', now() - interval '1 hour')"
# новый enum-значение из 0031: ряд в `expired` обязан пережить цикл (это проверка, что dump/restore
# тащит и значения enum, добавленные миграцией, а не только таблицы)
quiet "$SRC" "insert into notifications (kind, class_id, user_id, chat_id, payload, dedupe_key, send_at, status)
  values ('reminder10m','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','9000000000',
          '{\"text\":\"просроченный ряд\"}','backup-dedupe-2', now() - interval '3 hour', 'expired')"

COUNTS_SQL="select 'users='||count(*) from users union all
            select 'classes='||count(*) from classes union all
            select 'class_members='||count(*) from class_members union all
            select 'posts='||count(*) from posts union all
            select 'notifications='||count(*) from notifications union all
            select 'expired_rows='||count(*) from notifications where status='expired' union all
            select 'sending_label='||count(*) from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typname='notification_status' and e.enumlabel='sending'"
RLS_SQL="select md5(string_agg(relname||'|'||relrowsecurity||'|'||coalesce((select count(*) from pg_policies p where p.tablename=c.relname)::text,'0'),',' order by relname))
           from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind='r'"
GRANTS_SQL="select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated')"

SRC_COUNTS="$(q "$SRC" "$COUNTS_SQL" | sort | tr '\n' ' ')"
SRC_RLS="$(q "$SRC" "$RLS_SQL")"
SRC_GRANTS="$(q "$SRC" "$GRANTS_SQL")"
echo "   до: [$SRC_COUNTS] rls=$SRC_RLS grants(anon/authenticated)=$SRC_GRANTS"
[ "$SRC_GRANTS" = "0" ] || fail "у anon/authenticated уже есть привилегии ($SRC_GRANTS) — база не в проде-позе"

echo "== 3. backup.sh БЕЗ пароля обязан отказать и не оставить открытого дампа"
# PGDATABASE везде ниже обязателен: `backup.sh` по умолчанию дампит базу `klass` (это имя inside
# compose). В CI такая база существует и пуста — без явного PGDATABASE скрипт делал «бэкап» пустой
# базы, `restore.sh` на пустом дампе говорит «db OK», и краснел только подсчёт строк сырой ошибкой
# psql. Первый же прогон этого цикла (38941834886) показал это дословно.
A="$WORK/noenc"; mkdir -p "$A"
if BACKUP_DIR="$A" ALLOW_UNENCRYPTED_BACKUP="" PGDATABASE="$SRC" bash "$ROOT/deploy/scripts/backup.sh" >"$WORK/a.log" 2>&1; then
  cat "$WORK/a.log" >&2; fail "backup.sh без BACKUP_PASSPHRASE завершился успешно"
fi
grep -q "ОТКАЗ" "$WORK/a.log" || fail "в отказе нет внятной причины: $(tail -3 "$WORK/a.log")"
[ -z "$(ls -A "$A")" ] || { ls -l "$A" >&2; fail "после отказа в каталоге остались файлы"; }

echo "== 4. backup.sh с ALLOW_UNENCRYPTED_BACKUP=1 (открытый формат) и с паролем"
B="$WORK/plain"; mkdir -p "$B"
ALLOW_UNENCRYPTED_BACKUP=1 PGDATABASE="$SRC" BACKUP_DIR="$B" \
  bash "$ROOT/deploy/scripts/backup.sh" >"$WORK/b.log" 2>&1 \
  || { cat "$WORK/b.log" >&2; fail "backup.sh (открытый режим) упал"; }
[ -n "$(find "$B" -maxdepth 1 -name '*.sql.gz' -print -quit)" ] || { ls -l "$B" >&2; fail "открытый дамп не создан"; }
# сам дамп обязан быть содержательным: пустая база даёт валидный gzip без единой таблицы.
# `grep -c`, а не `grep -q`: -q выходит на первом совпадении, gunzip ловит SIGPIPE, и под
# `set -o pipefail` это смерть прогона (проверено на 38956155368: `gzip: stdout: Broken pipe`).
DUMP_PLAIN="$(ls "$B" | grep '\.sql\.gz$' | head -1)"
CREATE_TABLES="$(gunzip -c "$B/$DUMP_PLAIN" | grep -c '^CREATE TABLE' || true)"
[ "${CREATE_TABLES:-0}" -ge 30 ] \
  || { gunzip -c "$B/$DUMP_PLAIN" | head -20 >&2; fail "в дампе таблиц $CREATE_TABLES — дампится не та база?"; }
if [ -n "$(find "$B" -maxdepth 1 -name '*.enc' -print -quit)" ]; then fail "в открытом режиме появился .enc"; fi
rm -rf "$B"/*

C="$WORK/enc"; mkdir -p "$C"
BACKUP_PASSPHRASE="$PASS" PGDATABASE="$SRC" BACKUP_DIR="$C" bash "$ROOT/deploy/scripts/backup.sh" >"$WORK/c.log" 2>&1 \
  || { cat "$WORK/c.log" >&2; fail "backup.sh (шифрование) упал"; }
DUMP_ENC="$(ls "$C" | grep 'sql\.gz\.enc$' | head -1 || true)"
FILES_ENC="$(ls "$C" | grep 'files-.*\.tar\.gz\.enc$' | head -1 || true)"
[ -n "$DUMP_ENC" ] && [ -n "$FILES_ENC" ] || { ls -l "$C" >&2; fail "нет шифрованных дампов (sql/files)"; }
if [ -n "$(find "$C" -maxdepth 1 -type f ! -name '*.enc' -print -quit)" ]; then fail "рядом с .enc лежат открытые файлы"; fi
# содержимое зашифровано: gzip-заголовок наружу не торчит
if head -c 2 "$C/$DUMP_ENC" | od -An -tx1 | grep -qi '1f 8b'; then fail "в .enc узнаётся gzip — шифрования нет"; fi

echo "== 5. restore.sh в пустую базу (расшифровка входит в скрипт)"
quiet postgres "CREATE DATABASE $DST"
RSTORE="$WORK/restored"; mkdir -p "$RSTORE"
STORAGE_DIR="$RSTORE/files-store" FILES_BACKUP="$C/$FILES_ENC" BACKUP="$C/$DUMP_ENC" \
BACKUP_PASSPHRASE="$PASS" PGDATABASE="$DST" \
  bash "$ROOT/deploy/scripts/restore.sh" >"$WORK/r.log" 2>&1 \
  || { cat "$WORK/r.log" >&2; fail "restore.sh упал"; }
grep -q "db OK" "$WORK/r.log" || fail "restore.sh не сказал 'db OK'"
# «db OK» на пустом дампе — не проверка: сначала схема, потом счётчики (иначе psql падает
# сырой ошибкой `relation "users" does not exist`, из которой не видно, что восстанавливать было нечем)
DST_TABLES="$(q "$DST" "select count(*) from information_schema.tables where table_schema='public'")"
[ "${DST_TABLES:-0}" -ge 30 ] \
  || { cat "$WORK/r.log" >&2; fail "в восстановленной базе $DST таблиц $DST_TABLES — схема не применилась"; }

DST_COUNTS="$(q "$DST" "$COUNTS_SQL" | sort | tr '\n' ' ')"
DST_RLS="$(q "$DST" "$RLS_SQL")"
DST_GRANTS="$(q "$DST" "$GRANTS_SQL")"
echo "   после: [$DST_COUNTS] rls=$DST_RLS grants=$DST_GRANTS"
[ "$SRC_COUNTS" = "$DST_COUNTS" ] || fail "счётчики разошлись: было [$SRC_COUNTS], стало [$DST_COUNTS]"
[ "$SRC_RLS" = "$DST_RLS" ] || fail "состояние RLS разошлось: $SRC_RLS → $DST_RLS"
[ "$DST_GRANTS" = "0" ] || fail "после восстановления у anon/authenticated есть привилегии: $DST_GRANTS"
# текст внутри строки тоже доехал (сравнение не по количеству, а по содержанию)
[ "$(q "$DST" "select payload->>'text' from notifications where dedupe_key='backup-dedupe-1'")" = "дамп должен доехать" ] \
  || fail "jsonb дампа не совпал"

echo "== 6. файлы хранилища: записанный байт обязан вернуться байтом"
FDIR="$WORK/store-src"; mkdir -p "$FDIR/files-store"; echo "klass-file-content-0123456789" > "$FDIR/files-store/probe.txt"
F2="$WORK/enc2"; mkdir -p "$F2"
STORAGE_DIR="$FDIR/files-store" BACKUP_PASSPHRASE="$PASS" PGDATABASE="$SRC" BACKUP_DIR="$F2" \
  bash "$ROOT/deploy/scripts/backup.sh" >"$WORK/f.log" 2>&1 || { cat "$WORK/f.log" >&2; fail "backup.sh с files не собрался"; }
FB="$(ls "$F2" | grep 'files-.*\.tar\.gz\.enc$' | head -1 || true)"
[ -n "$FB" ] || fail "нет шифрованного архива файлов"
R2="$WORK/restored2"; mkdir -p "$R2"
DSTDB2="${DST}2"; quiet postgres "DROP DATABASE IF EXISTS $DSTDB2 WITH (FORCE)"; quiet postgres "CREATE DATABASE $DSTDB2"
STORAGE_DIR="$R2/files-store" FILES_BACKUP="$F2/$FB" BACKUP="$(ls "$F2"/*sql.gz.enc | head -1)" \
BACKUP_PASSPHRASE="$PASS" PGDATABASE="$DSTDB2" bash "$ROOT/deploy/scripts/restore.sh" >"$WORK/f2.log" 2>&1 \
  || { cat "$WORK/f2.log" >&2; fail "restore.sh с FILES_BACKUP упал"; }
[ -f "$R2/files-store/probe.txt" ] || { find "$R2" -type f >&2; fail "файл хранилища не восстановился"; }
cmp "$FDIR/files-store/probe.txt" "$R2/files-store/probe.txt" || fail "байты восстановленного файла не совпали"

echo "== 7. временные расшифровки не остаются на диске"
if [ -n "$(find "$C" "$F2" -name '*.gz' ! -name '*.enc' -print -quit)" ]; then
  find "$C" "$F2" -name '*.gz' ! -name '*.enc' >&2
  fail "расшифрованный файл остался рядом с .enc"
fi

echo "OK: цикл backup → шифрование → восстановление проходит, счётчики, RLS и файлы совпадают"
