-- 0002 — Jogadores (perfil vinculado 1–1 a um usuário). Produção começa LIMPA:
-- nenhum jogador fictício é migrado do sistema antigo.

create table players (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references users(id) on delete restrict,
  display_name text not null,
  document     text,                         -- CPF (KYC)
  phone        text,
  kyc_status   text not null default 'none' check (kyc_status in ('none','pending','approved','rejected')),
  created_at   timestamptz not null default now()
);
