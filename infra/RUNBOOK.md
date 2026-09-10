# RUNBOOK — Execução da Fase A (infra do C5) no VPS

> **Isolamento total.** Nada do C5 compartilha diretório, banco, `state.json`,
> serviço, processo ou porta com o `influcriator.com`. Se algum passo parecer
> tocar `/opt/influcriator-web`, `influcriator-web.service` ou a porta `3001`,
> **pare** — está errado. O script tem um *guard* que aborta nesse caso.

| Recurso | influcriator (existente, NÃO tocar) | C5 (novo, isolado) |
|---|---|---|
| Diretório | `/opt/influcriator-web` | `/opt/c5` |
| Serviço | `influcriator-web` | `c5-web` + `c5-worker` |
| Porta app | `3001` | `3005` (variável central `C5_WEB_PORT`; só localhost nesta fase) |
| Postgres | (não usa) | cluster `16/c5`, porta `5433`, DB `c5`, role `c5_app`, **só localhost** |
| nginx | server block do influcriator | **deferido** (sem domínio → sem block, sem reload) |
| Deploy | pipeline do influcriator | pipeline própria do C5 |
| Dados | `state.json` | Postgres `c5` |

## ⚠️ Importante nesta fase
- **Sem domínio ainda → sem exposição pública.** O script **não** cria/ativa
  server block do nginx nem dá reload no nginx (evita qualquer efeito no site
  atual). A app fica só em `localhost:3005`.
- **Os serviços NÃO são iniciados** no provisionamento (a aplicação do C5 ainda
  não foi construída — isso é Fase C). O script só **instala e habilita** as units.
- O provisionamento **não abre nenhuma porta pública nova**.

## Pré-requisitos (você)
1. Repositório `c5-loteria` criado (feito).
2. Senha forte do banco em `C5_DB_PASSWORD` (não versionar).

## Caminho 1 — você roda via SSH (recomendado)
No VPS, como root, com os arquivos de `infra/` presentes:
```bash
# 1) INVENTÁRIO — só leitura, não altera nada:
bash infra/provision-vps.sh --check

# 2) Se o inventário estiver ok, APLICA (idempotente):
export C5_DB_PASSWORD='...senha-forte...'
bash infra/provision-vps.sh --apply
```

## Caminho 2 — pela pipeline (GitHub Actions)
Se preferir automatizar, adicione no repo os secrets `SSH_HOST`, `SSH_USER`,
`SSH_PRIVATE_KEY` e `C5_DB_PASSWORD`, e rode o workflow **“Provision VPS (Fase A)”**
(Actions → Run workflow) com `mode = check` e depois `mode = apply`. Sem os
secrets, o workflow apenas avisa e não faz nada.

## Validações obrigatórias APÓS `--apply` (rode no VPS e me mande a saída)
Sistema atual intacto:
```bash
systemctl is-active influcriator-web           # deve continuar 'active'
ss -ltnp | grep ':3001'                         # 3001 só do influcriator
ls -la /opt/influcriator-web | head             # dir inalterado
curl -s https://influcriator.com/api/health     # mesmo SHA de antes
```
C5 existe e isolado:
```bash
systemctl is-enabled c5-web c5-worker           # enabled (ainda não started)
pg_lsclusters | grep ' c5 '                     # cluster c5 na 5433
ss -ltnp | grep ':5433'                         # PG do C5 só em 127.0.0.1
sudo -u postgres psql -p 5433 -c "\du" | grep c5_app
sudo -u postgres psql -p 5433 -c "\l" | grep ' c5 '
ls -la /opt/c5                                  # releases/current/shared/backups
```
Backup/restore mínimo do C5 (com o schema aplicado após o 1º release):
```bash
DATABASE_URL=... bash infra/backup.sh
DATABASE_URL=... bash infra/restore.sh /opt/c5/backups/c5-XXXX.dump c5_restore_check
```

## Depois (Fase C, só após sua aprovação)
Publicar 1º release em `/opt/c5/current`, `npm ci && npm run migrate`, então
`systemctl start c5-web c5-worker`. TLS/nginx entram quando houver domínio
(`certbot` + o `nginx-c5.conf.template`).

## Segredos
Vivem em `/opt/c5/shared/.env` (permissão 600), fora do git. O código lê só de
variáveis de ambiente — nenhum segredo no repositório.
