import test from "node:test";
import assert from "node:assert/strict";
import {
  isLowValueStreet,
  collapseStreetName,
  isAddressOnStreet,
} from "../streetClassifier.js";

test("Priority 2: 35 EB/35 WB/35th St Pedestrian Bridge/35th Street Access Path collapse to the same road", () => {
  const variants = [
    "35 EB",
    "35 WB",
    "35th St Pedestrian Bridge",
    "35th Street Access Path",
  ];
  const collapsed = new Set(variants.map((v) => collapseStreetName(v)));
  assert.equal(collapsed.size, 1, `Expected 1 collapsed name, got: ${Array.from(collapsed).join(", ")}`);
  assert.ok(collapsed.has("35th street"));
});

test("Priority 2: '110th Street' must not accept '311 S Wacker Dr #110'", () => {
  assert.equal(isAddressOnStreet("311 S Wacker Dr #110, Chicago, IL 60606", "110th Street"), false);
  assert.equal(isAddressOnStreet("311 S Wacker Dr Suite 110", "110th Street"), false);
});

test("Priority 2: '108th Street' must not accept '108 N State St'", () => {
  assert.equal(isAddressOnStreet("108 N State St, Chicago, IL 60602", "108th Street"), false);
});

test("Priority 2: Pedestrian Coffee (939 W Belmont Ave) must not pass for '41st Street Pedestrian Bridge'", () => {
  assert.equal(isAddressOnStreet("939 W Belmont Ave, Chicago, IL 60657", "41st Street Pedestrian Bridge"), false);
});

test("Priority 2: Valid addresses on targeted street pass", () => {
  assert.equal(isAddressOnStreet("3500 S State St, Chicago, IL 60616", "State Street"), true);
  assert.equal(isAddressOnStreet("123 W 35th St, Chicago, IL 60616", "35th Street"), true);
  assert.equal(isAddressOnStreet("123 W 35th St, Chicago, IL 60616", "35 EB"), true);
});

test("Priority 2: Low-value streets, route refs, and ramps are flagged", () => {
  assert.equal(isLowValueStreet("35 EB").isLowValue, true);
  assert.equal(isLowValueStreet("315, 379").isLowValue, true);
  assert.equal(isLowValueStreet("41st Street Pedestrian Bridge").isLowValue, true);
  assert.equal(isLowValueStreet("35th Street Access Path").isLowValue, true);
  assert.equal(isLowValueStreet("North State Street").isLowValue, false);
});
