/**
 * Phase 3C-4C-B — geographic search rotation.
 *
 * These tests exercise the REAL `claim_discovery_area()` /
 * `record_discovery_area_outcome()` Postgres functions (migrations/026)
 * against a real database — matching the existing convention in this
 * directory (discoveryConcurrency.integration.test.ts, itself modeled on
 * poolExpandDeliveryReservation.test.ts). A JS-level simulation cannot
 * prove either of these:
 *
 *   E — area state survives a fresh connection (simulates a worker
 *       restart): last_searched_at must be durable in Postgres, not just
 *       held in an in-process Map.
 *   F — two genuinely concurrent connections claiming for the SAME city
 *       must land on two DIFFERENT areas when alternatives exist — this is
 *       exactly the race the `for update skip locked` clause in
 *       claim_discovery_area() exists to prevent, and only a real
 *       multi-connection race can prove it actually does.
 *
 * Requires DATABASE_URL (or AREA_ROTATION_TEST_DATABASE_URL) pointing at a
 * Postgres instance with migrations 001-026 applied. If neither is
 * reachable, every test in this file is skipped (not failed) — this
 * environment has no such database reachable, so this suite could not be
 * run here; see the final report for that explicit statement.
 *
 * Run with:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/mast_test \
 *     npx tsx --test src/discovery/__tests__/areaRotation.integration.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const DATABASE_URL = process.env.AREA_ROTATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let poolAvailable = false;
let admin: pg.Client;
let connA: pg.Client;
let connB: pg.Client;
let connC: pg.Client;

async function claimArea(
  client: pg.Client,
  params: { niche: string; countryCode: string; city: string; source: string; areas: string[]; cooldownSeconds?: number },
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT claim_discovery_area($1, $2, $3, $4, $5, $6) AS area`,
    [params.niche, params.countryCode, params.city, params.source, params.areas, params.cooldownSeconds ?? 21600],
  );
  return rows[0].area as string | null;
}

async function recordOutcome(
  client: pg.Client,
  params: { niche: string; countryCode: string; city: string; area: string; source: string; discovered: number; accepted: number },
): Promise<void> {
  await client.query(
    `SELECT record_discovery_area_outcome($1, $2, $3, $4, $5, $6, $7)`,
    [params.niche, params.countryCode, params.city, params.area, params.source, params.discovered, params.accepted],
  );
}

async function readAreaStats(client: pg.Client, niche: string, countryCode: string, city: string, area: string) {
  const { rows } = await client.query(
    `SELECT searches, discovered_count, accepted_count, last_searched_at
     FROM discovery_area_stats
     WHERE niche = $1 AND country_code = $2 AND city = $3 AND area = $4`,
    [niche, countryCode, city, area],
  );
  return rows[0] as { searches: number; discovered_count: number; accepted_count: number; last_searched_at: Date | null } | undefined;
}

// Unique per-run niche so parallel CI runs / repeated local runs never
// collide on the same discovery_area_stats rows (same pattern as
// discoveryConcurrency.integration.test.ts's Date.now()-based test emails).
function testNiche(label: string): string {
  return `area-rotation-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("Phase 3C-4C-B: geographic area rotation — atomic claim + persistence", () => {
  before(async () => {
    if (!DATABASE_URL) {
      console.warn(
        "[areaRotation.integration.test] DATABASE_URL not set — skipping. " +
          "Set DATABASE_URL to a Postgres instance with migrations 001-026 applied to run this suite.",
      );
      return;
    }
    admin = new pg.Client({ connectionString: DATABASE_URL });
    connA = new pg.Client({ connectionString: DATABASE_URL });
    connB = new pg.Client({ connectionString: DATABASE_URL });
    connC = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await admin.connect();
      await connA.connect();
      await connB.connect();
      await connC.connect();
      await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'claim_discovery_area'`);
      await admin.query(`SELECT area FROM discovery_area_stats LIMIT 0`); // confirms migration 026 is applied
      poolAvailable = true;
    } catch (err) {
      console.warn("[areaRotation.integration.test] could not reach test database — skipping:", (err as Error).message);
      poolAvailable = false;
    }
  });

  after(async () => {
    if (!poolAvailable) return;
    await admin.end();
    await connA.end();
    await connB.end();
    await connC.end();
  });

  // ── Test F: concurrent claim for the same city returns different areas ──
  test("Test F — three concurrent workers claiming for the SAME city each get a different area", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const niche = testNiche("f");
    const areas = ["Brooklyn", "Queens", "Manhattan"];

    const results = await Promise.all([
      claimArea(connA, { niche, countryCode: "US", city: "New York", source: "google_maps", areas }),
      claimArea(connB, { niche, countryCode: "US", city: "New York", source: "google_maps", areas }),
      claimArea(connC, { niche, countryCode: "US", city: "New York", source: "google_maps", areas }),
    ]);

    assert.equal(results.filter((r) => r !== null).length, 3, "all three concurrent claims must succeed");
    assert.equal(new Set(results).size, 3, "three concurrent claimants must land on three DIFFERENT areas, not the same one");
    assert.deepEqual(new Set(results), new Set(areas));
  });

  // ── Test E: area state persists across a fresh connection (simulated restart) ──
  test("Test E — last_searched_at persists after a fresh connection, and outcome counters accumulate", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const niche = testNiche("e");
    const areas = ["Brooklyn", "Queens"];

    const first = await claimArea(admin, { niche, countryCode: "US", city: "New York", source: "google_maps", areas });
    assert.ok(first);
    await recordOutcome(admin, { niche, countryCode: "US", city: "New York", area: first!, source: "google_maps", discovered: 12, accepted: 3 });

    // A brand-new connection (simulates a worker restart) must see the
    // SAME durable state, not a fresh/empty one.
    const fresh = new pg.Client({ connectionString: DATABASE_URL });
    await fresh.connect();
    try {
      const stats = await readAreaStats(fresh, niche, "US", "New York", first!);
      assert.ok(stats, "area row must exist for a fresh connection to read");
      assert.ok(stats!.last_searched_at, "last_searched_at must be durably persisted, not held only in process memory");
      assert.equal(stats!.searches, 1);
      assert.equal(stats!.discovered_count, 12);
      assert.equal(stats!.accepted_count, 3);

      // A second outcome call on the SAME area accumulates, mirroring
      // record_discovery_location_outcome()'s (migration 016) own tested
      // accumulate-not-overwrite behavior.
      await recordOutcome(fresh, { niche, countryCode: "US", city: "New York", area: first!, source: "google_maps", discovered: 4, accepted: 1 });
      const accumulated = await readAreaStats(fresh, niche, "US", "New York", first!);
      assert.equal(accumulated!.searches, 2);
      assert.equal(accumulated!.discovered_count, 16);
      assert.equal(accumulated!.accepted_count, 4);
    } finally {
      await fresh.end();
    }
  });

  // ── Cooldown fallback proven against the real function, not just the pure JS mirror ──
  test("cooldown + fallback: a fresh claim skips the just-claimed area until it's the only option left", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const niche = testNiche("cooldown");
    const areas = ["Brooklyn", "Queens"];

    const brooklynFirst = await claimArea(admin, { niche, countryCode: "US", city: "New York", source: "google_maps", areas, cooldownSeconds: 3600 });
    assert.ok(brooklynFirst);

    // Second claim, same location, same long cooldown: must pick the
    // OTHER (never-searched) area, not re-claim the one just searched.
    const second = await claimArea(admin, { niche, countryCode: "US", city: "New York", source: "google_maps", areas, cooldownSeconds: 3600 });
    assert.notEqual(second, brooklynFirst, "the just-claimed area must not be re-selected while eligible alternatives exist");

    // Third claim: both areas are now inside the (long) cooldown window —
    // fallback policy must still return one of the two areas, never null.
    const third = await claimArea(admin, { niche, countryCode: "US", city: "New York", source: "google_maps", areas, cooldownSeconds: 3600 });
    assert.ok(areas.includes(third as string), "fallback must still return one of the curated areas rather than stalling");
  });
});
