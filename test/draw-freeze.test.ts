import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { pool, withTx, closePool } from "../src/db/pool.js";
import { ENGINE_VERSION } from "../packages/engine/version.js";
import { truncateAll } from "./helpers.js";

beforeEach(truncateAll);
afterAll(closePool);

// Insere uma versão de config e devolve seu id + os parâmetros.
async function insertConfig(retention: number): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `insert into engine_config_versions
       (engine_version, retention_target, bets_per_round, bets_volume_cents, winners_target, bet_weights)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ENGINE_VERSION, retention, 200, 0, 1, JSON.stringify({ milhar: 70, super: 10 })],
  );
  return Number(r.rows[0].id);
}

describe("sorteio — congelamento do snapshot matemático (marco = fechamento)", () => {
  it("config muda depois do fechamento e NÃO altera o sorteio já fechado", async () => {
    const v1 = await insertConfig(20); // config vigente na abertura/fechamento

    // cria e ABRE o sorteio
    const draw = await pool.query<{ id: string }>(
      "insert into draws(label, status) values ('Sorteio 001', 'open') returning id",
    );
    const drawId = draw.rows[0].id;

    // MARCO: fecha o sorteio e CONGELA o snapshot (engine_version + config usada)
    await withTx(async (c) => {
      const cfg = await c.query("select * from engine_config_versions where id=$1", [v1]);
      await c.query(
        `update draws set status='closed', closed_at=now(),
           engine_version=$2, engine_config_version_id=$3, config_snapshot=$4, bets_closed_hash=$5
         where id=$1`,
        [drawId, ENGINE_VERSION, v1, JSON.stringify(cfg.rows[0]), "hash_das_apostas_elegiveis"],
      );
    });

    // Admin muda a config DEPOIS (nova versão vigente com retenção 40)
    const v2 = await insertConfig(40);
    expect(v2).toBeGreaterThan(v1);

    // A config vigente agora é a v2...
    const cur = await pool.query<{ id: string; retention_target: string }>("select * from engine_config_current");
    expect(Number(cur.rows[0].id)).toBe(v2);
    expect(Number(cur.rows[0].retention_target)).toBe(40);

    // ...mas o SORTEIO continua congelado na v1 (retenção 20), reproduzível.
    const d = await pool.query("select engine_version, engine_config_version_id, config_snapshot from draws where id=$1", [drawId]);
    expect(d.rows[0].engine_version).toBe(ENGINE_VERSION);
    expect(Number(d.rows[0].engine_config_version_id)).toBe(v1);
    expect(Number(d.rows[0].config_snapshot.retention_target)).toBe(20);
  });

  it("tentar alterar o snapshot de um sorteio já fechado é BLOQUEADO", async () => {
    const v1 = await insertConfig(20);
    const draw = await pool.query<{ id: string }>(
      "insert into draws(label, status) values ('Sorteio 002', 'open') returning id",
    );
    const drawId = draw.rows[0].id;
    await pool.query(
      "update draws set status='closed', closed_at=now(), engine_version=$2, engine_config_version_id=$3, config_snapshot=$4 where id=$1",
      [drawId, ENGINE_VERSION, v1, JSON.stringify({ retention_target: 20 })],
    );
    // qualquer alteração do snapshot congelado deve estourar
    await expect(
      pool.query("update draws set config_snapshot=$2 where id=$1", [drawId, JSON.stringify({ retention_target: 99 })]),
    ).rejects.toThrow(/congelad/i);
    await expect(
      pool.query("update draws set engine_config_version_id=999999 where id=$1", [drawId]),
    ).rejects.toThrow(/congelad/i);
  });
});
