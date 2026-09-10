#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# C5 — Provisionamento IDEMPOTENTE do VPS, TOTALMENTE ISOLADO do influcriator.
# ---------------------------------------------------------------------------
# NÃO toca em nada do sistema atual. Tudo do C5 usa nomes/dirs/portas próprios:
#   dir /opt/c5   |  serviço c5-web (porta 3002) + c5-worker  |  DB "c5" role "c5_app"
#   nginx: server block próprio  |  .env próprio  |  backups próprios
#
# Rode como root NO VPS. É seguro rodar várias vezes (idempotente).
# Este script NÃO é executado pela sessão de desenvolvimento — é para você (ou
# para o pipeline do C5) executar deliberadamente.
set -euo pipefail

C5_DIR=/opt/c5
C5_PORT=3002
DB_NAME=c5
DB_ROLE=c5_app
DB_PORT=5433                       # Postgres do C5 em porta própria (não a 5432 padrão)
PG_VERSION=16

echo "==> [1/7] Guard: nada de tocar no influcriator"
for reserved in /opt/influcriator-web /etc/systemd/system/influcriator-web.service; do
  [ -e "$reserved" ] && echo "    (detectado $reserved — NÃO será alterado)"
done

echo "==> [2/7] Pacotes base (idempotente)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y postgresql-$PG_VERSION nginx curl ca-certificates
# Node 20 (se ainda não houver)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> [3/7] Instância PostgreSQL isolada do C5 na porta $DB_PORT"
# Usa um cluster dedicado para o C5 (não compartilha o cluster padrão).
if ! pg_lsclusters | grep -q "$PG_VERSION *c5 "; then
  pg_createcluster $PG_VERSION c5 -p $DB_PORT --start
fi
pg_ctlcluster $PG_VERSION c5 start || true

echo "==> [4/7] Role + banco do C5 (idempotente)"
DB_PW="${C5_DB_PASSWORD:?defina C5_DB_PASSWORD no ambiente antes de rodar}"
sudo -u postgres psql -p $DB_PORT -tc "select 1 from pg_roles where rolname='$DB_ROLE'" | grep -q 1 \
  || sudo -u postgres psql -p $DB_PORT -c "create role $DB_ROLE login password '$DB_PW';"
sudo -u postgres psql -p $DB_PORT -tc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres psql -p $DB_PORT -c "create database $DB_NAME owner $DB_ROLE;"
# Postgres só em localhost (nunca exposto à internet)
CONF=/etc/postgresql/$PG_VERSION/c5/postgresql.conf
grep -q "listen_addresses = 'localhost'" "$CONF" || echo "listen_addresses = 'localhost'" >> "$CONF"
pg_ctlcluster $PG_VERSION c5 restart || true

echo "==> [5/7] Diretórios do C5"
mkdir -p "$C5_DIR"/{releases,shared,backups}
[ -f "$C5_DIR/shared/.env" ] || cat > "$C5_DIR/shared/.env" <<ENV
DATABASE_URL=postgres://$DB_ROLE:$DB_PW@127.0.0.1:$DB_PORT/$DB_NAME
PORT=$C5_PORT
SESSION_SECRET=$(head -c48 /dev/urandom | base64 | tr -d '/+=' | head -c48)
NODE_ENV=production
ENV
chmod 600 "$C5_DIR/shared/.env"

echo "==> [6/7] systemd (c5-web + c5-worker)"
cp "$(dirname "$0")/c5-web.service"    /etc/systemd/system/c5-web.service
cp "$(dirname "$0")/c5-worker.service" /etc/systemd/system/c5-worker.service
systemctl daemon-reload
systemctl enable c5-web c5-worker

echo "==> [7/7] nginx (server block do C5 — hostname vem por variável)"
: "${C5_SERVER_NAME:=_}"   # defina C5_SERVER_NAME=seu.dominio quando tiver o domínio
sed "s/__SERVER_NAME__/$C5_SERVER_NAME/g; s/__PORT__/$C5_PORT/g" \
  "$(dirname "$0")/nginx-c5.conf.template" > /etc/nginx/sites-available/c5.conf
ln -sfn /etc/nginx/sites-available/c5.conf /etc/nginx/sites-enabled/c5.conf
nginx -t && systemctl reload nginx

echo "OK: infra do C5 provisionada e ISOLADA. Nada do influcriator foi tocado."
echo "Próximo: publicar um release em $C5_DIR/current, rodar 'npm ci && npm run migrate' e 'systemctl start c5-web c5-worker'."
