-- 0007 — Reconciliação como INVARIANTE (saldo materializado = soma do ledger).
--
-- AJUSTE: account_balances NUNCA é uma segunda fonte da verdade. Estas funções
-- COMPARAM o cache com a contabilidade (ledger). Elas NÃO corrigem nada: uma
-- divergência é ERRO CRÍTICO e deve estourar, para ser investigada — jamais
-- "consertada" silenciosamente.

-- Soma contábil (fonte da verdade) de uma conta.
create or replace function c5_ledger_sum(p_account uuid) returns bigint
language sql stable as $$
  select coalesce(sum(amount_cents), 0)::bigint from ledger_entries where account_id = p_account;
$$;

-- Relatório de reconciliação (todas as contas com saldo materializado):
-- devolve materializado, soma do ledger e se batem.
create or replace function c5_reconcile_report()
returns table(account_id uuid, materialized_cents bigint, ledger_cents bigint, ok boolean)
language sql stable as $$
  select ab.account_id,
         ab.balance_cents as materialized_cents,
         c5_ledger_sum(ab.account_id) as ledger_cents,
         ab.balance_cents = c5_ledger_sum(ab.account_id) as ok
  from account_balances ab;
$$;

-- Verificação estrita: estoura (erro crítico) na PRIMEIRA divergência.
-- Retorna o total de contas conferidas quando tudo bate.
create or replace function c5_assert_reconciled() returns bigint
language plpgsql stable as $$
declare r record; checked bigint := 0;
begin
  for r in select * from c5_reconcile_report() loop
    checked := checked + 1;
    if not r.ok then
      raise exception 'CRITICO: divergencia de saldo na conta % (materializado=% ledger=%)',
        r.account_id, r.materialized_cents, r.ledger_cents
        using errcode = 'data_corrupted';
    end if;
  end loop;
  return checked;
end $$;
