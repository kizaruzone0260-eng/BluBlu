#!/usr/bin/env bash
# Restore from backups: one command after a fresh `docker compose up -d postgres`
# or against any reachable Postgres (local test mode).
#   BACKUP=deploy/backups/klass-YYYYmmdd-HHMM.sql.gz ./restore.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
npath() { case "$1" in
  [A-Za-z]:*) printf '%s' "$1" | sed -E "s#^([A-Za-z]):[\\\\/]?#/\L\1/#; s#\\\\#/#g" ;;
  *) printf '%s' "$1" ;;
esac; }
ROOT="$(npath "$ROOT")"
BACKUP="$(npath "${BACKUP:?set BACKUP=/path/to/klass-*.sql.gz(.enc) or *-logical.tar.gz(.enc)}")"
FILES_BACKUP="$(npath "${FILES_BACKUP:-}")"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }

# Расшифровка идёт в отдельный каталог и удаляется по exit. Прежний вариант писал
# «klass-…sql.gz» РЯДОМ с «…sql.gz.enc» и не убирал: один восстановленный бэкап оставлял
# на диске открытую копию всей базы (проверка «временных расшифровок не остаётся» в
# test-backup-restore.sh поймала это дословно: четыре открытых файла в каталогах бэкапов).
TMPR="$(mktemp -d)"
cleanup() { rm -rf "$TMPR" "${TMPD:-}"; }
trap cleanup EXIT

maybe_decrypt() {
  local f="$1"
  if [[ "$f" == *.enc ]]; then
    [[ -n "${BACKUP_PASSPHRASE:-}" ]] || { echo "set BACKUP_PASSPHRASE for .enc file" >&2; exit 1; }
    local out="$TMPR/$(basename "${f%.enc}")"
    openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$BACKUP_PASSPHRASE" -in "$f" -out "$out"
    echo "$out"
  else echo "$f"; fi
}

DB=$(maybe_decrypt "$BACKUP")

if [[ -z "${PGHOST:-}" ]]; then
  COMPOSE="${COMPOSE:-docker compose -f $ROOT/deploy/docker-compose.yml}"
  echo "[restore] db via compose"
  gunzip -c "$DB" | $COMPOSE exec -T postgres psql -U klass -d klass -v ON_ERROR_STOP=1 \
    && echo "[restore] db OK" || { echo "[restore] db FAILED — is the schema clean? (drop/recreate klass db first)"; exit 1; }
  if [[ -n "$FILES_BACKUP" ]]; then
    FB=$(maybe_decrypt "$FILES_BACKUP")
    gunzip -c "$FB" | $COMPOSE exec -T api tar -xzf - -C /data
    echo "[restore] files OK"
  fi
else
  BIN="${PGBIN:-}"
  [[ -n "$BIN" ]] && PSQL="$BIN/psql" || PSQL=psql
  export PGUSER="${PGUSER:-klass}" PGPASSWORD="${PGPASSWORD:-$(getenv POSTGRES_PASSWORD)}"
  if command -v "$PSQL" >/dev/null 2>&1 || [[ -x "$PSQL" ]]; then
    "$PSQL" -d "${PGDATABASE:-klass}" -v ON_ERROR_STOP=1 -f <(gunzip -c "$DB") && echo "[restore] db OK"
  elif [[ "$DB" == *logical.tar.gz ]]; then
    echo "[restore] logical restore (migrations + JSONL)"
    TMPD="$ROOT/deploy/backups/.restore-tmp"; rm -rf "$TMPD"; mkdir -p "$TMPD"
    tar -xzf "$DB" -C "$TMPD"
    WIN="$(cygpath -w "$TMPD/dump" 2>/dev/null || echo "$TMPD/dump")"
    (cd "$ROOT/apps/api" && node scripts/logical-backup.mjs restore \
      in="$WIN" url="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE:-klass}")
    rm -rf "$TMPD"
  else
    echo "no psql available and dump is not logical — run restore in compose mode"; exit 1
  fi
  if [[ -n "$FILES_BACKUP" ]]; then
    FB=$(maybe_decrypt "$FILES_BACKUP")
    tar -xzf "$FB" -C "$(dirname "${STORAGE_DIR:-$ROOT/files-store}")"
    echo "[restore] files OK"
  fi
fi
echo "[restore] done — start app: docker compose up -d"
