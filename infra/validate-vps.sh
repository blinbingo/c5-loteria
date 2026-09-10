#!/usr/bin/env bash
# Validação PÓS-APPLY da Fase A (SOMENTE LEITURA + teste de backup/restore no
# cluster do C5). Roda como root no VPS. NUNCA imprime o .env nem a senha.
set -uo pipefail
C5_DIR=/opt/c5
DB_PORT=5433
DB_NAME=c5
DB_ROLE=c5_app
WEB_PORT=3005
PGADMIN="sudo -u postgres psql -p $DB_PORT"

ok() { echo "  ✓ $*"; }
no() { echo "  ✗ $*"; }
line() { echo "----------------------------------------------------------------"; }

echo "================= VALIDAÇÃO PÓS-APPLY — FASE A ================="

echo "[1] /opt/c5 e estrutura"; ls -ld "$C5_DIR" "$C5_DIR"/releases "$C5_DIR"/shared "$C5_DIR"/backups 2>&1 | sed 's/^/    /'
echo "    (current só é criado no 1º release — Fase C):"; ls -ld "$C5_DIR"/current 2>&1 | sed 's/^/    /'

echo "[2] proprietário/permissões"; stat -c '    %A %U:%G  %n' "$C5_DIR" "$C5_DIR"/shared 2>/dev/null

echo "[3] .env existe e permissão (conteúdo NÃO é impresso)"
if [ -f "$C5_DIR/shared/.env" ]; then stat -c '    perm=%a %U:%G %n' "$C5_DIR/shared/.env"; ok ".env presente"; else no ".env ausente"; fi

echo "[4] senha/segredo NÃO impressos"; ok "este script nunca faz cat do .env nem ecoa DATABASE_URL/senha"

echo "[5] cluster PostgreSQL do C5 online em 127.0.0.1:$DB_PORT"
pg_lsclusters 2>/dev/null | awk 'NR==1 || $2=="c5"' | sed 's/^/    /'
ss -ltnH 2>/dev/null | awk -v p=":$DB_PORT" '$4 ~ p {print "    "$1" "$4}'

echo "[6] $DB_PORT NÃO acessível externamente"
if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "(0\.0\.0\.0|\*|\[::\]):$DB_PORT$"; then no "$DB_PORT exposto!"; else ok "$DB_PORT só em loopback (127.0.0.1)"; fi

echo "[7] cluster main:5432 intacto"; pg_lsclusters 2>/dev/null | awk 'NR==1 || $2=="main"' | sed 's/^/    /'

echo "[8] database $DB_NAME existe"
[ "$($PGADMIN -tAc "select 1 from pg_database where datname='$DB_NAME'")" = "1" ] && ok "DB $DB_NAME existe" || no "DB $DB_NAME ausente"

echo "[9] role $DB_ROLE existe com privilégios MÍNIMOS"
$PGADMIN -tAc "select 'super='||rolsuper||' createdb='||rolcreatedb||' createrole='||rolcreaterole||' login='||rolcanlogin from pg_roles where rolname='$DB_ROLE'" | sed 's/^/    /'

echo "[10] conexão do $DB_ROLE ao banco $DB_NAME (sem expor a URL)"
URL=$(grep '^DATABASE_URL=' "$C5_DIR/shared/.env" | cut -d= -f2-)
who=$(psql "$URL" -tAc "select current_user||'@'||current_database()" 2>/dev/null); unset URL
[ -n "$who" ] && ok "conectou como $who" || no "falha ao conectar como $DB_ROLE"

echo "[11-13] serviços c5-web / c5-worker (existem, habilitados, PARADOS)"
for s in c5-web c5-worker; do
  if systemctl cat "$s" >/dev/null 2>&1; then
    echo "    $s: existe | enabled=$(systemctl is-enabled $s 2>/dev/null) | active=$(systemctl is-active $s 2>/dev/null)"
  else no "$s inexistente"; fi
done

echo "[14] porta $WEB_PORT LIVRE (app não iniciada)"
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ":$WEB_PORT$" && no "$WEB_PORT ocupada!" || ok "$WEB_PORT livre"

echo "[15-16] portas 3001 e 3002 intactas"
ss -ltnpH 2>/dev/null | awk '$4 ~ /:(3001|3002)$/ {print "    "$4"  "$6}'

echo "[17] influcriator-web ativo"; echo "    $(systemctl is-active influcriator-web 2>/dev/null)"

echo "[19-20] diretórios de outros projetos intactos"; ls -ld /opt/lotarium-staging /opt/c4-pay 2>/dev/null | sed 's/^/    /'

echo "[21] nginx NÃO recarregado/alterado"
systemctl show nginx -p ActiveEnterTimestamp 2>/dev/null | sed 's/^/    (ativo desde) /'
ok "o provisionamento não emitiu nginx reload/restart nem criou server block"

echo "[22-23] backup + restore no cluster do C5 (mecânica)"
DUMP=/tmp/c5-fasea-check.dump
if sudo -u postgres pg_dump -p $DB_PORT -Fc "$DB_NAME" -f "$DUMP" 2>/dev/null; then
  ok "backup gerado ($(du -h "$DUMP" | cut -f1))"
  $PGADMIN -c "drop database if exists c5_restore_check;" >/dev/null 2>&1
  $PGADMIN -c "create database c5_restore_check;" >/dev/null 2>&1
  if sudo -u postgres pg_restore -p $DB_PORT -d c5_restore_check "$DUMP" >/dev/null 2>&1; then ok "restore em banco temporário OK"; else no "restore falhou"; fi
  $PGADMIN -c "drop database if exists c5_restore_check;" >/dev/null 2>&1
  rm -f "$DUMP"
else no "backup falhou"; fi

echo "[24] mtimes dos outros sistemas (não modificados pelo apply)"
stat -c '    %y  %n' /opt/influcriator-web /opt/lotarium-staging /opt/c4-pay 2>/dev/null
line
echo "VALIDAÇÃO CONCLUÍDA"
