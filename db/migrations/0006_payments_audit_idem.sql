-- 0006 — Depósitos, saques (schema-base), auditoria e idempotência.
-- Observação: aqui é só a FUNDAÇÃO (tabelas). A OPERAÇÃO financeira externa
-- (depósito/saque de verdade) é de fase posterior; nada é executado agora.

create type deposit_status    as enum ('pending', 'confirmed', 'failed');
create type withdrawal_status as enum ('requested', 'approved', 'paid', 'rejected');

create table deposits (
  id                    uuid primary key default gen_random_uuid(),
  player_id             uuid not null references players(id) on delete restrict,
  amount_cents          bigint not null check (amount_cents > 0),
  method                text not null,
  status                deposit_status not null default 'pending',
  provider_ref          text,
  idempotency_key       text not null unique,
  ledger_transaction_id uuid references ledger_transactions(id),
  created_at            timestamptz not null default now(),
  confirmed_at          timestamptz
);
create index deposits_player_idx on deposits(player_id);

create table withdrawals (
  id                    uuid primary key default gen_random_uuid(),
  player_id             uuid not null references players(id) on delete restrict,
  amount_cents          bigint not null check (amount_cents > 0),
  method                text not null,
  status                withdrawal_status not null default 'requested',
  provider_ref          text,
  approved_by           uuid references users(id),
  idempotency_key       text not null unique,
  ledger_transaction_id uuid references ledger_transactions(id),
  created_at            timestamptz not null default now(),
  paid_at               timestamptz
);
create index withdrawals_player_idx on withdrawals(player_id);

-- Trilha de auditoria de TODA ação administrativa/sensível.
create table admin_audit_log (
  id            bigint generated always as identity primary key,
  actor_user_id uuid references users(id),
  action        text not null,               -- ex.: 'engine_config.update', 'draw.finalize', 'withdrawal.approve'
  entity        text,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  ip            text,
  created_at    timestamptz not null default now()
);
create index admin_audit_actor_idx on admin_audit_log(actor_user_id);
create index admin_audit_entity_idx on admin_audit_log(entity, entity_id);

-- Idempotência a nível de API (dedup de requisições que mudam estado).
create table idempotency_keys (
  key          text primary key,
  request_hash text not null,
  response     jsonb,
  created_at   timestamptz not null default now()
);
