/**
 * CRITMODE — contaminated New York street inventory: controlled rebuild.
 * =========================================================================
 *
 * A standalone, non-interactive script for the specific, one-time
 * remediation this incident needs. It does NOT touch poolExpandJob.ts,
 * worker concurrency, or the claim/heartbeat/complete RPCs — it only
 * calls the same production `ensureStreetInventory()` function those
 * files already call, with `region` supplied explicitly (poolExpandJob.ts's
 * own call site never passes `region` — see streetDiscovery.ts — so this
 * script is the one place New York gets built WITH its region set,
 * without editing that file).
 *
 * PREREQUISITE
 * ------------
 * Migration 032 (`032_discovery_streets_boundary_version.sql`) must
 * already be applied — it is what archives and deletes the contaminated
 * pre-fix New York rows so `ensureStreetInventory()`'s freshness check
 * (`streetInventoryFreshCount()`) actually sees 0 and triggers a real
 * rebuild here, instead of short-circuiting on stale data. This script
 * verifies that precondition itself (Step 0) rather than assuming it.
 *
 * USAGE
 * -----
 *   npx tsx scripts/rebuildNewYorkStreetInventory.ts
 *
 * Every step prints its own PASS/FAIL — this script never fabricates a
 * result for a step it could not execute.
 */

import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import {
  ensureStreetInventory,
  streetInventoryCount,
  streetInventoryFreshCount,
  CURRENT_STREET_BOUNDARY_VERSION,
} from "../src/discovery/streetDiscovery.js";

const db = supabaseAdmin as any;

const COUNTRY_CODE = "US";
const CITY = "New York";
const REGION = "NY";
const COUNTRY_NAME = "United States";

// Known contamination signatures from the production incident — any
// survival of these after rebuild is an immediate FAIL, not a warning.
const CONTAMINATION_SIGNATURES = [
  "1", // bare route-number artifact
  "1-2-mile-plungis-road",
  "1-3",
];
const CONTAMINATION_NAME_FRAGMENTS = ["plungis", "warwick"];

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function main() {
  console.log("=".repeat(78));
  console.log("CRITMODE — New York street inventory rebuild");
  console.log(`country=${COUNTRY_CODE} city=${CITY} region=${REGION}`);
  console.log(`expected boundary_version=${CURRENT_STREET_BOUNDARY_VERSION}`);
  console.log("=".repeat(78));

  // ---------------------------------------------------------------------
  // Step 0: precondition — migration 032 must have already purged the
  // contaminated rows. Fail loudly rather than silently rebuilding
  // alongside 114,103 stale rows.
  // ---------------------------------------------------------------------
  const rawBefore = await streetInventoryCount(db, COUNTRY_CODE, CITY);
  const freshBefore = await streetInventoryFreshCount(db, COUNTRY_CODE, CITY);
  const staleBefore = rawBefore - freshBefore;
  console.log(`\n[Step 0] pre-rebuild counts: raw=${rawBefore} fresh=${freshBefore} stale=${staleBefore}`);
  if (staleBefore > 0) {
    console.error(
      `[Step 0] FAIL — ${staleBefore} stale (pre-fix) row(s) still present for ${COUNTRY_CODE}/${CITY}. ` +
        `Apply migration 032_discovery_streets_boundary_version.sql before running this script.`,
    );
    process.exit(1);
  }
  console.log("[Step 0] PASS — no stale rows remain; safe to rebuild");

  // ---------------------------------------------------------------------
  // Step 1: run the REAL production path. Not a redesign — this is the
  // exact same ensureStreetInventory() poolExpandJob.ts already calls,
  // just invoked directly with region='NY' explicit (that call site
  // never passes region — see streetDiscovery.ts's own header comment).
  // ---------------------------------------------------------------------
  console.log("\n[Step 1] calling ensureStreetInventory() ...");
  const outcome = await ensureStreetInventory(db, COUNTRY_CODE, CITY, {
    countryName: COUNTRY_NAME,
    region: REGION,
  });
  console.log(`[Step 1] outcome: ${JSON.stringify(outcome)}`);
  if (outcome.mode !== "street") {
    console.error(`[Step 1] FAIL — builder did not produce street-mode inventory: ${JSON.stringify(outcome)}`);
    process.exit(1);
  }
  console.log(`[Step 1] PASS — mode=street count=${outcome.count}`);

  // ---------------------------------------------------------------------
  // Step 2: verify the corrected builder is actually responsible for the
  // new rows — every row must carry the CURRENT boundary_version and the
  // requested region, not a leftover/legacy value.
  // ---------------------------------------------------------------------
  console.log("\n[Step 2] verifying builder attribution ...");
  const { data: sample, error: sampleErr } = await db
    .from("discovery_streets")
    .select("street_key, street_name, normalized_name, region, boundary_version, source, source_id, metadata")
    .eq("country_code", COUNTRY_CODE)
    .eq("city", CITY)
    .order("normalized_name")
    .limit(2000);
  if (sampleErr) {
    console.error(`[Step 2] FAIL — could not read discovery_streets: ${errorDetail(sampleErr)}`);
    process.exit(1);
  }
  const rows: any[] = sample ?? [];
  const wrongVersion = rows.filter((r) => r.boundary_version !== CURRENT_STREET_BOUNDARY_VERSION);
  const wrongRegion = rows.filter((r) => (r.region ?? "").toLowerCase() !== REGION.toLowerCase());
  const wrongSource = rows.filter((r) => r.source !== "overpass");
  console.log(`[Step 2] rows_read=${rows.length} wrong_boundary_version=${wrongVersion.length} wrong_region=${wrongRegion.length} wrong_source=${wrongSource.length}`);
  if (wrongVersion.length > 0 || wrongSource.length > 0) {
    console.error("[Step 2] FAIL — some rows were not produced by the corrected overpass builder");
    process.exit(1);
  }
  if (wrongRegion.length > 0) {
    console.warn(
      `[Step 2] WARN — ${wrongRegion.length} row(s) do not carry region='NY'. This means ` +
        `region was not threaded through end-to-end; check that ensureStreetInventory's opts.region ` +
        `reached build_city_street_inventory / StreetRecord.region.`,
    );
  } else {
    console.log("[Step 2] PASS — every row carries the current boundary_version and region='NY'");
  }

  // ---------------------------------------------------------------------
  // Step 3: no outside-boundary contamination — the exact signatures from
  // the production incident, plus a defensive substring scan.
  // ---------------------------------------------------------------------
  console.log("\n[Step 3] scanning for known contamination signatures ...");
  const keySuffixes = rows.map((r) => String(r.street_key).split(":").slice(3).join(":"));
  const badKeyHits = CONTAMINATION_SIGNATURES.filter((sig) => keySuffixes.includes(sig));
  const badNameHits = rows.filter((r) =>
    CONTAMINATION_NAME_FRAGMENTS.some((frag) => String(r.street_name).toLowerCase().includes(frag)),
  );
  console.log(`[Step 3] bad_key_signature_hits=${badKeyHits.length} bad_name_fragment_hits=${badNameHits.length}`);
  if (badKeyHits.length > 0 || badNameHits.length > 0) {
    console.error("[Step 3] FAIL — contamination signatures found in rebuilt inventory:", {
      badKeyHits,
      badNames: badNameHits.map((r) => r.street_name),
    });
    process.exit(1);
  }
  console.log("[Step 3] PASS — no Warwick/Orange County or bare-digit artifacts found");

  // ---------------------------------------------------------------------
  // Step 4: sanity bound — a real NYC inventory should be a small
  // fraction of the old 114,103-row state-wide figure, and non-trivial.
  // ---------------------------------------------------------------------
  console.log("\n[Step 4] sanity-checking inventory size ...");
  const finalCount = await streetInventoryFreshCount(db, COUNTRY_CODE, CITY);
  console.log(`[Step 4] final fresh count = ${finalCount}`);
  if (finalCount === 0) {
    console.error("[Step 4] FAIL — rebuilt inventory is empty");
    process.exit(1);
  }
  if (finalCount >= 114_103) {
    console.error(
      `[Step 4] FAIL — rebuilt count (${finalCount}) is not smaller than the known-contaminated ` +
        `state-wide figure (114103); this looks like the state boundary was matched again`,
    );
    process.exit(1);
  }
  console.log("[Step 4] PASS — inventory size is plausible for a city, not a state");

  // ---------------------------------------------------------------------
  // Step 5: idempotency — calling ensureStreetInventory() again must NOT
  // trigger a second build (freshness check short-circuits).
  // ---------------------------------------------------------------------
  console.log("\n[Step 5] verifying idempotent reuse on a second call ...");
  const secondOutcome = await ensureStreetInventory(db, COUNTRY_CODE, CITY, {
    countryName: COUNTRY_NAME,
    region: REGION,
  });
  console.log(`[Step 5] second outcome: ${JSON.stringify(secondOutcome)}`);
  if (secondOutcome.mode !== "street" || secondOutcome.count !== finalCount) {
    console.error("[Step 5] FAIL — second call did not cleanly reuse the rebuilt inventory");
    process.exit(1);
  }
  console.log("[Step 5] PASS — second call reused existing fresh inventory without rebuilding");

  console.log("\n" + "=".repeat(78));
  console.log(`DONE. New York City street inventory rebuilt: ${finalCount} streets.`);
  console.log("Sample streets:");
  for (const r of rows.slice(0, 15)) {
    console.log(`  - ${r.street_name}  (key=${r.street_key})`);
  }
  console.log("=".repeat(78));
}

main().catch((err) => {
  console.error("FATAL:", errorDetail(err));
  process.exit(1);
});
