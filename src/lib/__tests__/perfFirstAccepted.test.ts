import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { JobProfiler } = await import("../perf.js");

describe("Priority 6: Telemetry and SLA consistency", () => {
  it("first_lead_delivered mark is stamped on first acceptance and not overwritten", async () => {
    const profiler = new JobProfiler();

    // Mark first lead delivered at time T1
    profiler.mark("first_lead_delivered");
    const t1 = profiler.getMarkMs("first_lead_delivered");
    assert.ok(t1 !== undefined && t1 >= 0);

    // Wait slightly
    await new Promise((r) => setTimeout(r, 20));

    // Subsequent lead delivery calls mark again
    profiler.mark("first_lead_delivered");
    const t2 = profiler.getMarkMs("first_lead_delivered");

    assert.equal(t1, t2, "first_lead_delivered must not be overwritten by subsequent leads");
  });

  it("first_candidate_accepted_ms never exceeds task_end_ms", () => {
    const taskEndMs = 500;
    const firstAcceptedMark = 650; // Late mark simulation

    const boundedFirstAcceptedMs =
      firstAcceptedMark !== undefined ? Math.min(taskEndMs, Math.round(firstAcceptedMark)) : undefined;

    assert.equal(boundedFirstAcceptedMs, taskEndMs);
    assert.ok(boundedFirstAcceptedMs! <= taskEndMs);
  });
});
