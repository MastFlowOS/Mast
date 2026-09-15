/**
 * CRITMODE Phase 4 — PART B pin tests.
 *
 * poolExpandJob.ts's `runGoogleAreaPoolForCity` is, like its sibling tests
 * (poolExpandJobExecutionModel.test.ts, poolExpandJobUserScopedDedup.test.ts)
 * already establish, not independently callable — it is heavily entangled
 * with Supabase, the browser-slot semaphore, and the real Python subprocess
 * bridge. Consistent with that existing precedent, these tests assert
 * directly against the source for the specific guarantees the audit +
 * activation task require, so a future edit that silently drops one of them
 * fails CI instead of only being caught in production telemetry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "../poolExpandJob.ts"), "utf8");

function sliceFunction(marker: string, approxLength = 60000): string {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `expected to find "${marker}" in poolExpandJob.ts`);
  return src.slice(start, start + approxLength);
}

test("street primitives are imported from streetDiscovery.ts", () => {
  assert.match(src, /claimDiscoveryStreet/);
  assert.match(src, /completeDiscoveryStreetClaim/);
  assert.match(src, /heartbeatDiscoveryStreetClaim/);
  assert.match(src, /ensureStreetInventory/);
  assert.match(src, /from "\.\.\/discovery\/streetDiscovery\.js"/);
});

test("street mode is only ever attempted for a followUp (real requesting user) — never a bare pool-growth run", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  const gate = fn.slice(0, fn.indexOf("const useStreetPool"));
  assert.match(
    gate,
    /if \(followUp\?\.userId\)/,
    "street inventory/claiming must be gated on followUp?.userId, never attempted for an ownerless bare pool-growth run",
  );
});

test("street scope never manufactures an owner and is scoped to the current (country, city)", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  const scopeBlock = fn.slice(fn.indexOf("streetScope = {"), fn.indexOf("streetScope = {") + 300);
  assert.match(scopeBlock, /userId:\s*followUp\.userId/);
  assert.match(scopeBlock, /countryCode:\s*country\.code/);
  assert.match(scopeBlock, /city,/, "streetScope.city must be the current city being processed, not a different one");
});

test("claimNextArea calls claimDiscoveryStreet in street mode, claimAreaForCity otherwise (no jumping city/queue)", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  const claimBlock = fn.slice(fn.indexOf("claimNextArea: async"), fn.indexOf("claimNextArea: async") + 900);
  assert.match(claimBlock, /if \(useStreetPool && streetScope\)/);
  assert.match(claimBlock, /claimDiscoveryStreet\(supabaseAdmin, streetScope,/);
  assert.match(claimBlock, /claimAreaForCity\(supabaseAdmin, \{/);
});

test("a claimed street produces an 'on {street}, {city}' query; area mode keeps 'in {area}, {city}' unchanged", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  assert.match(fn, /`\$\{singleNiche\} on \$\{areaLabel\}, \$\{city\}`/);
  assert.match(fn, /`\$\{singleNiche\} in \$\{areaLabel\}, \$\{city\}`/);
});

test("street claims are heartbeated while their engine call is running", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  assert.match(fn, /heartbeatDiscoveryStreetClaim\(supabaseAdmin, streetClaim, streetScope!\.userId, streetWorkerId\)/);
  assert.match(fn, /streetHeartbeatTimer = setInterval\(renewStreetClaim, STREET_HEARTBEAT_INTERVAL_MS\)/);
});

test("a street is completed only on genuine exhaustion (SUCCESS_EXHAUSTED) and a live (non-lost) heartbeat — never merely because a lead was found", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  const completeBlock = fn.slice(fn.indexOf("const streetCompleted ="), fn.indexOf("const streetCompleted =") + 300);
  assert.match(completeBlock, /!streetHeartbeatStopped/);
  assert.match(completeBlock, /effectiveTerminationReason === "SUCCESS_EXHAUSTED"/);
  assert.match(completeBlock, /completeDiscoveryStreetClaim\(supabaseAdmin, streetClaim, streetScope\.userId, streetWorkerId\)/);
  // Must NOT gate completion on accepted/discovered count anywhere in this block.
  assert.doesNotMatch(completeBlock, /accepted > 0/);
});

test("recordAreaOutcome (curated-area bookkeeping) is skipped for street-mode worker completions", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  const onEventBlock = fn.slice(fn.indexOf("onEvent: (event) => {"), fn.indexOf("runArea: async"));
  const finishedBranch = onEventBlock.slice(onEventBlock.indexOf('event.type === "worker_finished"'));
  // PAID-TIER LIVE SCRAPING BRIDGE: recordAreaOutcome is now gated with a
  // combined condition (`worker_finished && !useStreetPool`) rather than an
  // early `return` inside a nested `if` — the early return was replaced so
  // this same onEvent callback can still fall through to publish the live
  // discovery event for BOTH area and street mode. The actual guarantee
  // under test (recordAreaOutcome never runs for a street-mode completion)
  // is unchanged.
  assert.match(finishedBranch, /event\.type === "worker_finished" && !useStreetPool/);
  assert.doesNotMatch(
    finishedBranch.slice(0, finishedBranch.indexOf("recordAreaOutcome(supabaseAdmin")),
    /if \(useStreetPool\)/,
    "recordAreaOutcome must be reached only when !useStreetPool — no separate nested street-mode branch guarding it anymore",
  );
});

test("pool sizing (totalCuratedAreas) uses the real street inventory count in street mode, not the curated-area list length", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  assert.match(fn, /const totalClaimTargets = useStreetPool \? streetInventoryCountForCity : areas\.length;/);
  assert.match(fn, /totalCuratedAreas: totalClaimTargets,/);
});

test("area fallback is explicit and observable: a non-street outcome logs its fallback_reason", () => {
  const fn = sliceFunction("async function runGoogleAreaPoolForCity(");
  assert.match(fn, /mode=area /);
  assert.match(fn, /fallback_reason=\$\{inventoryOutcome\.fallbackReason\}/);
});
