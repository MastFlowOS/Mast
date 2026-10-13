/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions on thrown errors */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SMTP_KEY_ENV_VAR,
  SmtpCryptoError,
  decryptSmtpSecret,
  encryptSmtpSecret,
  isSmtpKeyConfigured,
  loadSmtpKey,
} from "../_smtpCrypto";
import { NO_KEY_ENV, SECRET, TEST_ENV, USER_A, USER_B } from "./helpers";

const key = () => loadSmtpKey(TEST_ENV);

test("round-trips and never stores plaintext in the token", () => {
  const token = encryptSmtpSecret(SECRET, USER_A, key());
  assert.ok(!token.includes(SECRET));
  assert.ok(token.startsWith("v1."));
  assert.equal(decryptSmtpSecret(token, USER_A, key()), SECRET);
});

test("uses a fresh IV: same input encrypts differently each time", () => {
  assert.notEqual(
    encryptSmtpSecret(SECRET, USER_A, key()),
    encryptSmtpSecret(SECRET, USER_A, key()),
  );
});

test("ciphertext is bound to its owner: another user's id fails authentication", () => {
  const token = encryptSmtpSecret(SECRET, USER_A, key());
  assert.throws(
    () => decryptSmtpSecret(token, USER_B, key()),
    (e: any) => e.code === "smtp_decrypt_failed",
  );
});

test("tampered ciphertext, wrong key, and malformed tokens are rejected without leaking content", () => {
  const token = encryptSmtpSecret(SECRET, USER_A, key());
  const parts = token.split(".");
  const flipped = [...parts.slice(0, 3), Buffer.from("x" + parts[3]).toString("base64url")].join(
    ".",
  );
  for (const bad of [flipped, "garbage", "v2.a.b.c", ""]) {
    assert.throws(
      () => decryptSmtpSecret(bad, USER_A, key()),
      (e: any) => {
        assert.ok(e instanceof SmtpCryptoError);
        assert.ok(!e.message.includes(SECRET));
        return e.code === "smtp_decrypt_failed";
      },
    );
  }
  const otherKey = loadSmtpKey({
    [SMTP_KEY_ENV_VAR]: Buffer.alloc(32, 9).toString("base64"),
  } as any);
  assert.throws(
    () => decryptSmtpSecret(token, USER_A, otherKey),
    (e: any) => e.code === "smtp_decrypt_failed",
  );
});

test("missing key fails safely and names the exact env var", () => {
  assert.equal(isSmtpKeyConfigured(NO_KEY_ENV), false);
  assert.throws(
    () => loadSmtpKey(NO_KEY_ENV),
    (e: any) => {
      return e.code === "smtp_key_not_configured" && e.message.includes("SMTP_CREDENTIALS_KEY");
    },
  );
});

test("a key that is not 32 bytes is rejected", () => {
  const short = { SMTP_CREDENTIALS_KEY: Buffer.alloc(16, 1).toString("base64") } as any;
  assert.throws(
    () => loadSmtpKey(short),
    (e: any) => e.code === "smtp_key_invalid",
  );
  assert.equal(isSmtpKeyConfigured(short), false);
});
