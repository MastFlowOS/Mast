import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContactUpdate,
  mergeEmailLists,
  mergePhoneLists,
  phoneDedupKey,
} from "../contactMerge.js";

// ── Rediscovery must not silently discard newly found contact data ─────────

test("rediscovery fills a missing email/phone/instagram/website", () => {
  const update = buildContactUpdate(
    { email: null, phone: null, instagram: null, website: null, emails: [], phones: [] },
    {
      email: "hello@shop.com",
      phone: "+1 (305) 555-1234",
      instagram: "https://www.instagram.com/shop/",
      website: "https://shop.com",
      emails: ["hello@shop.com"],
      phones: ["+1 (305) 555-1234"],
    },
  );
  assert.equal(update.email, "hello@shop.com");
  assert.equal(update.phone, "+1 (305) 555-1234");
  assert.equal(update.instagram, "https://www.instagram.com/shop/");
  assert.equal(update.website, "https://shop.com");
  assert.deepEqual(update.emails, ["hello@shop.com"]);
  assert.deepEqual(update.phones, ["+1 (305) 555-1234"]);
});

test("a stored valid value is never overwritten by a different one", () => {
  const update = buildContactUpdate(
    {
      email: "owner@shop.com",
      phone: "+1 (305) 555-1234",
      instagram: "https://www.instagram.com/shop/",
      website: "https://shop.com",
      emails: ["owner@shop.com"],
      phones: ["+1 (305) 555-1234"],
    },
    {
      email: "other@shop.com",
      phone: "+1 (212) 555-9999",
      instagram: "https://www.instagram.com/other/",
      website: "https://other.com",
    },
  );
  assert.equal("email" in update, false);
  assert.equal("phone" in update, false);
  assert.equal("instagram" in update, false);
  assert.equal("website" in update, false);
});

test("empty or invalid incoming values never overwrite or clear anything", () => {
  const existing = {
    email: "owner@shop.com",
    phone: "+1 (305) 555-1234",
    instagram: "https://www.instagram.com/shop/",
    website: "https://shop.com",
    emails: ["owner@shop.com"],
    phones: ["+1 (305) 555-1234"],
  };
  const update = buildContactUpdate(existing, {
    email: "",
    phone: null,
    instagram: "https://www.instagram.com/embed.js/",
    website: "",
    emails: ["logo@2x.png"],
    phones: ["0000000"],
  });
  assert.deepEqual(update, {});
});

test("a stored INVALID legacy value is replaced by a newly found valid one", () => {
  const update = buildContactUpdate(
    {
      email: "logo@2x.png",
      instagram: "https://www.instagram.com/sharer.php/",
      emails: ["logo@2x.png"],
    },
    {
      email: "info@shop.com",
      instagram: "https://www.instagram.com/shop/",
      emails: ["info@shop.com"],
    },
  );
  assert.equal(update.email, "info@shop.com");
  assert.equal(update.instagram, "https://www.instagram.com/shop/");
  // The legacy junk entry is dropped from the merged list.
  assert.deepEqual(update.emails, ["info@shop.com"]);
});

// ── Arrays are merged, never replaced ─────────────────────────────────────

test("emails and phones are merged and de-duplicated, existing first", () => {
  const update = buildContactUpdate(
    {
      emails: ["a@shop.com", "b@shop.com"],
      phones: ["+1 (305) 555-1234"],
      email: "a@shop.com",
      phone: "+1 (305) 555-1234",
    },
    { emails: ["B@Shop.com", "c@shop.com"], phones: ["305.555.1234", "+1 (212) 555-9999"] },
  );
  assert.deepEqual(update.emails, ["a@shop.com", "b@shop.com", "c@shop.com"]);
  // 305.555.1234 is the same number as +1 (305) 555-1234.
  assert.deepEqual(update.phones, ["+1 (305) 555-1234", "+1 (212) 555-9999"]);
});

test("a poorer rediscovery never shrinks a richer stored list", () => {
  const update = buildContactUpdate(
    { emails: ["a@shop.com", "b@shop.com", "c@shop.com"], email: "a@shop.com" },
    { emails: ["a@shop.com"] },
  );
  assert.equal("emails" in update, false);
});

test("{email, role} shaped stored entries are understood", () => {
  const merged = mergeEmailLists(
    [{ email: "a@shop.com", role: "info" }, "b@shop.com"],
    ["a@shop.com", { email: "c@shop.com" }],
  );
  assert.deepEqual(merged, ["a@shop.com", "b@shop.com", "c@shop.com"]);
});

test("an unchanged business produces no update at all", () => {
  const same = {
    email: "a@shop.com",
    phone: "+1 (305) 555-1234",
    emails: ["a@shop.com"],
    phones: ["+1 (305) 555-1234"],
    instagram: "https://www.instagram.com/shop/",
    website: "https://shop.com",
  };
  assert.deepEqual(buildContactUpdate(same, { ...same }), {});
});

test("phoneDedupKey treats equivalent numbers as one", () => {
  assert.equal(phoneDedupKey("+20 100 123 4567"), phoneDedupKey("0100 123 4567"));
  assert.equal(phoneDedupKey("+1 (305) 555-1234"), phoneDedupKey("305-555-1234"));
  assert.deepEqual(mergePhoneLists(["+20 100 123 4567"], ["0100 123 4567"]), ["+20 100 123 4567"]);
});
