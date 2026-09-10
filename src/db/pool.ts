// Pool de conexões Postgres + helper de transação.
// pg é JS puro (não quebra build). O saldo/idempotência dependem de transações
// e de lock de linha — por isso o helper withTx expõe o client transacional.
import { Pool, type PoolClient } from "pg";
import "dotenv/config";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Executa `fn` dentro de uma transação. Faz commit no sucesso e rollback em erro.
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
