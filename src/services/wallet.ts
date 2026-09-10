// Consultas de saldo e reconciliação.
// A FONTE DA VERDADE é o ledger. account_balances é só cache; toda leitura
// "oficial" pode ser reconstruída da soma dos lançamentos.
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

// Saldo reconstruído do LEDGER (fonte contábil).
export async function ledgerBalance(client: PoolClient, accountId: string): Promise<bigint> {
  const r = await client.query<{ s: string }>(
    "select coalesce(sum(amount_cents),0)::bigint as s from ledger_entries where account_id=$1",
    [accountId],
  );
  return BigInt(r.rows[0].s);
}

// Saldo materializado (cache).
export async function materializedBalance(client: PoolClient, accountId: string): Promise<bigint> {
  const r = await client.query<{ b: string | null }>(
    "select balance_cents::bigint as b from account_balances where account_id=$1",
    [accountId],
  );
  return BigInt(r.rows[0]?.b ?? "0");
}

export type Divergence = { accountId: string; materializedCents: bigint; ledgerCents: bigint };

// Reconciliação estrita: devolve as divergências (cache != ledger). Vazio = ok.
// NUNCA corrige — divergência é erro crítico a ser investigado.
export async function reconcile(client?: PoolClient): Promise<Divergence[]> {
  const q = "select account_id, materialized_cents, ledger_cents from c5_reconcile_report() where not ok";
  const r = client ? await client.query(q) : await pool.query(q);
  return r.rows.map((row: { account_id: string; materialized_cents: string; ledger_cents: string }) => ({
    accountId: row.account_id,
    materializedCents: BigInt(row.materialized_cents),
    ledgerCents: BigInt(row.ledger_cents),
  }));
}

// Estoura se houver qualquer divergência (usa a função SQL c5_assert_reconciled).
export async function assertReconciled(client?: PoolClient): Promise<number> {
  const q = "select c5_assert_reconciled() as checked";
  const r = client ? await client.query(q) : await pool.query(q);
  return Number(r.rows[0].checked);
}
