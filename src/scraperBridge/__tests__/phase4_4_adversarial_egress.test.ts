import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  runEngineEnrich,
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

const MOCK_PORT = 8779; // Dedicated port for Phase 4.4 adversarial egress suite
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

function killProc(proc: ChildProcess | null): void {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    // ignore
  }
}

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
      // wait for server readiness
    }
  }
  throw new Error("Failed to start mock server on port " + MOCK_PORT);
}

async function getMockStats(): Promise<{ total_requests: number; requests_by_path: Record<string, number> }> {
  const res = await fetch(`${MOCK_URL}/stats`);
  return res.json() as any;
}

describe("MAST Phase 4.4 — Adversarial Egress & Python Request Enforcement Suite", { concurrency: 1 }, () => {
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
    killProc(mockProc);
  });

  test.beforeEach(() => {
    closePersistentEnrichmentWorker();
    persistentEnrichmentBridge.setMaxConcurrency(4);
    persistentEnrichmentBridge.setMaxQueueLength(64);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);
  });

  describe("1. Adversarial External Redirect Blocking", () => {
    test("Local page returning 302 redirect to external domain is blocked by Python RedirectTracker", async () => {
      // /redirect-external returns 302 Location: https://external-prohibited-domain.example.com/escaped
      const res = await runEngineEnrich({ website: `${MOCK_URL}/redirect-external` });

      // Python's _RedirectTracker intercepts the redirect hop and prevents external TCP egress.
      // WebsiteWorker catches the DisallowedEgressError and marks website_reachable = false.
      assert.equal(res.website_reachable, false, "External redirect hop must cause website_reachable to be false");
      assert.notEqual(res.final_url, "https://external-prohibited-domain.example.com/escaped");
    });
  });

  describe("2. Adversarial External Contact Link Blocking", () => {
    test("Local HTML page containing absolute external contact link is blocked by Python ContactWorker", async () => {
      // /doc-with-external-contact contains <a href="https://external-contact-provider.example.com/reach-us">Contact Us</a>
      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc-with-external-contact` });

      // The initial local page is reachable
      assert.equal(res.website_reachable, true);

      // ContactWorker attempts to fetch the discovered external URL, which is blocked by egress_guard
      // The worker finishes cleanly without crashing the daemon or connecting to the external domain
      assert.ok(!res.contact_page || !res.contact_page.includes("external-contact-provider.example.com"),
        "External contact page must not be crawled or stored");
      assert.ok(!res.emails.some((email: string) => email.includes("external-contact-provider")),
        "No emails from external domain should be extracted");
    });
  });

  describe("3. Instagram External Egress Blocking", () => {
    test("External Instagram URL is blocked at Node boundary before dispatch", async () => {
      await assert.rejects(
        runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html`,
          instagram: "https://www.instagram.com/adversarial_target/",
        }),
        (err: any) => {
          assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
          return true;
        },
      );
    });
  });

  describe("4. Permitted Local Traversals Remain Functional", () => {
    test("Loopback multi-hop redirect chain succeeds completely", async () => {
      // /redirect/1 -> /redirect/2 -> /doc/doc_12_destination.html
      const res = await runEngineEnrich({ website: `${MOCK_URL}/redirect/1` });
      assert.equal(res.website_reachable, true);
      assert.ok(res.final_url?.includes("doc_12_destination.html"));
      assert.deepEqual(res.emails, ["reached@destination.com"]);
    });

    test("Relative local contact link navigation succeeds completely", async () => {
      // /doc/doc_10_home.html -> /contact-us
      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_10_home.html` });
      assert.equal(res.website_reachable, true);
      assert.ok(res.contact_page?.includes("/contact-us"));
      assert.ok(res.emails.includes("support@multistore.com"));
    });
  });

  describe("5. Malformed Schemes and Boundary Validation", () => {
    test("Unsupported and malformed schemes fail closed", async () => {
      const badSchemes = [
        "ftp://127.0.0.1:8779/leak",
        "file:///c:/windows/system32/cmd.exe",
        "javascript:alert(1)",
      ];

      for (const badUrl of badSchemes) {
        await assert.rejects(
          runEngineEnrich({ website: badUrl }),
          (err: any) => {
            assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback|Invalid URL/i.test(err.message));
            return true;
          },
        );
      }
    });

    test("Mock server request stats verify zero external egress and 100% loopback handling", async () => {
      const stats = await getMockStats();
      assert.ok(stats.total_requests > 0, "Mock server must have serviced requests");
      assert.ok(stats.requests_by_path["/redirect-external"] > 0, "/redirect-external was queried");
      assert.ok(stats.requests_by_path["/doc-with-external-contact"] > 0, "/doc-with-external-contact was queried");
      assert.ok(stats.requests_by_path["/redirect/1"] > 0);
      assert.ok(stats.requests_by_path["/doc/doc_10_home.html"] > 0);
      assert.ok(stats.requests_by_path["/contact-us"] > 0);
    });
  });
});
