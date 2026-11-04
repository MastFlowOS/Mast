import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { deriveWebsiteReachable } from "../reachability.js";

describe("deriveWebsiteReachable", () => {
  test("1. website_reachable = true directly provides true", () => {
    assert.equal(
      deriveWebsiteReachable({ website_reachable: true }),
      true,
      "explicit boolean website_reachable=true must return true",
    );
    assert.equal(
      deriveWebsiteReachable(null, true),
      true,
      "explicit siteReachable=true must return true",
    );
  });

  test("2. website_reachable = false directly provides false", () => {
    assert.equal(
      deriveWebsiteReachable({ website_reachable: false }),
      false,
      "explicit boolean website_reachable=false must return false",
    );
    assert.equal(
      deriveWebsiteReachable(null, false),
      false,
      "explicit siteReachable=false must return false",
    );
  });

  test("3. homepage_fetch_failed = false inverts to true when primary is absent", () => {
    assert.equal(
      deriveWebsiteReachable({
        contact_audit: { homepage_fetch_failed: false },
      }),
      true,
      "homepage_fetch_failed=false must invert to reachable=true",
    );
  });

  test("4. homepage_fetch_failed = true inverts to false when primary is absent", () => {
    assert.equal(
      deriveWebsiteReachable({
        contact_audit: { homepage_fetch_failed: true },
      }),
      false,
      "homepage_fetch_failed=true must invert to reachable=false",
    );
  });

  test("5. both sources missing leaves reachability undefined", () => {
    assert.equal(
      deriveWebsiteReachable({}),
      undefined,
      "empty signals must yield undefined reachability",
    );
    assert.equal(
      deriveWebsiteReachable(null),
      undefined,
      "null signals must yield undefined reachability",
    );
    assert.equal(
      deriveWebsiteReachable(undefined),
      undefined,
      "undefined signals must yield undefined reachability",
    );
  });

  test("6. contactAudit missing leaves reachability undefined", () => {
    assert.equal(
      deriveWebsiteReachable({
        tech_stack: { server: "nginx" },
      }),
      undefined,
      "missing contact_audit without primary signal must yield undefined reachability",
    );
  });

  test("7. homepage_fetch_failed undefined in contactAudit leaves reachability undefined", () => {
    assert.equal(
      deriveWebsiteReachable({
        contact_audit: { pages_crawled: 3 },
      }),
      undefined,
      "contact_audit lacking homepage_fetch_failed must not evaluate to true",
    );
  });

  test("8. primary signal takes precedence over fallback", () => {
    // Primary true, fallback says failed=true (which would invert to false)
    assert.equal(
      deriveWebsiteReachable({
        website_reachable: true,
        contact_audit: { homepage_fetch_failed: true },
      }),
      true,
      "primary website_reachable=true must take precedence over fallback failed=true",
    );

    // Primary false, fallback says failed=false (which would invert to true)
    assert.equal(
      deriveWebsiteReachable({
        website_reachable: false,
        contact_audit: { homepage_fetch_failed: false },
      }),
      false,
      "primary website_reachable=false must take precedence over fallback failed=false",
    );
  });

  test("9. existing website URL does not automatically mean reachable", () => {
    // Neither signals nor contact_audit has reachability info, even when website URL exists
    assert.equal(
      deriveWebsiteReachable({ website: "https://example.com", signals: {} }),
      undefined,
      "website URL presence on enriched row must not fabricate reachability",
    );
    assert.equal(
      deriveWebsiteReachable({ website: "https://example.com", signals: { contact_audit: {} } }),
      undefined,
      "website URL presence with empty contact_audit must not fabricate reachability",
    );
    assert.equal(
      deriveWebsiteReachable({ website: "https://example.com" }),
      undefined,
      "website URL presence must not fabricate reachability",
    );
  });
});
