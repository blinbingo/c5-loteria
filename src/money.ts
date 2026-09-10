// Política ÚNICA e DETERMINÍSTICA de dinheiro. Regras:
//   * Dinheiro sempre em CENTAVOS INTEIROS (bigint). Nunca float.
//   * Multiplicação de prêmio usa a cotação como RACIONAL (num/den) e arredonda
//     com "half-up" via aritmética inteira — resultado idêntico em toda máquina.
//   * Divisão de aposta por posições (scope='all') distribui centavos sem perder
//     nem criar dinheiro (a soma das partes = total).
//
// Cotações do jogo do bicho (preservadas do motor). Só a UNIDADE é fracionária
// (9,6 = 96/10); as demais são inteiras.

export type BetType = "super" | "milhar" | "centena" | "dezena" | "unidade" | "grupo";

export const QUOTE_RATIONAL: Record<BetType, { num: bigint; den: bigint }> = {
  super: { num: 96000n, den: 1n },
  milhar: { num: 9600n, den: 1n },
  centena: { num: 960n, den: 1n },
  dezena: { num: 96n, den: 1n },
  unidade: { num: 96n, den: 10n }, // 9,6
  grupo: { num: 22n, den: 1n },
};

// reais (number) -> centavos (bigint), half-up. Uso só na fronteira de entrada.
export function toCents(reais: number): bigint {
  if (!Number.isFinite(reais)) throw new Error("valor invalido");
  // trabalha em milésimos para arredondar o centavo com segurança
  const milli = Math.round(reais * 1000);
  const cents = Math.trunc(milli / 10) + (Math.abs(milli % 10) >= 5 ? Math.sign(milli) : 0);
  return BigInt(cents);
}

export function fromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const int = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

// Arredondamento half-up de a*num/den, tudo em inteiros (determinístico).
export function mulDivRoundHalfUp(value: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("denominador invalido");
  const prod = value * num;
  if (prod >= 0n) return (prod + den / 2n) / den;
  return -((-prod + den / 2n) / den);
}

// Prêmio de uma aposta que ACERTA uma posição: stake_da_posição × cotação.
export function payoutCents(stakePositionCents: bigint, type: BetType): bigint {
  const q = QUOTE_RATIONAL[type];
  return mulDivRoundHalfUp(stakePositionCents, q.num, q.den);
}

// Distribui `total` centavos em `parts` partes o mais igual possível, sem perder
// nem criar centavos: os primeiros (total mod parts) recebem 1 centavo a mais.
// Usado quando scope='all' (a aposta vale para as 5 posições).
export function splitEven(total: bigint, parts: number): bigint[] {
  if (parts <= 0) throw new Error("parts deve ser > 0");
  const p = BigInt(parts);
  const base = total / p;
  const rem = total - base * p; // 0..parts-1, mesmo sinal de total
  const out: bigint[] = [];
  const one = total >= 0n ? 1n : -1n;
  const r = rem < 0n ? -rem : rem;
  for (let i = 0; i < parts; i += 1) out.push(base + (BigInt(i) < r ? one : 0n));
  return out;
}
