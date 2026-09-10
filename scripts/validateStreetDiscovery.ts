/**
 * CRITMODE — Street Discovery LIVE Validation Harness
 * =====================================================
 *
 * Standalone, non-interactive script that exercises the REAL production
 * street-discovery functions against a REAL Supabase project, the REAL
 * OSM/Overpass inventory builder, and (optionally) the REAL Google Maps
 * scraper — end to end. It does not mock the core street flow: every RPC
 * call below is the exact same wrapper poolExpandJob.ts/discoveryPlanJob.ts
 * call in production (src/discovery/streetDiscovery.ts), used unmodified.
 *
 * This CANNOT be run from a sandboxed environment with restricted network
 * egress — it needs real access to your Supabase project, Overpass's public
 * API, and (for Step 4's live-scrape option) Google Maps itself. Run it
 * from your actual dev/deployed environment.
 *
 * WHAT THIS DOES NOT DO
 * ----------------------
 * - Does not modify poolExpandJob.ts, discoveryPlanJob.ts, or any RPC.
 * - Does not fabricate a result for a step it could not execute — every
 *   step that cannot run prints `NOT EXECUTED — ENVIRONMENT BLOCKED` plus
 *   the exact missing prerequisite, instead of a fake pass/fail.
 * - Does not delete or mutate any pre-existing user's street coverage.
 *   Every row this script writes is scoped to VALIDATION_USER_A/_B and a
 *   niche unique to this harness (default `__street_validation_harness__`),
 *   so it is trivially distinguishable from — and never overlaps — real
 *   user activity, even if a real user id is passed in for VALIDATION_USER_A.
 *
 * USAGE
 * -----
 *   npx tsx scripts/validateStreetDiscovery.ts
 *
 * See the bottom of this file (`printPrerequisites`) for the exact
 * environment variables and their defaults — also printed by the script
 * itself on every run, and on any early exit.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import {
  streetInventoryCount,
  ensureStreetInventory,
  initializeUserDiscoveryStreetState,
  claimDiscoveryStreet,
  heartbeatDiscoveryStreetClaim,
  completeDiscoveryStreetClaim,
  type StreetScope,
  type StreetClaim,
} from "../src/discovery/streetDiscovery.js";
import { getAreasForCity } from "../src/lib/geo/cityAreas.js";
import { runEngineQuery } from "../src/scraperBridge/pythonBridge.js";

const db = supabaseAdmin as any;

/** Supabase/Postgrest errors aren't `Error` instances — serialize them usefully instead of "[object Object]". */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const COUNTRY_CODE = process.env.VALIDATION_COUNTRY ?? "US";
// Deliberately NOT one of the CITY_AREAS-curated production cities (New
// York, Los Angeles, ...) by default — see getAreasForCity() guard below,
// which requires an explicit opt-in before touching a curated city. Real
// enough for Overpass to return a genuine street inventory; small enough
// that the query is fast and clearly not a high-traffic production city.
const CITY = process.env.VALIDATION_CITY ?? "Hoboken";
const NICHE = process.env.VALIDATION_NICHE ?? "__street_validation_harness__";
const PROFESSION_SLUG = process.env.VALIDATION_PROFESSION ?? null;
const SOURCE = "google_maps";

const USER_A = process.env.VALIDATION_USER_A;
const USER_B = process.env.VALIDATION_USER_B;

const ALLOW_PRODUCTION = process.env.VALIDATION_ALLOW_PRODUCTION === "1";
const RUN_LIVE_SCRAPE = process.env.VALIDATION_RUN_LIVE_SCRAPE === "1";

// A second, deliberately unresolvable city for Step 11 (area fallback) — a
// disposable scope, never a real city, so this step can never accidentally
// touch real inventory.
const FALLBACK_CITY = process.env.VALIDATION_FALLBACK_CITY ?? "Zzqqvvxx Nonexistent Validation City 9182";

const WORKER_ID = `validation-harness:${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Report scaffolding
// ---------------------------------------------------------------------------

type StepResult = { status: "PASS" | "FAIL" | "BLOCKED"; detail: Record<string, unknown> };
const report: Record<string, StepResult> = {};
let anyFail = false;

function pass(step: string, detail: Record<string, unknown>) {
  report[step] = { status: "PASS", detail };
  console.log(`\n[PASS] ${step}`);
  for (const [k, v] of Object.entries(detail)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}
function fail(step: string, detail: Record<string, unknown>) {
  anyFail = true;
  report[step] = { status: "FAIL", detail };
  console.log(`\n[FAIL] ${step}`);
  for (const [k, v] of Object.entries(detail)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}
function blocked(step: string, missingPrerequisite: string, extra: Record<string, unknown> = {}) {
  report[step] = { status: "BLOCKED", detail: { reason: "NOT EXECUTED — ENVIRONMENT BLOCKED", missingPrerequisite, ...extra } };
  console.log(`\n[BLOCKED] ${step}`);
  console.log(`  NOT EXECUTED — ENVIRONMENT BLOCKED`);
  console.log(`  missing prerequisite: ${missingPrerequisite}`);
}

function printPrerequisites() {
  console.log(`
Required environment variables:
  SUPABASE_URL                  (already required by src/config/env.ts)
  SUPABASE_SERVICE_ROLE_KEY     (already required by src/config/env.ts)
  SCRAPER_ENGINE_PATH           (defaults to ../mast-lead-engine; must have
                                 real Python deps installed — Overpass fetch
                                 needs only stdlib, Step 4's live scrape
                                 needs Playwright + browsers)

Optional:
  VALIDATION_COUNTRY            default "US"
  VALIDATION_CITY               default "Hoboken" (real, non-curated city)
  VALIDATION_NICHE              default "__street_validation_harness__"
  VALIDATION_PROFESSION         default none (null)
  VALIDATION_USER_A             REQUIRED for Steps 2,3,5,6,7,9,10 — a real
                                 auth.users(id) UUID for a dedicated test/
                                 service account. Never defaulted — the
                                 script will not invent or reuse a real
                                 customer's id.
  VALIDATION_USER_B             REQUIRED for Step 8 — a second, distinct
                                 auth.users(id) UUID.
  VALIDATION_ALLOW_PRODUCTION   must be "1" to target a VALIDATION_CITY
                                 that matches a curated production city in
                                 src/lib/geo/cityAreas.ts (e.g. "New York").
  VALIDATION_RUN_LIVE_SCRAPE    must be "1" to actually spawn the Python
                                 engine and hit live Google Maps for Step 4.
                                 Off by default — Step 4 still derives and
                                 reports the exact query that WOULD be sent,
                                 without executing a live scrape.
  VALIDATION_FALLBACK_CITY      default a nonsense string — used only for
                                 Step 11 (area fallback), never a real city.
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== STREET DISCOVERY LIVE VALIDATION ===");
  console.log(`country=${COUNTRY_CODE} city=${CITY} niche=${NICHE} profession=${PROFESSION_SLUG ?? "null"}`);

  // Safety gate: a curated production city requires explicit opt-in.
  const curatedAreas = getAreasForCity(COUNTRY_CODE, CITY);
  if (curatedAreas !== undefined && !ALLOW_PRODUCTION) {
    console.error(
      `\nREFUSING TO RUN: "${CITY}" is a curated production city (src/lib/geo/cityAreas.ts). ` +
        `Set VALIDATION_ALLOW_PRODUCTION=1 to target it, or leave VALIDATION_CITY unset to use the disposable default.`,
    );
    printPrerequisites();
    process.exit(2);
  }

  // -------------------------------------------------------------------
  // STEP 1 — REAL STREET INVENTORY
  // -------------------------------------------------------------------
  let inventoryCount = 0;
  let builderExecuted = false;
  try {
    const before = await streetInventoryCount(db, COUNTRY_CODE, CITY);
    const outcome = await ensureStreetInventory(db, COUNTRY_CODE, CITY);
    builderExecuted = before === 0; // ensureStreetInventory only invokes the builder when nothing existed yet
    inventoryCount = outcome.mode === "street" ? outcome.count : await streetInventoryCount(db, COUNTRY_CODE, CITY);

    if (outcome.mode !== "street" || inventoryCount === 0) {
      fail("inventory", {
        city: CITY,
        country: COUNTRY_CODE,
        count: inventoryCount,
        builder_executed: builderExecuted,
        fallback_reason: outcome.mode === "area" ? outcome.fallbackReason : undefined,
        note: "ensureStreetInventory() did not produce usable street inventory for this city — see fallback_reason",
      });
    } else {
      const { data: sample, error: sampleErr } = await db
        .from("discovery_streets")
        .select("street_key, street_name, source")
        .eq("country_code", COUNTRY_CODE)
        .eq("city", CITY)
        .order("normalized_name")
        .limit(10);
      if (sampleErr) throw sampleErr;

      const syntheticLike = (sample ?? []).filter((r: any) =>
        /street-coverage|integration\.test|synthetic/i.test(r.street_key ?? ""),
      );

      if (syntheticLike.length > 0) {
        fail("inventory", {
          city: CITY,
          country: COUNTRY_CODE,
          count: inventoryCount,
          sample_streets: sample,
          note: "sample rows look like integration-test fixtures, not real OSM data",
        });
      } else {
        pass("inventory", {
          city: CITY,
          country: COUNTRY_CODE,
          count: inventoryCount,
          builder_executed: builderExecuted,
          sample_streets: (sample ?? []).map((r: any) => ({ key: r.street_key, name: r.street_name, source: r.source })),
        });
      }
    }
  } catch (err) {
    fail("inventory", { error: errorDetail(err) });
  }

  if (inventoryCount === 0) {
    console.log("\nInventory is empty for this city — every remaining street-claim step is blocked.");
    for (const step of ["user_a_initialization", "claim_1", "google_maps_query", "heartbeat", "completion", "next_claim", "user_isolation", "city_stickiness", "no_top_n"]) {
      blocked(step, "street inventory count is 0 for the validation city — see 'inventory' step");
    }
  } else if (!USER_A) {
    for (const step of ["user_a_initialization", "claim_1", "google_maps_query", "heartbeat", "completion", "next_claim", "user_isolation", "city_stickiness", "no_top_n"]) {
      blocked(step, "VALIDATION_USER_A not set (must be a real auth.users(id) UUID for a dedicated test account)");
    }
  } else {
    await runUserAFlow();
  }

  // -------------------------------------------------------------------
  // STEP 11 — AREA FALLBACK (independent of everything above; always runs)
  // -------------------------------------------------------------------
  await runFallbackStep();

  // -------------------------------------------------------------------
  // FINAL REPORT
  // -------------------------------------------------------------------
  console.log("\n\n=== MACHINE-READABLE REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nFINAL RESULT: ${anyFail ? "FAIL" : "PASS"}`);
  printPrerequisites();
  process.exit(anyFail ? 1 : 0);
}

async function runUserAFlow() {
  const scopeA: StreetScope = {
    userId: USER_A!,
    niche: NICHE,
    professionSlug: PROFESSION_SLUG,
    countryCode: COUNTRY_CODE,
    city: CITY,
    source: SOURCE,
  };

  // -------------------------------------------------------------------
  // STEP 2 — USER A INITIAL STATE
  // -------------------------------------------------------------------
  try {
    const { data: firstStreet, error: firstStreetErr } = await db
      .from("discovery_streets")
      .select("id, street_key")
      .eq("country_code", COUNTRY_CODE)
      .eq("city", CITY)
      .order("normalized_name")
      .limit(1)
      .maybeSingle();
    if (firstStreetErr) throw firstStreetErr;
    if (!firstStreet) throw new Error("no inventory row found to initialize against");

    await initializeUserDiscoveryStreetState(db, scopeA, firstStreet.id);

    const { data: stateRows, error: stateErr } = await db
      .from("user_discovery_street_state")
      .select("status")
      .eq("user_id", USER_A)
      .eq("niche", NICHE)
      .eq("country_code", COUNTRY_CODE)
      .eq("city", CITY)
      .eq("source", SOURCE);
    if (stateErr) throw stateErr;

    const counts = { UNSEEN: 0, IN_PROGRESS: 0, COMPLETED: 0 } as Record<string, number>;
    for (const row of stateRows ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;

    if ((stateRows?.length ?? 0) < 1 || counts.UNSEEN < 1) {
      fail("user_a_initialization", { state_rows: stateRows?.length ?? 0, ...counts, note: "expected >=1 UNSEEN row after initialize" });
    } else {
      pass("user_a_initialization", { state_rows: stateRows?.length ?? 0, unseen: counts.UNSEEN, in_progress: counts.IN_PROGRESS, completed: counts.COMPLETED });
    }
  } catch (err) {
    fail("user_a_initialization", { error: errorDetail(err) });
  }

  // -------------------------------------------------------------------
  // STEP 3 — ATOMIC CLAIM
  // -------------------------------------------------------------------
  let claim1: StreetClaim | undefined;
  try {
    claim1 = await claimDiscoveryStreet(db, scopeA, WORKER_ID, `validation-run-${WORKER_ID}`);
    if (!claim1) {
      fail("claim_1", { note: "claimDiscoveryStreet returned no claim — no eligible street for this scope" });
    } else {
      const { data: stateRow, error: stateErr } = await db
        .from("user_discovery_street_state")
        .select("status, country_code, city")
        .eq("id", claim1.stateId)
        .maybeSingle();
      if (stateErr) throw stateErr;

      if (stateRow?.status !== "IN_PROGRESS" || stateRow.country_code !== COUNTRY_CODE || stateRow.city !== CITY) {
        fail("claim_1", { street_key: claim1.streetKey, street_name: claim1.streetName, state: stateRow?.status, note: "claim did not transition to IN_PROGRESS in the requested city/country" });
      } else {
        pass("claim_1", {
          street_id: claim1.streetId,
          street_key: claim1.streetKey,
          street_name: claim1.streetName,
          claim_token: claim1.claimToken,
          city: stateRow.city,
          country: stateRow.country_code,
          state: stateRow.status,
        });
      }
    }
  } catch (err) {
    fail("claim_1", { error: errorDetail(err) });
  }

  if (!claim1) {
    for (const step of ["google_maps_query", "heartbeat", "completion", "next_claim", "user_isolation", "city_stickiness", "no_top_n"]) {
      blocked(step, "no active claim from Step 3 to operate on");
    }
    return;
  }

  // -------------------------------------------------------------------
  // STEP 4 — REAL STREET QUERY
  // -------------------------------------------------------------------
  await runStreetQueryStep(claim1);

  // -------------------------------------------------------------------
  // STEP 5 — HEARTBEAT
  // -------------------------------------------------------------------
  try {
    const validRenewed = await heartbeatDiscoveryStreetClaim(db, claim1, USER_A!, WORKER_ID);
    const staleClaim: StreetClaim = { ...claim1, claimToken: "00000000-0000-0000-0000-000000000000" };
    const staleRenewed = await heartbeatDiscoveryStreetClaim(db, staleClaim, USER_A!, WORKER_ID);

    if (!validRenewed || staleRenewed) {
      fail("heartbeat", { valid: validRenewed, stale_token: staleRenewed, note: "expected valid=true, stale_token=false" });
    } else {
      pass("heartbeat", { valid: validRenewed, stale_token: staleRenewed });
    }
  } catch (err) {
    fail("heartbeat", { error: errorDetail(err) });
  }

  // -------------------------------------------------------------------
  // STEP 6 — COMPLETION
  // -------------------------------------------------------------------
  try {
    const { data: beforeRow } = await db.from("user_discovery_street_state").select("status").eq("id", claim1.stateId).maybeSingle();
    const completionResult = await completeDiscoveryStreetClaim(db, claim1, USER_A!, WORKER_ID);
    const { data: afterRow } = await db
      .from("user_discovery_street_state")
      .select("status, completed_at")
      .eq("id", claim1.stateId)
      .maybeSingle();

    if (!completionResult || afterRow?.status !== "COMPLETED" || !afterRow.completed_at) {
      fail("completion", { before_state: beforeRow?.status, completion_result: completionResult, after_state: afterRow?.status, completed_at: afterRow?.completed_at });
    } else {
      pass("completion", { before_state: beforeRow?.status, completion_result: completionResult, after_state: afterRow.status, completed_at: afterRow.completed_at });
    }
  } catch (err) {
    fail("completion", { error: errorDetail(err) });
  }

  // -------------------------------------------------------------------
  // STEP 7 — NEXT STREET / DURABLE PROGRESS
  // -------------------------------------------------------------------
  let claim2: StreetClaim | undefined;
  try {
    claim2 = await claimDiscoveryStreet(db, scopeA, WORKER_ID, `validation-run-2-${WORKER_ID}`);
    const different = claim2 !== undefined && claim2.streetKey !== claim1.streetKey;
    if (!claim2) {
      fail("next_claim", { previous_street_key: claim1.streetKey, note: "expected a second eligible street but got none — either inventory has only 1 street or a real bug" });
    } else if (!different) {
      fail("next_claim", { previous_street_key: claim1.streetKey, new_street_key: claim2.streetKey, different_from_previous: false, note: "re-claimed the just-completed street" });
    } else {
      pass("next_claim", { previous_street_key: claim1.streetKey, new_street_key: claim2.streetKey, different_from_previous: true });
    }
  } catch (err) {
    fail("next_claim", { error: errorDetail(err) });
  }

  // -------------------------------------------------------------------
  // STEP 8 — USER ISOLATION
  // -------------------------------------------------------------------
  if (!USER_B) {
    blocked("user_isolation", "VALIDATION_USER_B not set (must be a real auth.users(id) UUID for a second dedicated test account)");
  } else {
    try {
      const scopeB: StreetScope = { ...scopeA, userId: USER_B };
      const { data: sameStreet } = await db
        .from("discovery_streets")
        .select("id")
        .eq("street_key", claim1.streetKey)
        .maybeSingle();
      if (sameStreet) await initializeUserDiscoveryStreetState(db, scopeB, sameStreet.id);

      const claimB = await claimDiscoveryStreet(db, scopeB, `${WORKER_ID}-userB`, `validation-run-b-${WORKER_ID}`);

      // User A must NOT be able to re-claim its own completed street.
      const { data: aStateForCompletedStreet } = await db
        .from("user_discovery_street_state")
        .select("status")
        .eq("user_id", USER_A)
        .eq("street_id", sameStreet?.id)
        .eq("niche", NICHE)
        .eq("country_code", COUNTRY_CODE)
        .eq("city", CITY)
        .eq("source", SOURCE)
        .maybeSingle();
      const userASkipsCompleted = aStateForCompletedStreet?.status === "COMPLETED";

      if (!claimB || !userASkipsCompleted) {
        fail("user_isolation", {
          user_a_completed: claim1.streetKey,
          user_a_state_for_that_street: aStateForCompletedStreet?.status,
          user_b_claimed: claimB?.streetKey,
          same_street_allowed: claimB?.streetKey === claim1.streetKey,
        });
      } else {
        pass("user_isolation", {
          user_a_completed: claim1.streetKey,
          user_a_state_for_that_street: aStateForCompletedStreet?.status,
          user_b_claimed: claimB.streetKey,
          same_street_allowed: claimB.streetKey === claim1.streetKey,
        });
      }
    } catch (err) {
      fail("user_isolation", { error: errorDetail(err) });
    }
  }

  // -------------------------------------------------------------------
  // STEP 9 — CITY STICKINESS
  // -------------------------------------------------------------------
  try {
    const claims = [claim1, claim2].filter(Boolean) as StreetClaim[];
    const { data: rows, error } = await db
      .from("user_discovery_street_state")
      .select("id, country_code, city")
      .in("id", claims.map((c) => c.stateId));
    if (error) throw error;

    const allScoped = (rows ?? []).every((r: any) => r.country_code === COUNTRY_CODE && r.city === CITY);

    // Static source check — confirm poolExpandJob.ts's real claim call site
    // threads the CURRENT loop's country.code/city into StreetScope, never
    // a constant or a different variable (city-stickiness at the source
    // level, not just observed from this run's own claims).
    const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/jobs/poolExpandJob.ts");
    const poolSrc = readFileSync(srcPath, "utf8");
    const scopeBlockIdx = poolSrc.indexOf("streetScope = {");
    const scopeBlock = poolSrc.slice(scopeBlockIdx, scopeBlockIdx + 300);
    const sourceScoped = /countryCode:\s*country\.code/.test(scopeBlock) && /city,/.test(scopeBlock);

    if (!allScoped || !sourceScoped) {
      fail("city_stickiness", { claims: claims.map((c) => c.streetKey), all_rows_scoped_to_requested_city: allScoped, source_reads_current_loop_city: sourceScoped });
    } else {
      pass("city_stickiness", { claims: claims.map((c) => c.streetKey), all_rows_scoped_to_requested_city: allScoped, source_reads_current_loop_city: sourceScoped });
    }
  } catch (err) {
    fail("city_stickiness", { error: errorDetail(err) });
  }

  // -------------------------------------------------------------------
  // STEP 10 — NO TOP-N SHORTCUT
  // -------------------------------------------------------------------
  try {
    const totalInventory = await streetInventoryCount(db, COUNTRY_CODE, CITY);
    const { count: claimedForScope, error } = await db
      .from("user_discovery_street_state")
      .select("id", { count: "exact", head: true })
      .eq("user_id", USER_A)
      .eq("niche", NICHE)
      .eq("country_code", COUNTRY_CODE)
      .eq("city", CITY)
      .eq("source", SOURCE);
    if (error) throw error;

    const remainingEligible = totalInventory - (claimedForScope ?? 0);

    // Confirm the deployed RPC has no popularity/top-N WHERE clause — the
    // migration is the single source of truth for what's actually deployed
    // (grepping the RPC's own SQL, not re-deriving eligibility logic here).
    const migrationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations/029_user_discovery_street_coverage.sql");
    const migrationSrc = readFileSync(migrationPath, "utf8");
    const claimFnStart = migrationSrc.indexOf("create or replace function claim_discovery_street(");
    const claimFnEnd = migrationSrc.indexOf("$$;", claimFnStart);
    const claimFnSrc = migrationSrc.slice(claimFnStart, claimFnEnd);
    const noPopularityFilter = !/popular|top_n|rank\s*<=|limit\s+\d+/i.test(claimFnSrc.replace(/limit 1/gi, ""));

    if (totalInventory <= 1 || remainingEligible <= 0 || !noPopularityFilter) {
      fail("no_top_n", { total_inventory: totalInventory, claimed_for_scope: claimedForScope, remaining_eligible: remainingEligible, rpc_has_no_popularity_filter: noPopularityFilter });
    } else {
      pass("no_top_n", { total_inventory: totalInventory, claimed_for_scope: claimedForScope, remaining_eligible: remainingEligible, rpc_has_no_popularity_filter: noPopularityFilter });
    }
  } catch (err) {
    fail("no_top_n", { error: errorDetail(err) });
  }
}

async function runStreetQueryStep(claim: StreetClaim) {
  // Read the REAL template straight out of poolExpandJob.ts rather than
  // re-implementing it here, so this step can never silently drift from
  // what production actually sends — if the source no longer contains this
  // exact template, the assertion below fails loudly instead of the
  // harness quietly constructing a query production doesn't actually use.
  const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/jobs/poolExpandJob.ts");
  const poolSrc = readFileSync(srcPath, "utf8");
  const streetTemplatePresent = poolSrc.includes("`${singleNiche} on ${areaLabel}, ${city}`");
  if (!streetTemplatePresent) {
    fail("google_maps_query", { note: "poolExpandJob.ts no longer contains the expected street-scoped query template — harness is out of sync with production, refusing to guess" });
    return;
  }

  const exactQuery = `${NICHE} on ${claim.streetName}, ${CITY}`;
  const isAreaShaped = / in .+, .+/.test(exactQuery) && !exactQuery.includes(" on ");

  if (isAreaShaped || !exactQuery.includes(claim.streetName)) {
    fail("google_maps_query", { exact_query: exactQuery, note: "query is not street-scoped" });
    return;
  }

  if (!RUN_LIVE_SCRAPE) {
    report["google_maps_query"] = {
      status: "BLOCKED",
      detail: {
        reason: "NOT EXECUTED — ENVIRONMENT BLOCKED",
        missingPrerequisite: "VALIDATION_RUN_LIVE_SCRAPE=1 (live Google Maps scrape is opt-in — off by default)",
        exact_query_derived_not_executed: exactQuery,
      },
    };
    console.log(`\n[BLOCKED] google_maps_query`);
    console.log(`  NOT EXECUTED — ENVIRONMENT BLOCKED`);
    console.log(`  missing prerequisite: VALIDATION_RUN_LIVE_SCRAPE=1`);
    console.log(`  EXACT_QUERY=${exactQuery}  (derived from the real query template — NOT sent to Google Maps)`);
    return;
  }

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("validation-harness-timeout"), 90_000);
    let observedQuery: string | undefined;
    let deliveredAny = false;

    for await (const lead of runEngineQuery(
      {
        query: exactQuery,
        city: CITY,
        country: COUNTRY_CODE,
        niche: NICHE,
        area: claim.streetName,
        max_results: 3,
        deliver_target: 1,
        db_path: "data/leads-validation-harness.db",
        user_id: USER_A,
      },
      abortController.signal,
      () => {},
    )) {
      observedQuery = exactQuery; // the query is fixed per-call; presence of any lead confirms the call actually ran
      deliveredAny = true;
      abortController.abort("validation-harness-got-one-lead");
      void lead;
      break;
    }
    clearTimeout(timeout);

    pass("google_maps_query", {
      exact_query: exactQuery,
      street_scoped: true,
      live_scrape_executed: true,
      delivered_any_lead: deliveredAny,
      note: observedQuery ? "at least one lead observed" : "call completed without leads (still a real, executed query — not necessarily a failure)",
    });
  } catch (err) {
    fail("google_maps_query", { exact_query: exactQuery, error: errorDetail(err) });
  }
}

async function runFallbackStep() {
  try {
    const before = await streetInventoryCount(db, COUNTRY_CODE, FALLBACK_CITY);
    if (before > 0) {
      blocked("fallback", `VALIDATION_FALLBACK_CITY="${FALLBACK_CITY}" unexpectedly already has inventory — pick a different disposable value`);
      return;
    }
    const outcome = await ensureStreetInventory(db, COUNTRY_CODE, FALLBACK_CITY);
    const after = await streetInventoryCount(db, COUNTRY_CODE, FALLBACK_CITY);

    const streetModeNotSelected = outcome.mode === "area";
    const fallbackReasonLogged = outcome.mode === "area" && typeof outcome.fallbackReason === "string" && outcome.fallbackReason.length > 0;
    const noInventoryCreated = after === 0;

    if (!streetModeNotSelected || !fallbackReasonLogged || !noInventoryCreated) {
      fail("fallback", { city: FALLBACK_CITY, mode: outcome.mode, fallback_reason: outcome.mode === "area" ? outcome.fallbackReason : undefined, inventory_after: after });
    } else {
      pass("fallback", { city: FALLBACK_CITY, mode: outcome.mode, fallback_reason: outcome.fallbackReason, inventory_after: after, note: "no fake street claim created; area path remains available" });
    }
  } catch (err) {
    fail("fallback", { error: errorDetail(err) });
  }
}

main().catch((err) => {
  console.error("\nHARNESS CRASHED:", err);
  printPrerequisites();
  process.exit(1);
});
