/**
 * Server-side AES-256-GCM encryption for stored IMAP/inbox credentials.
 *
 * Uses the same `SMTP_CREDENTIALS_KEY` and `v1.<iv>.<authTag>.<ciphertext>`
 * authenticated-encryption format (with `userId` as GCM AAD) as
 * `api/_smtpCrypto.ts`, kept under `src/` so `tsconfig.server.json`
 * (`rootDir: "src"`) compiles cleanly without cross-root imports.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CREDENTIALS_KEY_ENV_VAR = "SMTP_CREDENTIALS_KEY";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type InboxCryptoErrorCode =
  | "inbox_key_not_configured"
  | "inbox_key_invalid"
  | "inbox_decrypt_failed";

export class InboxCryptoError extends Error {
  readonly code: InboxCryptoErrorCode;
  constructor(code: InboxCryptoErrorCode, message: string) {
    super(message);
    this.name = "InboxCryptoError";
    this.code = code;
  }
}

export function loadInboxKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[CREDENTIALS_KEY_ENV_VAR]?.trim();
  if (!raw) {
    throw new InboxCryptoError(
      "inbox_key_not_configured",
      `Secure inbox storage is not configured on the server. Set ${CREDENTIALS_KEY_ENV_VAR} (base64-encoded 32-byte key).`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new InboxCryptoError(
      "inbox_key_invalid",
      `${CREDENTIALS_KEY_ENV_VAR} must be a base64-encoded 32-byte key.`,
    );
  }
  return key;
}

export function isInboxKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadInboxKey(env);
    return true;
  } catch {
    return false;
  }
}

export function encryptInboxPassword(
  plaintext: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = loadInboxKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptWithAad(
  token: string,
  aad: Buffer,
  errorMessage: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = loadInboxKey(env);
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new InboxCryptoError("inbox_decrypt_failed", "Stored inbox credentials are malformed.");
  }

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || authTag.length !== 16) {
      throw new Error("Invalid IV or authTag length");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new InboxCryptoError("inbox_decrypt_failed", errorMessage);
  }
}

export function decryptInboxPassword(
  token: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return decryptWithAad(
    token,
    Buffer.from(userId, "utf8"),
    "Stored inbox credentials could not be decrypted. Please re-enter your IMAP password.",
    env,
  );
}

/**
 * Decrypts a `user_smtp_credentials.password_ciphertext` token (encrypted by
 * `api/_smtpCrypto.ts` with `mast:smtp-credentials:v1:<userId>` AAD) server-side
 * so Auto-fill from SMTP can reuse the saved App Password without exposing it.
 */
export function decryptSmtpPasswordForInbox(
  token: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return decryptWithAad(
    token,
    Buffer.from(`mast:smtp-credentials:${VERSION}:${userId}`, "utf8"),
    "Saved SMTP password could not be decrypted. Please re-enter your IMAP password.",
    env,
  );
}
