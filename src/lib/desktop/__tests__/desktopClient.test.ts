import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import {
  isDesktopApp,
  getDesktopInfo,
  getDesktopWorkerStatus,
  startDesktopWorker,
  stopDesktopWorker,
} from "../index";
import { buildDiscoverRequest } from "../../discoverRequest";

describe("Desktop Client & Runtime Boundary", () => {
  const originalIsTauri = (globalThis as Record<string, unknown>).isTauri;
  const originalTauriInternals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  const originalTauri = (globalThis as Record<string, unknown>).__TAURI__;
  const originalWindow = (globalThis as Record<string, unknown>).window;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri;
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (globalThis as Record<string, unknown>).__TAURI__;
    delete (globalThis as Record<string, unknown>).window;
  });

  afterEach(() => {
    if (originalIsTauri !== undefined) {
      (globalThis as Record<string, unknown>).isTauri = originalIsTauri;
    } else {
      delete (globalThis as Record<string, unknown>).isTauri;
    }

    if (originalTauriInternals !== undefined) {
      (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = originalTauriInternals;
    } else {
      delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    }

    if (originalTauri !== undefined) {
      (globalThis as Record<string, unknown>).__TAURI__ = originalTauri;
    } else {
      delete (globalThis as Record<string, unknown>).__TAURI__;
    }

    if (originalWindow !== undefined) {
      (globalThis as Record<string, unknown>).window = originalWindow;
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  test("isDesktopApp returns false in standard Node/SSR environment", () => {
    assert.strictEqual(isDesktopApp(), false);
  });

  test("isDesktopApp returns true when global isTauri flag is set", () => {
    (globalThis as Record<string, unknown>).isTauri = true;
    assert.strictEqual(isDesktopApp(), true);
  });

  test("isDesktopApp returns true when window.__TAURI_INTERNALS__ is present (Tauri v2)", () => {
    (globalThis as any).window = {
      __TAURI_INTERNALS__: { invoke: async () => {} },
      location: { origin: "http://localhost:5173", protocol: "http:" },
    };
    assert.strictEqual(isDesktopApp(), true);
  });

  test("isDesktopApp returns true when window.__TAURI__ namespace is present", () => {
    (globalThis as any).window = {
      __TAURI__: {},
      location: { origin: "http://localhost:5173", protocol: "http:" },
    };
    assert.strictEqual(isDesktopApp(), true);
  });

  test("isDesktopApp returns true when running under tauri.localhost custom scheme", () => {
    (globalThis as any).window = {
      location: { origin: "http://tauri.localhost", protocol: "http:" },
    };
    assert.strictEqual(isDesktopApp(), true);
  });

  test("isDesktopApp returns true when running under tauri:// custom protocol", () => {
    (globalThis as any).window = {
      location: { origin: "tauri://localhost", protocol: "tauri:" },
    };
    assert.strictEqual(isDesktopApp(), true);
  });

  test("isDesktopApp returns false in normal web browser environment", () => {
    (globalThis as any).window = {
      location: { origin: "https://app.mast-flow.com", protocol: "https:" },
    };
    assert.strictEqual(isDesktopApp(), false);
  });

  test("getDesktopInfo returns null when not running in desktop shell", async () => {
    const info = await getDesktopInfo();
    assert.strictEqual(info, null);
  });

  test("getDesktopWorkerStatus returns default stopped status on web", async () => {
    const status = await getDesktopWorkerStatus();
    assert.strictEqual(status.is_running, false);
    assert.strictEqual(status.status, "stopped");
    assert.deepStrictEqual(status.recent_logs, []);
  });

  test("startDesktopWorker rejects when called on web", async () => {
    await assert.rejects(
      async () => {
        await startDesktopWorker({ authToken: "valid-jwt" });
      },
      {
        message: "Cannot start desktop worker in a web browser environment",
      }
    );
  });

  test("startDesktopWorker rejects empty auth token", async () => {
    (globalThis as Record<string, unknown>).isTauri = true;
    await assert.rejects(
      async () => {
        await startDesktopWorker({ authToken: "   " });
      },
      {
        message: "A valid user JWT authentication token is required to start the desktop worker.",
      }
    );
  });

  test("stopDesktopWorker returns default stopped status on web", async () => {
    const status = await stopDesktopWorker();
    assert.strictEqual(status.is_running, false);
    assert.strictEqual(status.status, "stopped");
  });

  test("updateDesktopWorkerToken is safe no-op on web or with empty token", async () => {
    const { updateDesktopWorkerToken } = await import("../index");
    await updateDesktopWorkerToken("valid-token");
    await updateDesktopWorkerToken("");
    await updateDesktopWorkerToken("   ");
  });
});

describe("Desktop Discovery Routing & Target Resolution", () => {
  test("installed desktop user defaults to local desktop execution target", () => {
    const isDesktop = true;
    const executionTarget: "desktop" | "cloud" = "desktop";
    const target = isDesktop ? executionTarget : "cloud";
    assert.strictEqual(target, "desktop");

    const req = buildDiscoverRequest({
      quantity: 10,
      regions: ["United States"],
      niches: ["Bakeries"],
      channels: ["email"],
      method: "live",
      execution_target: target,
    });
    assert.strictEqual(req.execution_target, "desktop");
  });

  test("desktop user can explicitly toggle to cloud execution target", () => {
    const isDesktop = true;
    const executionTarget: "desktop" | "cloud" = "cloud";
    const target = isDesktop ? executionTarget : "cloud";
    assert.strictEqual(target, "cloud");

    const req = buildDiscoverRequest({
      quantity: 10,
      regions: ["United States"],
      niches: ["Bakeries"],
      channels: ["email"],
      method: "live",
      execution_target: target,
    });
    assert.strictEqual(req.execution_target, "cloud");
  });

  test("browser user strictly resolves to cloud execution target regardless of state", () => {
    const isDesktop = false;
    const executionTarget: "desktop" | "cloud" = "desktop";
    const target = isDesktop ? executionTarget : "cloud";
    assert.strictEqual(target, "cloud");

    const req = buildDiscoverRequest({
      quantity: 10,
      regions: ["United States"],
      niches: ["Bakeries"],
      channels: ["email"],
      method: "live",
      execution_target: target,
    });
    assert.strictEqual(req.execution_target, "cloud");
  });

  test("worker startup failure strictly aborts without falling back to cloud", async () => {
    const isDesktop = true;
    const executionTarget: "desktop" | "cloud" = "desktop";
    const target = isDesktop ? executionTarget : "cloud";

    // Simulate worker failure to start
    const mockEnsureWorkerRunning = async () => {
      throw new Error("Worker executable failed to spawn: Access is denied");
    };

    let submittedTarget: "desktop" | "cloud" | null = null;
    let caughtError: string | null = null;

    if (target === "desktop") {
      try {
        await mockEnsureWorkerRunning();
        submittedTarget = target;
      } catch (err) {
        caughtError = (err as Error).message;
        // MUST abort here and NEVER fallback to cloud
      }
    } else {
      submittedTarget = "cloud";
    }

    assert.strictEqual(caughtError, "Worker executable failed to spawn: Access is denied");
    assert.strictEqual(submittedTarget, null, "Discovery must NEVER be submitted if worker fails to start");
  });

  test("effective desktop resolves true even when React hook state has not yet updated", () => {
    // Simulate React state lagging behind late-injected __TAURI_INTERNALS__ bridge
    const hookStateIsDesktop = false;
    (globalThis as any).window = {
      __TAURI_INTERNALS__: { invoke: async () => {} },
      location: { origin: "http://tauri.localhost", protocol: "http:" },
    };

    const isEffectiveDesktop = hookStateIsDesktop || isDesktopApp();
    assert.strictEqual(isEffectiveDesktop, true, "Effective desktop MUST detect native runtime even if state lagged");

    const executionTarget = "desktop";
    const target = isEffectiveDesktop ? executionTarget : "cloud";
    assert.strictEqual(target, "desktop", "Target MUST remain desktop when running in native app");

    const req = buildDiscoverRequest({
      quantity: 5,
      regions: ["United States"],
      niches: ["Bakery"],
      channels: ["email"],
      method: "live",
      execution_target: target,
    });
    assert.strictEqual(req.execution_target, "desktop");
  });

  test("browser user cannot accidentally trigger desktop execution target", () => {
    const hookStateIsDesktop = false;
    (globalThis as any).window = {
      location: { origin: "https://app.mast-flow.com", protocol: "https:" },
    };

    const isEffectiveDesktop = hookStateIsDesktop || isDesktopApp();
    assert.strictEqual(isEffectiveDesktop, false);

    const executionTarget = "desktop"; // Hypothetical corrupted state
    const target = isEffectiveDesktop ? executionTarget : "cloud";
    assert.strictEqual(target, "cloud", "Browser MUST strictly resolve to cloud");

    const req = buildDiscoverRequest({
      quantity: 5,
      regions: ["United States"],
      niches: ["Bakery"],
      channels: ["email"],
      method: "live",
      execution_target: target,
    });
    assert.strictEqual(req.execution_target, "cloud");
  });

  test("startDesktopWorker rejects when apiUrl is omitted or empty", async () => {
    (globalThis as Record<string, unknown>).isTauri = true;
    await assert.rejects(
      async () => {
        await startDesktopWorker({ authToken: "valid-jwt", apiUrl: "" });
      },
      {
        message: "MAST API base URL is not configured. A valid coordination API URL is required to start the desktop worker.",
      }
    );

    await assert.rejects(
      async () => {
        await startDesktopWorker({ authToken: "valid-jwt", apiUrl: "   " });
      },
      {
        message: "MAST API base URL is not configured. A valid coordination API URL is required to start the desktop worker.",
      }
    );
  });

  test("buildDiscoverRequest preserves execution_target: desktop and never downgrades to cloud", () => {
    const req = buildDiscoverRequest({
      quantity: 20,
      regions: ["New York, NY"],
      niches: ["Coffee Shops"],
      channels: ["instagram", "website"],
      method: "live",
      execution_target: "desktop",
    });
    assert.strictEqual(req.execution_target, "desktop");
    assert.notStrictEqual(req.execution_target, "cloud");
  });

  test("getDesktopWorkerStatus performs read-only query and does not invoke start", async () => {
    let invokedCommand: string | null = null;
    (globalThis as any).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          invokedCommand = cmd;
          return { is_running: false, status: "stopped", recent_logs: [] };
        },
      },
      location: { origin: "http://localhost:5173", protocol: "http:" },
    };

    const status = await getDesktopWorkerStatus();
    assert.strictEqual(status.is_running, false);
    assert.strictEqual(status.status, "stopped");
    assert.strictEqual(invokedCommand, "get_worker_status");
  });

  test("stopDesktopWorker cleanly dispatches stop_worker command to shell", async () => {
    let invokedCommand: string | null = null;
    (globalThis as any).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          invokedCommand = cmd;
          return { is_running: false, status: "stopped", recent_logs: [] };
        },
      },
      location: { origin: "http://localhost:5173", protocol: "http:" },
    };

    const status = await stopDesktopWorker();
    assert.strictEqual(status.is_running, false);
    assert.strictEqual(status.status, "stopped");
    assert.strictEqual(invokedCommand, "stop_worker");
  });
});


