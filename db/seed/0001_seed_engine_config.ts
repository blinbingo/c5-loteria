// Migração do state.json antigo → engine_config_versions (v1).
// Aproveita SOMENTE os parâmetros do motor. Jogadores/apostas/sorteios do estudo
// NÃO são migrados (produção começa limpa). Uso:
//   STATE_JSON=/caminho/state.json tsx db/seed/0001_seed_engine_config.ts
import { readFileSync } from "node:fs";
import { pool } from "../../src/db/pool.js";
import { ENGINE_VERSION } from "../../packages/engine/version.js";
import { toCents } from "../../src/money.js";

async function main() {
  const path = process.env.STATE_JSON;
  const cfg = path ? (JSON.parse(readFileSync(path, "utf8")).config ?? {}) : {};

  const retention = Number(cfg.retentionTarget ?? 20);
  const betsPerRound = Number(cfg.betsPerRound ?? 200);
  const betsVolumeCents = toCents(Number(cfg.betsVolume ?? 0)).toString();
  const winnersTarget = Number(cfg.winnersTarget ?? 1);
  const betWeights = cfg.betWeights ?? { milhar: 70, super: 10, centena: 5, dezena: 5, unidade: 5, grupo: 5 };
  const avgMode = Boolean(cfg.avgMode ?? false);
  const avgTarget = Number(cfg.avgTarget ?? 20);
  const avgSince = cfg.avgSince || null;

  await pool.query(
    `insert into engine_config_versions
       (engine_version, retention_target, bets_per_round, bets_volume_cents, winners_target, bet_weights, avg_mode, avg_target, avg_since)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ENGINE_VERSION, retention, betsPerRound, betsVolumeCents, winnersTarget, JSON.stringify(betWeights), avgMode, avgTarget, avgSince],
  );
  console.log(`engine_config v1 semeada (retention=${retention}%, engine=${ENGINE_VERSION})${path ? ` a partir de ${path}` : " com defaults"}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
