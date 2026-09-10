import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { withTx, pool, closePool } from "../src/db/pool.js";
import { postTransaction } from "../src/services/ledger.js";
import { ensureSystemAccount } from "../src/services/accounts.js";
import { ledgerBalance, assertReconciled } from "../src/services/wallet.js";
import { truncateAll, newPlayerWithWallet } from "./helpers.js";

beforeEach(truncateAll);
afterAll(closePool);

describe("concorrência — sem gasto duplo (double-spend)", () => {
  it("100 débitos simultâneos nunca deixam o saldo negativo", async () => {
    const { walletId } = await newPlayerWithWallet();
    // deposita R$100,00 = 10000c
    await withTx(async (c) => {
      const clearing = await ensureSystemAccount(c, "deposits_clearing");
      await postTransaction(c, {
        type: "deposit",
        idempotencyKey: "seed",
        postings: [
          { accountId: walletId, amountCents: 10000n },
          { accountId: clearing, amountCents: -10000n },
        ],
      });
    });

    // dispara 100 apostas de R$1,00 (100c) EM PARALELO. Só ~100 cabem.
    const attempts = 100;
    const stake = 100n;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        withTx(async (c) => {
          const house = await ensureSystemAccount(c, "house");
          return postTransaction(c, {
            type: "bet_stake",
            idempotencyKey: `bet-${i}`,
            postings: [
              { accountId: walletId, amountCents: -stake },
              { accountId: house, amountCents: stake },
            ],
          });
        }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    const balance = await withTx((c) => ledgerBalance(c, walletId));
    expect(balance).toBeGreaterThanOrEqual(0n); // NUNCA negativo
    expect(balance).toBe(10000n - BigInt(ok) * stake); // consistente com os sucessos
    expect(ok).toBe(100); // exatamente o que cabia
    expect(failed).toBe(0);
    // invariante saldo=ledger continua válida sob concorrência
    await assertReconciled();
  });

  it("saldo insuficiente é rejeitado, sem meio-débito", async () => {
    const { walletId } = await newPlayerWithWallet();
    await withTx(async (c) => {
      const clearing = await ensureSystemAccount(c, "deposits_clearing");
      await postTransaction(c, {
        type: "deposit",
        idempotencyKey: "seed2",
        postings: [
          { accountId: walletId, amountCents: 150n },
          { accountId: clearing, amountCents: -150n },
        ],
      });
    });
    // tenta debitar 200c com 150c de saldo -> rejeita
    await expect(
      withTx(async (c) => {
        const house = await ensureSystemAccount(c, "house");
        await postTransaction(c, {
          type: "bet_stake",
          idempotencyKey: "over",
          postings: [
            { accountId: walletId, amountCents: -200n },
            { accountId: house, amountCents: 200n },
          ],
        });
      }),
    ).rejects.toThrow(/saldo insuficiente/i);
    const balance = await withTx((c) => ledgerBalance(c, walletId));
    expect(balance).toBe(150n);
    const n = await pool.query<{ c: string }>("select count(*)::text c from ledger_entries");
    expect(n.rows[0].c).toBe("2"); // só os 2 lançamentos do depósito
  });
});
