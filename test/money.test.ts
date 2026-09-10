import { describe, it, expect } from "vitest";
import { toCents, fromCents, payoutCents, mulDivRoundHalfUp, splitEven } from "../src/money.js";

describe("money — política determinística de centavos", () => {
  it("toCents/fromCents com half-up", () => {
    expect(toCents(10)).toBe(1000n);
    expect(toCents(0.1)).toBe(10n);
    expect(toCents(1.005)).toBe(101n); // half-up no centavo
    expect(fromCents(1000n)).toBe("10.00");
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(-105n)).toBe("-1.05");
  });

  it("cotações inteiras: prêmio exato", () => {
    // milhar 9600×: R$1,00 (100c) -> R$9.600,00 (960000c)
    expect(payoutCents(100n, "milhar")).toBe(960000n);
    expect(payoutCents(100n, "super")).toBe(9600000n);
    expect(payoutCents(100n, "grupo")).toBe(2200n);
  });

  it("unidade 9,6× é determinística (half-up), sem float", () => {
    // 1 centavo × 9,6 = 9,6c -> 10c (half-up)
    expect(payoutCents(1n, "unidade")).toBe(10n);
    // 5c × 9,6 = 48c
    expect(payoutCents(5n, "unidade")).toBe(48n);
    // 25c × 9,6 = 240c
    expect(payoutCents(25n, "unidade")).toBe(240n);
    // valor grande sem erro de float: 123456789c × 9,6 = 1185185174,4 -> 1185185174
    expect(payoutCents(123456789n, "unidade")).toBe(1185185174n);
  });

  it("mulDivRoundHalfUp arredonda .5 para cima", () => {
    expect(mulDivRoundHalfUp(1n, 1n, 2n)).toBe(1n); // 0,5 -> 1
    expect(mulDivRoundHalfUp(1n, 1n, 3n)).toBe(0n); // 0,333 -> 0
    expect(mulDivRoundHalfUp(2n, 1n, 3n)).toBe(1n); // 0,666 -> 1
  });

  it("splitEven distribui sem perder nem criar centavos", () => {
    const parts = splitEven(1000n, 5);
    expect(parts).toHaveLength(5);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
    // 1001c em 5 partes: 201,200,200,200,200
    const p2 = splitEven(1001n, 5);
    expect(p2.reduce((a, b) => a + b, 0n)).toBe(1001n);
    expect(p2[0]).toBe(201n);
    // 7c em 3 partes: soma preservada
    const p3 = splitEven(7n, 3);
    expect(p3.reduce((a, b) => a + b, 0n)).toBe(7n);
  });
});
