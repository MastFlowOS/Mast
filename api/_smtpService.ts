/**
 * SMTP settings service: validation, persistence rules, connection-test status.
 * Storage is injected (SmtpStore) so the rules are unit-testable without a DB.
 * Nothing here ever returns, logs, or throws a plaintext password.
 */
import {
  SMTP_KEY_ENV_VAR,
  SmtpCryptoError,
  decryptSmtpSecret,
  encryptSmtpSecret,
  isSmtpKeyConfigured,
  loadSmtpKey,
} from "./_smtpCrypto.js";

export type SmtpTestStatus = "success" | "failed";

/** Database row. password_ciphertext must never leave the server. */
export interface SmtpRow {
  user_id: string;
  host: string;
  port: number;
  username: string;
  encryption: string;
  password_ciphertext: string;
  /** Incremented whenever a connection-relevant field changes. */
  config_version: number;
  last_test_status: SmtpTestStatus | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  updated_at: string;
}

export interface SmtpStore {
  get(userId: string): Promise<SmtpRow | null>;
  /** Insert or fully replace the user's row. */
  put(row: SmtpRow): Promise<void>;
  /**
   * Update test-result columns only if config_version still equals
   * `expectVersion`. Returns false when the config changed in the meantime.
   */
  recordTest(
    userId: string,
    expectVersion: number,
    result: { status: SmtpTestStatus; testedAt: string; error: string | null },
  ): Promise<boolean>;
  delete(userId: string): Promise<void>;
}

export type SmtpUiStatus = "not_configured" | "untested" | "connected" | "failed";

/** The only SMTP shape the frontend ever receives. */
export interface PublicSmtpSettings {
  configured: boolean;
  host: string;
  port: string;
  username: string;
  encryption: string;
  hasPassword: boolean;
  status: SmtpUiStatus;
  lastTestedAt: string | null;
  lastTestError: string | null;
  updatedAt: string | null;
  encryptionConfigured: boolean;
}

export class SmtpServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SmtpServiceError";
    this.status = status;
    this.code = code;
  }
}

const ENCRYPTIONS = new Set(["None", "TLS", "SSL"]);

export function toPublicSmtp(
  row: SmtpRow | null,
  encryptionConfigured: boolean,
): PublicSmtpSettings {
  if (!row) {
    return {
      configured: false,
      host: "",
      port: "",
      username: "",
      encryption: "None",
      hasPassword: false,
      status: "not_configured",
      lastTestedAt: null,
      lastTestError: null,
      updatedAt: null,
      encryptionConfigured,
    };
  }
  // "connected" only ever reflects a stored, successful test of THIS config
  // version (changes clear the result), never a default or an assumption.
  const status: SmtpUiStatus =
    row.last_test_status === "success"
      ? "connected"
      : row.last_test_status === "failed"
        ? "failed"
        : "untested";
  return {
    configured: true,
    host: row.host,
    port: String(row.port),
    username: row.username,
    encryption: row.encryption,
    hasPassword: Boolean(row.password_ciphertext),
    status,
    lastTestedAt: row.last_tested_at,
    lastTestError: status === "failed" ? row.last_test_error : null,
    updatedAt: row.updated_at,
    encryptionConfigured,
  };
}

export interface SaveSmtpInput {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  encryption?: unknown;
  /** Optional on update: omitted/empty keeps the stored password. */
  password?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function toSmtpServiceError(err: unknown): SmtpServiceError {
  if (err instanceof SmtpServiceError) return err;
  if (err instanceof SmtpCryptoError) {
    const status = err.code === "smtp_decrypt_failed" ? 409 : 503;
    return new SmtpServiceError(status, err.code, err.message);
  }
  return new SmtpServiceError(500, "smtp_internal_error", "Unexpected SMTP settings error.");
}

export async function getSmtpSettings(store: SmtpStore, userId: string, env = process.env) {
  const row = await store.get(userId);
  return toPublicSmtp(row, isSmtpKeyConfigured(env));
}

export async function saveSmtpSettings(
  store: SmtpStore,
  userId: string,
  input: SaveSmtpInput,
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<PublicSmtpSettings> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  try {
    // Fail safely and clearly before touching any data.
    const key = loadSmtpKey(env);

    const host = str(input.host);
    const username = str(input.username);
    const encryption = str(input.encryption) || "None";
    const portNum = Number(str(input.port));
    const password = typeof input.password === "string" ? input.password : "";

    if (!host || !username) {
      throw new SmtpServiceError(400, "smtp_invalid", "SMTP host and username are required.");
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new SmtpServiceError(
        400,
        "smtp_invalid",
        "SMTP port must be a number between 1 and 65535.",
      );
    }
    if (!ENCRYPTIONS.has(encryption)) {
      throw new SmtpServiceError(400, "smtp_invalid", "SMTP encryption must be None, TLS, or SSL.");
    }

    const existing = await store.get(userId);
    if (!existing && !password) {
      throw new SmtpServiceError(400, "smtp_invalid", "An SMTP password is required.");
    }

    let ciphertext = existing?.password_ciphertext ?? "";
    let passwordChanged = false;
    if (password) {
      if (existing) {
        try {
          passwordChanged =
            decryptSmtpSecret(existing.password_ciphertext, userId, key) !== password;
        } catch {
          passwordChanged = true; // unreadable stored value: replace it
        }
      } else {
        passwordChanged = true;
      }
      if (passwordChanged) ciphertext = encryptSmtpSecret(password, userId, key);
    }

    const connectionChanged =
      !existing ||
      passwordChanged ||
      existing.host !== host ||
      existing.port !== portNum ||
      existing.username !== username ||
      existing.encryption !== encryption;

    if (existing && !connectionChanged) {
      return toPublicSmtp(existing, true); // nothing connection-relevant changed: keep the test result
    }

    const row: SmtpRow = {
      user_id: userId,
      host,
      port: portNum,
      username,
      encryption,
      password_ciphertext: ciphertext,
      config_version: (existing?.config_version ?? 0) + 1,
      // Invalidate the previous test: the new configuration has not been tested.
      last_test_status: null,
      last_tested_at: null,
      last_test_error: null,
      updated_at: now().toISOString(),
    };
    await store.put(row);
    return toPublicSmtp(row, true);
  } catch (err) {
    throw toSmtpServiceError(err);
  }
}

export async function deleteSmtpSettings(store: SmtpStore, userId: string): Promise<void> {
  try {
    await store.delete(userId); // removes the ciphertext and all status together
  } catch (err) {
    throw toSmtpServiceError(err);
  }
}

/** Removes any occurrence of the secret from text destined for logs/responses. */
export function redactSecret(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 1) out = out.split(s).join("[redacted]");
  }
  return out.slice(0, 300);
}

export interface VerifyConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  encryption: string;
}

export interface TestSmtpOutcome {
  success: boolean;
  /** False when the config changed during the test, so the result was not saved. */
  recorded: boolean;
  settings: PublicSmtpSettings;
  error?: string;
}

export async function testStoredSmtp(
  store: SmtpStore,
  userId: string,
  verify: (cfg: VerifyConfig) => Promise<void>,
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<TestSmtpOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  try {
    const key = loadSmtpKey(env);
    const row = await store.get(userId);
    if (!row) {
      throw new SmtpServiceError(
        400,
        "smtp_not_configured",
        "Save your SMTP settings before testing the connection.",
      );
    }
    const pass = decryptSmtpSecret(row.password_ciphertext, userId, key);

    let error: string | null = null;
    try {
      await verify({
        host: row.host,
        port: row.port,
        user: row.username,
        pass,
        encryption: row.encryption,
      });
    } catch (e: unknown) {
      const message =
        e instanceof Error && e.message ? e.message : "Failed to connect to SMTP server.";
      error = redactSecret(message, [pass]);
    }

    const status: SmtpTestStatus = error ? "failed" : "success";
    const recorded = await store.recordTest(userId, row.config_version, {
      status,
      testedAt: now().toISOString(),
      error,
    });
    const fresh = await store.get(userId);
    return {
      success: !error,
      recorded,
      settings: toPublicSmtp(fresh, true),
      ...(error ? { error } : {}),
    };
  } catch (err) {
    throw toSmtpServiceError(err);
  }
}

/** Decrypted credentials for sending mail. Server-side use only. */
export async function loadSmtpCredentials(
  store: SmtpStore,
  userId: string,
  env = process.env,
): Promise<{ host: string; port: number; user: string; pass: string; encryption: string } | null> {
  try {
    const row = await store.get(userId);
    if (!row) return null;
    const key = loadSmtpKey(env);
    return {
      host: row.host,
      port: row.port,
      user: row.username,
      pass: decryptSmtpSecret(row.password_ciphertext, userId, key),
      encryption: row.encryption,
    };
  } catch (err) {
    throw toSmtpServiceError(err);
  }
}

export { SMTP_KEY_ENV_VAR };
