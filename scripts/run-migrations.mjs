// Minimal migration runner — no framework dependency. Applies each .sql
// file in migrations/ (sorted by filename) inside a transaction, tracked in
// a `schema_migrations` table so re-running is a no-op.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rows } = await client.query("select 1 from schema_migrations where name = $1", [file]);
    if (rows.length > 0) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }

    console.log(`applying: ${file}`);
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }

  console.log("done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
