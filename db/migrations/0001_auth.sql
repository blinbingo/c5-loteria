-- 0001 — Identidade, autenticação e RBAC (base).
-- Usuários são a identidade de login de jogador E admin. Papéis via RBAC.
-- 2FA: admin obrigatório (aplicado na camada de auth, fase D); coluna preparada aqui.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  status        text not null default 'active' check (status in ('active','disabled')),
  totp_secret   text,                       -- segredo TOTP (2FA)
  totp_enabled  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- e-mail único, case-insensitive, sem depender de extensão citext
create unique index users_email_lower_uk on users (lower(email));

create type role_kind as enum ('player', 'admin', 'operator', 'viewer');

create table user_roles (
  user_id    uuid not null references users(id) on delete cascade,
  role       role_kind not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,          -- guarda só o hash do token, nunca o token
  ip         text,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions(user_id);
