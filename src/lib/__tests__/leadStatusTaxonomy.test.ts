import assert from "node:assert/strict";
import test from "node:test";
import {
  LEAD_STATUSES,
  leadStatusLabel,
  normalizeLeadStatus,
} from "../lead-workspace.js";

// Root-cause regression coverage (see audit): the canonical LEAD_STATUSES
// list must not contain the stale "ready" pipeline status, and legacy
// status strings that outreach actions and old data may still carry must
// normalize onto a real canonical status.

test("LEAD_STATUSES is exactly the current canonical status set (no stale 'ready')", () => {
  const values = LEAD_STATUSES.map((s) => s.value);
  assert.deepEqual(values, [
    "new",
    "email_sent",
    "called",
    "instagram_sent",
    "replied",
    "meeting_booked",
    "closed",
    "dead",
  ]);
  assert.ok(!values.includes("ready" as (typeof values)[number]));
});

test("normalizeLeadStatus maps the legacy 'outreach' alias onto a real canonical status", () => {
  const normalized = normalizeLeadStatus("outreach");
  assert.equal(normalized, "email_sent");
  assert.ok(LEAD_STATUSES.some((s) => s.value === normalized));
});

test("normalizeLeadStatus maps the stale 'ready' status onto 'new'", () => {
  assert.equal(normalizeLeadStatus("ready"), "new");
});

test("normalizeLeadStatus maps legacy 'contact_form_sent' onto the smallest existing canonical representation (email_sent)", () => {
  // There is no canonical `contact_form_sent` LeadStatus — LEGACY_STATUS_MAP
  // collapses it onto "email_sent", which is what ContactForm's Mark Sent
  // action must now write directly instead of the legacy "outreach" alias.
  assert.equal(normalizeLeadStatus("contact_form_sent"), "email_sent");
});

test("every canonical LEAD_STATUSES value normalizes to itself (idempotent)", () => {
  for (const { value } of LEAD_STATUSES) {
    assert.equal(normalizeLeadStatus(value), value);
  }
});

test("leadStatusLabel resolves the canonical outreach Mark Sent statuses to human labels", () => {
  assert.equal(leadStatusLabel("email_sent"), "Email Sent");
  assert.equal(leadStatusLabel("instagram_sent"), "Instagram Sent");
  assert.equal(leadStatusLabel("called"), "Called");
});
