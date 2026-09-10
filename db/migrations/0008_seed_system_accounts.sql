-- 0008 — Semeia as contas de SISTEMA (fixas, únicas por tipo).
-- Elas são criadas UMA vez aqui, no bootstrap do banco, e não sob concorrência
-- (evita corrida na criação e mantém o ledger determinístico).
insert into accounts (owner_type, owner_id, kind) values
  ('system', null, 'house'),
  ('system', null, 'deposits_clearing'),
  ('system', null, 'withdrawals_clearing'),
  ('system', null, 'prize_pool'),
  ('system', null, 'adjustments')
on conflict do nothing;
