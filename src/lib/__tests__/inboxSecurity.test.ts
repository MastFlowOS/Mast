import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CREDENTIALS_KEY_ENV_VAR,
  decryptInboxPassword,
  encryptInboxPassword,
  InboxCryptoError,
} from "../inboxCrypto.js";
import { InboxHostError, validateImapHost } from "../inboxHostValidator.js";

describe("inboxSecurity", () => {
  it("encrypts and decrypts IMAP passwords bound to userId via AES-256-GCM", () => {
    const key = randomBytes(32).toString("base64");
    const env = { [CREDENTIALS_KEY_ENV_VAR]: key };

    const token1 = encryptInboxPassword("app-pass-123", "user-a", env);
    const token2 = encryptInboxPassword("app-pass-123", "user-a", env);

    assert.notEqual(token1, token2);
    assert.equal(decryptInboxPassword(token1, "user-a", env), "app-pass-123");

    // Cross-user AAD check must fail
    assert.throws(
      () => decryptInboxPassword(token1, "user-b", env),
      (err: unknown) => err instanceof InboxCryptoError && err.code === "inbox_decrypt_failed",
    );
  });

  it("blocks localhost, private RFC1918, cloud metadata, and private DNS resolutions (SSRF protection)", async () => {
    await assert.rejects(
      () => validateImapHost("localhost"),
      (err: unknown) => err instanceof InboxHostError && err.code === "imap_prohibited_destination",
    );
    await assert.rejects(
      () => validateImapHost("169.254.169.254"),
      (err: unknown) => err instanceof InboxHostError && err.code === "imap_prohibited_destination",
    );
    await assert.rejects(
      () =>
        validateImapHost("evil-internal.example.com", {
          resolve4: async () => ["10.0.0.5"],
          resolve6: async () => [],
        }),
      (err: unknown) => err instanceof InboxHostError && err.code === "imap_prohibited_destination",
    );

    const valid = await validateImapHost("imap.gmail.com", {
      resolve4: async () => ["142.250.185.109"],
      resolve6: async () => [],
    });
    assert.equal(valid.canonicalHost, "imap.gmail.com");
    assert.equal(valid.pinnedIp, "142.250.185.109");
  });
});
