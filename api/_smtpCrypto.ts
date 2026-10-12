/**
 * Server-side encryption for stored SMTP credentials.
 *
 * Algorithm: AES-256-GCM (authenticated encryption) from node:crypto, with a
 * fresh random 96-bit IV per encryption. The ciphertext is bound to the owning
 * user through GCM Additional Authenticated Data, so a ciphertext copied into
 * another user's row fails authentication instead of decrypting.
 *
 * Key: SMTP_CREDENTIALS_KEY — base64 encoding of exactly 32 random bytes,
 * held only in the server environment (never VITE_-prefixed, never sent to the
 * browser). Generate one with:  openssl rand -base64 32
 *
 * Stored format:  v1.<iv>.<authTag>.<ciphertext>   (each part base64url)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SMTP_KEY_ENV_VAR = "SMTP_CREDENTIALS_KEY";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type SmtpCryptoErrorCode =
  | "smtp_key_not_configured"
  | "smtp_key_invalid"
  | "smtp_decrypt_failed";

export class SmtpCryptoError extends Error {
  readonly code: SmtpCryptoErrorCode;
  constructor(code: SmtpCryptoErrorCode, message: string) {
    super(message);
    this.name = "SmtpCryptoError";
    this.code = code;
  }
}

/** Reads and validates the key. Throws a safe, secret-free configuration error. */
export function loadSmtpKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[SMTP_KEY_ENV_VAR]?.trim();
  if (!raw) {
    throw new SmtpCryptoError(
      "smtp_key_not_configured",
      `Secure SMTP storage is not configured on the server. Set the ${SMTP_KEY_ENV_VAR} environment variable (base64-encoded 32-byte key).`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SmtpCryptoError(
      "smtp_key_invalid",
      `${SMTP_KEY_ENV_VAR} must be a base64-encoded 32-byte key.`,
    );
  }
  return key;
}

export function isSmtpKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadSmtpKey(env);
    return true;
  } catch {
    return false;
  }
}

function aad(userId: string): Buffer {
  return Buffer.from(`mast:smtp-credentials:${VERSION}:${userId}`, "utf8");
}

export function encryptSmtpSecret(plaintext: string, userId: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function decryptSmtpSecret(token: string, userId: string, key: Buffer): string {
  const fail = () =>
    new SmtpCryptoError(
      "smtp_decrypt_failed",
      "Stored SMTP credentials could not be decrypted. Re-enter the SMTP password in Settings.",
    );
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw fail();
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ct = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES) throw fail();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw fail();
  }
}
