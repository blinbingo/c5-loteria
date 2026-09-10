import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { pool, withTx, closePool } from "../src/db/pool.js";
import { postTransaction } from "../src/services/ledger.js";
import { ensureSystemAccount } from "../src/services/accounts.js";
import { ledgerBalance, materializedBalance, reconcile, assertReconciled } from "../src/services/wallet.js";
import { truncateAll, newPlayerWithWallet } from "./helpers.js";

beforeEach(truncateAll);
afterAll(closePool);

// credita a carteira (depósito) — dupla entrada: wallet +X / deposits_clearing -X
async function deposit(walletId: string, cents: bigint, key: string) {
  return withTx(async (c) => {
    const clearing = await ensureSystemAccount(c, "deposits_clearing");
    return postTransaction(c, {
      type: "deposit",
      idempotencyKey: key,
      postings: [
        { accountId: walletId, amountCents: cents },
        { accountId: clearing, amountCents: -cents },
      ],
    });
  });
}

describe("ledger — dupla entrada e imutabilidade", () => {
  it("transação balanceada é aceita e projeta o saldo", async () => {
    const { walletId } = await newPlayerWithWallet();
    await deposit(walletId, 10000n, "dep-1");
    const led = await withTx((c) => ledgerBalance(c, walletId));
    const mat = await withTx((c) => materializedBalance(c, walletId));
    expect(led).toBe(10000n);
    expect(mat).toBe(10000n);
  });

  it("transação DESBALANCEADA é rejeitada no commit (trigger deferida)", async () => {
    const { walletId } = await newPlayerWithWallet();
    await expect(
      withTx(async (c) => {
        const clearing = await ensureSystemAccount(c, "deposits_clearing");
        // soma != 0 -> deve estourar
        await postTransaction(c, {
          type: "deposit",
          idempotencyKey: "bad-1",
          postings: [
            { accountId: walletId, amountCents: 10000n },
            { accountId: clearing, amountCents: -9999n },
          ],
        });
      }),
    ).rejects.toThrow();
    // nada persistido
    const led = await withTx((c) => ledgerBalance(c, walletId));
    expect(led).toBe(0n);
  });

  it("ledger é append-only: UPDATE e DELETE são proibidos", async () => {
    const { walletId } = await newPlayerWithWallet();
    await deposit(walletId, 500n, "dep-imut");
    await expect(pool.query("update ledger_entries set amount_cents = 1")).rejects.toThrow(/append-only/i);
    await expect(pool.query("delete from ledger_entries")).rejects.toThrow(/append-only/i);
    await expect(pool.query("delete from ledger_transactions")).rejects.toThrow(/append-only/i);
  });
});

describe("ledger — idempotência financeira", () => {
  it("mesma idempotency_key NÃO duplica lançamentos", async () => {
    const { walletId } = await newPlayerWithWallet();
    const r1 = await deposit(walletId, 7000n, "idem-key");
    const r2 = await deposit(walletId, 7000n, "idem-key"); // retry
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(true);
    expect(r2.transactionId).toBe(r1.transactionId);
    const led = await withTx((c) => ledgerBalance(c, walletId));
    expect(led).toBe(7000n); // creditou UMA vez só
    const n = await pool.query<{ c: string }>("select count(*)::text c from ledger_transactions");
    expect(n.rows[0].c).toBe("1");
  });
});

describe("ledger — reconstrução de saldo e invariante", () => {
  it("saldo materializado == soma do ledger, após várias operações", async () => {
    const { walletId } = await newPlayerWithWallet();
    await deposit(walletId, 10000n, "r-1");
    await deposit(walletId, 2500n, "r-2");
    // aposta: debita a carteira, credita a casa
    await withTx(async (c) => {
      const house = await ensureSystemAccount(c, "house");
      await postTransaction(c, {
        type: "bet_stake",
        idempotencyKey: "r-bet",
        postings: [
          { accountId: walletId, amountCents: -3000n },
          { accountId: house, amountCents: 3000n },
        ],
      });
    });
    const led = await withTx((c) => ledgerBalance(c, walletId));
    const mat = await withTx((c) => materializedBalance(c, walletId));
    expect(led).toBe(9500n);
    expect(mat).toBe(led);
    const checked = await assertReconciled();
    expect(checked).toBeGreaterThan(0);
    expect(await reconcile()).toHaveLength(0);
  });

  it("DIVERGÊNCIA é detectada como erro crítico e NUNCA corrigida", async () => {
    const { walletId } = await newPlayerWithWallet();
    await deposit(walletId, 4000n, "d-1");
    // corrompe o cache de propósito (simula bug/adulteração)
    await pool.query("update account_balances set balance_cents = balance_cents + 1 where account_id=$1", [walletId]);
    const div = await reconcile();
    expect(div).toHaveLength(1);
    expect(div[0].materializedCents).toBe(4001n);
    expect(div[0].ledgerCents).toBe(4000n);
    // a checagem estrita ESTOURA (não corrige)
    await expect(assertReconciled()).rejects.toThrow(/CRITICO|divergencia/i);
    // e o ledger (fonte da verdade) segue intacto
    const led = await withTx((c) => ledgerBalance(c, walletId));
    expect(led).toBe(4000n);
  });
});

describe("ledger — rollback desfaz tudo", () => {
  it("erro no meio da transação não deixa resíduo", async () => {
    const { walletId } = await newPlayerWithWallet();
    await deposit(walletId, 1000n, "rb-ok");
    await expect(
      withTx(async (c) => {
        const clearing = await ensureSystemAccount(c, "deposits_clearing");
        await postTransaction(c, {
          type: "deposit",
          idempotencyKey: "rb-2",
          postings: [
            { accountId: walletId, amountCents: 5000n },
            { accountId: clearing, amountCents: -5000n },
          ],
        });
        throw new Error("boom no meio da transação");
      }),
    ).rejects.toThrow(/boom/);
    // o depósito de 5000 foi desfeito; sobra só o de 1000
    const led = await withTx((c) => ledgerBalance(c, walletId));
    expect(led).toBe(1000n);
    const n = await pool.query<{ c: string }>("select count(*)::text c from ledger_transactions");
    expect(n.rows[0].c).toBe("1");
  });
});
