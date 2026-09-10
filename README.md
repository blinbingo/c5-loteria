# C5 — Loteria com Retenção

Sistema operacional de loteria (jogo do bicho) com **retenção configurável**,
valores **reais**, carteira e ledger auditável. Isolado do `influcriator.com`.

- Arquitetura: [`docs/ARQUITETURA-C5.md`](docs/ARQUITETURA-C5.md)
- Infra/VPS (isolado): [`infra/RUNBOOK.md`](infra/RUNBOOK.md)

## Estado atual
**Fase A** (infra) entregue como scripts idempotentes em `infra/` (execução no VPS
é manual/pipeline). **Fase B** (fundação de dados) implementada: migrations,
ledger de dupla entrada, idempotência, reconciliação de saldo, congelamento do
sorteio, RBAC base — tudo coberto por testes e CI.

## Rodar localmente
Requer PostgreSQL 16 e Node 20.
```bash
cp .env.example .env         # ajuste DATABASE_URL
npm install
npm run migrate              # aplica as migrations
npm test                     # suíte completa
npm run typecheck
```

## Regras invioláveis
- Dinheiro só em **centavos inteiros** (`bigint`), nunca `float`.
- **Ledger** é a fonte contábil; saldo é reconstruível dele.
- **Motor preservado** em `packages/engine` (sem alteração de matemática).
- Retenção/inteligência do resultado são **internas do admin** — invisíveis ao jogador.
