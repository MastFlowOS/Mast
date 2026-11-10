// Hardened, Fail-Closed MAST Migration Runner
//
// Enforces:
// 1. Strict schema qualification (public.schema_migrations)
// 2. Comprehensive catalog-based detection of MAST-owned objects (tables, partitions, views, sequences, routines)
// 3. Strict manifest integrity and correspondence (version, count, uniqueness, safe filenames, no rogue files)
// 4. Absolute prohibition of unsupported empty-db bootstrap
// 5. Prohibition of historical migrations executing as forward migrations
// 6. Transactional isolation for forward migrations
//
// Usage:
//   node scripts/run-migrations.mjs

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "migration-manifest.json");

export const SAFE_FILENAME_REGEX = /^[0-9]{3}[a-z]?_[a-z0-9_]+\.sql$/;

// Known MAST catalog objects across tables, partitioned tables, views, sequences, and routines
export const MAST_CATALOG_TABLES = [
  "businesses",
  "leads",
  "profiles",
  "scrape_jobs",
  "credit_transactions",
  "crm_leads",
  "daily_goals",
  "discovery_tasks",
  "discovery_plans",
  "discovery_streets",
  "user_discovery_street_state",
  "lead_followups",
  "lead_messages",
  "professions",
  "goal_completions",
  "discovery_live_events",
  "discovery_location_stats",
  "request_lifecycle_events",
  "user_smtp_credentials",
  "discovery_streets_contamination_archive_2026_09",
  "user_discovery_street_state_contamination_archive_2026_09"
];

export const MAST_CATALOG_VIEWS = [
  "v_qualified_opportunities"
];

export const MAST_CATALOG_SEQUENCES = [
  "leads_id_seq",
  "discovery_tasks_id_seq",
  "discovery_plans_id_seq",
  "scrape_jobs_id_seq",
  "credit_transactions_id_seq",
  "crm_leads_id_seq"
];

export const MAST_CATALOG_ROUTINES = [
  "deliver_lead_for_user",
  "award_goal_xp",
  "consume_crm_lead_credit",
  "claim_discovery_street",
  "release_discovery_street",
  "create_crm_lead",
  "try_increment_lead_usage",
  "get_plan_limits",
  "claim_discovery_streets_batch",
  "accumulate_discovery_location_stats",
  "sync_business_enrichment_fingerprints",
  "atomic_business_upsert_and_lead_delivery",
  "bump_scrape_job_results_count"
];

/**
 * Extracts numeric prefix from migration filename (e.g. '049_...' -> 49, '019b_...' -> 19).
 */
export function extractPrefixNumber(filename) {
  const match = filename.match(/^([0-9]{3})/);
  if (!match) return -1;
  return parseInt(match[1], 10);
}

/**
 * Loads and validates the migration baseline manifest with strict integrity checks.
 */
export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Migration manifest not found at: ${manifestPath}`);
  }
  const content = readFileSync(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(`Invalid JSON in migration manifest at ${manifestPath}: ${parseErr.message}`);
  }

  // 1. Validate manifest version
  if (parsed.version !== 1) {
    throw new Error(`Invalid manifest version in ${manifestPath}: expected 1, found ${parsed.version}`);
  }

  // 2. Validate declared baseline count
  if (typeof parsed.baseline_count !== "number") {
    throw new Error(`Invalid manifest at ${manifestPath}: missing numeric baseline_count`);
  }
  if (!Array.isArray(parsed.baseline_migrations)) {
    throw new Error(`Invalid manifest at ${manifestPath}: missing baseline_migrations array`);
  }
  if (parsed.baseline_count !== parsed.baseline_migrations.length) {
    throw new Error(
      `Manifest integrity violation: declared baseline_count (${parsed.baseline_count}) ` +
      `does not match baseline_migrations length (${parsed.baseline_migrations.length})`
    );
  }

  // 3. Validate unique migration filenames
  const uniqueSet = new Set(parsed.baseline_migrations);
  if (uniqueSet.size !== parsed.baseline_migrations.length) {
    throw new Error(`Manifest integrity violation: duplicate migration filenames found in ${manifestPath}`);
  }

  // 4. Validate safe filename format for all baseline entries
  for (const filename of parsed.baseline_migrations) {
    if (!SAFE_FILENAME_REGEX.test(filename)) {
      throw new Error(`Unsafe or invalid migration filename in manifest: ${filename}`);
    }
  }

  return parsed;
}

/**
 * Core migration runner logic.
 */
export async function runMigrations(options = {}) {
  const {
    client: customClient,
    connectionString = process.env.DATABASE_URL,
    manifestPath = DEFAULT_MANIFEST_PATH,
    manifest: providedManifest,
    migrationsDir = DEFAULT_MIGRATIONS_DIR,
    args = process.argv.slice(2),
    logger = console,
    exitProcess = false
  } = options;

  // Defect 1: Explicitly reject unsupported bootstrap
  if (args.includes("--bootstrap-empty-db")) {
    const err = new Error(
      "Bootstrap is unsupported and rejected. Historical migrations 001-049 cannot be executed " +
      "sequentially on an unbaselined database without a documented and validated base schema " +
      "prerequisite procedure. Every unbaselined database must fail closed."
    );
    logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
    if (exitProcess) process.exit(1);
    return { success: false, error: err };
  }

  const dryRun = args.includes("--dry-run");

  // Load and validate manifest integrity
  let manifest;
  try {
    manifest = providedManifest || loadManifest(manifestPath);
  } catch (mErr) {
    logger.error(`[MIGRATION RUNNER MANIFEST ERROR] ${mErr.message}`);
    if (exitProcess) process.exit(1);
    return { success: false, error: mErr };
  }

  const baselineSet = new Set(manifest.baseline_migrations);
  const maxBaselinePrefix = Math.max(...manifest.baseline_migrations.map(extractPrefixNumber));

  // Disk migration validation & correspondence
  if (!existsSync(migrationsDir)) {
    const err = new Error(`Migrations directory not found: ${migrationsDir}`);
    logger.error(`[MIGRATION RUNNER ERROR] ${err.message}`);
    if (exitProcess) process.exit(1);
    return { success: false, error: err };
  }

  const allDiskEntries = readdirSync(migrationsDir);
  const diskSqlFiles = allDiskEntries.filter((f) => f.endsWith(".sql")).sort();

  // Validate filename safety on disk
  for (const f of diskSqlFiles) {
    if (!SAFE_FILENAME_REGEX.test(f)) {
      const err = new Error(`Unsafe or non-conforming migration filename on disk: ${f}`);
      logger.error(`[MIGRATION RUNNER ERROR] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }
  }

  const diskFileSet = new Set(diskSqlFiles);

  // Check: Every historical migration in the manifest must exist on disk
  for (const baselineFile of manifest.baseline_migrations) {
    if (!diskFileSet.has(baselineFile)) {
      const err = new Error(`Historical baseline migration file missing from disk: ${baselineFile}`);
      logger.error(`[MIGRATION RUNNER ERROR] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }
  }

  // Check: No historical migration file on disk is omitted from manifest
  for (const diskFile of diskSqlFiles) {
    const prefixNum = extractPrefixNumber(diskFile);
    if (prefixNum <= maxBaselinePrefix && !baselineSet.has(diskFile)) {
      const err = new Error(
        `Historical migration file on disk omitted from manifest: ${diskFile}.\n` +
        `Files with prefix <= ${maxBaselinePrefix} belong to the historical sequence and cannot ` +
        `be silently executed as forward migrations. Stop execution.`
      );
      logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }
  }

  let client = customClient;
  let ownClient = false;

  if (!client) {
    if (!connectionString) {
      const err = new Error("DATABASE_URL environment variable is missing or empty.");
      logger.error(`[MIGRATION RUNNER ERROR] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }
    client = new pg.Client({ connectionString });
    ownClient = true;
    await client.connect();
  }

  try {
    // Defect 2: Catalog-based inspection of MAST-owned objects
    const mastCatalogQuery = `
      WITH mast_catalog_scan AS (
        SELECT 'table' AS artifact_type, c.relname AS artifact_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1::text[])

        UNION ALL

        SELECT 'view' AS artifact_type, c.relname AS artifact_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('v', 'm')
          AND c.relname = ANY($2::text[])

        UNION ALL

        SELECT 'sequence' AS artifact_type, c.relname AS artifact_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
          AND c.relname = ANY($3::text[])

        UNION ALL

        SELECT 'routine' AS artifact_type, p.proname AS artifact_name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY($4::text[])
      )
      SELECT artifact_type, artifact_name FROM mast_catalog_scan ORDER BY artifact_type, artifact_name;
    `;

    const catalogScanResult = await client.query(mastCatalogQuery, [
      MAST_CATALOG_TABLES,
      MAST_CATALOG_VIEWS,
      MAST_CATALOG_SEQUENCES,
      MAST_CATALOG_ROUTINES
    ]);

    const foundMastArtifacts = catalogScanResult.rows.map(
      (r) => `${r.artifact_type}:${r.artifact_name}`
    );
    const hasMastArtifacts = foundMastArtifacts.length > 0;

    // Check if public.schema_migrations exists
    const ledgerCheckQuery = `
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists;
    `;
    const ledgerResult = await client.query(ledgerCheckQuery);
    const ledgerExists = Boolean(ledgerResult.rows[0]?.exists);

    // Fail-Closed Check A: Database has MAST artifacts but NO public.schema_migrations
    if (hasMastArtifacts && !ledgerExists) {
      const err = new Error(
        `Unbaselined MAST database detected! Found ${foundMastArtifacts.length} existing MAST-owned ` +
        `catalog artifact(s) in public schema (${foundMastArtifacts.slice(0, 5).join(", ")}${foundMastArtifacts.length > 5 ? "..." : ""}), ` +
        `but public.schema_migrations does not exist.\n` +
        `Refusing to execute migrations automatically. Running historical migrations on an existing ` +
        `database will cause duplicate relation errors and resurrect dropped wide-open policies (e.g. 001 vs 043).\n` +
        `Action required: Run the read-only baseline verification suite ` +
        `(verify_stage2_preflight.sql, verify_stage2_data_invariants.sql, verify_migrations_read_only.sql). ` +
        `Once verified, initialize public.schema_migrations with the verified historical baseline before running forward migrations.`
      );
      logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }

    // Fail-Closed Check B: Database has NO MAST artifacts and NO ledger (Empty DB)
    // Unsupported bootstrap is completely disabled: every unbaselined database must fail closed.
    if (!hasMastArtifacts && !ledgerExists) {
      const err = new Error(
        `Unbaselined empty database detected (no MAST domain artifacts found in public catalog, and no public.schema_migrations).\n` +
        `Automatic bootstrap of historical migrations is unsupported and disabled.\n` +
        `Historical migrations 001-049 reflect incremental migration history, not a consolidated fresh-install base schema.\n` +
        `Until a complete fresh-install schema prerequisite procedure is documented and validated, every unbaselined database must fail closed.`
      );
      logger.error(`[MIGRATION RUNNER REFUSAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }

    // Inspect applied migrations
    const appliedResult = await client.query(`
      SELECT name, applied_at
      FROM public.schema_migrations
      ORDER BY name ASC;
    `);
    const appliedNames = new Set(appliedResult.rows.map((r) => r.name));

    // Fail-Closed Check C: Existing database with empty ledger
    if (appliedNames.size === 0) {
      const err = new Error(
        `Empty ledger detected! public.schema_migrations exists but contains 0 records.\n` +
        `Refusing to execute to prevent replaying historical migrations from 001.`
      );
      logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }

    // Defect 3: No unknown ledger entries in public.schema_migrations
    for (const appliedName of appliedNames) {
      const isBaseline = baselineSet.has(appliedName);
      const isKnownForwardOnDisk = diskFileSet.has(appliedName) && extractPrefixNumber(appliedName) > maxBaselinePrefix;
      if (!isBaseline && !isKnownForwardOnDisk) {
        const err = new Error(
          `Unknown migration recorded in public.schema_migrations: '${appliedName}'.\n` +
          `Ledger entry does not correspond to any baseline migration in manifest or valid forward migration on disk.\n` +
          `Halting to prevent execution on a corrupted or untracked schema ledger.`
        );
        logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
        if (exitProcess) process.exit(1);
        return { success: false, error: err };
      }
    }

    // Fail-Closed Check D: Partial historical baseline
    const missingBaseline = manifest.baseline_migrations.filter((m) => !appliedNames.has(m));
    if (missingBaseline.length > 0) {
      const err = new Error(
        `Incomplete historical baseline in public.schema_migrations!\n` +
        `The ledger is missing ${missingBaseline.length} baseline migration(s):\n` +
        `  ${missingBaseline.slice(0, 10).join(", ")}${missingBaseline.length > 10 ? " ... and more" : ""}\n` +
        `Refusing to apply migrations to prevent partial replay or out-of-order execution.\n` +
        `Action required: Run baseline verification and complete ledger registration.`
      );
      logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }

    // Candidate forward migrations
    const unappliedDiskFiles = diskSqlFiles.filter((f) => !appliedNames.has(f));

    // Check: Any unapplied file with prefix <= maxBaselinePrefix cannot run as forward migration
    const attemptedOldFiles = unappliedDiskFiles.filter((f) => extractPrefixNumber(f) <= maxBaselinePrefix);
    if (attemptedOldFiles.length > 0) {
      const err = new Error(
        `Historical migration file(s) cannot execute as forward migrations: ${attemptedOldFiles.join(", ")}.\n` +
        `A migration must qualify as forward-only only when it is demonstrably outside the approved historical baseline (prefix > ${maxBaselinePrefix}).`
      );
      logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
      if (exitProcess) process.exit(1);
      return { success: false, error: err };
    }

    // Pending forward migrations
    const pendingForwardFiles = unappliedDiskFiles.filter((f) => extractPrefixNumber(f) > maxBaselinePrefix);

    if (pendingForwardFiles.length === 0) {
      logger.info(`[MIGRATION RUNNER] Schema up to date. (${appliedNames.size} migrations recorded in public.schema_migrations).`);
      return { success: true, applied: [], skipped: diskSqlFiles.length };
    }

    logger.info(`[MIGRATION RUNNER] Found ${pendingForwardFiles.length} pending forward migration(s) to apply.`);

    if (dryRun) {
      logger.info(`[MIGRATION RUNNER] DRY RUN: Would apply:\n  ${pendingForwardFiles.join("\n  ")}`);
      return { success: true, applied: [], dryRun: true, pending: pendingForwardFiles };
    }

    // Apply pending forward migrations inside transactions
    const applied = [];
    for (const file of pendingForwardFiles) {
      logger.info(`[MIGRATION RUNNER] Applying: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf8");

      await client.query("BEGIN;");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (name) VALUES ($1);", [file]);
        await client.query("COMMIT;");
        applied.push(file);
        logger.info(`[MIGRATION RUNNER] Successfully applied: ${file}`);
      } catch (applyErr) {
        logger.error(`[MIGRATION RUNNER] Error applying ${file}. Rolling back transaction...`);
        try {
          await client.query("ROLLBACK;");
        } catch (rollbackErr) {
          logger.error(`[MIGRATION RUNNER] Rollback also encountered error: ${rollbackErr.message}`);
        }
        const err = new Error(`Migration ${file} failed: ${applyErr.message}`);
        err.originalError = applyErr;
        err.migrationFile = file;
        logger.error(`[MIGRATION RUNNER CRITICAL] ${err.message}`);
        if (exitProcess) process.exit(1);
        return { success: false, applied, failedAt: file, error: err };
      }
    }

    logger.info(`[MIGRATION RUNNER] Done. Applied ${applied.length} forward migration(s).`);
    return { success: true, applied, skipped: diskSqlFiles.length - applied.length };
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}

// Direct invocation check
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  runMigrations({ exitProcess: true }).catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
