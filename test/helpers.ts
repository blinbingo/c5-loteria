// Utilidades de teste: cria jogador+carteira, contas de sistema e limpa o banco
// entre os testes. Usa a MESMA base local; cada teste zera as tabelas.
import type { PoolClient } from "pg";
import { pool, withTx } from "../src/db/pool.js";
import { createPlayerWallet, ensureSystemAccount } from "../src/services/accounts.js";

export async function truncateAll(): Promise<void> {
  await pool.query(`
    truncate table
      ledger_entries, ledger_transactions, account_balances, accounts,
      bets, draws, engine_config_versions,
      deposits, withdrawals, admin_audit_log, idempotency_keys,
      sessions, user_roles, players, users
    restart identity cascade`);
  // re-semeia as contas de sistema (o truncate acima as apagou)
  await pool.query(`
    insert into accounts (owner_type, owner_id, kind) values
      ('system', null, 'house'),
      ('system', null, 'deposits_clearing'),
      ('system', null, 'withdrawals_clearing'),
      ('system', null, 'prize_pool'),
      ('system', null, 'adjustments')
    on conflict do nothing`);
}

let seq = 0;
export async function newPlayerWithWallet(): Promise<{ userId: string; playerId: string; walletId: string }> {
  seq += 1;
  const email = `p${Date.now()}_${seq}@c5.local`;
  return withTx(async (c: PoolClient) => {
    const u = await c.query<{ id: string }>(
      "insert into users(email, password_hash) values ($1,$2) returning id",
      [email, "x"],
    );
    const userId = u.rows[0].id;
    await c.query("insert into user_roles(user_id, role) values ($1,'player')", [userId]);
    const p = await c.query<{ id: string }>(
      "insert into players(user_id, display_name) values ($1,$2) returning id",
      [userId, `Player ${seq}`],
    );
    const playerId = p.rows[0].id;
    const walletId = await createPlayerWallet(c, playerId);
    return { userId, playerId, walletId };
  });
}

export async function houseAccount(): Promise<string> {
  return withTx((c) => ensureSystemAccount(c, "house"));
}
