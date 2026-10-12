import test from "node:test";
import assert from "node:assert/strict";
import {
  engineRequiredChannels,
  evaluateEarlyChannelPrune,
  leadOnlyChannels,
} from "../earlyPrune.js";
import { channelsSatisfied } from "../../lib/channelFilter.js";

const lead = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  phone: "",
  website: "",
  email: "",
  instagram: "",
  ...over,
});

// ── 1 / 2: required website ─────────────────────────────────────────────────

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

// ── 3: email / instagram are never decided at this stage ────────────────────

test("required email + lead has no email and no website -> NOT pruned (enrichment / existing row may supply it)", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead(), ["email"]), { prune: false });
});

test("required instagram + lead has no instagram -> NOT pruned", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead(), ["instagram"]), { prune: false });
});

test("email+instagram requested together never prune on their own", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead(), ["email", "instagram"]), { prune: false });
});

test("mixed request: email is ignored, website still decides", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["email", "website"]);
  assert.equal(d.prune, true);
  if (d.prune) {
    assert.deepEqual(d.evaluated, ["website"]);
    assert.deepEqual(d.missing, ["website"]);
  }
  assert.deepEqual(
    evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["email", "website"]),
    { prune: false },
  );
});

// ── 4: required phone ───────────────────────────────────────────────────────

test("required phone: present passes, absent prunes", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead({ phone: "+1 555 0100" }), ["phone"]), { prune: false });
  const d = evaluateEarlyChannelPrune(lead(), ["phone"]);
  assert.equal(d.prune, true);
  if (d.prune) assert.deepEqual(d.missing, ["phone"]);
});

test("required phone is strict on the lead even when a website exists (parity with the pre-existing post-upsert gate; enrichment is never consulted for phone in Live Discovery)", () => {
  const d = evaluateEarlyChannelPrune(lead({ website: "https://acme.example" }), ["phone"]);
  assert.equal(d.prune, true);
});

// ── 5 / parity: verdict identical to the gate this replaced ─────────────────

test("verdict is identical to the legacy post-upsert gate across a full matrix", () => {
  const legacy = (l: ReturnType<typeof lead>, req: string[]) =>
    !channelsSatisfied(l, req.filter((c) => c === "phone" || c === "website"));
  const phones = ["", "+1 555 0100"];
  const sites = ["", "https://acme.example"];
  const reqs = [
    [], ["phone"], ["website"], ["email"], ["instagram"],
    ["phone", "website"], ["email", "website"], ["email", "phone"],
    ["phone", "website", "email", "instagram"],
  ];
  for (const phone of phones) for (const website of sites) for (const req of reqs) {
    const l = lead({ phone, website });
    assert.equal(
      evaluateEarlyChannelPrune(l, req).prune,
      legacy(l, req),
      `phone=${JSON.stringify(phone)} website=${JSON.stringify(website)} req=${JSON.stringify(req)}`,
    );
  }
});

test("reason string keeps the legacy `maps_channel_gate:requested=[...]` format so candidate_rejected consumers are unaffected", () => {
  const d = evaluateEarlyChannelPrune(lead(), ["phone", "email", "website"]);
  assert.equal(d.prune, true);
  if (d.prune) assert.equal(d.reason, 'maps_channel_gate:requested=["phone","website"]');
});

test("no requested channels never prunes", () => {
  assert.deepEqual(evaluateEarlyChannelPrune(lead(), []), { prune: false });
});

// ── helper surface ──────────────────────────────────────────────────────────

test("leadOnlyChannels keeps order, drops duplicates and email/instagram", () => {
  assert.deepEqual(leadOnlyChannels(["website", "email", "phone", "website", "instagram"]), ["website", "phone"]);
});

test("engineRequiredChannels never forwards email or instagram to the engine", () => {
  assert.deepEqual(engineRequiredChannels(["email", "instagram"]), []);
  assert.deepEqual(engineRequiredChannels(["email", "website"]), ["website"]);
});
