// Criação/obtenção de contas. Contas de sistema são únicas por tipo; cada
// jogador tem exatamente uma carteira.
import type { PoolClient } from "pg";

export type AccountKind =
  | "player_wallet"
  | "house"
  | "deposits_clearing"
  | "withdrawals_clearing"
  | "prize_pool"
  | "adjustments";

const SYSTEM_KINDS: AccountKind[] = ["house", "deposits_clearing", "withdrawals_clearing", "prize_pool", "adjustments"];

// Contas de sistema são semeadas no bootstrap (migration 0008). Aqui só as
// buscamos — nunca criamos sob concorrência, o que evita corrida na criação.
export async function ensureSystemAccount(client: PoolClient, kind: AccountKind): Promise<string> {
  if (!SYSTEM_KINDS.includes(kind)) throw new Error(`kind de sistema invalido: ${kind}`);
  const found = await client.query<{ id: string }>(
    "select id from accounts where owner_type='system' and kind=$1",
    [kind],
  );
  if (!found.rows[0]) throw new Error(`conta de sistema '${kind}' nao semeada (rode as migrations)`);
  return found.rows[0].id;
}

export async function createPlayerWallet(client: PoolClient, playerId: string): Promise<string> {
  const ins = await client.query<{ id: string }>(
    "insert into accounts(owner_type, owner_id, kind) values ('player', $1, 'player_wallet') returning id",
    [playerId],
  );
  return ins.rows[0].id;
}

export async function getPlayerWallet(client: PoolClient, playerId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    "select id from accounts where kind='player_wallet' and owner_id=$1",
    [playerId],
  );
  return r.rows[0]?.id ?? null;
}
