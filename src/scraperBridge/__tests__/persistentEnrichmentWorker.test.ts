import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
} from "../pythonBridge.js";

describe("Persistent Enrichment Worker", { concurrency: 1 }, () => {
  test.before(() => {
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
  });

  test.after(() => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    closePersistentEnrichmentWorker();
  });

  test("persistent enrichment worker - executes successfully and returns expected fields", async () => {
    const result = await runEngineEnrich({ website: "https://example.com" });
    assert.ok(result, "Result should be defined");
    assert.equal(result.website_reachable, true);
    assert.equal(typeof result.http_status, "number");
    assert.ok(result.http_status !== null && result.http_status >= 200 && result.http_status < 400);
    assert.ok(Array.isArray(result.emails));
    assert.ok(Array.isArray(result.phones));
    assert.ok("opportunity_score" in result);
  });

  test("persistent enrichment worker - warm calls reuse process and domain cache", async () => {
    // First call warms up the worker and populates WebsiteWorker._domain_cache
    const t0 = Date.now();
    const res1 = await runEngineEnrich({ website: "https://example.com" });
    const coldDuration = Date.now() - t0;
    assert.equal(res1.website_reachable, true);

    // Second call to same domain should hit the warm process and cache
    const t1 = Date.now();
    const res2 = await runEngineEnrich({ website: "https://example.com" });
    const warmDuration = Date.now() - t1;
    assert.equal(res2.website_reachable, true);

    assert.ok(
      warmDuration < 2000,
      `Warm duration (${warmDuration}ms) should complete promptly`,
    );
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
  });

  test("persistent enrichment worker - concurrent requests correlate correctly", async () => {
    const targets = [
      { website: "https://example.com" },
      { website: "https://example.org" },
      { website: "https://example.net" },
      { website: "https://example.com" },
    ];

    const results = await Promise.all(targets.map((params) => runEngineEnrich(params)));
    assert.equal(results.length, 4);
    results.forEach((r, idx) => {
      assert.equal(r.website_reachable, true, `Target ${idx} should be reachable`);
      assert.ok(typeof r.final_url === "string", `Target ${idx} should have final_url`);
    });
  });

  test("persistent enrichment worker - per-request failure isolation", async () => {
    // An unreachable / invalid domain alongside a valid domain
    const [validRes, invalidRes] = await Promise.all([
      runEngineEnrich({ website: "https://example.com" }),
      runEngineEnrich({ website: "https://invalid-non-existent-domain-123456789.org" }),
    ]);

    assert.equal(validRes.website_reachable, true, "Valid site should succeed");
    assert.equal(invalidRes.website_reachable, false, "Invalid site should report unreachable without throwing");
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), true, "Worker should stay alive after failed lead");
  });

  test("persistent enrichment worker - cancellation via AbortSignal aborts request cleanly", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        await runEngineEnrich({ website: "https://example.com" }, controller.signal);
      },
      /aborted/i,
      "Should reject when signal is aborted",
    );
  });

  test("persistent enrichment worker - crash recovery and automatic restart", async () => {
    // First, ensure worker is spawned
    await runEngineEnrich({ website: "https://example.com" });
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);

    // Simulate worker crash by closing worker
    closePersistentEnrichmentWorker();
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

    // Next call should automatically respawn and succeed
    const recoveredResult = await runEngineEnrich({ website: "https://example.com" });
    assert.equal(recoveredResult.website_reachable, true);
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
  });

  test("fallback to one-shot enrichment when USE_PERSISTENT_ENRICHMENT=false", async () => {
    closePersistentEnrichmentWorker();
    process.env.USE_PERSISTENT_ENRICHMENT = "false";
    try {
      const res = await runEngineEnrich({ website: "https://example.com" });
      assert.equal(res.website_reachable, true);
      // Persistent worker should not be spawned
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
    } finally {
      delete process.env.USE_PERSISTENT_ENRICHMENT;
    }
  });
});
