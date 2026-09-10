#!/usr/bin/env bash
# ===========================================================================
# C5 — Provisionamento da infra base, TOTALMENTE ISOLADO do influcriator.com.
# ===========================================================================
# Uso:
#   provision-vps.sh --check    # (padrão) só INVENTÁRIO/verificação — NÃO altera nada
#   provision-vps.sh --apply    # aplica as mudanças (idempotente)
#
# Rode como root NO VPS. Nada aqui é executado pela sessão de desenvolvimento
# (ela não tem SSH). Seguro rodar várias vezes.
#
# ISOLAMENTO (nada compartilhado com o sistema atual):
#   C5:            dir /opt/c5 | c5-web (porta 3002) + c5-worker | cluster PG 16
#                  "c5" na porta 5433 (localhost) | DB "c5" role "c5_app" | .env próprio
#   RESERVADO (nunca tocar): /opt/influcriator-web | influcriator-web.service | porta 3001
#
# SEGURANÇA (ajuste importante em relação à 1ª versão):
#   * Enquanto NÃO houver domínio do C5, NÃO criamos/hab. server block do nginx e
#     NÃO damos reload no nginx — assim não há risco de afetar o site atual nem de
#     expor o C5 publicamente. A app fica só em localhost:3002.
#   * NÃO iniciamos c5-web/c5-worker no provisionamento (a aplicação ainda não foi
#     construída — isso é da fase seguinte). Só instalamos e habilitamos as units.
set -euo pipefail

MODE="${1:---check}"

# ---- Constantes do C5 (próprias, isoladas) --------------------------------
C5_DIR=/opt/c5
C5_WEB_PORT=3002
DB_NAME=c5
DB_ROLE=c5_app
DB_PORT=5433
PG_VERSION=16

# ---- Recursos RESERVADOS do sistema atual (nunca alterar) -----------------
RES_DIR=/opt/influcriator-web
RES_SVC=influcriator-web
RES_PORT=3001

log()  { echo -e "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
inventory() {
  log "================ INVENTÁRIO DO AMBIENTE (somente leitura) ================"
  log "\n[1] Serviço do sistema atual (influcriator):"
  if have systemctl; then
    log "    influcriator-web: $(systemctl is-active $RES_SVC 2>/dev/null || echo desconhecido) / $(systemctl is-enabled $RES_SVC 2>/dev/null || echo n/a)"
    log "    c5-web:           $(systemctl is-active c5-web 2>/dev/null || echo inexistente)"
    log "    c5-worker:        $(systemctl is-active c5-worker 2>/dev/null || echo inexistente)"
  else
    log "    (systemctl indisponível)"
  fi

  log "\n[2] Portas em uso (foco 3001/3002/5432/5433):"
  if have ss; then
    ss -ltnp 2>/dev/null | awk 'NR==1 || /:(3001|3002|5432|5433)\y/' || true
  elif have netstat; then
    netstat -ltnp 2>/dev/null | grep -E ':(3001|3002|5432|5433)\b' || echo "    (nenhuma dessas portas escutando)"
  else
    log "    (ss/netstat indisponíveis)"
  fi

  log "\n[3] Diretórios em /opt:"
  ls -1d /opt/*/ 2>/dev/null | sed 's/^/    /' || log "    (/opt vazio)"
  log "    $RES_DIR existe? $( [ -d "$RES_DIR" ] && echo SIM || echo não )"
  log "    $C5_DIR existe?  $( [ -d "$C5_DIR" ] && echo SIM || echo não )"

  log "\n[4] nginx:"
  if have nginx; then
    log "    instalado: sim ($(nginx -v 2>&1))"
    log "    server blocks (server_name/listen):"
    nginx -T 2>/dev/null | grep -E 'server_name|listen ' | sed 's/^/      /' | head -40 || true
  else
    log "    nginx NÃO instalado"
  fi

  log "\n[5] PostgreSQL:"
  if have pg_lsclusters; then pg_lsclusters 2>/dev/null | sed 's/^/    /'; else log "    postgres não instalado (sem pg_lsclusters)"; fi

  log "\n[6] Espaço em disco:"
  df -h / 2>/dev/null | sed 's/^/    /'

  log "\n[7] Node:"
  if have node; then log "    node $(node -v)"; else log "    node não instalado"; fi
  log "========================================================================="
}

# ---------------------------------------------------------------------------
guard() {
  log "\n==> GUARD de isolamento (aborta se algo puder afetar o sistema atual)"
  local fail=0
  # C5 nunca pode usar a porta/dir/serviço do influcriator
  [ "$C5_WEB_PORT" = "$RES_PORT" ] && { log "  ✗ C5_WEB_PORT == $RES_PORT (porta do influcriator)"; fail=1; }
  case "$C5_DIR" in "$RES_DIR"|"$RES_DIR"/*) log "  ✗ C5_DIR dentro de $RES_DIR"; fail=1;; esac
  # a porta do C5 não pode já estar ocupada por outro processo
  if have ss && ss -ltn 2>/dev/null | grep -q ":$C5_WEB_PORT\b"; then
    log "  ⚠ porta $C5_WEB_PORT já está escutando — verifique quem é antes de aplicar"; fi
  if have ss && ss -ltn 2>/dev/null | grep -q ":$DB_PORT\b"; then
    log "  ⚠ porta $DB_PORT já está escutando — verifique antes de aplicar"; fi
  if [ "$fail" = 1 ]; then log "\nABORTADO: configuração colidiria com o sistema atual."; exit 2; fi
  log "  ✓ sem colisão com $RES_DIR / $RES_SVC / porta $RES_PORT"
}

# ---------------------------------------------------------------------------
apply() {
  local HERE; HERE="$(cd "$(dirname "$0")" && pwd)"
  : "${C5_DB_PASSWORD:?defina C5_DB_PASSWORD no ambiente antes de --apply}"
  export DEBIAN_FRONTEND=noninteractive

  log "\n==> [1/6] Pacotes (só o necessário; nginx NÃO é instalado/alterado nesta fase)"
  apt-get update -y
  apt-get install -y "postgresql-$PG_VERSION" curl ca-certificates
  if ! have node || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    log "    node $(node -v) já atende (>=20) — não reinstala"
  fi

  log "\n==> [2/6] Cluster PostgreSQL ISOLADO do C5 (porta $DB_PORT, só localhost)"
  if ! pg_lsclusters 2>/dev/null | grep -qE "^$PG_VERSION +c5 "; then
    pg_createcluster "$PG_VERSION" c5 -p "$DB_PORT" -- --auth-host=scram-sha-256
  fi
  local CONF="/etc/postgresql/$PG_VERSION/c5/postgresql.conf"
  grep -q "^listen_addresses = 'localhost'" "$CONF" || echo "listen_addresses = 'localhost'" >> "$CONF"
  pg_ctlcluster "$PG_VERSION" c5 start || true

  log "\n==> [3/6] Role + banco do C5 (idempotente)"
  sudo -u postgres psql -p "$DB_PORT" -tAc "select 1 from pg_roles where rolname='$DB_ROLE'" | grep -q 1 \
    || sudo -u postgres psql -p "$DB_PORT" -c "create role $DB_ROLE login password '$C5_DB_PASSWORD';"
  sudo -u postgres psql -p "$DB_PORT" -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres psql -p "$DB_PORT" -c "create database $DB_NAME owner $DB_ROLE;"

  log "\n==> [4/6] Diretórios /opt/c5 (releases/current/shared/backups) + .env (600)"
  mkdir -p "$C5_DIR"/{releases,shared,backups}
  if [ ! -f "$C5_DIR/shared/.env" ]; then
    cat > "$C5_DIR/shared/.env" <<ENV
DATABASE_URL=postgres://$DB_ROLE:$C5_DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME
PORT=$C5_WEB_PORT
SESSION_SECRET=$(head -c48 /dev/urandom | base64 | tr -d '/+=' | head -c48)
NODE_ENV=production
ENV
    chmod 600 "$C5_DIR/shared/.env"
  fi
  # guarda o template do nginx para uso FUTURO (quando houver domínio) — sem ativar
  cp "$HERE/nginx-c5.conf.template" "$C5_DIR/shared/nginx-c5.conf.template"

  log "\n==> [5/6] systemd: instala e HABILITA c5-web/c5-worker (NÃO inicia ainda)"
  cp "$HERE/c5-web.service"    /etc/systemd/system/c5-web.service
  cp "$HERE/c5-worker.service" /etc/systemd/system/c5-worker.service
  systemctl daemon-reload
  systemctl enable c5-web c5-worker
  log "    (start só depois do 1º release + 'npm run migrate' — a app ainda não existe)"

  log "\n==> [6/6] nginx / exposição pública: DEFERIDO (sem domínio → sem server block)"
  log "    A app fica só em localhost:$C5_WEB_PORT. Nada público é aberto."
  log "    Quando houver domínio: C5_SERVER_NAME=seu.dominio, criar o block a partir"
  log "    de $C5_DIR/shared/nginx-c5.conf.template e recarregar o nginx então."

  log "\nOK: infra base do C5 aplicada e ISOLADA. Sistema atual não foi tocado."
}

# ---------------------------------------------------------------------------
inventory
case "$MODE" in
  --check) log "\nMODO --check: nenhuma alteração feita. Rode com --apply para provisionar."; guard ;;
  --apply) guard; apply ;;
  *) log "uso: $0 [--check|--apply]"; exit 1 ;;
esac
