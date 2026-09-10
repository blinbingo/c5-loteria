-- 0004 — Configuração do MOTOR, versionada e append-only.
-- Trocar config = INSERIR uma nova versão (nunca UPDATE). Assim temos histórico,
-- rollback e auditoria. A config "atual" é a de maior id. Cada sorteio congela a
-- versão que usou (ver 0005), então mudar aqui NÃO altera sorteios já fechados.

create table engine_config_versions (
  id                bigint generated always as identity primary key,
  engine_version    text not null,              -- versão/build do motor usada
  retention_target  numeric(6,3) not null,      -- % por-sorteio (modo normal)
  bets_per_round    integer not null,
  bets_volume_cents bigint not null default 0,
  winners_target    integer not null,
  bet_weights       jsonb not null,             -- pesos por modalidade
  avg_mode          boolean not null default false,
  avg_target        numeric(6,3) not null default 20,
  avg_since         timestamptz,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now()
);

-- Append-only: proíbe UPDATE/DELETE (usa a mesma função de 0003).
create trigger engine_config_no_update before update on engine_config_versions
  for each row execute function c5_forbid_mutation();
create trigger engine_config_no_delete before delete on engine_config_versions
  for each row execute function c5_forbid_mutation();

-- View de conveniência: a configuração vigente (maior id).
create view engine_config_current as
  select * from engine_config_versions order by id desc limit 1;
