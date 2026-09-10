#!/usr/bin/env bash
# Backup do banco do C5 (pg_dump custom-format). Retenção simples 7 diários.
# Rode via cron no VPS:  0 4 * * *  /opt/c5/current/infra/backup.sh
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL}"
DEST="${C5_BACKUP_DIR:-/opt/c5/backups}"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DEST/c5-$STAMP.dump"
pg_dump "$DATABASE_URL" -Fc -f "$FILE"
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
# mantém os 7 mais recentes
ls -1t "$DEST"/c5-*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f
