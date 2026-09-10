// C5 — Motor do jogo do bicho (núcleo puro da retenção).
// PRESERVADO do projeto anterior SEM alteração de lógica/matemática: cotações,
// apuração REAL (settleReal: ganha só quem acerta; prêmio = valor × cotação) e
// escolha do resultado pela casa (chooseResult: mira retenção-alvo e nº de
// ganhadores). Função pura: não conhece banco, carteira nem autenticação.
// Qualquer mudança de matemática aqui deve ser explícita e coberta por testes.

export type BetType = "super" | "milhar" | "centena" | "dezena" | "unidade" | "grupo";
export type PrizeScope = 0 | 1 | 2 | 3 | 4 | "all";
export type ModeKind = "exact" | "suffix" | "group";
export type Mode = { key: BetType; label: string; short: string; quote: number; placeholder: string; kind: ModeKind; parts: number[] };

export type TicketStatus = "pendente" | "premiado" | "perdido";
export type Ticket = {
  id: string;
  drawId: string;
  playerId: string;
  playerName: string;
  type: BetType;
  selection: string;
  scope: PrizeScope;
  amount: number;
  status: TicketStatus;
  payout: number;
};
export type DrawStatus = "aberto" | "fechado" | "finalizado";
export type Draw = {
  id: string;
  label: string;
  createdAt: string;
  drawTime: string | null; // horário agendado do resultado (null = manual)
  finalizedAt: string | null;
  status: DrawStatus;
  prizes: string[] | null;
  staked: number;
  payout: number;
  retention: number | null;
  ticketCount: number;
  targetRetention: number;
  winnerId: string | null;
  winnerName: string | null;
};
export type Player = {
  id: string;
  name: string;
  balance: number;
  staked: number;
  won: number;
  wins: number;
  betCount: number;
  lastWin: number;
};

export const PRIZE_COUNT = 5;
export const STARTING_CREDITS = 10_000;
export const PLAYER_COUNT = 1_000;

export const MODES: Mode[] = [
  { key: "super", label: "Super milhar", short: "5 dígitos", quote: 96000, placeholder: "00000", kind: "exact", parts: [5] },
  { key: "milhar", label: "Milhar", short: "4 dígitos", quote: 9600, placeholder: "0000", kind: "suffix", parts: [4] },
  { key: "centena", label: "Centena", short: "3 dígitos", quote: 960, placeholder: "000", kind: "suffix", parts: [3] },
  { key: "dezena", label: "Dezena", short: "2 dígitos", quote: 96, placeholder: "00", kind: "suffix", parts: [2] },
  { key: "unidade", label: "Unidade", short: "1 dígito", quote: 9.6, placeholder: "0", kind: "suffix", parts: [1] },
  { key: "grupo", label: "Grupo", short: "1 a 25", quote: 22, placeholder: "01", kind: "group", parts: [2] },
];
export const MODE_BY_KEY = Object.fromEntries(MODES.map((mode) => [mode.key, mode])) as Record<BetType, Mode>;
export const ALL_TYPES = MODES.map((mode) => mode.key);
export const modeByKey = (key: BetType) => MODE_BY_KEY[key];

export const formatCredits = (value: number) => `R$ ${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
export const formatPercent = (value: number) => `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`;
export const formatInt = (value: number) => new Intl.NumberFormat("pt-BR").format(value);
export const formatDateTime = (iso: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));

const padDraw = (value: number) => String(value).padStart(5, "0");
// Grupo do jogo do bicho a partir da dezena final (00→25, 01–04→01, 05–08→02, …, 85–88→22, 89–92→23, 93–96→24, 97–99→25).
export const groupOfTwo = (two: number) => (two === 0 ? 25 : Math.ceil(two / 4));
const hypotheticalGroup = (draw: string) => groupOfTwo(Number(draw.slice(-2)));
export const scopeIndexes = (scope: PrizeScope) => (scope === "all" ? [0, 1, 2, 3, 4] : [scope]);
export const scopeLabel = (scope: PrizeScope) => (scope === "all" ? "1º–5º" : `${Number(scope) + 1}º prêmio`);
export const betStakeForPosition = (ticket: Pick<Ticket, "amount" | "scope">) => ticket.amount / scopeIndexes(ticket.scope).length;

const randInt = (max: number) => Math.floor(Math.random() * max);
const randomDigits = (size: number) => String(randInt(10 ** size)).padStart(size, "0");

export const normalizeSelection = (type: BetType, raw: string) => {
  const mode = modeByKey(type);
  const digits = raw.replace(/\D/g, "");
  let offset = 0;
  return mode.parts
    .map((size) => {
      const part = digits.slice(offset, offset + size).padStart(size, "0");
      offset += size;
      return part;
    })
    .join("/");
};

const isModeMatch = (prize: string, mode: Mode, selection: string) => {
  const part = selection.split("/")[0];
  if (mode.kind === "exact") return prize === part;
  if (mode.kind === "suffix") return prize.slice(-mode.parts[0]) === part;
  return hypotheticalGroup(prize) === Number(part);
};
export const isBetMatch = (prize: string, ticket: Pick<Ticket, "type" | "selection">) => isModeMatch(prize, modeByKey(ticket.type), ticket.selection);

// Seleção aleatória válida para uma modalidade (usada para gerar os palpites fictícios).
export const randomSelectionFor = (type: BetType) => {
  const mode = modeByKey(type);
  if (mode.kind === "group") return String(randInt(25) + 1).padStart(2, "0");
  return randomDigits(mode.parts[0]);
};

// ---------------------------------------------------------------------------
// Apuração REAL (jogo do bicho): dado o resultado, ganha quem realmente acerta.
// Os bilhetes já existem antes do resultado; aqui só conferimos e pagamos
// valor_por_posição × cotação para cada posição coincidente.
// ---------------------------------------------------------------------------
export type Settlement = { payoutById: Map<string, number>; total: number; winners: number };

export const settleReal = (prizes: string[], tickets: Ticket[]): Settlement => {
  const payoutById = new Map<string, number>();
  let total = 0;
  let winners = 0;
  for (const t of tickets) {
    const mode = modeByKey(t.type);
    const stakePer = betStakeForPosition(t);
    let pay = 0;
    for (const pos of scopeIndexes(t.scope)) {
      if (isBetMatch(prizes[pos], t)) pay += stakePer * mode.quote;
    }
    if (pay > 0) {
      payoutById.set(t.id, pay);
      total += pay;
      winners += 1;
    }
  }
  return { payoutById, total, winners };
};

// Tabelas de pagamento (e nº de acertos) por posição: quanto sairia de prêmio /
// quantos bilhetes ganhariam se aquela posição fosse o número n. Construídas por
// histograma de sufixos (rápido, O(bilhetes) + O(5×100000)).
const buildTables = (tickets: Ticket[]) => {
  const suffix = [1, 2, 3, 4].map((L) => Array.from({ length: PRIZE_COUNT }, () => new Float64Array(10 ** L)));
  const suffixWin = [1, 2, 3, 4].map((L) => Array.from({ length: PRIZE_COUNT }, () => new Float64Array(10 ** L)));
  const grp = Array.from({ length: PRIZE_COUNT }, () => new Float64Array(26));
  const grpWin = Array.from({ length: PRIZE_COUNT }, () => new Float64Array(26));
  const exact: Array<Map<number, number>> = Array.from({ length: PRIZE_COUNT }, () => new Map());
  const exactWin: Array<Map<number, number>> = Array.from({ length: PRIZE_COUNT }, () => new Map());
  for (const t of tickets) {
    const mode = modeByKey(t.type);
    const pay = betStakeForPosition(t) * mode.quote;
    const val = Number(t.selection.split("/")[0]);
    for (const p of scopeIndexes(t.scope)) {
      if (mode.kind === "exact") {
        exact[p].set(val, (exact[p].get(val) ?? 0) + pay);
        exactWin[p].set(val, (exactWin[p].get(val) ?? 0) + 1);
      } else if (mode.kind === "group") {
        grp[p][val] += pay;
        grpWin[p][val] += 1;
      } else {
        const L = mode.parts[0];
        suffix[L - 1][p][val] += pay;
        suffixWin[L - 1][p][val] += 1;
      }
    }
  }
  const payout = Array.from({ length: PRIZE_COUNT }, () => new Float64Array(100_000));
  const winners = Array.from({ length: PRIZE_COUNT }, () => new Float64Array(100_000));
  for (let p = 0; p < PRIZE_COUNT; p++) {
    for (let n = 0; n < 100_000; n++) {
      const two = n % 100;
      const g = groupOfTwo(two);
      let v = suffix[0][p][n % 10] + suffix[1][p][two] + suffix[2][p][n % 1000] + suffix[3][p][n % 10_000] + grp[p][g];
      let w = suffixWin[0][p][n % 10] + suffixWin[1][p][two] + suffixWin[2][p][n % 1000] + suffixWin[3][p][n % 10_000] + grpWin[p][g];
      const e = exact[p].get(n);
      if (e) { v += e; w += exactWin[p].get(n) ?? 0; }
      payout[p][n] = v;
      winners[p][n] = w;
    }
  }
  return { payout, winners };
};

// Escolhe ~24 números representativos por posição, espalhados do menor ao maior
// pagamento. Entre números de MESMO pagamento, sorteia um ao acaso (amostragem
// de reservatório) para o resultado ter cara real, e não sair sempre 00xxx.
const spreadOptions = (table: Float64Array, count = 24): number[] => {
  let min = Infinity;
  let max = -Infinity;
  for (let n = 0; n < table.length; n++) { const v = table[n]; if (v < min) min = v; if (v > max) max = v; }
  if (max <= min) return [randInt(100_000)]; // nenhuma diferença de pagamento → número aleatório
  const span = max - min;
  const best = new Array(count).fill(-1);
  const bestDist = new Array(count).fill(Infinity);
  const seen = new Array(count).fill(0);
  for (let n = 0; n < table.length; n++) {
    const i = Math.round(((table[n] - min) / span) * (count - 1));
    const target = min + (span * i) / (count - 1);
    const d = Math.abs(table[n] - target);
    if (d < bestDist[i]) { bestDist[i] = d; best[i] = n; seen[i] = 1; }
    else if (d === bestDist[i]) { seen[i] += 1; if (Math.random() < 1 / seen[i]) best[i] = n; }
  }
  return Array.from(new Set(best.filter((x) => x >= 0)));
};

// A casa escolhe o RESULTADO com uma busca em dois objetivos, mantendo a
// apuração real (ganha só quem acerta):
//   1) pagar o mais PERTO possível do valor-alvo (retenção-alvo);
//   2) entre os resultados de pagamento parecido, o que tem o número de
//      ganhadores mais PRÓXIMO do alvo (se o alvo não existe, o mais perto).
// Os bilhetes já existem e não mudam.
export const chooseResult = (tickets: Ticket[], staked: number, targetRetention: number, targetWinners: number): string[] => {
  const random5 = () => Array.from({ length: PRIZE_COUNT }, () => padDraw(randInt(100_000)));
  if (!tickets.length || staked <= 0) return random5();
  const { payout, winners } = buildTables(tickets);
  // Opções por posição cobrindo os DOIS eixos: espalhadas por pagamento E por
  // número de ganhadores. Assim a busca consegue mirar valor e nº de ganhadores.
  const opts = payout.map((table, p) => Array.from(new Set([...spreadOptions(table, 16), ...spreadOptions(winners[p], 10)])).slice(0, 22));

  type Half = { pay: number; win: number; nums: number[] };
  const first: Half[] = [];
  for (const a of opts[0]) for (const b of opts[1]) for (const c of opts[2]) {
    first.push({ pay: payout[0][a] + payout[1][b] + payout[2][c], win: winners[0][a] + winners[1][b] + winners[2][c], nums: [a, b, c] });
  }
  const second: Half[] = [];
  for (const d of opts[3]) for (const e of opts[4]) {
    second.push({ pay: payout[3][d] + payout[4][e], win: winners[3][d] + winners[4][e], nums: [d, e] });
  }
  second.sort((x, y) => x.pay - y.pay);
  const secIdx = Array.from(new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((f) => Math.round(f * (second.length - 1)))));

  const targetPayout = staked * (1 - targetRetention);
  type Cand = { pay: number; win: number; nums: number[] };
  const cands: Cand[] = [];
  for (const f of first) {
    for (const si of secIdx) {
      const sHalf = second[si];
      if (!sHalf) continue;
      cands.push({ pay: f.pay + sHalf.pay, win: f.win + sHalf.win, nums: [...f.nums, ...sHalf.nums] });
    }
  }
  if (!cands.length) return random5();

  // 1º objetivo: RETENÇÃO o mais perto possível do alvo (pagamento perto do alvo).
  let minPayErr = Infinity;
  for (const c of cands) { const e = Math.abs(c.pay - targetPayout); if (e < minPayErr) minPayErr = e; }
  // Tolerância pequena (~2% do vendido) para poder otimizar os ganhadores SEM se
  // afastar da retenção-alvo.
  const tol = Math.max(staked * 0.02, minPayErr * 1.3);

  // 2º objetivo: entre os de retenção parecida, ganhadores mais perto do alvo;
  // desempate pelo pagamento mais certeiro.
  let best: Cand | null = null;
  let bestDw = Infinity;
  let bestPe = Infinity;
  for (const c of cands) {
    const pe = Math.abs(c.pay - targetPayout);
    if (pe > minPayErr + tol) continue;
    const dw = Math.abs(Math.round(c.win) - targetWinners);
    if (!best || dw < bestDw || (dw === bestDw && pe < bestPe)) { best = c; bestDw = dw; bestPe = pe; }
  }
  return (best ?? cands[0]).nums.map((n) => padDraw(n));
};

// ---------------------------------------------------------------------------
// Geração de 1000 nomes fictícios (Mariazinha, Zezinho, etc.)
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  "Mariazinha", "Zezinho", "Joãozinho", "Aninha", "Chico", "Dona Cida", "Seu Zé", "Bia", "Toninho", "Neném",
  "Cleide", "Wanderson", "Jussara", "Robertinho", "Marlene", "Vagner", "Dedé", "Fabiana", "Genival", "Sueli",
  "Nilton", "Rosinha", "Cacá", "Divina", "Elias", "Fátima", "Gilmar", "Hilda", "Ivo", "Jandira",
  "Kleber", "Lurdes", "Moacir", "Neusa", "Odair", "Perpétua", "Quitéria", "Reginaldo", "Solange", "Tião",
  "Ubiratan", "Valdirene", "Wesley", "Ximena", "Yara", "Zilda", "Adriano", "Benedita", "Cléber", "Domingas",
  "Edinho", "Fernandinha", "Gerson", "Heloísa", "Irineu", "Josenildo", "Kátia", "Luizinho", "Márcia", "Nego",
];
const SURNAMES = [
  "da Silva", "dos Santos", "Pereira", "Oliveira", "Souza", "Lima", "Costa", "Alves", "Ferreira", "Rodrigues",
  "Gomes", "Martins", "Araújo", "Barbosa", "Ribeiro", "Cardoso", "Rocha", "Dias", "Nascimento", "Moreira",
  "do Carmo", "Bezerra", "Cavalcante", "Teixeira", "Vieira", "Mendes", "Freitas", "Nunes", "Ramos", "Machado",
];

export const generatePlayers = (count = PLAYER_COUNT, credits = STARTING_CREDITS): Player[] => {
  const players: Player[] = [];
  const used = new Set<string>();
  let i = 0;
  while (players.length < count) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const surname = SURNAMES[Math.floor(i / FIRST_NAMES.length) % SURNAMES.length];
    let name = `${first} ${surname}`;
    if (used.has(name)) name = `${first} ${surname} ${Math.floor(i / (FIRST_NAMES.length * SURNAMES.length)) + 2}`;
    used.add(name);
    players.push({
      id: `p${players.length + 1}`,
      name,
      balance: credits,
      staked: 0,
      won: 0,
      wins: 0,
      betCount: 0,
      lastWin: -1,
    });
    i += 1;
  }
  return players;
};

// ---------------------------------------------------------------------------
// Tipos e defaults do estado da simulação (compartilhados servidor/cliente).
// ---------------------------------------------------------------------------
export type Config = {
  retentionTarget: number;
  betsPerRound: number;
  betsVolume: number;
  winnersTarget: number;
  betWeights: Record<BetType, number>;
  // Modo "média alvo": quando ligado, cada sorteio compensa os anteriores para a
  // MÉDIA (dos sorteios do período) ficar no alvo — não o sorteio isolado.
  avgMode: boolean;
  avgTarget: number; // % de retenção que a MÉDIA do período deve atingir
  avgSince: string; // período: considera sorteios finalizados A PARTIR desta data/hora (ISO). "" = todo o histórico.
};
export type State = { players: Player[]; draws: Draw[]; tickets: Ticket[]; config: Config; seq: number };
export const DEFAULT_BET_WEIGHTS: Record<BetType, number> = { milhar: 70, super: 10, centena: 5, dezena: 5, unidade: 5, grupo: 5 };
export const freshConfig = (): Config => ({ retentionTarget: 20, betsPerRound: 30_000, betsVolume: 0, winnersTarget: 1, betWeights: { ...DEFAULT_BET_WEIGHTS }, avgMode: false, avgTarget: 20, avgSince: "" });
