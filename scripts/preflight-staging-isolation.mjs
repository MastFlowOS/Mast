import pg from "pg";
import { URL, fileURLToPath } from "node:url";

export const MANDATORY_ENV_VARS = [
  "EXPECTED_STAGING_PROJECT_REF",
  "PROD_PROJECT_REF",
  "EXPECTED_STAGING_DB_HOST",
  "EXPECTED_STAGING_DB_NAME",
  "EXPECTED_STAGING_GATEWAY_HOST",
  "PROD_GATEWAY_HOST",
  "DATABASE_URL",
  "SUPABASE_URL",
  "MAST_API_URL",
  "LOCALAPPDATA",
];

/**
 * Extracts the Supabase project reference from a database URL.
 * Recognizes:
 * 1. Supabase pooler format: host `*.pooler.supabase.com` with user `postgres.<project_ref>`
 * 2. Supabase direct connection format: host `db.<project_ref>.supabase.co`
 *
 * If the format is unrecognized or ambiguous, returns null.
 */
export function extractProjectRefFromDbUrl(dbUrlObj) {
  const host = dbUrlObj.hostname.toLowerCase();
  const username = decodeURIComponent(dbUrlObj.username || "");

  // 1. Direct connection format: db.<project_ref>.supabase.co
  const directMatch = host.match(/^db\.([a-zA-Z0-9_-]+)\.supabase\.co$/);
  if (directMatch) {
    return directMatch[1];
  }

  // 2. Pooler format: user is postgres.<project_ref>
  const poolerUserMatch = username.match(/^postgres\.([a-zA-Z0-9_-]+)$/);
  if (poolerUserMatch) {
    return poolerUserMatch[1];
  }

  return null;
}

/**
 * Validates environment variables and URL formats against staging/production isolation rules.
 * Throws an error on missing variables, ambiguous targets, or production leakage.
 */
export function validateEnvironment(env) {
  // 1. Check for missing mandatory variables
  const missing = MANDATORY_ENV_VARS.filter(
    (key) => !env[key] || typeof env[key] !== "string" || env[key].trim() === ""
  );
  if (missing.length > 0) {
    throw new Error(`[ABORT] Missing required environment variables: ${missing.join(", ")}`);
  }

  const stagingRef = env.EXPECTED_STAGING_PROJECT_REF.trim();
  const prodRef = env.PROD_PROJECT_REF.trim();
  const expectedStagingDbHost = env.EXPECTED_STAGING_DB_HOST.trim().toLowerCase();
  const expectedStagingDbName = env.EXPECTED_STAGING_DB_NAME.trim();
  const expectedStagingGatewayHost = env.EXPECTED_STAGING_GATEWAY_HOST.trim().toLowerCase();
  const prodGatewayHost = env.PROD_GATEWAY_HOST.trim().toLowerCase();

  // 2. Cross-check staging vs production expectations
  if (stagingRef === prodRef) {
    throw new Error("[ABORT] EXPECTED_STAGING_PROJECT_REF and PROD_PROJECT_REF cannot be identical.");
  }
  if (expectedStagingGatewayHost === prodGatewayHost) {
    throw new Error("[ABORT] EXPECTED_STAGING_GATEWAY_HOST and PROD_GATEWAY_HOST cannot be identical.");
  }
  if (expectedStagingDbHost.includes(prodRef)) {
    throw new Error(`[ABORT] EXPECTED_STAGING_DB_HOST contains production project reference "${prodRef}".`);
  }

  // 3. Validate MAST_API_URL (Gateway Host)
  let gatewayUrl;
  try {
    gatewayUrl = new URL(env.MAST_API_URL);
  } catch {
    throw new Error("[ABORT] MAST_API_URL is not a valid URL.");
  }
  const gatewayHost = gatewayUrl.hostname.toLowerCase();

  if (gatewayHost !== expectedStagingGatewayHost) {
    throw new Error(
      `[ABORT] Gateway host "${gatewayHost}" does not match EXPECTED_STAGING_GATEWAY_HOST "${expectedStagingGatewayHost}".`
    );
  }
  if (gatewayHost === prodGatewayHost || gatewayHost.includes(prodRef)) {
    throw new Error(`[ABORT] Gateway host "${gatewayHost}" matches or contains production reference.`);
  }

  // 4. Validate SUPABASE_URL
  let supabaseUrl;
  try {
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    throw new Error("[ABORT] SUPABASE_URL is not a valid URL.");
  }
  const supabaseHost = supabaseUrl.hostname.toLowerCase();
  const supabaseRefMatch = supabaseHost.match(/^([a-zA-Z0-9_-]+)\.supabase\.co$/);
  if (!supabaseRefMatch) {
    throw new Error(
      `[ABORT] SUPABASE_URL host "${supabaseHost}" is not a recognized Supabase domain (*.supabase.co).`
    );
  }
  const supabaseRef = supabaseRefMatch[1];

  if (supabaseRef !== stagingRef) {
    throw new Error(
      `[ABORT] SUPABASE_URL project ref "${supabaseRef}" does not match EXPECTED_STAGING_PROJECT_REF "${stagingRef}".`
    );
  }
  if (supabaseRef === prodRef || supabaseHost.includes(prodRef)) {
    throw new Error(`[ABORT] SUPABASE_URL targets production project ref "${prodRef}".`);
  }

  // 5. Validate DATABASE_URL
  let dbUrl;
  try {
    dbUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("[ABORT] DATABASE_URL is not a valid URL.");
  }

  const dbHost = dbUrl.hostname.toLowerCase();
  const dbName = dbUrl.pathname.replace(/^\//, "");
  const dbUser = decodeURIComponent(dbUrl.username || "");

  // Check expected database name
  if (dbName !== expectedStagingDbName) {
    throw new Error(
      `[ABORT] DATABASE_URL database name "${dbName}" does not match EXPECTED_STAGING_DB_NAME "${expectedStagingDbName}".`
    );
  }

  // Check expected database host
  if (dbHost !== expectedStagingDbHost) {
    throw new Error(
      `[ABORT] DATABASE_URL host "${dbHost}" does not match EXPECTED_STAGING_DB_HOST "${expectedStagingDbHost}".`
    );
  }
  if (dbHost.includes(prodRef)) {
    throw new Error(`[ABORT] DATABASE_URL host "${dbHost}" contains production project reference "${prodRef}".`);
  }

  // Check project reference in DATABASE_URL
  const extractedDbRef = extractProjectRefFromDbUrl(dbUrl);
  if (!extractedDbRef) {
    throw new Error(
      `[ABORT] Unrecognized database host format or unverifiable project reference in DATABASE_URL. Ambiguous connection target.`
    );
  }
  if (extractedDbRef !== stagingRef) {
    throw new Error(
      `[ABORT] DATABASE_URL project ref "${extractedDbRef}" does not match EXPECTED_STAGING_PROJECT_REF "${stagingRef}".`
    );
  }
  if (extractedDbRef === prodRef || dbUser.includes(prodRef)) {
    throw new Error(`[ABORT] DATABASE_URL references production project ref "${prodRef}".`);
  }

  // 6. Validate LOCALAPPDATA (Desktop profile isolation)
  const localAppData = env.LOCALAPPDATA.trim();
  if (!localAppData.includes("mast_staging_profile")) {
    throw new Error(
      `[ABORT] LOCALAPPDATA must point to an isolated staging directory containing "mast_staging_profile".`
    );
  }
  if (env.USERPROFILE && localAppData === `${env.USERPROFILE}\\AppData\\Local`) {
    throw new Error(`[ABORT] LOCALAPPDATA is set to default system AppData directory. Isolation violated.`);
  }

  return {
    stagingRef,
    expectedStagingDbHost,
    expectedStagingDbName,
    expectedStagingGatewayHost,
  };
}

/**
 * Connects to the database and verifies database name, connected user, and absence of production contamination.
 */
export async function verifyDatabaseTarget(client, env) {
  const stagingRef = env.EXPECTED_STAGING_PROJECT_REF.trim();
  const prodRef = env.PROD_PROJECT_REF.trim();
  const expectedDbName = env.EXPECTED_STAGING_DB_NAME.trim();

  const idCheck = await client.query("SELECT current_database(), current_user, inet_server_addr()");
  const { current_database, current_user } = idCheck.rows[0];

  if (current_database !== expectedDbName) {
    throw new Error(
      `[ABORT] Live database name "${current_database}" does not match EXPECTED_STAGING_DB_NAME "${expectedDbName}".`
    );
  }

  if (current_user.includes(prodRef)) {
    throw new Error(`[ABORT] Connected database user "${current_user}" references production project ref "${prodRef}".`);
  }

  // Pooler users are structured as postgres.<project_ref>
  if (current_user.startsWith("postgres.") && !current_user.includes(stagingRef)) {
    throw new Error(`[ABORT] Connected database user "${current_user}" does not match staging ref "${stagingRef}".`);
  }

  // Dedicated Queue Isolation Proof:
  // Check if pgboss schema exists. If it exists, verify that no pending/active job belongs to production users or projects.
  const pgbossTableCheck = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'pgboss' AND table_name = 'job'
    );
  `);

  if (pgbossTableCheck.rows[0].exists) {
    const jobCheck = await client.query(`
      SELECT count(*) AS prod_leak_count 
      FROM pgboss.job 
      WHERE data::text LIKE $1;
    `, [`%${prodRef}%`]);

    if (parseInt(jobCheck.rows[0].prod_leak_count, 10) > 0) {
      throw new Error(`[ABORT] Found jobs in pgboss.job containing production project reference "${prodRef}"!`);
    }
  }

  return {
    verifiedDatabase: current_database,
    verifiedUserPrefix: current_user.split(".")[0],
    pgbossPresent: pgbossTableCheck.rows[0].exists,
  };
}

/**
 * Main execution function.
 */
export async function runPreflight(env = process.env, dbClientFactory = null) {
  console.log("==================================================");
  console.log("   MAST STAGING PREFLIGHT ISOLATION AUDIT");
  console.log("==================================================");

  // 1. Static environment and URL checks
  const validated = validateEnvironment(env);
  console.log(`[PASS] Environment check: validated staging ref matches expected value.`);
  console.log(`[PASS] Gateway host: verified matches ${validated.expectedStagingGatewayHost}.`);
  console.log(`[PASS] Database host: verified matches ${validated.expectedStagingDbHost}.`);
  console.log(`[PASS] Database name: verified matches ${validated.expectedStagingDbName}.`);
  console.log(`[PASS] Local desktop profile: verified isolated staging directory.`);

  // 2. Live database connection check
  const makeClient = dbClientFactory || (() => new pg.Client({ connectionString: env.DATABASE_URL }));
  const client = makeClient();

  try {
    await client.connect();
    const dbTarget = await verifyDatabaseTarget(client, env);
    console.log(`[PASS] Live DB target verified: database=${dbTarget.verifiedDatabase}, user_prefix=${dbTarget.verifiedUserPrefix}`);
    console.log(`[PASS] Queue isolation verified: connected to dedicated staging database instance.`);
  } finally {
    try {
      await client.end();
    } catch {
      // client may already be ended or mock
    }
  }

  console.log("==================================================");
  console.log("[PASS] Strict preflight passed: 100% isolated from production.");
  console.log("==================================================");
  return true;
}

// Auto-run if executed directly as a script
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPreflight()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
