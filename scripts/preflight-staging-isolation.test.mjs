import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateEnvironment,
  verifyDatabaseTarget,
  extractProjectRefFromDbUrl,
  runPreflight,
} from "./preflight-staging-isolation.mjs";

function getValidEnv() {
  return {
    EXPECTED_STAGING_PROJECT_REF: "staging123ref",
    PROD_PROJECT_REF: "prod456ref",
    EXPECTED_STAGING_DB_HOST: "aws-0-us-west-1.pooler.supabase.com",
    EXPECTED_STAGING_DB_NAME: "postgres",
    EXPECTED_STAGING_GATEWAY_HOST: "mast-gateway-staging.up.railway.app",
    PROD_GATEWAY_HOST: "app.mast.com",
    DATABASE_URL: "postgres://postgres.staging123ref:secretpass@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
    SUPABASE_URL: "https://staging123ref.supabase.co",
    MAST_API_URL: "https://mast-gateway-staging.up.railway.app",
    LOCALAPPDATA: "C:\\Users\\Beboo\\AppData\\Local\\Temp\\mast_staging_profile",
  };
}

describe("extractProjectRefFromDbUrl", () => {
  it("extracts ref from pooler user format", () => {
    const url = new URL("postgres://postgres.myref123:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres");
    assert.equal(extractProjectRefFromDbUrl(url), "myref123");
  });

  it("extracts ref from direct connection host format", () => {
    const url = new URL("postgres://postgres:secret@db.myref123.supabase.co:5432/postgres");
    assert.equal(extractProjectRefFromDbUrl(url), "myref123");
  });

  it("returns null for unrecognized or ambiguous connection targets", () => {
    const url = new URL("postgres://postgres:secret@unknown-proxy.com:5432/postgres");
    assert.equal(extractProjectRefFromDbUrl(url), null);
  });
});

describe("validateEnvironment", () => {
  it("passes with correct staging configuration (pooler format)", () => {
    const env = getValidEnv();
    const result = validateEnvironment(env);
    assert.equal(result.stagingRef, "staging123ref");
    assert.equal(result.expectedStagingDbHost, "aws-0-us-west-1.pooler.supabase.com");
    assert.equal(result.expectedStagingDbName, "postgres");
    assert.equal(result.expectedStagingGatewayHost, "mast-gateway-staging.up.railway.app");
  });

  it("passes with direct database connection format when explicitly expected", () => {
    const env = getValidEnv();
    env.EXPECTED_STAGING_DB_HOST = "db.staging123ref.supabase.co";
    env.DATABASE_URL = "postgres://postgres:secretpass@db.staging123ref.supabase.co:5432/postgres";
    const result = validateEnvironment(env);
    assert.equal(result.stagingRef, "staging123ref");
    assert.equal(result.expectedStagingDbHost, "db.staging123ref.supabase.co");
  });

  it("aborts when mandatory identifiers are missing", () => {
    const mandatoryKeys = [
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

    for (const key of mandatoryKeys) {
      const env = getValidEnv();
      delete env[key];
      assert.throws(
        () => validateEnvironment(env),
        new RegExp(`Missing required environment variables:.*${key}`)
      );
    }
  });

  it("aborts when staging and production project refs are identical", () => {
    const env = getValidEnv();
    env.EXPECTED_STAGING_PROJECT_REF = "sameRef";
    env.PROD_PROJECT_REF = "sameRef";
    assert.throws(
      () => validateEnvironment(env),
      /EXPECTED_STAGING_PROJECT_REF and PROD_PROJECT_REF cannot be identical/
    );
  });

  it("aborts when staging and production gateway hosts are identical", () => {
    const env = getValidEnv();
    env.EXPECTED_STAGING_GATEWAY_HOST = "app.mast.com";
    env.PROD_GATEWAY_HOST = "app.mast.com";
    assert.throws(
      () => validateEnvironment(env),
      /EXPECTED_STAGING_GATEWAY_HOST and PROD_GATEWAY_HOST cannot be identical/
    );
  });

  it("aborts on mismatched staging database host", () => {
    const env = getValidEnv();
    env.DATABASE_URL = "postgres://postgres.staging123ref:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
    assert.throws(
      () => validateEnvironment(env),
      /DATABASE_URL host "aws-0-eu-central-1\.pooler\.supabase\.com" does not match EXPECTED_STAGING_DB_HOST/
    );
  });

  it("aborts on mismatched database name", () => {
    const env = getValidEnv();
    env.DATABASE_URL = "postgres://postgres.staging123ref:secret@aws-0-us-west-1.pooler.supabase.com:5432/otherdb";
    assert.throws(
      () => validateEnvironment(env),
      /DATABASE_URL database name "otherdb" does not match EXPECTED_STAGING_DB_NAME "postgres"/
    );
  });

  it("aborts when database URL references production project ref", () => {
    const env = getValidEnv();
    env.DATABASE_URL = "postgres://postgres.prod456ref:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
    assert.throws(
      () => validateEnvironment(env),
      /DATABASE_URL project ref "prod456ref" does not match EXPECTED_STAGING_PROJECT_REF/
    );
  });

  it("aborts when gateway URL points to production host", () => {
    const env = getValidEnv();
    env.MAST_API_URL = "https://app.mast.com";
    assert.throws(
      () => validateEnvironment(env),
      /Gateway host "app\.mast\.com" does not match EXPECTED_STAGING_GATEWAY_HOST/
    );
  });

  it("aborts on ambiguous database connection target", () => {
    const env = getValidEnv();
    env.EXPECTED_STAGING_DB_HOST = "custom-proxy.internal";
    env.DATABASE_URL = "postgres://customuser:custompass@custom-proxy.internal:5432/postgres";
    assert.throws(
      () => validateEnvironment(env),
      /Unrecognized database host format or unverifiable project reference in DATABASE_URL/
    );
  });

  it("aborts when LOCALAPPDATA does not point to isolated staging profile", () => {
    const env = getValidEnv();
    env.LOCALAPPDATA = "C:\\Users\\Beboo\\AppData\\Local";
    assert.throws(
      () => validateEnvironment(env),
      /LOCALAPPDATA must point to an isolated staging directory containing "mast_staging_profile"/
    );
  });
});

describe("verifyDatabaseTarget", () => {
  it("passes when live database identity and queue isolation are confirmed", async () => {
    const env = getValidEnv();
    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes("SELECT current_database()")) {
          return { rows: [{ current_database: "postgres", current_user: "postgres.staging123ref" }] };
        }
        if (sql.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("SELECT count(*) AS prod_leak_count")) {
          return { rows: [{ prod_leak_count: "0" }] };
        }
        return { rows: [] };
      },
    };

    const res = await verifyDatabaseTarget(mockClient, env);
    assert.equal(res.verifiedDatabase, "postgres");
    assert.equal(res.verifiedUserPrefix, "postgres");
    assert.equal(res.pgbossPresent, true);
  });

  it("aborts when live database name does not match expected staging database", async () => {
    const env = getValidEnv();
    const mockClient = {
      query: async () => ({ rows: [{ current_database: "production_master", current_user: "postgres.staging123ref" }] }),
    };

    await assert.rejects(
      async () => verifyDatabaseTarget(mockClient, env),
      /Live database name "production_master" does not match EXPECTED_STAGING_DB_NAME/
    );
  });

  it("aborts when live database user references production project ref", async () => {
    const env = getValidEnv();
    const mockClient = {
      query: async () => ({ rows: [{ current_database: "postgres", current_user: "postgres.prod456ref" }] }),
    };

    await assert.rejects(
      async () => verifyDatabaseTarget(mockClient, env),
      /Connected database user "postgres\.prod456ref" references production project ref "prod456ref"/
    );
  });

  it("aborts when pgboss queue in target database contains production jobs", async () => {
    const env = getValidEnv();
    const mockClient = {
      query: async (sql) => {
        if (sql.includes("SELECT current_database()")) {
          return { rows: [{ current_database: "postgres", current_user: "postgres.staging123ref" }] };
        }
        if (sql.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("SELECT count(*) AS prod_leak_count")) {
          return { rows: [{ prod_leak_count: "5" }] }; // Leaked jobs detected!
        }
        return { rows: [] };
      },
    };

    await assert.rejects(
      async () => verifyDatabaseTarget(mockClient, env),
      /Found jobs in pgboss\.job containing production project reference "prod456ref"/
    );
  });
});

describe("runPreflight end-to-end with mock DB client", () => {
  it("completes preflight successfully without logging credentials", async () => {
    const env = getValidEnv();
    let loggedText = "";
    const origLog = console.log;
    console.log = (...args) => {
      loggedText += args.join(" ") + "\n";
    };

    const mockClient = {
      connect: async () => {},
      end: async () => {},
      query: async (sql) => {
        if (sql.includes("SELECT current_database()")) {
          return { rows: [{ current_database: "postgres", current_user: "postgres.staging123ref" }] };
        }
        if (sql.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("SELECT count(*) AS prod_leak_count")) {
          return { rows: [{ prod_leak_count: "0" }] };
        }
        return { rows: [] };
      },
    };

    try {
      const ok = await runPreflight(env, () => mockClient);
      assert.equal(ok, true);
      // Assert no secret password or full connection URL is present in logs
      assert.equal(loggedText.includes("secretpass"), false);
      assert.equal(loggedText.includes("postgres://"), false);
      assert.equal(loggedText.includes("aws-0-us-west-1.pooler.supabase.com:5432"), false);
    } finally {
      console.log = origLog;
    }
  });
});
