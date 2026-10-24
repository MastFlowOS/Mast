import net from "node:net";

/**
 * MAST Phase 4.1 / 4.2 — Hard Isolation Boundary Guard
 *
 * Enforces a fail-closed boundary ensuring that local test harnesses and workers
 * never connect to production databases, live Supabase projects, Railway deployments,
 * or live third-party APIs.
 */

const PRODUCTION_HOST_PATTERNS = [
  "supabase.co",
  "supabase.com",
  "pooler.supabase.com",
  "railway.app",
  "up.railway.app",
  "replit.app",
  "api.openai.com",
  "api.anthropic.com",
];

export class IsolationBreachError extends Error {
  readonly code = "ISOLATION_BREACH";
  constructor(message: string) {
    super(`[ISOLATION BREACH] ${message}`);
    this.name = "IsolationBreachError";
  }
}

/**
 * Checks whether a given URL points to a remote/production domain.
 */
export function isRemoteOrProductionHost(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  for (const pattern of PRODUCTION_HOST_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

/**
 * Asserts that the current process environment is strictly isolated from production.
 * Throws IsolationBreachError if any environment variable points to a remote/production host.
 */
export function assertLocalIsolation(): void {
  const dbUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const viteSupabaseUrl = process.env.VITE_SUPABASE_URL;
  const apiBaseUrl = process.env.VITE_API_BASE_URL;

  if (isRemoteOrProductionHost(dbUrl)) {
    throw new IsolationBreachError(
      "DATABASE_URL points to a production or remote host. Refusing to run tests against live data."
    );
  }

  if (isRemoteOrProductionHost(supabaseUrl)) {
    throw new IsolationBreachError(
      "SUPABASE_URL points to a production Supabase project. Refusing to run tests against live data."
    );
  }

  if (isRemoteOrProductionHost(viteSupabaseUrl)) {
    throw new IsolationBreachError(
      "VITE_SUPABASE_URL points to a production Supabase project. Refusing to run tests against live data."
    );
  }

  if (isRemoteOrProductionHost(apiBaseUrl)) {
    throw new IsolationBreachError(
      "VITE_API_BASE_URL points to a production Railway deployment. Refusing to run tests against live deployment."
    );
  }

  // Ensure mock / local URLs only
  const isLocalOrMock = (u?: string) =>
    !u || u.includes("localhost") || u.includes("127.0.0.1") || u.includes("mock") || u.startsWith("postgres://postgres:postgres@localhost");

  if (dbUrl && !isLocalOrMock(dbUrl)) {
    throw new IsolationBreachError(`DATABASE_URL must be local/mock, got unrecognized host.`);
  }

  if (supabaseUrl && !isLocalOrMock(supabaseUrl)) {
    throw new IsolationBreachError(`SUPABASE_URL must be local/mock, got unrecognized host.`);
  }
}

/**
 * Enforces safe synthetic environment variables for local testing,
 * scrubbing any inherited production URLs before test execution.
 */
export function enforceLocalSyntheticEnv(): void {
  process.env.DATABASE_URL = "postgres://postgres:local_synthetic_pass@localhost:5433/mast_synthetic_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-local-service-role-key-test-only";
  process.env.SUPABASE_JWT_SECRET = "synthetic-local-jwt-secret-test-only";
  process.env.VITE_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.VITE_SUPABASE_ANON_KEY = "synthetic-local-anon-key-test-only";
  process.env.VITE_API_BASE_URL = "http://127.0.0.1:8080";
  process.env.ALLOWED_ORIGIN = "http://127.0.0.1:3000";

  // Re-verify after applying
  assertLocalIsolation();
}

/**
 * Validates that an enrichment target URL strictly points to a local address (loopback / 127.0.0.1 / localhost).
 * Prevents local tests or workers from accidentally issuing outbound network fetches to real websites.
 */
export function isLocalAddress(url?: string): boolean {
  if (!url) return true;
  try {
    // Reject percent-encoded host/authority components before WHATWG parser decodes them
    const rawHost = url.split("://")[1]?.split("/")[0]?.split("?")[0]?.split("#")[0];
    if (rawHost) {
      if (rawHost.includes("%")) {
        return false;
      }
      // Reject ambiguous leading zeros in IPv4 octets (consistent with Python ipaddress rejection)
      const hostWithoutPort = rawHost.replace(/:\d+$/, "");
      if (/(^|\.)0\d/.test(hostWithoutPort)) {
        return false;
      }
    }

    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostname || hostname.includes("%")) {
      return false;
    }
    // Reject unspecified address (0.0.0.0 or ::) - not loopback
    if (hostname === "0.0.0.0" || hostname === "::") {
      return false;
    }
    if (hostname === "localhost" || hostname === "::1") {
      return true;
    }
    // Strictly match IPv4 loopback (127.0.0.0/8)
    const ipv4Match = /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(hostname);
    return ipv4Match;
  } catch {
    return false;
  }
}

export function assertLocalEnrichmentUrl(url?: string): void {
  if (!url) return;
  if (isRemoteOrProductionHost(url)) {
    throw new IsolationBreachError(
      `Enrichment target URL "${url}" matches prohibited production/remote host pattern.`
    );
  }
  if (!isLocalAddress(url)) {
    throw new IsolationBreachError(
      `Enrichment target URL "${url}" is not a local loopback address in isolated test mode.`
    );
  }
}

/**
 * Returns a sanitized copy of the process environment for child process spawning,
 * ensuring no production secrets or remote hosts leak into subprocesses.
 */
export function getSanitizedSubprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: "postgres://postgres:local_synthetic_pass@localhost:5433/mast_synthetic_test",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-service-role-key-test-only",
    SUPABASE_JWT_SECRET: "synthetic-local-jwt-secret-test-only",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
    VITE_SUPABASE_ANON_KEY: "synthetic-local-anon-key-test-only",
    VITE_API_BASE_URL: "http://127.0.0.1:8080",
    ALLOWED_ORIGIN: "http://127.0.0.1:3000",
  };
}

let originalSocketConnect: any = null;

/**
 * Installs active Node-level socket interception to fail-closed if any code
 * attempts to establish a TCP/TLS connection to prohibited production domains.
 */
export function installNodeNetworkIsolationGuard(): void {
  if (originalSocketConnect) return;
  originalSocketConnect = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const opts = Array.isArray(args[0]) ? args[0][0] : typeof args[0] === "object" && args[0] !== null ? args[0] : null;
    const host = opts?.host || (typeof args[1] === "string" ? args[1] : undefined);

    if (host && isRemoteOrProductionHost(host)) {
      const err = new IsolationBreachError(
        `Outbound socket connection to production host "${host}" blocked by network isolation guard.`
      );
      process.nextTick(() => {
        this.emit("error", err);
        this.destroy(err);
      });
      return this;
    }

    return originalSocketConnect.apply(this, args);
  };
}

/**
 * Restores the original Socket.prototype.connect method.
 */
export function uninstallNodeNetworkIsolationGuard(): void {
  if (originalSocketConnect) {
    net.Socket.prototype.connect = originalSocketConnect;
    originalSocketConnect = null;
  }
}

export function isNetworkIsolationInstalled(): boolean {
  return originalSocketConnect !== null;
}
