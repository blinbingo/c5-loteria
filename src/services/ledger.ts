// Serviço do LEDGER — a primitiva contábil de todo o C5.
// Garante: dupla entrada (soma zero), idempotência, e ausência de gasto duplo
// (lock de linha das contas envolvidas antes de conferir saldo e lançar).
import type { PoolClient } from "pg";

export type LedgerTxType = "deposit" | "withdrawal" | "bet_stake" | "bet_payout" | "adjustment";

export type Posting = { accountId: string; amountCents: bigint }; // débito < 0, crédito > 0

export type PostInput = {
  type: LedgerTxType;
  idempotencyKey: string;
  postings: Posting[];
  referenceType?: string | null;
  referenceId?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  // se true, permite carteira de jogador ficar negativa (ex.: ajuste). Padrão: false.
  allowNegative?: boolean;
};

export type PostResult = { transactionId: string; idempotent: boolean };

// Lança uma transação financeira dentro de uma transação de banco JÁ ABERTA.
// Idempotente pela idempotency_key: reenvio devolve a mesma transação sem
// duplicar lançamentos.
export async function postTransaction(client: PoolClient, input: PostInput): Promise<PostResult> {
  if (input.postings.length < 2) throw new Error("dupla entrada exige >= 2 lancamentos");
  const sum = input.postings.reduce((a, p) => a + p.amountCents, 0n);
  if (sum !== 0n) throw new Error(`transacao desbalanceada: soma=${sum}`);

  // 1) Idempotência: cria a transação; se a chave já existe, é retry -> no-op.
  const tx = await client.query<{ id: string }>(
    `insert into ledger_transactions(type, reference_type, reference_id, idempotency_key, created_by, metadata)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      input.type,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey,
      input.createdBy ?? null,
      input.metadata ?? {},
    ],
  );
  if (!tx.rows[0]) {
    const existing = await client.query<{ id: string }>(
      "select id from ledger_transactions where idempotency_key=$1",
      [input.idempotencyKey],
    );
    return { transactionId: existing.rows[0].id, idempotent: true };
  }
  const transactionId = tx.rows[0].id;

  // 2) Anti-gasto-duplo: bloqueia as contas envolvidas em ordem determinística
  //    (evita deadlock) e confere saldo das carteiras de jogador que serão debitadas.
  const accountIds = [...new Set(input.postings.map((p) => p.accountId))].sort();
  await client.query("select id from accounts where id = any($1::uuid[]) order by id for update", [accountIds]);

  if (!input.allowNegative) {
    for (const p of input.postings) {
      if (p.amountCents >= 0n) continue; // só débitos
      const acc = await client.query<{ kind: string }>("select kind from accounts where id=$1", [p.accountId]);
      if (acc.rows[0]?.kind !== "player_wallet") continue; // só carteira de jogador não pode negativar
      const bal = await client.query<{ balance_cents: string }>(
        "select coalesce(sum(amount_cents),0)::bigint as balance_cents from ledger_entries where account_id=$1",
        [p.accountId],
      );
      const current = BigInt(bal.rows[0].balance_cents);
      if (current + p.amountCents < 0n) {
        throw new Error(`saldo insuficiente na conta ${p.accountId}: saldo=${current} debito=${p.amountCents}`);
      }
    }
  }

  // 3) Lançamentos (a trigger DEFERIDA confere a dupla entrada no commit).
  for (const p of input.postings) {
    await client.query(
      "insert into ledger_entries(transaction_id, account_id, amount_cents) values ($1,$2,$3)",
      [transactionId, p.accountId, p.amountCents.toString()],
    );
  }

  return { transactionId, idempotent: false };
}
