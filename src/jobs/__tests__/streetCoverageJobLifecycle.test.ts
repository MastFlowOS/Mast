import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const discoveryPlanJobSrc = readFileSync(
  path.join(__dirname, "../discoveryPlanJob.ts"),
  "utf8",
);

const poolExpandJobSrc = readFileSync(
  path.join(__dirname, "../poolExpandJob.ts"),
  "utf8",
);

const streetDiscoverySrc = readFileSync(
  path.join(__dirname, "../../discovery/streetDiscovery.ts"),
  "utf8",
);

describe("Street Coverage Job Lifecycle & Diagnostics", () => {
  test("streetDiscovery.ts exports releaseDiscoveryStreetClaim", () => {
    assert.match(
      streetDiscoverySrc,
      /export async function releaseDiscoveryStreetClaim\(/,
      "streetDiscovery.ts must export releaseDiscoveryStreetClaim",
    );
  });

  test("discoveryPlanJob.ts imports releaseDiscoveryStreetClaim", () => {
    assert.match(
      discoveryPlanJobSrc,
      /releaseDiscoveryStreetClaim/,
      "discoveryPlanJob.ts must import releaseDiscoveryStreetClaim",
    );
  });

  test("discoveryPlanJob.ts calls releaseDiscoveryStreetClaim when street is not completed", () => {
    assert.match(
      discoveryPlanJobSrc,
      /releaseDiscoveryStreetClaim\(db,\s*claim,\s*streetScope\.userId,\s*slotWorkerLabel\)/,
      "discoveryPlanJob.ts must call releaseDiscoveryStreetClaim when street is not completed",
    );
  });

  test("discoveryPlanJob.ts logs one mode line stating mode, inventory and fallback_reason", () => {
    assert.match(
      discoveryPlanJobSrc,
      /mode=\$\{useStreetPool \? "street" : "area"\}\s+inventory=\$\{streetCount\}\s+fallback_reason=/,
      "discoveryPlanJob.ts must log mode line with mode, inventory, and fallback_reason",
    );
  });

  test("poolExpandJob.ts imports and calls releaseDiscoveryStreetClaim when street is not completed", () => {
    assert.match(
      poolExpandJobSrc,
      /releaseDiscoveryStreetClaim/,
      "poolExpandJob.ts must import releaseDiscoveryStreetClaim",
    );
    assert.match(
      poolExpandJobSrc,
      /releaseDiscoveryStreetClaim\(supabaseAdmin,\s*streetClaim,\s*streetScope\.userId,\s*slotWorkerId\)/,
      "poolExpandJob.ts must call releaseDiscoveryStreetClaim when street is not completed",
    );
  });
});
