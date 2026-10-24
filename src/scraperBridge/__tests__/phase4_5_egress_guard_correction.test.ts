import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalAddress,
  assertLocalEnrichmentUrl,
  IsolationBreachError,
  enforceLocalSyntheticEnv,
  assertLocalIsolation,
} from "../isolationGuard.js";
import { runEngineEnrich } from "../pythonBridge.js";

describe("MAST Phase 4.5 — Destination Allowlist & Egress Guard Correction Suite", { concurrency: 1 }, () => {
  test.before(() => {
    enforceLocalSyntheticEnv();
    assertLocalIsolation();
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    process.env.ENFORCE_LOCAL_ISOLATION = "true";
  });

  test.after(() => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    delete process.env.ENFORCE_LOCAL_ISOLATION;
  });

  describe("1. Strict Destination Allowlist & 0.0.0.0 Rejection", () => {
    test("isLocalAddress strictly rejects 0.0.0.0 and :: (unspecified addresses)", () => {
      assert.equal(isLocalAddress("http://0.0.0.0:8000"), false, "0.0.0.0 must be rejected");
      assert.equal(isLocalAddress("http://0.0.0.0:80/index.html"), false, "0.0.0.0 with path must be rejected");
      assert.equal(isLocalAddress("https://0.0.0.0/api"), false, "https://0.0.0.0 must be rejected");
      assert.equal(isLocalAddress("http://[::]:8000"), false, "[::] must be rejected");
    });

    test("assertLocalEnrichmentUrl throws IsolationBreachError for 0.0.0.0 and ::", () => {
      assert.throws(
        () => assertLocalEnrichmentUrl("http://0.0.0.0:8080/test"),
        IsolationBreachError,
        "Must reject 0.0.0.0",
      );
      assert.throws(
        () => assertLocalEnrichmentUrl("http://[::]:8080/test"),
        IsolationBreachError,
        "Must reject ::",
      );
    });

    test("runEngineEnrich rejects 0.0.0.0 website and instagram targets before dispatch", async () => {
      await assert.rejects(
        runEngineEnrich({ website: "http://0.0.0.0:8000/doc.html" }),
        (err: any) => {
          assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
          return true;
        },
        "Must reject 0.0.0.0 website",
      );

      await assert.rejects(
        runEngineEnrich({
          website: "http://127.0.0.1:8765/doc.html",
          instagram: "http://0.0.0.0:8000/profile",
        }),
        (err: any) => {
          assert.ok(err instanceof IsolationBreachError || /prohibited|local loopback/i.test(err.message));
          return true;
        },
        "Must reject 0.0.0.0 instagram",
      );
    });

    test("isLocalAddress accepts legitimate IPv4 loopback (127.0.0.0/8), IPv6 loopback (::1), and localhost", () => {
      // Localhost
      assert.equal(isLocalAddress("http://localhost:3000/api"), true);
      assert.equal(isLocalAddress("https://localhost:8080/path"), true);
      assert.equal(isLocalAddress("http://localhost.:3000/api"), true);

      // IPv4 Loopback range 127.0.0.0/8
      assert.equal(isLocalAddress("http://127.0.0.1:8000/doc"), true);
      assert.equal(isLocalAddress("http://127.0.0.2:8000/doc"), true);
      assert.equal(isLocalAddress("http://127.1.2.3:8080"), true);
      assert.equal(isLocalAddress("http://127.100.200.50:9000"), true);
      assert.equal(isLocalAddress("http://127.255.255.254:8080"), true);
      assert.equal(isLocalAddress("http://127.255.255.255:8080"), true);

      // IPv6 Loopback ::1
      assert.equal(isLocalAddress("http://[::1]:8765/stats"), true);
      assert.equal(isLocalAddress("https://[::1]:443/secure"), true);
    });

    test("isLocalAddress rejects external IPs, domains, and obfuscated hostnames", () => {
      // External IPs
      assert.equal(isLocalAddress("http://8.8.8.8:53"), false);
      assert.equal(isLocalAddress("http://192.168.1.1:80"), false);
      assert.equal(isLocalAddress("http://10.0.0.1:8080"), false);
      assert.equal(isLocalAddress("http://126.0.0.1:8080"), false);
      assert.equal(isLocalAddress("http://128.0.0.1:8080"), false);
      assert.equal(isLocalAddress("http://127.00.0.1:8080"), false);
      assert.equal(isLocalAddress("http://127.0.0.256:8080"), false);

      // Public domains
      assert.equal(isLocalAddress("https://example.com"), false);
      assert.equal(isLocalAddress("http://google.com"), false);
      assert.equal(isLocalAddress("https://xyz.supabase.co"), false);

      // Obfuscated / spoofed loopback strings
      assert.equal(isLocalAddress("http://localhost.evil.com"), false);
      assert.equal(isLocalAddress("http://127.0.0.1.nip.io"), false);
      assert.equal(isLocalAddress("http://%31%32%37.0.0.1:8080"), false);
      assert.equal(isLocalAddress("http://%6c%6f%63%61%6c%68%6f%73%74"), false);

      // Unsupported schemes
      assert.equal(isLocalAddress("ftp://127.0.0.1:21/file"), false);
      assert.equal(isLocalAddress("file:///etc/passwd"), false);
      assert.equal(isLocalAddress("javascript:alert(1)"), false);
    });
  });
});
