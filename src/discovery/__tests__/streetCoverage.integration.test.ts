/**
 * Phase 2B integration proof for per-user street coverage and atomic leases.
 * Requires DATABASE_URL (or STREET_COVERAGE_TEST_DATABASE_URL) with 001-031.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const DATABASE_URL = process.env.STREET_COVERAGE_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
type Claim = { state_id: string; street_id: string; street_key: string; street_name: string; claim_token: string; claimed_at: Date; lease_expires_at: Date };
let available = false;
let admin: pg.Client; let connA: pg.Client; let connB: pg.Client; let connC: pg.Client;
const label = (prefix: string) => `street-coverage-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function makeUser(client: pg.Client): Promise<string> {
  const { rows } = await client.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${label("user")}@example.test`]);
  return rows[0].id as string;
}
async function makeStreets(client: pg.Client, city: string, count: number): Promise<{ id: string; key: string }[]> {
  const streets: { id: string; key: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const key = `${label("street")}-${i}`;
    const { rows } = await client.query(
      `insert into discovery_streets (street_key, street_name, normalized_name, country_code, region, city, source)
       values ($1, $2, $3, 'US', 'Test Region', $4, 'overpass') returning id, street_key`,
      [key, `Street ${i}`, `street-${i}`, city],
    );
    streets.push({ id: rows[0].id as string, key: rows[0].street_key as string });
  }
  return streets;
}
async function claim(client: pg.Client, params: { userId: string; niche: string; city: string; worker: string; profession?: string | null; source?: string; run?: string }): Promise<Claim | null> {
  const { rows } = await client.query(
    `select * from claim_discovery_street($1, $2, $3, 'US', $4, $5, $6, $7, 300)`,
    [params.userId, params.niche, params.profession ?? null, params.city, params.source ?? "google_maps", params.worker, params.run ?? label("run")],
  );
  return (rows[0] as Claim | undefined) ?? null;
}
async function complete(client: pg.Client, userId: string, worker: string, row: Claim): Promise<boolean> {
  const { rows } = await client.query(`select complete_discovery_street_claim($1, $2, $3, $4) as completed`, [row.state_id, userId, row.claim_token, worker]);
  return rows[0].completed as boolean;
}
async function heartbeat(client: pg.Client, userId: string, worker: string, row: Claim): Promise<boolean> {
  const { rows } = await client.query(`select heartbeat_discovery_street_claim($1, $2, $3, $4, 300) as renewed`, [row.state_id, userId, row.claim_token, worker]);
  return rows[0].renewed as boolean;
}
async function state(client: pg.Client, id: string) {
  const { rows } = await client.query(`select status, claim_token, worker_id, lease_expires_at, completed_at from user_discovery_street_state where id = $1`, [id]);
  return rows[0] as { status: string; claim_token: string | null; worker_id: string | null; lease_expires_at: Date | null; completed_at: Date | null } | undefined;
}

describe("Phase 2B: per-user street coverage and atomic claims", () => {
  before(async () => {
    if (!DATABASE_URL) { console.warn("[streetCoverage.integration.test] DATABASE_URL not set — skipping."); return; }
    admin = new pg.Client({ connectionString: DATABASE_URL }); connA = new pg.Client({ connectionString: DATABASE_URL }); connB = new pg.Client({ connectionString: DATABASE_URL }); connC = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await Promise.all([admin.connect(), connA.connect(), connB.connect(), connC.connect()]);
      await admin.query(`select claim_discovery_street($1, $2, null, $3, $4, $5, $6)`, ["00000000-0000-0000-0000-000000000000", "coverage-probe", "US", "No Streets", "google_maps", "probe"]);
      available = true;
    } catch (err) { console.warn("[streetCoverage.integration.test] database unavailable or migration 029 missing — skipping:", (err as Error).message); available = false; }
  });
  after(async () => { if (available) await Promise.all([admin.end(), connA.end(), connB.end(), connC.end()]); });

  test("TEST 1 — same user's completed street is no longer eligible", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), streets = await makeStreets(admin, city, 2), niche = label("coffee");
    const first = await claim(admin, { userId: user, niche, city, worker: "one" }); assert.ok(first); assert.equal(await complete(admin, user, "one", first!), true);
    const next = await claim(admin, { userId: user, niche, city, worker: "two" }); assert.ok(next); assert.notEqual(next!.street_id, first!.street_id); assert.ok(streets.some((s) => s.id === next!.street_id));
  });
  test("TEST 2 — a different user can claim a street user A completed", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), [a, b] = await Promise.all([makeUser(admin), makeUser(admin)]), [street] = await makeStreets(admin, city, 1), niche = label("coffee");
    const aClaim = await claim(admin, { userId: a, niche, city, worker: "a" }); assert.ok(aClaim); assert.equal(await complete(admin, a, "a", aClaim!), true);
    assert.equal((await claim(admin, { userId: b, niche, city, worker: "b" }))?.street_id, street.id);
  });
  test("TEST 3 — niche and profession definitions remain independent search scopes", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), [street] = await makeStreets(admin, city, 1);
    const coffee = await claim(admin, { userId: user, niche: label("coffee"), city, worker: "coffee" }); assert.ok(coffee); assert.equal(await complete(admin, user, "coffee", coffee!), true);
    assert.equal((await claim(admin, { userId: user, niche: label("dentist"), city, worker: "dentist" }))?.street_id, street.id);
    const professionNiche = label("same-niche");
    const graphic = await claim(admin, { userId: user, niche: professionNiche, profession: "graphic_design", city, worker: "graphic" });
    assert.ok(graphic); assert.equal(await complete(admin, user, "graphic", graphic!), true);
    assert.equal((await claim(admin, { userId: user, niche: professionNiche, profession: "digital_marketing", city, worker: "marketing" }))?.street_id, street.id);
  });
  test("TEST 4 — concurrent workers receive distinct streets", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("atomic"); await makeStreets(admin, city, 3);
    const rows = await Promise.all([claim(connA, { userId: user, niche, city, worker: "a" }), claim(connB, { userId: user, niche, city, worker: "b" }), claim(connC, { userId: user, niche, city, worker: "c" })]);
    assert.equal(rows.filter(Boolean).length, 3); assert.equal(new Set(rows.map((row) => row?.street_id)).size, 3);
  });
  test("TEST 5 — concurrent discovery runs cannot claim the same street", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("runs"); await makeStreets(admin, city, 2);
    const [one, two] = await Promise.all([claim(connA, { userId: user, niche, city, worker: "one", run: "run-one" }), claim(connB, { userId: user, niche, city, worker: "two", run: "run-two" })]);
    assert.ok(one); assert.ok(two); assert.notEqual(one!.street_id, two!.street_id);
  });
  test("TEST 6 — an expired lease becomes reclaimable and its stale token is rejected", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("expiry"); await makeStreets(admin, city, 1);
    const first = await claim(admin, { userId: user, niche, city, worker: "lost" }); assert.ok(first);
    await admin.query(`update user_discovery_street_state set lease_expires_at = now() - interval '1 second' where id = $1`, [first!.state_id]);
    const recovered = await claim(connA, { userId: user, niche, city, worker: "recovery" }); assert.equal(recovered?.state_id, first!.state_id); assert.notEqual(recovered?.claim_token, first!.claim_token);
    assert.equal(await heartbeat(connB, user, "lost", first!), false, "a stale token cannot renew a reclaimed street");
    assert.equal(await complete(connB, user, "lost", first!), false, "a stale token cannot complete a reclaimed street");
  });
  test("TEST 7 — a valid lease prevents another worker from claiming", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("active"); await makeStreets(admin, city, 1);
    assert.ok(await claim(admin, { userId: user, niche, city, worker: "owner" })); assert.equal(await claim(connA, { userId: user, niche, city, worker: "other" }), null);
  });
  test("TEST 8 — completion persists to a fresh database connection", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("persistence"); await makeStreets(admin, city, 1);
    const row = await claim(admin, { userId: user, niche, city, worker: "owner" }); assert.ok(row); assert.equal(await complete(admin, user, "owner", row!), true);
    const fresh = new pg.Client({ connectionString: DATABASE_URL }); await fresh.connect(); try { const persisted = await state(fresh, row!.state_id); assert.equal(persisted?.status, "COMPLETED"); assert.ok(persisted?.completed_at); } finally { await fresh.end(); }
  });
  test("TEST 9 — user B sees user A's completed inventory as unprocessed", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), [a, b] = await Promise.all([makeUser(admin), makeUser(admin)]), streets = await makeStreets(admin, city, 3), niche = label("isolation");
    for (let i = 0; i < 3; i++) { const row = await claim(admin, { userId: a, niche, city, worker: `a-${i}` }); assert.ok(row); assert.equal(await complete(admin, a, `a-${i}`, row!), true); }
    const bClaim = await claim(connA, { userId: b, niche, city, worker: "b" }); assert.ok(bClaim); assert.ok(streets.some((street) => street.id === bClaim!.street_id));
  });
  test("TEST 10 — initialization is idempotent for the same scope and street", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), [street] = await makeStreets(admin, city, 1), niche = label("init"), args = [user, street.id, niche, null, "US", city, "google_maps"];
    const first = await admin.query(`select initialize_user_discovery_street_state($1,$2,$3,$4,$5,$6,$7) as id`, args), second = await connA.query(`select initialize_user_discovery_street_state($1,$2,$3,$4,$5,$6,$7) as id`, args);
    assert.equal(first.rows[0].id, second.rows[0].id); const count = await admin.query(`select count(*)::int as count from user_discovery_street_state where id = $1`, [first.rows[0].id]); assert.equal(count.rows[0].count, 1);
  });
  test("TEST 11 — recovery never falsely marks an abandoned claim complete", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("city"), user = await makeUser(admin), niche = label("failed"); await makeStreets(admin, city, 1);
    const lost = await claim(admin, { userId: user, niche, city, worker: "crashed" }); assert.ok(lost); await admin.query(`update user_discovery_street_state set lease_expires_at = now() - interval '1 second' where id = $1`, [lost!.state_id]);
    const reclaimed = await claim(connA, { userId: user, niche, city, worker: "replacement" }); assert.ok(reclaimed); const recovered = await state(admin, reclaimed!.state_id); assert.equal(recovered?.status, "IN_PROGRESS"); assert.equal(recovered?.completed_at, null);
  });
  test("TEST 12 — the existing area-claim API remains available", async (t) => {
    if (!available) return t.skip("no database available"); const { rows } = await admin.query(`select exists(select 1 from pg_proc where proname = 'claim_discovery_area') as present`); assert.equal(rows[0].present, true);
  });
  test("TEST 13 — Phase 1 core tables remain present", async (t) => {
    if (!available) return t.skip("no database available"); const { rows } = await admin.query(`select to_regclass('public.businesses') as businesses, to_regclass('public.leads') as leads`); assert.equal(rows[0].businesses, "businesses"); assert.equal(rows[0].leads, "leads");
  });
  test("Phase 3 deterministic worker scenario — user A resumes at D/E while user B starts independently", async (t) => {
    if (!available) return t.skip("no database available");
    const city = label("phase3-city"), [a, b] = await Promise.all([makeUser(admin), makeUser(admin)]), niche = label("phase3-niche");
    const streets = await makeStreets(admin, city, 5);

    // makeStreets uses normalized names Street 1..5, the RPC's deterministic order.
    for (let i = 0; i < 3; i++) {
      const row = await claim(admin, { userId: a, niche, city, worker: `a-seed-${i}` });
      assert.ok(row);
      assert.equal(await complete(admin, a, `a-seed-${i}`, row!), true);
    }

    const resumed = await Promise.all([
      claim(connA, { userId: a, niche, city, worker: "a-worker-1" }),
      claim(connB, { userId: a, niche, city, worker: "a-worker-2" }),
      claim(connC, { userId: a, niche, city, worker: "a-worker-3" }),
    ]);
    const resumedIds = resumed.filter(Boolean).map((row) => row!.street_id);
    assert.deepEqual(new Set(resumedIds), new Set([streets[3].id, streets[4].id]));
    assert.equal(resumed.filter(Boolean).length, 2, "A/B/C are completed and no sixth street exists");

    const bClaims = await Promise.all([
      claim(connA, { userId: b, niche, city, worker: "b-worker-1" }),
      claim(connB, { userId: b, niche, city, worker: "b-worker-2" }),
      claim(connC, { userId: b, niche, city, worker: "b-worker-3" }),
    ]);
    assert.deepEqual(new Set(bClaims.filter(Boolean).map((row) => row!.street_id)), new Set(streets.slice(0, 3).map((street) => street.id)));
  });
});
