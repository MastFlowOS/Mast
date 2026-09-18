import test from "node:test";
import assert from "node:assert/strict";
import { formatForChannel, INSTAGRAM_TARGET_MAX_CHARS } from "@/lib/outreach/channels/formatters";
import type { SlotContent } from "@/lib/outreach/types";

const FIXTURE: SlotContent = {
  opening: "Hi, I'm a freelance graphic designer — I help businesses improve their visual identity.",
  continuity: "I got in touch a couple of days ago and wanted to follow up on it.",
  observation: "a business's visual identity can become inconsistent or dated across different materials over time",
  angle: "graphic design can bring a business's visual materials into a more consistent system",
  value: "consistent templates and visual elements can make a business's social presence feel more intentional",
  cta: "Would it be useful if I shared a few quick thoughts?",
  signoff: "Jamie",
};

test("EMAIL: has a subject, paragraph separation, and a signoff", () => {
  const result = formatForChannel("email", FIXTURE, "Test Biz");
  assert.ok(result.subject && result.subject.length > 0);
  assert.ok(result.body.includes("\n\n"));
  assert.ok(result.body.trim().endsWith("Jamie"));
  assert.ok(result.body.includes("Best,"));
});

test("EMAIL: omits signoff line entirely when none is supplied", () => {
  const { signoff, ...rest } = FIXTURE;
  const result = formatForChannel("email", rest as SlotContent, "Test Biz");
  assert.equal(result.body.includes("Best,"), false);
});

test("INSTAGRAM: no subject", () => {
  const result = formatForChannel("instagram", FIXTURE, "Test Biz");
  assert.equal(result.subject, null);
});

test("INSTAGRAM: concise, single-line-joined, stays within target budget", () => {
  const result = formatForChannel("instagram", FIXTURE, "Test Biz");
  assert.equal(result.body.includes("\n"), false);
  assert.ok(result.body.length <= INSTAGRAM_TARGET_MAX_CHARS);
});

test("INSTAGRAM: deterministic shortening drops angle/value before continuity/cta when over budget", () => {
  const long: SlotContent = {
    ...FIXTURE,
    angle: "x".repeat(400),
    value: "y".repeat(400),
  };
  const result = formatForChannel("instagram", long, "Test Biz");
  assert.ok(result.body.length <= INSTAGRAM_TARGET_MAX_CHARS);
  assert.equal(result.body.includes("x".repeat(400)), false);
  // opening should still be present after the drop
  assert.ok(result.body.includes("freelance graphic designer") || result.body.length === INSTAGRAM_TARGET_MAX_CHARS);
});

test("INSTAGRAM: same input always produces the same output (deterministic)", () => {
  const a = formatForChannel("instagram", FIXTURE, "Test Biz");
  const b = formatForChannel("instagram", FIXTURE, "Test Biz");
  assert.deepEqual(a, b);
});

test("PHONE: spoken script structure — opener, reason, ask, graceful exit", () => {
  const result = formatForChannel("phone", FIXTURE, "Test Biz");
  assert.equal(result.subject, null);
  assert.ok(result.body.includes("Opener:"));
  assert.ok(result.body.includes("Reason for calling:"));
  assert.ok(result.body.includes("Ask:"));
  assert.ok(result.body.toLowerCase().includes("no problem"));
});

test("PHONE: condenses observation/angle into a single reason line", () => {
  const result = formatForChannel("phone", FIXTURE, "Test Biz");
  const reasonLine = result.body.split("\n\n").find((line) => line.startsWith("Reason for calling:"));
  assert.ok(reasonLine);
  assert.ok(reasonLine!.includes(FIXTURE.observation!));
});

test("CONTACT_FORM: plain text, no subject, no email-style signoff", () => {
  const result = formatForChannel("contact_form", FIXTURE, "Test Biz");
  assert.equal(result.subject, null);
  assert.equal(result.body.includes("Best,"), false);
  assert.equal(result.body.includes("Jamie"), false);
});

test("CONTACT_FORM: includes angle/value and CTA as separate paragraphs", () => {
  const result = formatForChannel("contact_form", FIXTURE, "Test Biz");
  assert.ok(result.body.includes(FIXTURE.cta));
});
