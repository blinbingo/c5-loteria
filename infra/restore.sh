#!/usr/bin/env bash
# Restore de um dump do C5 para um banco (por padrão, um banco de VERIFICAÇÃO,
# nunca o de produção, a menos que TARGET_DB seja passado explicitamente).
# Uso: DATABASE_URL=... ./restore.sh /opt/c5/backups/c5-XXXX.dump [target_db]
set -euo pipefail
DUMP="${1:?informe o arquivo .dump}"
TARGET_DB="${2:-c5_restore_check}"
: "${DATABASE_URL:?defina DATABASE_URL (aponta para o Postgres do C5)}"

# deriva host/port/user do DATABASE_URL para criar o banco alvo
BASE_URL="${DATABASE_URL%/*}"   # tira o /db do fim
psql "$BASE_URL/postgres" -c "drop database if exists $TARGET_DB;" -c "create database $TARGET_DB;"
pg_restore --no-owner -d "$BASE_URL/$TARGET_DB" "$DUMP"

echo "== verificação pós-restore =="
psql "$BASE_URL/$TARGET_DB" -tAc "select 'reconciled='||c5_assert_reconciled();"
echo "restore verificado em: $TARGET_DB"
