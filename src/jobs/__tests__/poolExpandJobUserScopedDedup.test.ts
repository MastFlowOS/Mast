/**
 * CRITMODE — Production User-Scoped Dedup Bug.
 *
 * Confirmed production regression: a `followUp` pool-expand run (a real
 * waiting user, e.g. `followUp for user=8aa324e4-3ce4-4810-b86c-f98b09feed80`
 * in the parent job's own telemetry) was NOT threading `followUp.userId`
 * into either `runEngineQuery()` call's `EngineQueryParams`. Python's
 * `mast.early_dedup` telemetry then always logged `userId: null` for that
 * run, because `service.run_query(user_id=...)` never received one —
 * `build_seven_stage_pipeline(requesting_user_id=...)` fell back to
 * `PersistentEarlyDedupChecker._is_duplicate_global` (the GLOBAL
 * `businesses`-existence check) instead of `._is_duplicate_for_user` (the
 * per-user `leads(user_id, business_id)` ownership check) — silently
 * defeating Phase 1A's user-scoped early-dedup ownership fix for every
 * followUp delivery in production.
 *
 * Like poolExpandJobExecutionModel.test.ts, this pins the guarantee
 * directly against the source: poolExpandJob.ts's `runGoogleAreaPoolForCity`
 * (curated-area pooled path) and its legacy single-search path are both
 * heavily entangled with Supabase/the browser-slot semaphore/the real
 * Python subprocess bridge, and are not independently callable units — so,
 * consistent with that file's own precedent, this asserts against the
 * actual EngineQueryParams object literal built at each call site.
 *
 * These tests would FAIL if production ever again drops `followUp.userId`
 * from either call site — i.e. exactly the confirmed regression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolExpandJobSrc = readFileSync(
  path.join(__dirname, "../poolExpandJob.ts"),
  "utf8",
);

// Split the source into the two runEngineQuery(...) call expressions so
// each param object can be inspected independently (the pooled-area path
// and the legacy single-search path each build a distinct params literal).
function extractRunEngineQueryCallBlocks(src: string): string[] {
  const blocks: string[] = [];
  // Only the two actual call sites (`for await (const lead of
  // runEngineQuery(`) — not every prose mention of "runEngineQuery()" in
  // comments elsewhere in the file.
  const marker = "for await (const lead of runEngineQuery(";
  let searchFrom = 0;
  while (true) {
    const start = src.indexOf(marker, searchFrom);
    if (start === -1) break;
    // Comfortably larger than either call's params object plus its
    // trailing signal/onDone/options arguments and this repo's own
    // in-place explanatory comments — rather than a fragile
    // paren-balance scan.
    blocks.push(src.slice(start, start + 2500));
    searchFrom = start + marker.length;
  }
  return blocks;
}

test("both runEngineQuery() call sites in poolExpandJob.ts thread followUp.userId through as user_id", () => {
  const blocks = extractRunEngineQueryCallBlocks(poolExpandJobSrc);
  assert.equal(
    blocks.length,
    2,
    "expected exactly two runEngineQuery() call sites (pooled-area path + legacy path) — update this test if that count intentionally changes",
  );

  for (const [i, block] of blocks.entries()) {
    assert.match(
      block,
      /user_id:\s*followUp\?\.userId/,
      `runEngineQuery() call site #${i + 1} must pass "user_id: followUp?.userId" so the Python engine receives the real requesting user ` +
        `(when present) instead of always falling back to the global businesses-existence check — this is the exact production regression`,
    );
  }
});

test("user_id is never hardcoded or defaulted to a non-followUp value (must stay undefined for bare pool-growth runs)", () => {
  const blocks = extractRunEngineQueryCallBlocks(poolExpandJobSrc);
  for (const block of blocks) {
    // Guards against a "fix" that always passes SOME user id (e.g. a
    // system/service account) — that would defeat requirement 4 ("without
    // a user ID, preserve the existing pool/global behavior") by turning
    // every bare pool-growth run into a spuriously user-scoped one.
    assert.doesNotMatch(
      block,
      /user_id:\s*(?!followUp\?\.userId)['"a-zA-Z_]/,
      "user_id must be derived only from followUp?.userId (undefined when there is no followUp), never hardcoded or defaulted to another value",
    );
  }
});
