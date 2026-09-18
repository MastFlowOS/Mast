import test from "node:test";
import assert from "node:assert/strict";
import { readContinuity, isGenuineSend, parseContinuityMetadata, GENUINE_SEND_TYPES, NO_CONTINUITY } from "@/lib/outreach/continuity/read";
import { buildContinuityMetadata, withContinuityMetadata } from "@/lib/outreach/continuity/write";
import type { LeadActivity } from "@/lib/api";

// LeadActivityType (src/lib/api.ts) is known to omit instagram_sent,
// call_completed, and contact_form_sent even though they're real runtime
// values written by the send paths (see continuity/read.ts's doc comment).
// This helper accepts the wider runtime type, same as those call sites do.
type AnyActivityType = LeadActivity["type"] | "instagram_sent" | "call_completed" | "contact_form_sent" | "message_generated" | "email_opened" | "instagram_opened" | "contact_form_opened";

function activity(overrides: Partial<Omit<LeadActivity, "type">> & { type?: AnyActivityType }): LeadActivity {
  return {
    id: overrides.id ?? "1",
    leadId: 1,
    type: "email_sent",
    timestamp: "2026-01-01T00:00:00.000Z",
    content: "",
    ...overrides,
  } as LeadActivity;
}

test("genuine outbound event types qualify", () => {
  assert.deepEqual([...GENUINE_SEND_TYPES].sort(), ["call_completed", "contact_form_sent", "email_sent", "instagram_sent"].sort());
  for (const type of GENUINE_SEND_TYPES) {
    // GENUINE_SEND_TYPES intentionally isn't a subset of LeadActivityType —
    // see continuity/read.ts's doc comment: that union is known to omit
    // instagram_sent/call_completed/contact_form_sent, which are real
    // runtime values. The cast here mirrors that, it isn't a test bug.
    assert.equal(isGenuineSend({ type: type as any }), true);
  }
});

test("message_generated does NOT qualify", () => {
  assert.equal(isGenuineSend({ type: "message_generated" as any }), false);
});

test("opened events do NOT qualify (email/instagram/contact_form)", () => {
  assert.equal(isGenuineSend({ type: "email_opened" as any }), false);
  assert.equal(isGenuineSend({ type: "instagram_opened" as any }), false);
  assert.equal(isGenuineSend({ type: "contact_form_opened" as any }), false);
});

test("readContinuity: no genuine sends -> NO_CONTINUITY", () => {
  const result = readContinuity([activity({ type: "message_generated" as any })]);
  assert.deepEqual(result, NO_CONTINUITY);
});

test("readContinuity: most recent genuine send wins", () => {
  const older = activity({ id: "a", type: "email_sent", timestamp: "2026-01-01T00:00:00.000Z", channel: "email" });
  const newer = activity({ id: "b", type: "instagram_sent", timestamp: "2026-01-05T00:00:00.000Z", channel: "instagram" });
  const result = readContinuity([older, newer]);
  assert.equal(result.lastSendAt, "2026-01-05T00:00:00.000Z");
  assert.equal(result.lastSendChannel, "instagram");
});

test("readContinuity: channel is derived from activity.channel, not lead.status", () => {
  const result = readContinuity([activity({ type: "call_completed", channel: "phone" })]);
  assert.equal(result.lastSendChannel, "phone");
});

test("readContinuity: old activity without metadata remains readable (continuity: null, not an error)", () => {
  const result = readContinuity([activity({ type: "email_sent", metadata: undefined })]);
  assert.equal(result.lastSendAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.continuity, null);
});

test("readContinuity: metadata with continuity fields is read correctly", () => {
  const metadata = {
    originalTemplate: "initial",
    originalAngleComponent: "branding",
    originalAngleSource: "opportunity",
    sentAt: "2026-01-01T00:00:00.000Z",
    channel: "email",
  };
  const result = readContinuity([activity({ type: "email_sent", metadata })]);
  assert.deepEqual(result.continuity, metadata);
});

test("readContinuity: multiple previous sends works correctly (count + most recent)", () => {
  const a = activity({ id: "a", type: "email_sent", timestamp: "2026-01-01T00:00:00.000Z" });
  const b = activity({ id: "b", type: "email_sent", timestamp: "2026-01-03T00:00:00.000Z" });
  const c = activity({ id: "c", type: "call_completed", timestamp: "2026-01-02T00:00:00.000Z" });
  const result = readContinuity([a, b, c]);
  assert.equal(result.sendCount, 3);
  assert.equal(result.lastSendAt, "2026-01-03T00:00:00.000Z");
});

test("readContinuity never parses message body/content for continuity data", () => {
  const suspicious = activity({
    type: "email_sent",
    content: JSON.stringify({ originalTemplate: "initial", originalAngleComponent: "branding" }),
    body: JSON.stringify({ originalTemplate: "initial", originalAngleComponent: "branding" }),
    metadata: undefined,
  });
  const result = readContinuity([suspicious]);
  // Body/content are never read as a source of continuity — only structured metadata is.
  assert.equal(result.continuity, null);
});

test("parseContinuityMetadata rejects malformed/partial metadata rather than guessing", () => {
  assert.equal(parseContinuityMetadata(null), null);
  assert.equal(parseContinuityMetadata({}), null);
  assert.equal(parseContinuityMetadata({ originalTemplate: "initial" }), null);
  assert.equal(
    parseContinuityMetadata({
      originalTemplate: "initial",
      originalAngleComponent: "not_a_real_component",
      originalAngleSource: "opportunity",
      sentAt: "2026-01-01T00:00:00.000Z",
      channel: "email",
    }),
    null,
  );
});

// ─── Write ───────────────────────────────────────────────────────────────────

test("buildContinuityMetadata produces all required structured fields", () => {
  const metadata = buildContinuityMetadata({
    templateKey: "initial",
    angleComponent: "branding",
    angleSource: "opportunity",
    channel: "email",
    sentAt: "2026-01-01T00:00:00.000Z",
    ctaStyle: "showWork",
  });
  assert.deepEqual(metadata, {
    originalTemplate: "initial",
    originalAngleComponent: "branding",
    originalAngleSource: "opportunity",
    sentAt: "2026-01-01T00:00:00.000Z",
    channel: "email",
    ctaStyle: "showWork",
  });
});

test("buildContinuityMetadata omits ctaStyle when not supplied", () => {
  const metadata = buildContinuityMetadata({
    templateKey: "initial",
    angleComponent: "generic",
    angleSource: "profession-generic",
    channel: "phone",
    sentAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal("ctaStyle" in metadata, false);
});

test("withContinuityMetadata merges without clobbering existing metadata", () => {
  const existing = { foo: "bar" };
  const metadata = buildContinuityMetadata({
    templateKey: "initial",
    angleComponent: "branding",
    angleSource: "opportunity",
    channel: "email",
    sentAt: "2026-01-01T00:00:00.000Z",
  });
  const merged = withContinuityMetadata(existing, metadata);
  assert.equal(merged?.foo, "bar");
  assert.equal(merged?.originalTemplate, "initial");
});

test("withContinuityMetadata passes through existing metadata unchanged when metadata is null (non-send activity paths)", () => {
  const existing = { foo: "bar" };
  assert.deepEqual(withContinuityMetadata(existing, null), existing);
  assert.equal(withContinuityMetadata(null, null), null);
});
