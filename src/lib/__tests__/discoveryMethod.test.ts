/**
 * Discovery method semantics: derived from the plan by the server, mirrored
 * (not re-invented) by the UI. These pin the mapping so the Discover page can
 * never claim a method the backend does not run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PLANS } from "../../config/plans.js";
import {
  DISCOVERY_METHODS,
  discoveryMethodForPlan,
  generationModeFor,
  isDiscoveryMethodEligible,
  nextDiscoveryMethod,
} from "../discoveryMethod.js";

test("every plan maps to exactly the method the server runs (config/plans.ts is the source of truth)", () => {
  for (const plan of Object.values(PLANS)) {
    assert.equal(discoveryMethodForPlan(plan.id).id, plan.discoveryMode, plan.id);
  }
});

test("Free = live, Starter = instant pool, Pro/Premium = ranked instant pool", () => {
  assert.equal(discoveryMethodForPlan("free").id, "live");
  assert.equal(discoveryMethodForPlan("starter").id, "instant_pool");
  assert.equal(discoveryMethodForPlan("pro").id, "instant_pool_ranked");
  assert.equal(discoveryMethodForPlan("premium").id, "instant_pool_ranked");
  assert.equal(discoveryMethodForPlan(undefined).id, "live");
});

test("the comparison lists exactly the three backend modes — nothing the backend does not run", () => {
  assert.deepEqual(DISCOVERY_METHODS.map((m) => m.id), ["live", "instant_pool", "instant_pool_ranked"]);
});

test("each method's minimum plan is the lowest plan that actually runs it", () => {
  for (const m of DISCOVERY_METHODS) {
    const lowest = Object.values(PLANS).find((p) => p.discoveryMode === m.id)!;
    assert.equal(m.minPlan, lowest.id, m.id);
  }
});

test("upgrade target is the next method up; none on the top method", () => {
  assert.equal(nextDiscoveryMethod("free")?.id, "instant_pool");
  assert.equal(nextDiscoveryMethod("starter")?.id, "instant_pool_ranked");
  assert.equal(nextDiscoveryMethod("pro"), null);
  assert.equal(nextDiscoveryMethod("premium"), null);
});

test("request mode value matches what the server will do", () => {
  assert.equal(generationModeFor("live"), "scrape");
  assert.equal(generationModeFor("instant_pool"), "pool");
  assert.equal(generationModeFor("instant_pool_ranked"), "premium");
});

test("isDiscoveryMethodEligible: a plan may select its own ceiling and everything below it, nothing above", () => {
  assert.equal(isDiscoveryMethodEligible("free", "live"), true);
  assert.equal(isDiscoveryMethodEligible("free", "instant_pool"), false);
  assert.equal(isDiscoveryMethodEligible("free", "instant_pool_ranked"), false);

  assert.equal(isDiscoveryMethodEligible("starter", "live"), true);
  assert.equal(isDiscoveryMethodEligible("starter", "instant_pool"), true);
  assert.equal(isDiscoveryMethodEligible("starter", "instant_pool_ranked"), false);

  assert.equal(isDiscoveryMethodEligible("pro", "live"), true);
  assert.equal(isDiscoveryMethodEligible("pro", "instant_pool"), true);
  assert.equal(isDiscoveryMethodEligible("pro", "instant_pool_ranked"), true);

  assert.equal(isDiscoveryMethodEligible("premium", "instant_pool_ranked"), true);
});
