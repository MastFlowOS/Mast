import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { LEAD_STATUSES, normalizeLeadStatus } from "../lead-workspace.js";

/**
 * Regression coverage: the four outreach "Mark Sent"/"Mark Called" actions
 * used to patch `status: "outreach"` — a legacy alias absent from
 * LEAD_STATUSES — instead of a real canonical LeadStatus (see audit).
 * Each channel now writes the canonical status that represents it.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const canonicalValues = new Set(LEAD_STATUSES.map((s) => s.value));

const expectations: Array<{ file: string; expectedStatus: string }> = [
  { file: "src/components/mast/workspace/components/EmailForm.tsx", expectedStatus: "email_sent" },
  { file: "src/components/mast/workspace/components/InstagramForm.tsx", expectedStatus: "instagram_sent" },
  { file: "src/components/mast/workspace/components/PhoneForm.tsx", expectedStatus: "called" },
  { file: "src/components/mast/workspace/components/ContactForm.tsx", expectedStatus: "email_sent" },
];

for (const { file, expectedStatus } of expectations) {
  test(`${path.basename(file)} Mark Sent/Called writes canonical status "${expectedStatus}", not the legacy "outreach" alias`, () => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");

    assert.ok(
      !/status:\s*["']outreach["']/.test(source),
      `${file} must not patch the legacy "outreach" status alias`,
    );
    assert.ok(
      source.includes(`status: "${expectedStatus}"`),
      `${file} must patch status: "${expectedStatus}"`,
    );
    assert.ok(canonicalValues.has(expectedStatus), `"${expectedStatus}" must be a canonical LeadStatus`);
  });
}

test('Contact Form\'s canonical status matches the existing LEGACY_STATUS_MAP normalization for "contact_form_sent"', () => {
  // There is no canonical `contact_form_sent` LeadStatus. The product's
  // existing normalization already collapses that legacy value onto
  // "email_sent" — ContactForm's Mark Sent action must write that same
  // canonical value directly rather than inventing a new status.
  assert.equal(normalizeLeadStatus("contact_form_sent"), "email_sent");
});
