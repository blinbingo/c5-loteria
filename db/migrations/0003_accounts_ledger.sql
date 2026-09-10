-- 0003 — Contabilidade: contas + LEDGER de dupla entrada (append-only, imutável).
-- Regras invioláveis:
--   * Dinheiro SEMPRE em centavos inteiros (bigint). Nunca float.
--   * O ledger é a ÚNICA fonte contábil da verdade.
--   * Toda transação financeira soma ZERO (dupla entrada).
--   * O ledger é imutável: UPDATE/DELETE são proibidos por trigger.
--   * account_balances é apenas um CACHE materializado, mantido na MESMA
--     transação por trigger; é reconciliável e nunca é fonte da verdade.

create type account_owner as enum ('player', 'system');
create type account_kind  as enum (
  'player_wallet',        -- carteira de um jogador
  'house',                -- casa (retenção/resultado da banca)
  'deposits_clearing',    -- contrapartida de depósitos
  'withdrawals_clearing', -- contrapartida de saques
  'prize_pool',           -- pool de prêmios das apostas
  'adjustments'           -- ajustes manuais auditados
);

create table accounts (
  id         uuid primary key default gen_random_uuid(),
  owner_type account_owner not null,
  owner_id   uuid,                              -- player_id quando player; null quando system
  kind       account_kind not null,
  currency   text not null default 'BRL',
  created_at timestamptz not null default now(),
  -- coerência: conta de jogador exige owner_id; conta de sistema não tem owner_id
  constraint accounts_owner_ck check ((owner_type = 'player') = (owner_id is not null))
);
-- 1 carteira por jogador; 1 conta de sistema por tipo
create unique index accounts_player_wallet_uk on accounts (owner_id) where kind = 'player_wallet';
create unique index accounts_system_kind_uk   on accounts (kind)     where owner_type = 'system';

create type ledger_tx_type as enum ('deposit', 'withdrawal', 'bet_stake', 'bet_payout', 'adjustment');

create table ledger_transactions (
  id              uuid primary key default gen_random_uuid(),
  type            ledger_tx_type not null,
  reference_type  text,                          -- ex.: 'bet', 'deposit'
  reference_id    uuid,
  idempotency_key text not null unique,          -- garante idempotência financeira
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  metadata        jsonb not null default '{}'::jsonb
);

create table ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references ledger_transactions(id) on delete restrict,
  account_id     uuid not null references accounts(id) on delete restrict,
  amount_cents   bigint not null,                -- assinado: débito < 0, crédito > 0
  created_at     timestamptz not null default now(),
  constraint ledger_entries_nonzero_ck check (amount_cents <> 0)
);
create index ledger_entries_account_idx on ledger_entries(account_id);
create index ledger_entries_tx_idx      on ledger_entries(transaction_id);

-- Saldo materializado (cache p/ leitura O(1)). Invariante: = SUM(ledger_entries).
create table account_balances (
  account_id    uuid primary key references accounts(id) on delete cascade,
  balance_cents bigint not null default 0,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Append-only: proíbe UPDATE/DELETE no ledger (transações e lançamentos).
-- ---------------------------------------------------------------------------
create or replace function c5_forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'ledger e append-only: % nao permitido em %', tg_op, tg_table_name
    using errcode = 'check_violation';
end $$;

create trigger ledger_entries_no_update before update on ledger_entries
  for each row execute function c5_forbid_mutation();
create trigger ledger_entries_no_delete before delete on ledger_entries
  for each row execute function c5_forbid_mutation();
create trigger ledger_tx_no_update before update on ledger_transactions
  for each row execute function c5_forbid_mutation();
create trigger ledger_tx_no_delete before delete on ledger_transactions
  for each row execute function c5_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Dupla entrada: no COMMIT, a soma dos lançamentos de cada transação deve ser 0.
-- Constraint trigger DEFERIDA: valida no fim da transação (após inserir todos).
-- ---------------------------------------------------------------------------
create or replace function c5_assert_tx_balanced() returns trigger language plpgsql as $$
declare
  s bigint;
  n int;
begin
  select coalesce(sum(amount_cents), 0), count(*) into s, n
    from ledger_entries where transaction_id = new.transaction_id;
  if n < 2 then
    raise exception 'transacao % precisa de ao menos 2 lancamentos (dupla entrada)', new.transaction_id
      using errcode = 'check_violation';
  end if;
  if s <> 0 then
    raise exception 'transacao % desbalanceada: soma=%', new.transaction_id, s
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger ledger_entries_balanced
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function c5_assert_tx_balanced();

-- ---------------------------------------------------------------------------
-- Projeção do saldo: a cada lançamento (INSERT), atualiza account_balances na
-- MESMA transação. Como o ledger é append-only, o cache reflete exatamente a
-- soma dos lançamentos por construção. (Reconciliação/invariante em 0006.)
-- ---------------------------------------------------------------------------
create or replace function c5_apply_balance() returns trigger language plpgsql as $$
begin
  insert into account_balances(account_id, balance_cents, updated_at)
  values (new.account_id, new.amount_cents, now())
  on conflict (account_id)
    do update set balance_cents = account_balances.balance_cents + new.amount_cents,
                  updated_at = now();
  return null;
end $$;

create trigger ledger_entries_apply_balance after insert on ledger_entries
  for each row execute function c5_apply_balance();
