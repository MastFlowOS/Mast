/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions on thrown errors */
import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteSmtpSettings,
  getSmtpSettings,
  loadSmtpCredentials,
  redactSecret,
  saveSmtpSettings,
  testStoredSmtp,
  type VerifyConfig,
} from "../_smtpService";
import { BASE_INPUT, NO_KEY_ENV, SECRET, TEST_ENV, USER_A, USER_B, memoryStore } from "./helpers";

const ok: (cfg: VerifyConfig) => Promise<void> = async () => {};
const fixedNow = (iso: string) => () => new Date(iso);
const save = (store: any, input: any, userId = USER_A) =>
  saveSmtpSettings(store, userId, input, { env: TEST_ENV });
const runTest = (store: any, verify = ok, userId = USER_A, iso = "2026-10-13T10:00:00.000Z") =>
  testStoredSmtp(store, userId, verify, { env: TEST_ENV, now: fixedNow(iso) });

test("a saved config starts as untested, never connected", async () => {
  const store = memoryStore();
  const pub = await save(store, BASE_INPUT);
  assert.equal(pub.configured, true);
  assert.equal(pub.status, "untested");
  assert.equal(pub.lastTestedAt, null);
  assert.equal(pub.hasPassword, true);
});

test("successful test persists and survives reload (page refresh / new session)", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  const outcome = await runTest(store);
  assert.equal(outcome.success, true);
  assert.equal(outcome.settings.status, "connected");

  // "Refresh": a brand-new read from persisted state only.
  const reloaded = await getSmtpSettings(store, USER_A, TEST_ENV);
  assert.equal(reloaded.status, "connected");
  assert.equal(reloaded.lastTestedAt, "2026-10-13T10:00:00.000Z");
  assert.equal(reloaded.host, "smtp.gmail.com");
  assert.equal(reloaded.username, "a@example.com");
});

test("a failed test is recorded as failed, with the password redacted from the error", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  const outcome = await runTest(store, async () => {
    throw new Error(`535 auth failed for password ${SECRET}`);
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.settings.status, "failed");
  assert.ok(!JSON.stringify(outcome).includes(SECRET));
  assert.ok(outcome.error!.includes("[redacted]"));
  assert.equal((await getSmtpSettings(store, USER_A, TEST_ENV)).status, "failed");
});

test("a later failure replaces an earlier success (status reflects the LATEST test)", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  await runTest(store);
  await runTest(store, async () => {
    throw new Error("timeout");
  });
  assert.equal((await getSmtpSettings(store, USER_A, TEST_ENV)).status, "failed");
});

for (const [field, value] of [
  ["host", "smtp.other.com"],
  ["port", "465"],
  ["username", "b@example.com"],
  ["encryption", "SSL"],
  ["password", "a-different-password"],
] as const) {
  test(`changing ${field} invalidates a previous successful test`, async () => {
    const store = memoryStore();
    await save(store, BASE_INPUT);
    await runTest(store);
    assert.equal((await getSmtpSettings(store, USER_A, TEST_ENV)).status, "connected");

    const after = await save(store, { ...BASE_INPUT, [field]: value });
    assert.equal(after.status, "untested");
    assert.equal(after.lastTestedAt, null);
    assert.equal((await getSmtpSettings(store, USER_A, TEST_ENV)).status, "untested");
  });
}

test("re-saving identical values, or omitting the password, keeps the test result", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  await runTest(store);
  assert.equal((await save(store, BASE_INPUT)).status, "connected");
  const { password: _omit, ...noPassword } = BASE_INPUT;
  assert.equal((await save(store, noPassword)).status, "connected");
  // and the stored password is still the original one
  const creds = await loadSmtpCredentials(store, USER_A, TEST_ENV);
  assert.equal(creds?.pass, SECRET);
});

test("a test result from a stale config version is not recorded", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  const outcome = await runTest(store, async () => {
    // config edited while the connection test is in flight
    await save(store, { ...BASE_INPUT, host: "smtp.changed.com" });
  });
  assert.equal(outcome.recorded, false);
  assert.notEqual(outcome.settings.status, "connected");
  assert.equal(outcome.settings.host, "smtp.changed.com");
});

test("deleting the configuration clears credentials and status", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT);
  await runTest(store);
  await deleteSmtpSettings(store, USER_A);
  assert.equal(store.rows.has(USER_A), false);
  const pub = await getSmtpSettings(store, USER_A, TEST_ENV);
  assert.equal(pub.configured, false);
  assert.equal(pub.status, "not_configured");
  assert.equal(pub.hasPassword, false);
  assert.equal(await loadSmtpCredentials(store, USER_A, TEST_ENV), null);
});

test("the password is stored only as ciphertext and never appears in any public response", async () => {
  const store = memoryStore();
  const saved = await save(store, BASE_INPUT);
  await runTest(store);
  const fetched = await getSmtpSettings(store, USER_A, TEST_ENV);
  const row = store.rows.get(USER_A)!;
  assert.ok(!row.password_ciphertext.includes(SECRET));
  for (const payload of [saved, fetched]) {
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(SECRET));
    assert.ok(!json.includes(row.password_ciphertext));
    assert.ok(!/password_ciphertext|"password"|"pass"/.test(json));
  }
});

test("no secret is written to console output during save, test, failure, or load", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log =
    console.error =
    console.warn =
      (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const store = memoryStore();
    await save(store, BASE_INPUT);
    await runTest(store, async () => {
      throw new Error(`bad login ${SECRET}`);
    });
    await getSmtpSettings(store, USER_A, TEST_ENV);
    await loadSmtpCredentials(store, USER_A, TEST_ENV);
    await save(store, { ...BASE_INPUT, host: "" }).catch(() => undefined);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("without SMTP_CREDENTIALS_KEY, save and test fail safely with a clear 503 and store nothing", async () => {
  const store = memoryStore();
  await assert.rejects(
    saveSmtpSettings(store, USER_A, BASE_INPUT, { env: NO_KEY_ENV }),
    (e: any) =>
      e.status === 503 &&
      e.code === "smtp_key_not_configured" &&
      e.message.includes("SMTP_CREDENTIALS_KEY"),
  );
  assert.equal(store.rows.size, 0);
  await save(store, BASE_INPUT);
  await assert.rejects(
    testStoredSmtp(store, USER_A, ok, { env: NO_KEY_ENV }),
    (e: any) => e.status === 503 && e.code === "smtp_key_not_configured",
  );
  const pub = await getSmtpSettings(store, USER_A, NO_KEY_ENV);
  assert.equal(pub.encryptionConfigured, false);
  assert.notEqual(pub.status, "connected");
});

test("input validation rejects bad host/port/encryption/missing password", async () => {
  const store = memoryStore();
  for (const bad of [
    { ...BASE_INPUT, host: " " },
    { ...BASE_INPUT, port: "0" },
    { ...BASE_INPUT, port: "70000" },
    { ...BASE_INPUT, port: "abc" },
    { ...BASE_INPUT, encryption: "STARTTLS-ish" },
    { ...BASE_INPUT, password: "" },
  ]) {
    await assert.rejects(
      save(store, bad),
      (e: any) => e.status === 400 && e.code === "smtp_invalid",
    );
  }
  assert.equal(store.rows.size, 0);
});

test("testing before saving is a clear 400, not a crash", async () => {
  await assert.rejects(
    runTest(memoryStore()),
    (e: any) => e.status === 400 && e.code === "smtp_not_configured",
  );
});

test("one user cannot read, overwrite, test, or decrypt another user's SMTP settings", async () => {
  const store = memoryStore();
  await save(store, BASE_INPUT, USER_A);
  await runTest(store, ok, USER_A);

  // B sees nothing of A's.
  const bView = await getSmtpSettings(store, USER_B, TEST_ENV);
  assert.equal(bView.configured, false);
  assert.equal(bView.username, "");

  // B saving does not touch A's row.
  await save(
    store,
    { ...BASE_INPUT, host: "smtp.b.com", username: "b@example.com", password: "b-pass" },
    USER_B,
  );
  const aAfter = await getSmtpSettings(store, USER_A, TEST_ENV);
  assert.equal(aAfter.host, "smtp.gmail.com");
  assert.equal(aAfter.status, "connected");
  assert.equal((await loadSmtpCredentials(store, USER_A, TEST_ENV))?.pass, SECRET);

  // B testing runs against B's own config only.
  let seenHost = "";
  await runTest(store, async (cfg) => void (seenHost = cfg.host), USER_B);
  assert.equal(seenHost, "smtp.b.com");

  // A ciphertext copied into B's row cannot be decrypted as B (AAD binds it to A).
  const stolen = store.rows.get(USER_A)!.password_ciphertext;
  store.rows.get(USER_B)!.password_ciphertext = stolen;
  await assert.rejects(
    loadSmtpCredentials(store, USER_B, TEST_ENV),
    (e: any) => e.code === "smtp_decrypt_failed",
  );
});

test("redactSecret strips every occurrence and caps length", () => {
  assert.equal(redactSecret(`a ${SECRET} b ${SECRET}`, [SECRET]), "a [redacted] b [redacted]");
  assert.equal(redactSecret("x".repeat(1000), []).length, 300);
});
