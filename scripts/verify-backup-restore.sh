#!/usr/bin/env bash
# Verificação automatizada de BACKUP + RESTORE (usada localmente e no CI).
# Requer acesso de superusuário ao Postgres para criar o banco de verificação.
# Usa ADMIN_URL (superusuário) para criar/dropar; DATABASE_URL para o dump.
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL}"
ADMIN_URL="${ADMIN_URL:-$DATABASE_URL}"
BASE_ADMIN="${ADMIN_URL%/*}"
DUMP="$(mktemp -t c5XXXX).dump"

echo "== dump =="
pg_dump "$DATABASE_URL" -Fc -f "$DUMP"

echo "== restore em banco novo (c5_restore_check) =="
psql "$BASE_ADMIN/postgres" -v ON_ERROR_STOP=1 -c "drop database if exists c5_restore_check;" -c "create database c5_restore_check;"
pg_restore --no-owner -d "$BASE_ADMIN/c5_restore_check" "$DUMP"

echo "== verificação: reconciliação saldo=ledger no restaurado =="
psql "$BASE_ADMIN/c5_restore_check" -v ON_ERROR_STOP=1 -tAc "select c5_assert_reconciled();"
echo "BACKUP/RESTORE OK"
rm -f "$DUMP"
