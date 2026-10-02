#!/usr/bin/env bash
# Daily backup: pg_dump + files volume, encrypted with a passphrase.
# Runs on the server via compose (default) or against any reachable Postgres
# (used by the local test: PGHOST/PGPORT/PGUSER override, PGBIN for tool path).
# cron example (server):  17 3 * * * BACKUP_PASSPHRASE=... /opt/klass/deploy/scripts/backup.sh
set -euo pipefail

# Windows Git Bash can hand back mixed C:\ paths — normalize to POSIX
npath() { case "$1" in
  [A-Za-z]:*) printf '%s' "$1" | sed -E 's#^([A-Za-z]):[\\/]?#/\L\1/#; s#\\#/#g' ;;
  *) printf '%s' "$1" ;;
esac; }
ROOT="$(npath "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"
DEST="$(npath "${BACKUP_DIR:-$ROOT/backups}")"
STORAGE_DIR="$(npath "${STORAGE_DIR:-}")"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M)"

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }

if [[ -z "${PGHOST:-}" ]]; then
  # Docker/compose mode: dump from the postgres container.
  COMPOSE="${COMPOSE:-docker compose -f $ROOT/deploy/docker-compose.yml}"
  mkdir -p "$DEST"
  echo "[backup] db dump (compose)"
  $COMPOSE exec -T postgres pg_dump -U klass -d klass | gzip -9 > "$DEST/klass-$STAMP.sql.gz"
  echo "[backup] files volume"
  $COMPOSE exec -T api tar -czf - -C /data files > "$DEST/klass-files-$STAMP.tar.gz"
else
  BIN="${PGBIN:-}"
  [[ -n "$BIN" ]] && PG_DUMP="$BIN/pg_dump" || PG_DUMP=pg_dump
  export PGUSER="${PGUSER:-klass}" PGPASSWORD="${PGPASSWORD:-$(getenv POSTGRES_PASSWORD)}"
  mkdir -p "$DEST"
  if command -v "$PG_DUMP" >/dev/null 2>&1 || [[ -x "$PG_DUMP" ]]; then
    echo "[backup] db dump via pg_dump ($PGHOST:$PGPORT)"
    "$PG_DUMP" -d "${PGDATABASE:-klass}" | gzip -9 > "$DEST/klass-$STAMP.sql.gz"
  else
    echo "[backup] pg_dump not found — logical dump via driver (JSONL/COPY-equivalent)"
    TMPD="$DEST/.tmp-$STAMP"; mkdir -p "$TMPD"
    WOUT="$(cygpath -w "$TMPD/dump" 2>/dev/null || echo "$TMPD/dump")"
    (cd "$ROOT/apps/api" && DATABASE_URL="${DATABASE_URL:-postgres://klass:klass@${PGHOST}:${PGPORT}/${PGDATABASE:-klass}}" \
      node scripts/logical-backup.mjs out="$WOUT" >/dev/null)
    tar -czf "$DEST/klass-$STAMP-logical.tar.gz" -C "$TMPD" dump
    rm -rf "$TMPD"
  fi
  echo "[backup] files dir ${STORAGE_DIR:-$ROOT/files-store}"
  SD="${STORAGE_DIR:-$ROOT/files-store}"
  tar -czf "$DEST/klass-files-$STAMP.tar.gz" -C "$(dirname "$SD")" "$(basename "$SD")"
fi

# Encrypt with openssl (aes-256-cbc, pbkdf2) if a passphrase is provided.
if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  for f in "$DEST"/*-"$STAMP".*; do
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$BACKUP_PASSPHRASE" -in "$f" -out "$f.enc"
    rm -f "$f"
  done
  echo "[backup] encrypted"
fi

# Rotate
find "$DEST" -type f -mtime "+$KEEP_DAYS" -delete
echo "[backup] done: $(ls -la "$DEST" | tail -3)"
echo "[backup] REMEMBER: copy $DEST off this server (home PC / free object storage) — see docs/DEPLOY.md"
