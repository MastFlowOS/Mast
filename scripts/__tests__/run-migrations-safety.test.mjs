import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runMigrations,
  loadManifest,
  MAST_CATALOG_TABLES,
  MAST_CATALOG_SEQUENCES,
  MAST_CATALOG_ROUTINES,
  SAFE_FILENAME_REGEX
} from "../run-migrations.mjs";

class MockPgClient {
  constructor(config = {}) {
    // If mastArtifacts is explicitly provided, use it; otherwise convert markerTables to 'table:<name>'
    if (config.mastArtifacts) {
      this.mastArtifacts = [...config.mastArtifacts];
    } else if (config.markerTables) {
      this.mastArtifacts = config.markerTables.map((t) => `table:${t}`);
    } else {
      this.mastArtifacts = [];
    }
    this.ledgerExists = config.ledgerExists ?? false;
    this.appliedMigrations = config.appliedMigrations ? [...config.appliedMigrations] : [];
    this.failOnSql = config.failOnSql || null;
    this.failOnLedgerInsert = config.failOnLedgerInsert || false;
    this.queries = [];
    this.connected = false;
    this.ended = false;
  }

  async connect() {
    this.connected = true;
  }

  async end() {
    this.ended = true;
  }

  async query(text, params = []) {
    const raw = text.trim();
    this.queries.push({ text: raw, params });
    const normalized = raw.toLowerCase().replace(/\s+/g, " ");

    if (normalized.startsWith("begin")) {
      return { rows: [] };
    }
    if (normalized.startsWith("commit")) {
      return { rows: [] };
    }
    if (normalized.startsWith("rollback")) {
      return { rows: [] };
    }

    if (normalized.includes("mast_catalog_scan")) {
      return {
        rows: this.mastArtifacts.map((art) => {
          const [type, name] = art.split(":");
          return { artifact_type: type, artifact_name: name };
        })
      };
    }

    if (normalized.includes("to_regclass('public.schema_migrations')")) {
      return {
        rows: [{ exists: this.ledgerExists }]
      };
    }

    if (normalized.includes("create table if not exists public.schema_migrations")) {
      this.ledgerExists = true;
      return { rows: [] };
    }

    if (
      normalized.includes("select name, applied_at from public.schema_migrations") ||
      normalized.includes("select name from public.schema_migrations")
    ) {
      return {
        rows: this.appliedMigrations.map((m) => ({ name: m, applied_at: new Date() }))
      };
    }

    if (normalized.includes("insert into public.schema_migrations")) {
      if (this.failOnLedgerInsert) {
        throw new Error("Simulated public.schema_migrations constraint/connection failure");
      }
      const name = params[0];
      this.appliedMigrations.push(name);
      return { rows: [] };
    }

    if (this.failOnSql && raw.includes(this.failOnSql)) {
      throw new Error(`Simulated SQL execution error on: ${this.failOnSql}`);
    }

    return { rows: [] };
  }
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

describe("MAST Hardened Migration Runner — Safety & Defect Verification Suite", () => {
  const manifest = loadManifest();
  const allBaseline = manifest.baseline_migrations;

  // Scenario 1: Missing ledger on populated MAST DB -> ABORTS
  test("Scenario 1: Populated MAST DB without public.schema_migrations aborts with critical error", async () => {
    const client = new MockPgClient({
      markerTables: ["businesses", "leads", "profiles"],
      ledgerExists: false
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Unbaselined MAST database detected/);
    assert.strictEqual(
      client.queries.some((q) => q.text.startsWith("BEGIN")),
      false,
      "Must not execute any transactions"
    );
  });

  // Scenario 2: Existing empty ledger on populated DB -> ABORTS
  test("Scenario 2: Populated DB with empty public.schema_migrations aborts to prevent historical replay", async () => {
    const client = new MockPgClient({
      markerTables: ["businesses", "leads"],
      ledgerExists: true,
      appliedMigrations: []
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Empty ledger detected/);
    assert.strictEqual(
      client.queries.some((q) => q.text.startsWith("BEGIN")),
      false
    );
  });

  // Scenario 3: Partial historical baseline on populated DB -> ABORTS
  test("Scenario 3: Populated DB with incomplete baseline (e.g. 50/51) aborts before applying any file", async () => {
    const incompleteBaseline = allBaseline.slice(0, 50); // missing 049
    const client = new MockPgClient({
      markerTables: ["businesses", "profiles"],
      ledgerExists: true,
      appliedMigrations: incompleteBaseline
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Incomplete historical baseline in public\.schema_migrations/);
    assert.match(result.error.message, /049_fix_deliver_lead_for_user_bigint_lead_id\.sql/);
    assert.strictEqual(
      client.queries.some((q) => q.text.startsWith("BEGIN")),
      false
    );
  });

  // Scenario 4: Attempted replay of historical baseline migration on populated DB -> ABORTS
  test("Scenario 4: Replay of historical migration (001) is intercepted and rejected", async () => {
    const missing001 = allBaseline.filter((m) => m !== "001_opportunity_engine.sql");
    const client = new MockPgClient({
      markerTables: ["businesses", "leads"],
      ledgerExists: true,
      appliedMigrations: missing001
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /001_opportunity_engine\.sql/);
    assert.strictEqual(
      client.queries.some((q) => q.text.includes("create policy \"businesses readable by authenticated\"")),
      false
    );
  });

  // Scenario 5: Complete historical baseline + new forward migration (050) -> EXECUTES in transaction
  test("Scenario 5: Complete baseline + forward migration executes inside BEGIN/COMMIT with ledger insertion", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-5-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline mock");
      }
      const forwardSql = "CREATE TABLE test_forward_050 (id bigint PRIMARY KEY);";
      fs.writeFileSync(path.join(tempDir, "050_test_forward_migration.sql"), forwardSql);

      const client = new MockPgClient({
        markerTables: ["businesses", "leads", "profiles"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.applied, ["050_test_forward_migration.sql"]);

      const executed = client.queries.map((q) => q.text);
      const beginIdx = executed.indexOf("BEGIN;");
      const sqlIdx = executed.indexOf(forwardSql);
      const insertIdx = executed.findIndex((q) => q.startsWith("INSERT INTO public.schema_migrations"));
      const commitIdx = executed.indexOf("COMMIT;");

      assert.ok(beginIdx !== -1, "Must execute BEGIN;");
      assert.ok(sqlIdx > beginIdx, "SQL must execute after BEGIN;");
      assert.ok(insertIdx > sqlIdx, "INSERT must execute after SQL;");
      assert.ok(commitIdx > insertIdx, "COMMIT must execute after INSERT;");
      assert.ok(client.appliedMigrations.includes("050_test_forward_migration.sql"));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 6: Alternative schema ledger (supabase_migrations) does NOT satisfy ledger check
  test("Scenario 6: Alternative schema ledger (supabase_migrations) does not satisfy public.schema_migrations check", async () => {
    const client = new MockPgClient({
      markerTables: ["businesses"],
      ledgerExists: false
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Unbaselined MAST database detected/);
  });

  // Scenario 7: Forward migration SQL fails -> ROLLBACK and halts immediately, no ledger insert
  test("Scenario 7: Forward migration SQL failure triggers ROLLBACK and aborts without ledger entry", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-7-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      const badSql = "SYNTAX ERROR STATEMENT;";
      fs.writeFileSync(path.join(tempDir, "050_bad_sql.sql"), badSql);

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline],
        failOnSql: "SYNTAX ERROR STATEMENT"
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Migration 050_bad_sql\.sql failed/);

      const executed = client.queries.map((q) => q.text);
      assert.ok(executed.includes("BEGIN;"), "Must have started transaction");
      assert.ok(executed.includes("ROLLBACK;"), "Must have issued ROLLBACK;");
      assert.strictEqual(
        executed.some((q) => q.startsWith("INSERT INTO public.schema_migrations") && q.includes("050_bad_sql")),
        false,
        "Failed migration must NEVER be inserted into public.schema_migrations"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 8: Ledger insertion fails -> ROLLBACK of entire migration transaction
  test("Scenario 8: Failure during ledger insertion rolls back the migration DDL transaction", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-8-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      fs.writeFileSync(path.join(tempDir, "050_table_create.sql"), "CREATE TABLE test_rollback (id int);");

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline],
        failOnLedgerInsert: true
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Migration 050_table_create\.sql failed/);

      const executed = client.queries.map((q) => q.text);
      assert.ok(executed.includes("BEGIN;"));
      assert.ok(executed.includes("ROLLBACK;"));
      assert.strictEqual(
        client.appliedMigrations.includes("050_table_create.sql"),
        false,
        "Migration must not remain in applied set"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 9: Empty DB without bootstrap flag -> ABORTS with safety notice
  test("Scenario 9: Empty database without bootstrap flag refuses automatic execution", async () => {
    const client = new MockPgClient({
      mastArtifacts: [],
      ledgerExists: false
    });

    const result = await runMigrations({
      client,
      manifest,
      args: [],
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Unbaselined empty database detected/);
    assert.match(result.error.message, /every unbaselined database must fail closed/i);
    assert.strictEqual(
      client.queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS public.schema_migrations")),
      false
    );
  });

  // Scenario 10 (DEFECT 1 CORRECTION): Bootstrap with --bootstrap-empty-db is explicitly rejected
  test("Scenario 10: Bootstrap with --bootstrap-empty-db is rejected and fails closed while unsupported", async () => {
    const client = new MockPgClient({
      mastArtifacts: [],
      ledgerExists: false
    });

    const result = await runMigrations({
      client,
      manifest,
      args: ["--bootstrap-empty-db"],
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Bootstrap is unsupported and rejected/);
    assert.match(result.error.message, /Every unbaselined database must fail closed/);
    assert.strictEqual(
      client.queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS public.schema_migrations")),
      false,
      "Must never create schema_migrations on unsupported bootstrap"
    );
  });

  // Scenario 11: All baseline + forward migrations applied, no new migrations -> clean up-to-date no-op
  test("Scenario 11: Up-to-date database performs zero DDL and returns clean success", async () => {
    const allDiskSql = fs
      .readdirSync(path.resolve("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const client = new MockPgClient({
      markerTables: ["businesses", "leads", "profiles"],
      ledgerExists: true,
      appliedMigrations: allDiskSql
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(
      client.queries.some((q) => q.text.startsWith("BEGIN")),
      false
    );
  });

  // Scenario 12: Replay of migration 001 attempted on populated DB -> intercepted and prevented
  test("Scenario 12: Populated DB explicitly protects against 001 opportunity_engine replay", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-12-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline mock");
      }
      const p001 = "001_opportunity_engine.sql";
      fs.writeFileSync(
        path.join(tempDir, p001),
        "CREATE POLICY \"businesses readable by authenticated\" ON businesses FOR SELECT USING (true);"
      );

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: allBaseline.filter((m) => m !== p001)
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Incomplete historical baseline/);
      assert.strictEqual(
        client.queries.some((q) => q.text.includes("businesses readable by authenticated")),
        false
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 13: search_path manipulation cannot trick ledger check (explicit public qualification)
  test("Scenario 13: All ledger operations use explicit public.schema_migrations schema qualification", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-13-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      fs.writeFileSync(path.join(tempDir, "050_test.sql"), "SELECT 1;");

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      for (const q of client.queries) {
        const text = q.text.toLowerCase();
        if (text.includes("schema_migrations")) {
          assert.ok(
            text.includes("public.schema_migrations"),
            `Query must explicitly qualify public.schema_migrations: ${q.text}`
          );
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 14: Non-SQL or non-conforming files in migrations/ are ignored safely
  test("Scenario 14: Non-SQL files (.md, .txt, .DS_Store) are safely ignored by the runner", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-mig-test-14-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Documentation");
      fs.writeFileSync(path.join(tempDir, ".DS_Store"), "binary junk");
      fs.writeFileSync(path.join(tempDir, "notes.txt"), "some notes");
      fs.writeFileSync(path.join(tempDir, "050_forward.sql"), "SELECT 1;");

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.applied, ["050_forward.sql"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 15: Missing DATABASE_URL / connection error fails cleanly
  test("Scenario 15: Missing DATABASE_URL fails cleanly with actionable error", async () => {
    const result = await runMigrations({
      client: null,
      connectionString: "",
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /DATABASE_URL environment variable is missing or empty/);
  });

  // Scenario 16 (DEFECT 2): MAST object exists without a marker table (routine or sequence)
  test("Scenario 16: MAST catalog artifact (function or sequence) without marker table triggers abort if unbaselined", async () => {
    // DB has no marker tables, but has MAST function deliver_lead_for_user and sequence leads_id_seq
    const client = new MockPgClient({
      mastArtifacts: ["routine:deliver_lead_for_user", "sequence:leads_id_seq"],
      ledgerExists: false
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Unbaselined MAST database detected/);
    assert.match(result.error.message, /routine:deliver_lead_for_user/);
  });

  // Scenario 17 (DEFECT 3): Unknown ledger filename in public.schema_migrations
  test("Scenario 17: Unknown ledger filename in public.schema_migrations halts with critical error", async () => {
    const client = new MockPgClient({
      markerTables: ["businesses"],
      ledgerExists: true,
      appliedMigrations: [...allBaseline, "999_unknown_rogue_migration.sql"]
    });

    const result = await runMigrations({
      client,
      manifest,
      logger: silentLogger,
      exitProcess: false
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error.message, /Unknown migration recorded in public\.schema_migrations/);
    assert.match(result.error.message, /999_unknown_rogue_migration\.sql/);
  });

  // Scenario 18 (DEFECT 3): Duplicate manifest entries
  test("Scenario 18: Duplicate migration filenames in manifest cause immediate rejection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-dup-manifest-"));
    try {
      const badManifest = {
        version: 1,
        baseline_count: 3,
        baseline_migrations: [
          "001_opportunity_engine.sql",
          "002_scraper_bridge.sql",
          "001_opportunity_engine.sql"
        ]
      };
      const manifestFile = path.join(tempDir, "manifest.json");
      fs.writeFileSync(manifestFile, JSON.stringify(badManifest));

      assert.throws(
        () => loadManifest(manifestFile),
        /Manifest integrity violation: duplicate migration filenames found/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 19 (DEFECT 3): Baseline manifest count mismatch
  test("Scenario 19: Baseline count mismatch between baseline_count and array length triggers error", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-count-mismatch-"));
    try {
      const badManifest = {
        version: 1,
        baseline_count: 51,
        baseline_migrations: [
          "001_opportunity_engine.sql",
          "002_scraper_bridge.sql"
        ]
      };
      const manifestFile = path.join(tempDir, "manifest.json");
      fs.writeFileSync(manifestFile, JSON.stringify(badManifest));

      assert.throws(
        () => loadManifest(manifestFile),
        /Manifest integrity violation: declared baseline_count \(51\) does not match baseline_migrations length \(2\)/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 20 (DEFECT 3): Historical migration absent from disk
  test("Scenario 20: Historical baseline migration file absent from disk aborts execution", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-missing-disk-"));
    try {
      // Create only 001-048 on disk (omit 049)
      for (const m of allBaseline.slice(0, 50)) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Historical baseline migration file missing from disk/);
      assert.match(result.error.message, /049_fix_deliver_lead_for_user_bigint_lead_id\.sql/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 21 (DEFECT 3): Historical migration on disk omitted from manifest
  test("Scenario 21: Historical migration file on disk omitted from manifest halts execution", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-omitted-manifest-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      // Add a rogue historical file with prefix 040
      fs.writeFileSync(path.join(tempDir, "040b_untracked_historical.sql"), "SELECT 1;");

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Historical migration file on disk omitted from manifest/);
      assert.match(result.error.message, /040b_untracked_historical\.sql/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 22 (DEFECT 3): Unknown old migration cannot execute as a forward migration
  test("Scenario 22: Unapplied historical migration (prefix <= 49) cannot execute as a forward migration", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-old-forward-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      // Suppose an unapplied file with prefix 033 exists
      const rogueOld = "033c_rogue_old_migration.sql";
      fs.writeFileSync(path.join(tempDir, rogueOld), "SELECT 1;");

      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: [...allBaseline]
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Historical migration file on disk omitted from manifest/);
      assert.strictEqual(
        client.queries.some((q) => q.text.startsWith("BEGIN")),
        false
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario 23 (DEFECT 3): All historical baseline entries must be verified before forward migrations execute
  test("Scenario 23: Forward migration execution is blocked if even one baseline entry is missing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-baseline-gate-"));
    try {
      for (const m of allBaseline) {
        fs.writeFileSync(path.join(tempDir, m), "-- baseline");
      }
      fs.writeFileSync(path.join(tempDir, "050_legit_forward.sql"), "CREATE TABLE forward_test (id int);");

      // Ledger has 001-048, missing 049
      const client = new MockPgClient({
        markerTables: ["businesses"],
        ledgerExists: true,
        appliedMigrations: allBaseline.slice(0, 50)
      });

      const result = await runMigrations({
        client,
        manifest,
        migrationsDir: tempDir,
        logger: silentLogger,
        exitProcess: false
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error.message, /Incomplete historical baseline in public\.schema_migrations/);
      assert.strictEqual(
        client.queries.some((q) => q.text.includes("CREATE TABLE forward_test")),
        false,
        "Forward migration 050 must NEVER execute if baseline is incomplete"
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
