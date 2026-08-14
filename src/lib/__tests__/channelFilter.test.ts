import assert from "node:assert/strict";
import test from "node:test";
import { channelsSatisfied } from "../channelFilter.js";

test("channelsSatisfied handles empty requested channels (no filter)", () => {
  const candidate = { email: null, phone: null, instagram: null, website: null };
  assert.equal(channelsSatisfied(candidate, []), true);
});

test("channelsSatisfied handles ['email', 'phone'] requirement", () => {
  const full = { email: "a@b.com", phone: "+1234567890", website: "https://a.com" };
  const phoneOnly = { email: "", phone: "+1234567890", website: "https://a.com" };
  const emailOnly = { email: "a@b.com", phone: null, website: "https://a.com" };

  assert.equal(channelsSatisfied(full, ["email", "phone"]), true);
  assert.equal(channelsSatisfied(phoneOnly, ["email", "phone"]), false);
  assert.equal(channelsSatisfied(emailOnly, ["email", "phone"]), false);
});

test("channelsSatisfied handles ['website', 'instagram'] requirement", () => {
  const full = { website: "https://a.com", instagram: "https://instagram.com/foo" };
  const siteOnly = { website: "https://a.com", instagram: "" };

  assert.equal(channelsSatisfied(full, ["website", "instagram"]), true);
  assert.equal(channelsSatisfied(siteOnly, ["website", "instagram"]), false);
});

test("channelsSatisfied handles ['phone'] requirement", () => {
  const phoneNoSite = { phone: "+1234567890", website: null, email: null };
  const noPhone = { phone: "", website: "https://a.com" };

  assert.equal(channelsSatisfied(phoneNoSite, ["phone"]), true);
  assert.equal(channelsSatisfied(noPhone, ["phone"]), false);
});

test("channelsSatisfied handles ['email'] requirement", () => {
  const withEmail = { email: "hello@domain.com" };
  const noEmail = { email: "   ", phone: "+12345" };

  assert.equal(channelsSatisfied(withEmail, ["email"]), true);
  assert.equal(channelsSatisfied(noEmail, ["email"]), false);
});

test("channelsSatisfied handles ['website'] requirement", () => {
  const withSite = { website: "https://site.org" };
  const noSite = { website: "", phone: "+12345" };

  assert.equal(channelsSatisfied(withSite, ["website"]), true);
  assert.equal(channelsSatisfied(noSite, ["website"]), false);
});

test("channelsSatisfied handles ['instagram'] requirement", () => {
  const withIG = { instagram: "https://instagram.com/myhandle" };
  const noIG = { instagram: null };

  assert.equal(channelsSatisfied(withIG, ["instagram"]), true);
  assert.equal(channelsSatisfied(noIG, ["instagram"]), false);
});

test("channelsSatisfied handles ['email', 'instagram'] requirement", () => {
  const Both = { email: "test@co.com", instagram: "https://instagram.com/co" };
  const EmailOnly = { email: "test@co.com", instagram: "" };

  assert.equal(channelsSatisfied(Both, ["email", "instagram"]), true);
  assert.equal(channelsSatisfied(EmailOnly, ["email", "instagram"]), false);
});

test("channelsSatisfied handles ['phone', 'website', 'instagram'] requirement", () => {
  const AllThree = { phone: "+12345", website: "https://a.com", instagram: "https://instagram.com/a" };
  const MissingPhone = { phone: "", website: "https://a.com", instagram: "https://instagram.com/a" };

  assert.equal(channelsSatisfied(AllThree, ["phone", "website", "instagram"]), true);
  assert.equal(channelsSatisfied(MissingPhone, ["phone", "website", "instagram"]), false);
});
