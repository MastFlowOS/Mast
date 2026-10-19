import { isTauri, invoke } from "@tauri-apps/api/core";

export interface DesktopInfo {
  is_desktop: boolean;
  platform: string;
  arch: string;
  version: string;
}

export interface DesktopWorkerStatus {
  is_running: boolean;
  status: "stopped" | "starting" | "running" | "error";
  pid?: number;
  last_error?: string;
  recent_logs: string[];
}

/**
 * Returns true if the frontend is currently running inside the Tauri Windows application shell.
 * Returns false when running in a web browser, mobile browser, or SSR environment.
 * 
 * Supports Tauri v2 native architecture by inspecting window.__TAURI_INTERNALS__ (the IPC
 * bridge Tauri v2 injects into all webviews) without requiring broad global exposure (withGlobalTauri).
 * Also recognizes custom desktop schemes (tauri.localhost / tauri://) and standard globals.
 */
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") {
    // In SSR, test, or Node environments, check globalThis fallback flags
    const g = globalThis as Record<string, unknown> | undefined;
    if (g && (Boolean(g.isTauri) || typeof g.__TAURI_INTERNALS__ !== "undefined" || typeof g.__TAURI__ !== "undefined")) {
      return true;
    }
    return false;
  }

  try {
    const win = window as any;

    // 1. Primary Tauri v2 detection: __TAURI_INTERNALS__ is injected into window
    // in all Tauri v2 webviews (used internally by @tauri-apps/api/core invoke).
    if (typeof win.__TAURI_INTERNALS__ !== "undefined" && win.__TAURI_INTERNALS__ !== null) {
      return true;
    }

    // 2. Standard withGlobalTauri / isTauri flag
    if (typeof win.isTauri !== "undefined" && Boolean(win.isTauri)) {
      return true;
    }

    // 3. Global Tauri namespace (window.__TAURI__)
    if (typeof win.__TAURI__ !== "undefined" && win.__TAURI__ !== null) {
      return true;
    }

    // 4. Packaged desktop URL scheme (tauri.localhost on Windows WebView2, or tauri://)
    if (typeof win.location !== "undefined" && win.location) {
      const origin = typeof win.location.origin === "string" ? win.location.origin : "";
      const protocol = typeof win.location.protocol === "string" ? win.location.protocol : "";
      if (origin.includes("tauri.localhost") || protocol === "tauri:") {
        return true;
      }
    }

    // 5. Fallback check to @tauri-apps/api/core isTauri()
    if (typeof isTauri === "function" && isTauri()) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Retrieves platform and version metadata from the desktop host.
 * Returns null if running in web browser.
 */
export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<DesktopInfo>("get_desktop_info");
  } catch (error) {
    console.error("Failed to fetch desktop info:", error);
    return null;
  }
}

/**
 * Queries the current lifecycle status of the local discovery engine worker.
 */
export async function getDesktopWorkerStatus(): Promise<DesktopWorkerStatus> {
  if (!isDesktopApp()) {
    return {
      is_running: false,
      status: "stopped",
      recent_logs: [],
    };
  }
  try {
    return await invoke<DesktopWorkerStatus>("get_worker_status");
  } catch (error) {
    return {
      is_running: false,
      status: "error",
      last_error: error instanceof Error ? error.message : String(error),
      recent_logs: [],
    };
  }
}

/**
 * Starts the packaged Python discovery worker child process via the secure Tauri host.
 * The authentication token is handed off via environment variables to prevent leaking
 * into command line arguments, and access tokens are never logged.
 */
export async function startDesktopWorker(params: {
  apiUrl?: string;
  authToken: string;
}): Promise<DesktopWorkerStatus> {
  if (!isDesktopApp()) {
    throw new Error("Cannot start desktop worker in a web browser environment");
  }
  if (!params.authToken || !params.authToken.trim()) {
    throw new Error("A valid user JWT authentication token is required to start the desktop worker.");
  }
  const apiUrl = params.apiUrl?.trim();
  if (!apiUrl) {
    throw new Error("MAST API base URL is not configured. A valid coordination API URL is required to start the desktop worker.");
  }
  return await invoke<DesktopWorkerStatus>("start_worker", {
    apiUrl,
    authToken: params.authToken.trim(),
  });
}

/**
 * Stops the managed discovery worker child process cleanly.
 */
export async function stopDesktopWorker(): Promise<DesktopWorkerStatus> {
  if (!isDesktopApp()) {
    return {
      is_running: false,
      status: "stopped",
      recent_logs: [],
    };
  }
  return await invoke<DesktopWorkerStatus>("stop_worker");
}

/**
 * Propagates an updated/refreshed user authentication token to the desktop worker host.
 * Safely writes to the user-scoped secure token store so active and future discovery
 * tasks pick up the refreshed credentials without terminating running processes.
 */
export async function updateDesktopWorkerToken(authToken: string): Promise<void> {
  if (!isDesktopApp()) return;
  if (!authToken || !authToken.trim()) return;
  try {
    await invoke("update_worker_token", { authToken: authToken.trim() });
  } catch (error) {
    console.warn("Failed to propagate refreshed auth token to desktop host:", error);
  }
}

/**
 * Sets or clears the active discovery plan ID in the desktop host.
 * The local Python worker uses this to target tasks for the user's active search.
 */
export async function setActiveDesktopPlan(planId: string | null): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    await invoke("set_active_plan", { planId: planId?.trim() || null });
  } catch (error) {
    console.warn("Failed to set active discovery plan in desktop host:", error);
  }
}
