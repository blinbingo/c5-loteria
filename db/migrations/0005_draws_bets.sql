-- 0005 — Sorteios e apostas, com SNAPSHOT MATEMÁTICO IMUTÁVEL.
--
-- AJUSTE (congelamento explícito): os parâmetros que governam um sorteio ficam
-- IMUTÁVEIS no MARCO DE FECHAMENTO (status 'open' -> 'closed', quando closed_at
-- é gravado). A partir daí, alterar a config no admin cria uma NOVA versão em
-- engine_config_versions, mas NÃO altera retroativamente este sorteio.
-- A finalização usa SOMENTE o snapshot do sorteio, nunca a config vigente.
--
-- Reprodutibilidade/auditoria de cada resultado a partir de:
--   engine_version + engine_config_version_id + config_snapshot (config usada)
--   bets_closed_hash (apostas elegíveis) + closed_at (horário de fechamento)
--   prizes (resultado) + bets.payout_cents/ledger (pagamentos resultantes).

create type draw_status  as enum ('open', 'closed', 'finalized', 'canceled');
create type bet_type     as enum ('super', 'milhar', 'centena', 'dezena', 'unidade', 'grupo');
create type bet_status   as enum ('pending', 'won', 'lost', 'void');
create type prize_scope  as enum ('0', '1', '2', '3', '4', 'all');

create table draws (
  id                       uuid primary key default gen_random_uuid(),
  label                    text not null,
  scheduled_at             timestamptz,           -- horário do resultado (null = manual)
  status                   draw_status not null default 'open',
  opened_at                timestamptz not null default now(),
  closed_at                timestamptz,            -- MARCO do congelamento
  finalized_at             timestamptz,
  -- SNAPSHOT IMUTÁVEL (congelado no fechamento):
  engine_version           text,
  engine_config_version_id bigint references engine_config_versions(id),
  config_snapshot          jsonb,                  -- cópia dos parâmetros efetivos
  bets_closed_hash         text,                   -- hash das apostas elegíveis
  -- RESULTADO:
  prizes                   text[],                 -- 5 números
  total_staked_cents       bigint not null default 0,
  total_payout_cents       bigint not null default 0,
  retention                numeric(8,5),
  winners_count            integer,
  created_by               uuid references users(id),
  created_at               timestamptz not null default now(),
  constraint draws_prizes_len_ck check (prizes is null or array_length(prizes, 1) = 5)
);
create index draws_status_idx on draws(status);

create table bets (
  id               uuid primary key default gen_random_uuid(),
  draw_id          uuid not null references draws(id) on delete restrict,
  player_id        uuid not null references players(id) on delete restrict,
  type             bet_type not null,
  selection        text not null,
  scope            prize_scope not null,
  stake_cents      bigint not null check (stake_cents > 0),
  status           bet_status not null default 'pending',
  payout_cents     bigint not null default 0 check (payout_cents >= 0),
  ledger_stake_tx  uuid references ledger_transactions(id),
  ledger_payout_tx uuid references ledger_transactions(id),
  idempotency_key  text not null unique,
  created_at       timestamptz not null default now()
);
create index bets_draw_idx   on bets(draw_id);
create index bets_player_idx on bets(player_id);

-- ---------------------------------------------------------------------------
-- Congelamento: depois que um sorteio é fechado/finalizado/cancelado, o
-- SNAPSHOT (engine_version, versão da config, config_snapshot, closed_at) é
-- imutável. Alterações posteriores são bloqueadas — nunca retroativas.
-- ---------------------------------------------------------------------------
create or replace function c5_freeze_draw_snapshot() returns trigger language plpgsql as $$
begin
  if old.status in ('closed', 'finalized', 'canceled') then
    if new.engine_version           is distinct from old.engine_version
       or new.engine_config_version_id is distinct from old.engine_config_version_id
       or new.config_snapshot        is distinct from old.config_snapshot
       or new.closed_at              is distinct from old.closed_at then
      raise exception 'sorteio % tem snapshot congelado (status=%): parametros nao podem mudar', old.id, old.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger draws_freeze_snapshot before update on draws
  for each row execute function c5_freeze_draw_snapshot();
