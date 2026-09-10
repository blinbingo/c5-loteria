#!/usr/bin/env bash
# ===========================================================================
# C5 — Provisionamento da infra base, TOTALMENTE ISOLADO do influcriator/lotarium.
# ===========================================================================
# Uso:
#   provision-vps.sh --check    # (padrão) só INVENTÁRIO/verificação — NÃO altera nada
#   provision-vps.sh --apply    # aplica as mudanças (idempotente)
#
# Rode como root NO VPS. Nada aqui é executado pela sessão de desenvolvimento
# (ela não tem SSH). Seguro rodar várias vezes.
#
# ---- CONFIGURAÇÃO CENTRAL (fonte única; nada de número espalhado) ----------
# A porta do C5 é definida UMA vez aqui (C5_WEB_PORT) e reutilizada por todos os
# derivados: o .env (lido pelos serviços systemd) e o nginx (via placeholder).
# Pode ser sobrescrita por variável de ambiente sem editar o arquivo.
C5_WEB_PORT="${C5_WEB_PORT:-3005}"     # porta do c5-web (isolada; 3001=influ, 3002=lotarium)
C5_DIR="${C5_DIR:-/opt/c5}"
DB_PORT="${C5_DB_PORT:-5433}"          # cluster Postgres do C5 (isolado)
DB_NAME=c5
DB_ROLE=c5_app
PG_VERSION=16
C5_SERVICES=(c5-web c5-worker)

# ---- Recursos RESERVADOS (nunca colidir / nunca alterar) -------------------
RES_DIR=/opt/influcriator-web
RES_SVC=influcriator-web
RESERVED_PORTS=(3001 3002)             # 3001 influcriator · 3002 lotarium(next-server)
RESERVED_DIR_GLOBS=(/opt/influcriator /opt/lotarium)   # + qualquer sufixo
RESERVED_SVC_PREFIXES=(influcriator lotarium)

MODE="${1:---check}"
log()  { echo -e "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# Portas TCP em LISTEN. Robusto: usa /proc/net/tcp{,6} (sempre presente, estado
# 0A=LISTEN, porta em hex) E também o ss quando existe. Não depende só do ss.
listening_ports() {
  {
    awk '$4=="0A"{split($2,a,":"); print a[2]}' /proc/net/tcp /proc/net/tcp6 2>/dev/null \
      | while read -r h; do [ -n "$h" ] && printf '%d\n' "0x$h"; done
    have ss && ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'
  } | sort -u
}
port_in_use() { listening_ports | grep -qx "$1"; }
svc_active()  { have systemctl && systemctl is-active --quiet "$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
inventory() {
  log "================ INVENTÁRIO DO AMBIENTE (somente leitura) ================"
  log "\n[1] Serviços:"
  if have systemctl; then
    log "    influcriator-web: $(systemctl is-active $RES_SVC 2>/dev/null || echo desconhecido) / $(systemctl is-enabled $RES_SVC 2>/dev/null || echo n/a)"
    for s in "${C5_SERVICES[@]}"; do log "    $s: $(systemctl is-active "$s" 2>/dev/null || echo inexistente)"; done
  else log "    (systemctl indisponível)"; fi

  log "\n[2] Portas escutando (foco C5=$C5_WEB_PORT, 3001, 3002, $DB_PORT):"
  if have ss; then
    ss -ltnp 2>/dev/null | awk -v p="(:$C5_WEB_PORT|:3001|:3002|:$DB_PORT)\\\\y" 'NR==1 || $4 ~ p' || true
  else log "    (ss indisponível)"; fi

  log "\n[3] Diretórios em /opt:"
  ls -1d /opt/*/ 2>/dev/null | sed 's/^/    /' || log "    (/opt vazio)"
  log "    $C5_DIR existe? $( [ -d "$C5_DIR" ] && echo SIM || echo não )"

  log "\n[4] nginx:"
  if have nginx; then
    log "    instalado: sim ($(nginx -v 2>&1))"
    nginx -T 2>/dev/null | grep -E 'server_name ' | sed 's/^/      /' | sort -u | head -40 || true
  else log "    nginx NÃO instalado"; fi

  log "\n[5] PostgreSQL:"
  if have pg_lsclusters; then pg_lsclusters 2>/dev/null | sed 's/^/    /'; else log "    postgres não instalado (sem pg_lsclusters)"; fi

  log "\n[6] Espaço em disco:"; df -h / 2>/dev/null | sed 's/^/    /'
  log "\n[7] Node:"; have node && log "    node $(node -v)" || log "    node não instalado"
  log "========================================================================="
}

# ---------------------------------------------------------------------------
# GUARD: ABORTA se algo puder colidir com o sistema atual ou com o lotarium.
guard() {
  log "\n==> GUARD de isolamento (ABORTA em qualquer colisão)"
  local fail=0

  # (a) porta do C5 não pode ser uma porta reservada
  for p in "${RESERVED_PORTS[@]}"; do
    [ "$C5_WEB_PORT" = "$p" ] && { log "  ✗ C5_WEB_PORT=$C5_WEB_PORT é RESERVADA (influcriator/lotarium)"; fail=1; }
  done
  # (b) porta do C5 e do PG não podem já estar em uso
  if port_in_use "$C5_WEB_PORT"; then log "  ✗ porta do C5 ($C5_WEB_PORT) JÁ ESTÁ EM USO"; fail=1; else log "  ✓ porta do C5 ($C5_WEB_PORT) livre"; fi
  if port_in_use "$DB_PORT";     then log "  ✗ porta do Postgres do C5 ($DB_PORT) JÁ ESTÁ EM USO"; fail=1; else log "  ✓ porta do Postgres do C5 ($DB_PORT) livre"; fi
  # (c) diretório do C5 não pode colidir com reservados
  case "$C5_DIR" in "$RES_DIR"|"$RES_DIR"/*) log "  ✗ C5_DIR colide com $RES_DIR"; fail=1;; esac
  for g in "${RESERVED_DIR_GLOBS[@]}"; do
    case "$C5_DIR" in "$g"|"$g"*) log "  ✗ C5_DIR ($C5_DIR) colide com reservado ($g*)"; fail=1;; esac
  done
  # (d) nomes de serviço do C5 não podem começar com prefixo reservado
  for s in "${C5_SERVICES[@]}"; do
    for pre in "${RESERVED_SVC_PREFIXES[@]}"; do
      case "$s" in "$pre"*) log "  ✗ serviço $s colide com prefixo reservado '$pre'"; fail=1;; esac
    done
    # e não pode já existir ATIVO (instalação estranha/foreign)
    svc_active "$s" && { log "  ✗ serviço $s já está ATIVO — investigar antes de aplicar"; fail=1; }
  done
  # (e) se o cluster PG do C5 já existir, DB/role devem ser compatíveis
  if have pg_lsclusters && pg_lsclusters 2>/dev/null | grep -qE "^$PG_VERSION +c5 "; then
    local owner
    owner=$(sudo -u postgres psql -p "$DB_PORT" -tAc \
      "select pg_catalog.pg_get_userbyid(datdba) from pg_database where datname='$DB_NAME'" 2>/dev/null || true)
    if [ -n "$owner" ] && [ "$owner" != "$DB_ROLE" ]; then
      log "  ✗ DB '$DB_NAME' já existe com owner '$owner' (esperado '$DB_ROLE')"; fail=1
    fi
  fi

  if [ "$fail" = 1 ]; then log "\nABORTADO: colisão detectada — nada foi alterado."; exit 2; fi
  log "  ✓ sem colisão com influcriator / lotarium / porta $C5_WEB_PORT / PG $DB_PORT / $C5_DIR"
}

# ---------------------------------------------------------------------------
apply() {
  local HERE; HERE="$(cd "$(dirname "$0")" && pwd)"
  : "${C5_DB_PASSWORD:?defina C5_DB_PASSWORD no ambiente antes de --apply}"
  export DEBIAN_FRONTEND=noninteractive

  log "\n==> [1/6] Pacotes (nginx NÃO é instalado/alterado nesta fase)"
  apt-get update -y
  apt-get install -y "postgresql-$PG_VERSION" curl ca-certificates
  if ! have node || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs
  else log "    node $(node -v) já atende (>=20) — não reinstala"; fi

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

  log "\n==> [4/6] Diretórios $C5_DIR + .env (600) — porta vem de C5_WEB_PORT"
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
  # template do nginx com a porta central já aplicada, guardado p/ uso FUTURO (sem ativar)
  sed "s/__PORT__/$C5_WEB_PORT/g" "$HERE/nginx-c5.conf.template" > "$C5_DIR/shared/nginx-c5.conf.template"

  log "\n==> [5/6] systemd: instala e HABILITA ${C5_SERVICES[*]} (NÃO inicia ainda)"
  cp "$HERE/c5-web.service"    /etc/systemd/system/c5-web.service
  cp "$HERE/c5-worker.service" /etc/systemd/system/c5-worker.service
  systemctl daemon-reload
  systemctl enable "${C5_SERVICES[@]}"
  log "    (start só depois do 1º release + migrate — a app ainda não existe)"

  log "\n==> [6/6] nginx / exposição pública: DEFERIDO (sem domínio → sem block, sem reload)"
  log "    App só em localhost:$C5_WEB_PORT. Nada público é aberto. Nginx do influcriator/lotarium intacto."

  log "\nOK: infra base do C5 aplicada e ISOLADA. Sistemas atuais não foram tocados."
}

# ---------------------------------------------------------------------------
inventory
case "$MODE" in
  --check) log "\nMODO --check: nenhuma alteração feita. Rode com --apply para provisionar."; guard ;;
  --apply) guard; apply ;;
  *) log "uso: $0 [--check|--apply]"; exit 1 ;;
esac
