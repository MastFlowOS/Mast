import assert from "node:assert/strict";
import test from "node:test";
import { channelsSatisfied, mergeEnrichedChannels } from "../channelFilter.js";
import { normalizeInstagram } from "../instagram.js";
import {
  isValidEmail,
  isValidPhone,
  sanitizeLeadContacts,
  validateLead,
} from "../leadValidation.js";

// ── Email false positives ─────────────────────────────────────────────────

test("asset file names are not emails", () => {
  for (const bad of ["logo@2x.png", "hero@3x.jpg", "a@b.png", "icon@2x.svg", "x@sub.2x.com"]) {
    assert.equal(isValidEmail(bad), false, bad);
  }
});

test("hash-like and system mailboxes are not emails", () => {
  assert.equal(isValidEmail("0123456789abcdef0123456789abcdef@host.com"), false);
  assert.equal(isValidEmail("noreply@shop.com"), false);
  assert.equal(isValidEmail("user@wix.com"), false);
});

test("real business emails stay valid", () => {
  for (const ok of ["info@shop.com", "john.smith@shop.co.uk", "hello@my-cafe.io"]) {
    assert.equal(isValidEmail(ok), true, ok);
  }
});

// ── Instagram false positives / mobile URLs ──────────────────────────────

test("non-profile Instagram paths are rejected", () => {
  for (const bad of [
    "https://www.instagram.com/sharer.php",
    "https://www.instagram.com/static/",
    "https://www.instagram.com/embed.js",
    "https://www.instagram.com/p/ABC123/",
    "https://www.instagram.com/explore/",
  ]) {
    assert.equal(normalizeInstagram(bad), null, bad);
  }
});

test("legitimate and mobile Instagram URLs normalize", () => {
  assert.equal(
    normalizeInstagram("https://m.instagram.com/joesbarber/?hl=en")?.profileUrl,
    "https://www.instagram.com/joesbarber/",
  );
  assert.equal(normalizeInstagram("//instagram.com/joes.barber")?.handle, "joes.barber");
  assert.equal(normalizeInstagram("@7eleven")?.handle, "7eleven");
  assert.equal(normalizeInstagram("https://instagram.com/business")?.handle, "business");
});

// ── Channel qualification validates real data ─────────────────────────────

test("a junk string no longer satisfies a requested channel", () => {
  assert.equal(channelsSatisfied({ email: "logo@2x.png" }, ["email"]), false);
  assert.equal(
    channelsSatisfied({ instagram: "https://www.instagram.com/embed.js/" }, ["instagram"]),
    false,
  );
  assert.equal(channelsSatisfied({ phone: "abc" }, ["phone"]), false);
  assert.equal(channelsSatisfied({ website: "not a url" }, ["website"]), false);
});

test("real values still satisfy their channels", () => {
  assert.equal(
    channelsSatisfied(
      {
        email: "info@shop.com",
        phone: "+1 305 555 1234",
        instagram: "https://www.instagram.com/shop/",
        website: "https://shop.com",
      },
      ["email", "phone", "instagram", "website"],
    ),
    true,
  );
});

test("an unrequested channel is never required", () => {
  assert.equal(channelsSatisfied({ email: "info@shop.com" }, ["email"]), true);
  assert.equal(channelsSatisfied({ phone: "+1 305 555 1234" }, []), true);
});

test("mergeEnrichedChannels does not let an invalid enriched value replace a valid lead value", () => {
  const merged = mergeEnrichedChannels(
    { email: "good@shop.com", instagram: "https://www.instagram.com/shop/" },
    { email: "logo@2x.png", instagram: "https://www.instagram.com/embed.js/" },
  );
  assert.equal(merged.email, "good@shop.com");
  assert.equal(merged.instagram, "https://www.instagram.com/shop/");
});

// ── Optional-channel failures must not fail the whole lead ───────────────

test("sanitizeLeadContacts drops only the invalid optional fields", () => {
  const lead = {
    name: "Joe's Pizza",
    email: "logo@2x.png",
    phone: "+1 305 555 1234",
    website: "https://joes.com",
    instagram: "https://www.instagram.com/sharer.php/",
    emails: ["logo@2x.png", "info@joes.com", { email: "x@2x.png" }],
    phones: ["+1 305 555 1234", "0000000"],
  };
  const dropped = sanitizeLeadContacts(lead);
  assert.deepEqual(dropped.sort(), ["email", "instagram"]);
  assert.equal(lead.email, "");
  assert.equal(lead.instagram, "");
  assert.equal(lead.phone, "+1 305 555 1234");
  assert.deepEqual(lead.emails, ["info@joes.com"]);
  assert.deepEqual(lead.phones, ["+1 305 555 1234"]);
  // The lead is still deliverable: it has a name and other valid channels.
  assert.deepEqual(validateLead(lead), { valid: true });
});

test("a lead with no valid channel left is still rejected", () => {
  const lead = { name: "X", email: "logo@2x.png", phone: "", website: "", instagram: "" };
  sanitizeLeadContacts(lead);
  assert.deepEqual(validateLead(lead), { valid: false, reason: "no_usable_channel" });
});

test("isValidPhone still bounds digit count", () => {
  assert.equal(isValidPhone("+20 100 123 4567"), true);
  assert.equal(isValidPhone("12345"), false);
});
