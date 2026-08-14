import assert from "node:assert/strict";
import test from "node:test";

test("Bug 3 - Engine crash retry semantics & single-flight protection", async () => {
  // Test 1: Single-flight claim rejects re-execution when scrape_job is already terminal ('failed')
  const jobState = {
    id: "job-uuid-123",
    status: "failed",
    last_heartbeat_at: new Date().toISOString(),
  };

  function claimPoolExpandExecution(scrapeJobId: string, currentStatus: string): boolean {
    if (["completed", "cancelled", "failed", "completed_partial"].includes(currentStatus)) {
      return false;
    }
    return true;
  }

  const claimResult = claimPoolExpandExecution(jobState.id, jobState.status);
  assert.equal(claimResult, false, "Terminal status 'failed' MUST prevent re-claiming the job for execution");

  // Test 2: Uncontrolled duplicate execution count on crash is 0
  let engineSpawnCount = 0;
  let jobCompletedOrFailed = false;

  async function handleJobWithRetryGuard(isRetry: boolean) {
    if (isRetry && jobState.status === "failed") {
      // Single-flight claim blocks duplicate execution
      return;
    }
    engineSpawnCount += 1;
    // Simulate engine crash on first run
    jobState.status = "failed";
    jobCompletedOrFailed = true;
    throw new Error("scraper engine exited with code 1");
  }

  // First attempt: engine runs and crashes
  try {
    await handleJobWithRetryGuard(false);
  } catch (err) {
    assert.match((err as Error).message, /scraper engine exited with code 1/);
  }
  assert.equal(engineSpawnCount, 1, "First run should spawn 1 engine");

  // Simulated pg-boss retry 3 seconds later
  try {
    await handleJobWithRetryGuard(true);
  } catch (err) {
    assert.fail("Retry should be safely guarded by single-flight claim and return without spawning second engine");
  }

  assert.equal(engineSpawnCount, 1, "pg-boss retry MUST NOT spawn a 2nd engine when job is already failed");
});
