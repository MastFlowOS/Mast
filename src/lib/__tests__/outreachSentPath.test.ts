import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

/**
 * Source-contract coverage (same approach as updateLeadPipelineBoundary.test.ts:
 * api.ts reads import.meta.env at module scope, so it cannot be imported under
 * `tsx --test`). These tests pin the investigated finding for the
 * "User profile or settings not found." report:
 *
 *   - That message is produced ONLY by api/send-email.ts (the connected "Send
 *     Email" path), never by the manual "Mark as sent" handlers.
 *   - Manual "Mark as sent" writes through createLeadActivity + updateLead,
 *     both scoped to the authenticated user's id, and never reads `profiles`.
 *
 * They are NOT a substitute for an end-to-end test against a live database.
 */

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  let i = source.indexOf("{", start);
  const from = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  return source.slice(from, i + 1);
}

test("the 'profile not found' wording is gone, replaced by distinct error codes in send-email", () => {
  const send = read("api/send-email.ts");
  assert.ok(!send.includes("User profile or settings not found"));
  for (const code of ["profile_not_found", "smtp_not_configured", "send_failed"]) {
    assert.ok(send.includes(code), `send-email should report ${code}`);
  }
  assert.ok(
    send.includes("classifyDbError"),
    "profile lookup errors must be classified, not collapsed",
  );
});

test("header 'Mark as sent' never calls the send-email API or reads profiles", () => {
  const src = read("src/components/mast/workspace/LeadWorkspaceHeader.tsx");
  const fn = body(src, "const handleMarkAsSent = async () => {");
  assert.ok(
    /recordActivity|useRecordLeadActivity|mutateAsync/.test(fn),
    "should record via the activity mutation",
  );
  for (const forbidden of ["sendLeadEmail", "send-email", "profiles", "test-smtp"]) {
    assert.ok(!fn.includes(forbidden), `handleMarkAsSent must not reference ${forbidden}`);
  }
});

test("only the connected Send path calls sendLeadEmail; the manual path does not", () => {
  const src = read("src/components/mast/workspace/CenterWorkspace.tsx");
  const connected = body(src, "const handleSendConnected = async () => {");
  assert.ok(
    connected.includes("sendLeadEmail") || connected.includes("sendEmail"),
    "connected send calls the API",
  );
  const manualButton = src.slice(
    src.indexOf("Mark as Sent (Manual)") - 900,
    src.indexOf("Mark as Sent (Manual)"),
  );
  assert.ok(
    !manualButton.includes("handleSendConnected"),
    "manual button must not invoke the connected send",
  );
});

test("lead writes behind 'Mark as sent' are scoped to the authenticated user", () => {
  const api = read("src/lib/api.ts");
  const activity = body(api, "export async function createLeadActivity(");
  assert.ok(activity.includes("requireUserId()"));
  assert.ok(activity.includes("user_id: userId"));
  assert.ok(activity.includes('from("lead_activities")'));
  assert.ok(!activity.includes('from("profiles")'));

  const update = body(
    api,
    "export async function updateLead(id: number, body: UpdateLeadBody): Promise<Lead> {",
  );
  assert.ok(
    update.includes('.eq("user_id", userId)'),
    "updateLead must filter by the caller's user_id",
  );
  assert.ok(!update.includes('from("profiles")'));
});

test("the client never writes an SMTP password into profiles.settings", () => {
  const api = read("src/lib/api.ts");
  assert.ok(api.includes("function omitSmtpPassword"));
  const update = body(
    api,
    "export async function updateSettings(body: SettingsMap, fullName?: string): Promise<SettingsMap> {",
  );
  assert.ok(
    update.includes("omitSmtpPassword(body)"),
    "updateSettings must strip smtpPassword from the payload",
  );
  const get = body(api, "export async function getSettings(): Promise<SettingsMap> {");
  assert.ok(
    get.includes("omitSmtpPassword("),
    "getSettings must not surface a legacy plaintext password",
  );

  const page = read("src/routes/dashboard.settings.tsx");
  assert.ok(
    !/smtpPassword,\s*\n\s*smtpEncryption,\s*\n\s*smtpSenderName/.test(page),
    "Settings save() must not send smtpPassword",
  );
});
