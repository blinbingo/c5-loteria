# RUNBOOK — Infra do C5 (Fase A)

> **Isolamento total.** Nada do C5 compartilha diretório, banco, `state.json`,
> serviço, processo ou porta com o sistema atual (`influcriator.com`). Se algum
> passo abaixo parecer tocar `/opt/influcriator-web`, `influcriator-web.service`
> ou a porta `3001`, **pare** — está errado.

| Recurso | influcriator (existente, NÃO tocar) | C5 (novo, isolado) |
|---|---|---|
| Diretório | `/opt/influcriator-web` | `/opt/c5` |
| Serviço | `influcriator-web` | `c5-web` + `c5-worker` |
| Porta app | `3001` | `3002` |
| Postgres | (não usa) | cluster próprio `16/c5`, porta `5433`, DB `c5`, role `c5_app` |
| nginx | server block do influcriator | server block próprio do C5 |
| Deploy | pipeline do influcriator | pipeline própria do C5 |
| Dados | `state.json` | Postgres `c5` |

## Pré-requisitos (você faz uma vez)
1. Criar o repositório `c5-loteria` (privado) e dar acesso.
2. Definir uma senha forte do banco em `C5_DB_PASSWORD` (não versionar).
3. (Opcional agora) escolher o subdomínio e apontar o DNS — o código NÃO depende
   do hostname; ele entra só no nginx via `C5_SERVER_NAME`.

## Provisionar (roda no VPS, como root — idempotente)
```bash
export C5_DB_PASSWORD='...senha-forte...'
export C5_SERVER_NAME='_'         # troque pelo domínio quando existir
bash infra/provision-vps.sh
```
Isso instala Postgres 16 (cluster próprio na 5433), cria `c5`/`c5_app`, prepara
`/opt/c5`, instala `c5-web`/`c5-worker` e o server block do nginx. **Não altera
o influcriator.**

## Publicar um release (feito pela pipeline do C5)
```bash
# no diretório do release em /opt/c5/current:
npm ci --omit=dev
npm run migrate          # aplica as migrations no banco c5
systemctl restart c5-web c5-worker
```

## Backups (cron no VPS)
```
0 4 * * *  DATABASE_URL=... /opt/c5/current/infra/backup.sh
```
Teste de restauração periódico (nunca no banco de produção):
```bash
DATABASE_URL=... bash infra/restore.sh /opt/c5/backups/c5-XXXX.dump c5_restore_check
```

## TLS
Depois do DNS apontando, `certbot --nginx -d SEU.DOMINIO` adiciona HTTPS ao
server block do C5.

## Segredos
Vivem em `/opt/c5/shared/.env` (permissão 600), **fora do git**. O código lê só
de variáveis de ambiente — nenhum segredo no repositório.
