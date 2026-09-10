# C5 — Loteria com Retenção — Arquitetura

Sistema **operacional** (jogadores, apostas e valores **reais**). Sem linguagem de
"estudo/simulação/fictício". Isolado do `influcriator.com` (repo, VPS, banco,
serviço, diretório e domínio próprios).

## Princípios invioláveis
1. **Motor preservado.** O jogo do bicho (cotações, apuração real, escolha do
   resultado pela casa) é o `packages/engine` — cópia **sem alteração de lógica**
   do motor anterior. Ganha só quem acerta; prêmio = valor × cotação.
2. **Retenção é interna do admin.** O jogador nunca vê retenção, "resultado
   manipulado" nem parâmetros do motor.
3. **Dinheiro só em centavos inteiros (`bigint`).** Nunca `float`. Arredondamento
   determinístico e testado (`src/money.ts`).
4. **Ledger é a única fonte contábil.** Dupla entrada, append-only. Saldo é
   reconstruível do ledger; `account_balances` é só cache reconciliável.

## Camadas
- `packages/engine` — motor **puro** (não conhece banco/carteira/auth).
- `apps/api` (fase C+) — Express + Postgres: auth, players, wallet, bets, draws,
  config, audit. O `DrawService` carrega apostas do banco, chama o engine e grava
  resultado + ledger numa transação.
- `apps/web` (fase F) — app do jogador + admin (retenção só no admin).
- `worker` — scheduler ÚNICO que fecha/finaliza sorteios (evita finalização dupla).
- `tools/lab` — laboratório matemático **isolado** (reusa o engine + o `state.json`
  antigo em memória; nunca toca o banco de produção).

## Banco (PostgreSQL 16)
Tabelas de fundação (Fase B, já implementadas):
`users, user_roles, sessions` · `players` · `accounts, ledger_transactions,
ledger_entries, account_balances` · `engine_config_versions` · `draws, bets` ·
`deposits, withdrawals` · `admin_audit_log, idempotency_keys`.

### Ledger (dupla entrada)
- Cada transação financeira tem ≥2 lançamentos que **somam zero** (trigger
  deferida valida no commit).
- `ledger_entries`/`ledger_transactions` são **append-only** (trigger bloqueia
  UPDATE/DELETE).
- Idempotência: `idempotency_key` único por transação → retry não duplica.
- Anti-gasto-duplo: lock `FOR UPDATE` das contas antes de conferir saldo e lançar.
- `account_balances` é mantido por trigger na mesma transação.

### Reconciliação (invariante testada)
`c5_reconcile_report()` e `c5_assert_reconciled()` comparam cache × soma do
ledger. **Divergência = erro crítico** (`errcode data_corrupted`), **nunca**
corrigida silenciosamente. Testes provam: (a) batem após operações; (b) uma
divergência forçada é detectada e estoura.

## Congelamento do sorteio (marco explícito)
O snapshot matemático de um sorteio é **congelado no FECHAMENTO** (status
`open → closed`, quando `closed_at` é gravado). A partir daí gravam-se, imutáveis:
`engine_version`, `engine_config_version_id`, `config_snapshot`, `bets_closed_hash`.
- Mudar a config no admin depois cria uma **nova versão** e **não** altera o
  sorteio já fechado (trigger `c5_freeze_draw_snapshot` bloqueia).
- A finalização usa **só** o snapshot do sorteio.
- Reprodutibilidade/auditoria por: versão do engine + config usada + apostas
  elegíveis (hash) + horário de fechamento + resultado + pagamentos (bets/ledger).

## Config do motor (versionada)
`engine_config_versions` é append-only; trocar config = inserir versão nova. Dá
histórico, rollback e auditoria. A vigente é a de maior `id`.

## Auth/RBAC (fase D, base já preparada)
Argon2id para senhas; papéis `player|admin|operator|viewer`; `/admin` protegido.
**2FA obrigatório para admin** desde a 1ª versão (coluna `totp_*` preparada;
jogador pode ganhar 2FA depois sem mudança de arquitetura).

## Isolamento no VPS
`/opt/c5` · `c5-web` (3005, var central `C5_WEB_PORT`) + `c5-worker` · cluster Postgres próprio (5433, DB
`c5`, role `c5_app`) · nginx próprio · `.env` próprio · backups próprios · pipeline
própria. Nada compartilhado com o influcriator. Detalhes em `infra/RUNBOOK.md`.

## Fases
- **A — infra isolada** (scripts em `infra/`).
- **B — fundação de dados** (schema/migrations/ledger/testes) ✅ implementada.
- **C — motor no banco** (DrawService usando o engine + scheduler transacional).
- **D — auth/RBAC + 2FA admin + audit**.
- **E — carteira/ledger em operação** (aposta debita, prêmio credita; depósito/
  saque, começando com aprovação manual).
- **F — apps** (jogador + admin).
- **G — laboratório isolado**.
- **H — hardening + backups + carga**.
- **I — go-live** (deploy na infra do C5, nunca no influcriator).

## Segurança mínima antes de valor real
Centavos inteiros · idempotência · transações + lock · ledger auditável · auth
forte (Argon2id, cookie httpOnly/Secure, CSRF, rate-limit, lockout) · RBAC + admin
protegido + 2FA + audit log · segredos em `.env` · Postgres só em localhost ·
saque com aprovação manual no início · HTTPS/HSTS. **Legal/licenciamento + KYC/AML
são pré-requisitos de negócio.**
