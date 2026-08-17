import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHANNELS,
  channelsForRequest,
  toggleChannelSelection,
} from "../channelSelection.js";

// ─── Default: no channel is silently pre-selected ──────────────────────────

test("DEFAULT_CHANNELS is empty — no channel, or combination, is silently forced", () => {
  assert.deepEqual(DEFAULT_CHANNELS, []);
});

// ─── toggleChannelSelection: pure add/remove, order-preserving, no dupes ──

test("toggleChannelSelection adds a channel not yet selected", () => {
  assert.deepEqual(toggleChannelSelection([], "email"), ["email"]);
  assert.deepEqual(toggleChannelSelection(["email"], "phone"), ["email", "phone"]);
});

test("toggleChannelSelection removes a channel already selected", () => {
  assert.deepEqual(toggleChannelSelection(["email", "phone"], "email"), ["phone"]);
  assert.deepEqual(toggleChannelSelection(["email", "phone"], "phone"), ["email"]);
});

test("toggleChannelSelection never produces a duplicate", () => {
  const once = toggleChannelSelection([], "email");
  const stillOnce = toggleChannelSelection(once, "email"); // toggled off
  assert.deepEqual(stillOnce, []);
});

test("toggleChannelSelection preserves the order of channels left untouched", () => {
  const withThree = ["phone", "website", "instagram"] as const;
  // Removing the middle entry must not reorder the survivors.
  assert.deepEqual(toggleChannelSelection(withThree, "website"), ["phone", "instagram"]);
});

// ─── channelsForRequest: exact pass-through, every supported combination ──
// Mirrors the combination list already covered server-side in
// tests/test_dynamic_channel_pruning.py and src/lib/__tests__/channelFilter.test.ts
// — this file proves the UI never mutates the array on its way OUT, those
// prove the engine enforces AND semantics once it arrives.

const SUPPORTED_COMBINATIONS: readonly (readonly string[])[] = [
  ["email", "phone"],
  ["website", "instagram"],
  ["phone"],
  ["email"],
  ["website"],
  ["instagram"],
  ["email", "instagram"],
  ["phone", "website", "instagram"],
];

test("channelsForRequest passes every supported combination through unchanged", () => {
  for (const combo of SUPPORTED_COMBINATIONS) {
    assert.deepEqual(channelsForRequest(combo), combo);
  }
});

test("channelsForRequest does not dedupe, sort, or otherwise transform the selection", () => {
  // Order as selected, not alphabetical/canonical order — proves this is a
  // true pass-through, not a normalization step that happens to look like one.
  assert.deepEqual(channelsForRequest(["phone", "email"]), ["phone", "email"]);
  assert.deepEqual(channelsForRequest(["instagram", "website"]), ["instagram", "website"]);
});

test("channelsForRequest returns an empty array for an empty selection (never a fallback combination)", () => {
  assert.deepEqual(channelsForRequest([]), []);
});

test("channelsForRequest returns a copy, not the same reference — selecting later never mutates a request already sent", () => {
  const selected = ["email", "phone"];
  const forRequest = channelsForRequest(selected);
  assert.notEqual(forRequest, selected);
  forRequest.push("website");
  assert.deepEqual(selected, ["email", "phone"]); // original untouched
});
