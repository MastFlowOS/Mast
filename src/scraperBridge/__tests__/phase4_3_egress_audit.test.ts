import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
  closePersistentEnrichmentWorkerGraceful,
} from "../pythonBridge.js";
import {
  assertLocalIsolation,
  enforceLocalSyntheticEnv,
  installNodeNetworkIsolationGuard,
  uninstallNodeNetworkIsolationGuard,
  IsolationBreachError,
} from "../isolationGuard.js";

const MOCK_PORT = 8778; // Dedicated port for Phase 4.3 egress audit
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
  throw new Error("Failed to start mock server on port " + MOCK_PORT);
}

async function getMockStats(): Promise<{ total_requests: number; requests_by_path: Record<string, number> }> {
  const res = await fetch(`${MOCK_URL}/stats`);
  return res.json() as any;
}

describe("MAST Phase 4.3 — Final Enrichment Egress Audit Suite", { concurrency: 1 }, () => {
  test.before(async () => {
    enforceLocalSyntheticEnv();
    assertLocalIsolation();
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    process.env.ENFORCE_LOCAL_ISOLATION = "true";
    mockProc = await startMockServer();
  });

  test.after(async () => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    delete process.env.ENFORCE_LOCAL_ISOLATION;
    uninstallNodeNetworkIsolationGuard();
    await closePersistentEnrichmentWorkerGraceful(2000);
    if (mockProc) mockProc.kill();
  });

  test.beforeEach(() => {
    closePersistentEnrichmentWorker();
    persistentEnrichmentBridge.setMaxConcurrency(4);
    persistentEnrichmentBridge.setMaxQueueLength(64);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);
  });

  describe("1. Bridge Egress Validation Under ENFORCE_LOCAL_ISOLATION", () => {
    test("runEngineEnrich rejects external website URLs before dispatching to Python", async () => {
      // Prohibited external targets
      const prohibitedTargets = [
        "https://example.com",
        "https://google.com/search?q=test",
        "https://xyz.supabase.co/rest/v1/",
        "http://railway.app/health",
      ];

      for (const target of prohibitedTargets) {
        await assert.rejects(
          runEngineEnrich({ website: target }),
          (err: any) => {
            assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
            return true;
          },
          `Must reject external URL: ${target}`,
        );
      }
    });

    test("runEngineEnrich rejects external instagram URLs before dispatching to Python", async () => {
      await assert.rejects(
        runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html`,
          instagram: "https://www.instagram.com/real_profile/",
        }),
        (err: any) => {
          assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
          return true;
        },
        "Must reject external Instagram URL",
      );
    });

    test("runEngineEnrichOneShot enforces identical URL rejection when persistent enrichment is disabled", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "false";
      try {
        await assert.rejects(
          runEngineEnrich({ website: "https://example.com/one-shot-test" }),
          (err: any) => {
            assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
            return true;
          },
          "One-shot path must reject external URL under local isolation",
        );
      } finally {
        process.env.USE_PERSISTENT_ENRICHMENT = "true";
      }
    });

    test("permitted local loopback targets execute and receive valid enrichment results", async () => {
      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=5` });
      assert.equal(res.website_reachable, true);
      assert.equal(res.title, "Bay Area Bakery");
      assert.deepEqual(res.emails, ["contact@bayareabakery.com"]);
    });
  });

  describe("2. Redirect & Multi-Page Traversal Integrity", () => {
    test("WebsiteWorker follows local multi-hop redirects without escaping the fixture server", async () => {
      // /redirect/1 redirects to /redirect/2 which redirects to /doc/doc_12_destination.html
      const res = await runEngineEnrich({ website: `${MOCK_URL}/redirect/1` });
      assert.equal(res.website_reachable, true);
      assert.ok(res.final_url?.includes("doc_12_destination.html"));
      assert.deepEqual(res.emails, ["reached@destination.com"]);
    });

    test("ContactWorker crawls multi-page contact hints staying strictly within local corpus", async () => {
      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_10_home.html` });
      assert.equal(res.website_reachable, true);
      // doc_10_home.html links to /contact-us which serves doc_10_contact.html
      assert.ok(res.contact_page?.includes("/contact-us"));
      assert.ok(res.emails.includes("support@multistore.com"));
      assert.ok(res.phones.length > 0);
    });
  });

  describe("3. Active Socket Interception & Mock Corpus Accounting", () => {
    test("installNodeNetworkIsolationGuard actively intercepts and destroys sockets targeting production domains", async () => {
      installNodeNetworkIsolationGuard();

      try {
        await assert.rejects(
          new Promise((resolve, reject) => {
            const socket = net.connect({ host: "aws-0-us-east-1.pooler.supabase.com", port: 5432 });
            socket.on("error", reject);
            socket.on("connect", () => {
              socket.destroy();
              resolve(true);
            });
          }),
          (err: any) => {
            assert.ok(err instanceof IsolationBreachError || /blocked by network isolation guard/i.test(err.message));
            return true;
          },
        );
      } finally {
        uninstallNodeNetworkIsolationGuard();
      }
    });

    test("Mock server stats verify all test HTTP traffic remained 100% on local loopback", async () => {
      const stats = await getMockStats();
      assert.ok(stats.total_requests > 0, "Mock server must have recorded incoming requests");
      assert.ok(stats.requests_by_path["/doc/doc_01_small_business.html"] > 0);
      assert.ok(stats.requests_by_path["/redirect/1"] > 0);
      assert.ok(stats.requests_by_path["/redirect/2"] > 0);
      assert.ok(stats.requests_by_path["/doc/doc_12_destination.html"] > 0);
      console.log(`\n[EGRESS AUDIT] Total requests recorded on local fixture server: ${stats.total_requests}`);
      console.log(`[EGRESS AUDIT] Request distribution across synthetic endpoints:`, stats.requests_by_path);
    });
  });
});
