import test from "node:test";
import assert from "node:assert/strict";
import {
  engineRequiredChannels,
  evaluateEarlyChannelPrune,
  isChannelPotentiallySatisfiable,
  leadOnlyChannels,
} from "../earlyPrune.js";

const lead = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  phone: "",
  website: "",
  email: "",
  instagram: "",
  ...over,
});

// ── 1: required website ─────────────────────────────────────────────────────

test("required website + lead has no website -> pruned before persistence", () => {
  const d = evaluateEarlyChannelPrune(lead({ phone: "+1 555 0100" }), ["website"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.deepEqual(d.missing, ["website"]);
    assert.deepEqual(d.evaluated, ["website"]);
  }
});

test("required website + lead has a website -> NOT pruned", () => {
  const d = evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["website"]);
  assert.deepEqual(d, { prune: false });
});

// ── 2: email / instagram ────────────────────────────────────────────────────

test("required email + lead has no email BUT has a usable website -> NOT pruned (enrichment may discover email)", () => {
  assert.deepEqual(
    evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["email"]),
    { prune: false },
  );
});

test("required email + lead has no email and no website -> pruned early (cannot discover email)", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["email"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.deepEqual(d.missing, ["email"]);
  }
});

test("required instagram + lead has no instagram BUT has website -> NOT pruned", () => {
  assert.deepEqual(
    evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["instagram"]),
    { prune: false },
  );
});

test("required instagram + lead has no instagram and no website -> pruned early", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["instagram"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.deepEqual(d.missing, ["instagram"]);
  }
});

test("mixed request: email + website present -> NOT pruned", () => {
  assert.deepEqual(
    evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["email", "website"]),
    { prune: false },
  );
});

test("mixed request: email + website missing -> pruned early", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["email", "website"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.ok(d.missing.includes("website"));
  }
});

// ── 3: required phone (Phase 1 Fix) ────────────────────────────────────────

test("required phone: phone present on Maps lead -> NOT pruned", () => {
  assert.deepEqual(
    evaluateEarlyChannelPrune(lead({ phone: "+1 555 0100" }), ["phone"]),
    { prune: false },
  );
});

test("required phone: phone missing on Maps lead BUT usable website exists -> NOT pruned (attempt enrichment)", () => {
  const d = evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["phone"]);
  assert.deepEqual(d, { prune: false });
});

test("required phone: phone missing on Maps lead AND NO usable website -> pruned early", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["phone"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.deepEqual(d.missing, ["phone"]);
    assert.deepEqual(d.evaluated, ["phone"]);
  }
});

test("required phone + email: phone missing on Maps, email missing on Maps, BUT usable website exists -> NOT pruned", () => {
  const d = evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["email", "phone"]);
  assert.deepEqual(d, { prune: false });
});

test("required phone + email: phone missing, email missing, AND NO website -> pruned early", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["email", "phone"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.ok(d.missing.includes("phone"));
    assert.ok(d.missing.includes("email"));
  }
});

// ── 4: reason string and helper surface ─────────────────────────────────────

test("reason string keeps the `maps_channel_gate:requested=[...]` format", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["phone", "email", "website"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.equal(d.reason, 'maps_channel_gate:requested=["phone","website"]');
  }
});

test("no requested channels never prunes", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead(), []), { prune: false });
});

test("isChannelPotentiallySatisfiable helper correctly handles channels and websites", () => {
  assert.equal(isChannelPotentiallySatisfiable(lead({ phone: "+1 555 0100" }), "phone"), true);
  assert.equal(isChannelPotentiallySatisfiable(lead({ website: "https://acme.example" }), "phone"), true);
  assert.equal(isChannelPotentiallySatisfiable(lead(), "phone"), false);
  assert.equal(isChannelPotentiallySatisfiable(lead({ website: "https://acme.example" }), "website"), true);
  assert.equal(isChannelPotentiallySatisfiable(lead(), "website"), false);
  assert.equal(isChannelPotentiallySatisfiable(lead({ website: "https://acme.example" }), "email"), true);
  assert.equal(isChannelPotentiallySatisfiable(lead(), "email"), false);
});

test("leadOnlyChannels keeps order, drops duplicates and email/instagram", () => {
  assert.deepEqual(leadOnlyChannels(["website", "email", "phone", "website", "instagram"]), ["website", "phone"]);
});

test("engineRequiredChannels never forwards email or instagram to the engine", () => {
  assert.deepEqual(engineRequiredChannels(["email", "instagram"]), []);
  assert.deepEqual(engineRequiredChannels(["email", "website"]), ["website"]);
});
