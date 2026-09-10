// Runner de migrations simples, transacional e idempotente.
// Cada arquivo .sql em db/migrations é aplicado uma única vez, dentro de uma
// transação, e registrado em schema_migrations. Uso: tsx db/migrate.ts up|status
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function ensureTable(pool: Pool) {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
}

async function applied(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>("select name from schema_migrations");
  return new Set(rows.map((r) => r.name));
}

async function up() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ensureTable(pool);
    const done = await applied(pool);
    let count = 0;
    for (const name of listMigrations()) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values ($1)", [name]);
        await client.query("commit");
        console.log(`APPLIED ${name}`);
        count += 1;
      } catch (e) {
        await client.query("rollback");
        console.error(`FAILED  ${name}: ${(e as Error).message}`);
        throw e;
      } finally {
        client.release();
      }
    }
    console.log(count ? `\n${count} migration(s) aplicada(s).` : "\nNada a aplicar (banco atualizado).");
  } finally {
    await pool.end();
  }
}

async function status() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ensureTable(pool);
    const done = await applied(pool);
    for (const name of listMigrations()) {
      console.log(`${done.has(name) ? "[x]" : "[ ]"} ${name}`);
    }
  } finally {
    await pool.end();
  }
}

const cmd = process.argv[2] ?? "up";
(cmd === "status" ? status() : up()).catch((e) => {
  console.error(e);
  process.exit(1);
});
