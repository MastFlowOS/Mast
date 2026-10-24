import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
} from "../src/scraperBridge/pythonBridge.js";

const MOCK_PORT = 8769;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

let mockProc: ChildProcess | null = null;

async function startMockServer(): Promise<ChildProcess> {
  const serverPath = path.resolve(
    "C:/Users/Beboo/.gemini/antigravity/brain/854d10fa-ba51-4763-9ab2-87c1cb1ad634/scratch/enrichment_benchmark/mock_server/server.py",
  );
  const proc = spawn("python", [serverPath, String(MOCK_PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${MOCK_URL}/stats`);
      if (res.ok) {
        return proc;
      }
    } catch {
      // wait
    }
  }
  throw new Error("Failed to start mock server");
}

describe("MAST Phase 3.1 — Release Readiness Verification", { concurrency: 1 }, () => {
  test.before(async () => {
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    mockProc = await startMockServer();
    // Warm up the persistent daemon so cold start / module imports do not skew steady-state tests
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
  });

  test.after(() => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    closePersistentEnrichmentWorker();
    if (mockProc) mockProc.kill();
  });

  describe("1. Concurrency Verification", () => {
    test("multiple independent requests genuinely overlap and do not block each other", async () => {
      // Dispatch 4 requests each with 400ms delay.
      // If executed serially: total time >= 1600ms.
      // If executed concurrently: total time < 1000ms.
      const t0 = performance.now();
      const urls = [
        `${MOCK_URL}/doc/doc_01_small_business.html?delay=400&u=1`,
        `${MOCK_URL}/doc/doc_01_small_business.html?delay=400&u=2`,
        `${MOCK_URL}/doc/doc_01_small_business.html?delay=400&u=3`,
        `${MOCK_URL}/doc/doc_01_small_business.html?delay=400&u=4`,
      ];
      const results = await Promise.all(urls.map((u) => runEngineEnrich({ website: u })));
      const elapsed = performance.now() - t0;

      assert.equal(results.length, 4);
      for (const r of results) {
        assert.equal(r.website_reachable, true);
      }
      assert.ok(
        elapsed < 1100,
        `Expected concurrent execution under 1100ms, but took ${elapsed}ms (serial would be >= 1600ms)`,
      );
    });

    test("a slow website does not block faster concurrent requests", async () => {
      // Request 1: slow (1200ms delay)
      // Request 2: fast (50ms delay)
      // Request 2 must complete significantly BEFORE Request 1!
      let fastFinishedAt = 0;
      let slowFinishedAt = 0;
      const t0 = performance.now();

      const pSlow = runEngineEnrich({
        website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1200&slow=1`,
      }).then((r) => {
        slowFinishedAt = performance.now() - t0;
        return r;
      });

      // Brief delay to ensure slow request is dispatched first
      await new Promise((r) => setTimeout(r, 50));

      const pFast = runEngineEnrich({
        website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=50&fast=1`,
      }).then((r) => {
        fastFinishedAt = performance.now() - t0;
        return r;
      });

      const [slowRes, fastRes] = await Promise.all([pSlow, pFast]);
      assert.equal(slowRes.website_reachable, true);
      assert.equal(fastRes.website_reachable, true);
      assert.ok(fastFinishedAt > 0);
      assert.ok(slowFinishedAt > 0);
      assert.ok(
        fastFinishedAt < slowFinishedAt - 600,
        `Fast request (${fastFinishedAt}ms) should complete well before slow request (${slowFinishedAt}ms)`,
      );
    });

    test("concurrency bounds limit active daemon in-flight requests", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);
      try {
        let maxActiveInBridge = 0;
        const interval = setInterval(() => {
          const count = persistentEnrichmentBridge.getActivePendingCount();
          if (count > maxActiveInBridge) {
            maxActiveInBridge = count;
          }
        }, 10);

        const urls = [
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=250&b=1`,
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=250&b=2`,
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=250&b=3`,
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=250&b=4`,
        ];
        await Promise.all(urls.map((u) => runEngineEnrich({ website: u })));
        clearInterval(interval);

        assert.ok(
          maxActiveInBridge <= 2,
          `Expected max active in daemon <= 2, observed ${maxActiveInBridge}`,
        );
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
      }
    });
  });

  describe("2. Connection-Pool & Cache Reuse Verification", () => {
    test("domain cache serves warm hits without HTTP requests to mock doc", async () => {
      const docPath = "/doc/doc_01_small_business.html";
      const statsBefore = await (await fetch(`${MOCK_URL}/stats`)).json();
      const docHitsBefore = statsBefore.requests_by_path[docPath] || 0;

      const target = `${MOCK_URL}${docPath}?cache_unique=2026`;

      // 1st request: cold
      const t1Start = performance.now();
      const res1 = await runEngineEnrich({ website: target });
      const t1 = performance.now() - t1Start;

      const statsMid = await (await fetch(`${MOCK_URL}/stats`)).json();
      const docHitsMid = statsMid.requests_by_path[docPath] || 0;
      assert.equal(
        docHitsMid,
        docHitsBefore + 1,
        "Mock server should receive exactly 1 doc request on cold call",
      );

      // 2nd request: warm cache hit
      const t2Start = performance.now();
      const res2 = await runEngineEnrich({ website: target });
      const t2 = performance.now() - t2Start;

      const statsAfter = await (await fetch(`${MOCK_URL}/stats`)).json();
      const docHitsAfter = statsAfter.requests_by_path[docPath] || 0;
      assert.equal(
        docHitsAfter,
        docHitsMid,
        "Mock server doc requests must NOT increase on warm cache call",
      );

      // Verify identical result
      assert.equal(res1.website_reachable, res2.website_reachable);
      assert.equal(res1.final_url, res2.final_url);
      assert.equal(res1.title, res2.title);
      assert.deepEqual(res1.emails, res2.emails);
      assert.deepEqual(res1.phones, res2.phones);
      assert.ok(t2 < t1, `Warm call (${t2}ms) should be faster than cold call (${t1}ms)`);
    });
  });

  describe("3. Cancellation, Timeouts, and Backpressure Verification", () => {
    test("cancellation via AbortSignal aborts and frees slot immediately", async () => {
      const ac = new AbortController();
      const slowTarget = `${MOCK_URL}/doc/doc_01_small_business.html?delay=3000&abort_test=1`;

      const p = runEngineEnrich({ website: slowTarget }, ac.signal);
      setTimeout(() => ac.abort(), 100);

      await assert.rejects(p, (err: Error) => {
        return err.message.includes("aborted");
      });

      // Confirm subsequent requests succeed immediately (slot was freed in finally)
      const fastTarget = `${MOCK_URL}/doc/doc_01_small_business.html?delay=20&after_abort=1`;
      const res = await runEngineEnrich({ website: fastTarget });
      assert.equal(res.website_reachable, true);
    });

    test("process crash rejects in-flight requests cleanly and restarts on next request", async () => {
      // 1. Ensure worker is alive
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);

      // 2. Kill the process directly while dispatching
      const slowTarget = `${MOCK_URL}/doc/doc_01_small_business.html?delay=2000&crash_test=1`;
      const p = runEngineEnrich({ website: slowTarget });

      // Kill the daemon after 100ms
      setTimeout(() => {
        persistentEnrichmentBridge.close();
      }, 100);

      await assert.rejects(p, (err: Error) => {
        return err.message.includes("exited") || err.message.includes("daemon");
      });

      // 3. Verify next request automatically recovers and spawns fresh daemon
      const nextRes = await runEngineEnrich({
        website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=20&recovery=1`,
      });
      assert.equal(nextRes.website_reachable, true);
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
    });
  });

  describe("4. Correctness Parity Across Edge Cases", () => {
    const testCases: Array<{ name: string; params: any }> = [
      { name: "empty payload", params: {} },
      { name: "empty website string", params: { website: "" } },
      { name: "malformed website (spaces)", params: { website: "   " } },
      { name: "malformed URL syntax", params: { website: "http://:" } },
      { name: "social URL as website (should not reach)", params: { website: "https://facebook.com/mybusiness" } },
      { name: "ordering platform (should not reach)", params: { website: "https://grubhub.com/restaurant/test" } },
      { name: "HTTP 404 response", params: { website: `${MOCK_URL}/error/404` } },
      { name: "HTTP 500 response", params: { website: `${MOCK_URL}/error/500` } },
      { name: "standard website with contacts", params: { website: `${MOCK_URL}/doc/doc_01_small_business.html` } },
      { name: "multi-page website with contact link", params: { website: `${MOCK_URL}/doc/doc_10_home.html` } },
      {
        name: "lead with name, category, and website",
        params: {
          name: "Bay Area Bakery",
          category: "Bakery",
          website: `${MOCK_URL}/doc/doc_01_small_business.html`,
          phone: "+14155550199",
        },
      },
      {
        name: "lead with instagram url",
        params: {
          name: "Test IG",
          instagram: "https://www.instagram.com/testbusiness/",
          website: `${MOCK_URL}/doc/doc_01_small_business.html`,
        },
      },
    ];

    for (const tc of testCases) {
      test(`parity on ${tc.name}`, async () => {
        const [oneShotRes, daemonRes] = await Promise.all([
          runEngineEnrichOneShot(tc.params),
          runEngineEnrich(tc.params),
        ]);

        const fieldsToCompare = [
          "website_reachable",
          "http_status",
          "title",
          "meta_description",
          "detected_platform",
          "email",
          "phone",
          "contact_form_url",
          "whatsapp_link",
          "messenger_link",
          "telegram_link",
          "linkedin",
          "instagram",
          "instagram_reachable",
          "opportunity_score",
          "score_tier",
        ];

        for (const f of fieldsToCompare) {
          assert.equal(
            (oneShotRes as any)[f],
            (daemonRes as any)[f],
            `Field mismatch on '${f}' for test case '${tc.name}': one-shot=${(oneShotRes as any)[f]}, daemon=${(daemonRes as any)[f]}`,
          );
        }

        // Compare contact arrays
        assert.deepEqual(oneShotRes.emails, daemonRes.emails);
        assert.deepEqual(oneShotRes.phones, daemonRes.phones);
        assert.deepEqual(oneShotRes.score_breakdown, daemonRes.score_breakdown);
      });
    }

    test("concurrency parity: request failing with 500 does not affect concurrent succeeding request", async () => {
      const pFail = runEngineEnrich({ website: `${MOCK_URL}/error/500?c=fail` });
      const pSuccess = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?c=success` });

      const [resFail, resSuccess] = await Promise.all([pFail, pSuccess]);
      assert.equal(resFail.http_status, 500);
      assert.equal(resSuccess.http_status, 200);
      assert.equal(resSuccess.website_reachable, true);
      assert.ok(resSuccess.title);
    });

    test("duplicate submissions for the same business/domain finish consistently", async () => {
      const target = `${MOCK_URL}/doc/doc_01_small_business.html?dup_test=1`;
      const [res1, res2] = await Promise.all([
        runEngineEnrich({ name: "Biz A", website: target }),
        runEngineEnrich({ name: "Biz A", website: target }),
      ]);
      assert.equal(res1.website_reachable, res2.website_reachable);
      assert.equal(res1.opportunity_score, res2.opportunity_score);
      assert.deepEqual(res1.emails, res2.emails);
    });
  });
});
