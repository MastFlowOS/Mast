import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { supabaseAdmin } = await import("../../lib/supabaseAdmin.js");
const { insertLeadForUser, resolveLeadCooldownDays } = await import("../../scraperBridge/deliverLead.js");
const { lookupAndDeliverFromPool } = await import("../../lib/poolLookup.js");
const { getCooldownSnapshotForTask } = await import("../../jobs/discoveryPlanJob.js");
const { FakeDb, installFakeSupabase } = await import("../../lib/__tests__/helpers/fakeSupabaseAdmin.js");

describe("15-Day Cross-User Lead Cooldown Protection", () => {
  it("resolveLeadCooldownDays defaults to 15 days and respects LEAD_COOLDOWN_DAYS env", () => {
    const prev = process.env.LEAD_COOLDOWN_DAYS;
    try {
      delete process.env.LEAD_COOLDOWN_DAYS;
      assert.equal(resolveLeadCooldownDays(), 15);

      process.env.LEAD_COOLDOWN_DAYS = "21";
      assert.equal(resolveLeadCooldownDays(), 21);

      process.env.LEAD_COOLDOWN_DAYS = "invalid";
      assert.equal(resolveLeadCooldownDays(), 15);
    } finally {
      if (prev === undefined) delete process.env.LEAD_COOLDOWN_DAYS;
      else process.env.LEAD_COOLDOWN_DAYS = prev;
    }
  });

  it("insertLeadForUser forwards cooldown_days=15 in p_lead_row to deliver_lead_for_user RPC", async () => {
    const originalRpc = (supabaseAdmin as any).rpc;
    const originalFrom = (supabaseAdmin as any).from;
    let capturedArgs: any = null;

    (supabaseAdmin as any).rpc = async (fn: string, args: any) => {
      if (fn === "deliver_lead_for_user") {
        capturedArgs = args;
        return {
          data: [
            {
              status: "delivered",
              lead_id: 101,
              was_new_for_user: true,
              credit_charged: true,
              limit_reached: false,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    };
    (supabaseAdmin as any).from = () => ({
      insert: async () => ({ data: null, error: null }),
    });

    try {
      const res = await insertLeadForUser(
        {
          id: "biz-cooldown-1",
          name: "Downtown Roasters",
          niche: "Coffee Shop",
          address: "100 Main St",
          website: "https://downtownroasters.com",
          email: "hello@downtownroasters.com",
          phone: "+12125550100",
          instagram: "downtownroasters",
        },
        {
          userId: "user-a",
          professionSlug: "web_design",
          discoveryMode: "live",
          scrapeJobId: "job-1",
          dailyLimit: 25,
          monthlyLimit: 500,
          discoveryPlanId: "plan-1",
        },
      );

      assert.equal(res.wasNewForUser, true);
      assert.ok(capturedArgs, "deliver_lead_for_user must be called");
      assert.equal(capturedArgs.p_lead_row.cooldown_days, 15);
    } finally {
      (supabaseAdmin as any).rpc = originalRpc;
      (supabaseAdmin as any).from = originalFrom;
    }
  });

  it("Instant Pool excludes businesses with active 15-day cooldown and delivers expired cooldown businesses", async () => {
    const db = new FakeDb();
    const restore = installFakeSupabase(supabaseAdmin, db);

    try {
      const futureIso = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const expiredIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      db.businesses.push(
        {
          id: "biz-active-cooldown",
          name: "Cooldown Coffee",
          niche: "Coffee Shop",
          region: "New York",
          country_code: "US",
          address: "1 Broadway, NY",
          website: "https://cooldowncoffee.com",
          email: "hi@cooldowncoffee.com",
          phone: "+12125550101",
          instagram: "cooldowncoffee",
          is_disqualified: false,
          cooldown_until: futureIso,
          first_discovered_at: "2026-11-10T00:00:00Z",
        },
        {
          id: "biz-expired-cooldown",
          name: "Fresh Again Coffee",
          niche: "Coffee Shop",
          region: "New York",
          country_code: "US",
          address: "2 Broadway, NY",
          website: "https://freshagaincoffee.com",
          email: "hi@freshagaincoffee.com",
          phone: "+12125550102",
          instagram: "freshagaincoffee",
          is_disqualified: false,
          cooldown_until: expiredIso,
          first_discovered_at: "2026-11-09T00:00:00Z",
        },
        {
          id: "biz-never-delivered",
          name: "Brand New Cafe",
          niche: "Coffee Shop",
          region: "New York",
          country_code: "US",
          address: "3 Broadway, NY",
          website: "https://brandnewcafe.com",
          email: "hi@brandnewcafe.com",
          phone: "+12125550103",
          instagram: "brandnewcafe",
          is_disqualified: false,
          cooldown_until: null,
          first_discovered_at: "2026-11-08T00:00:00Z",
        },
      );

      const poolRes = await lookupAndDeliverFromPool({
        userId: "user-b",
        region: "United States",
        niche: "Coffee Shop",
        quantity: 5,
        professionSlug: "web_design",
        rank: false,
        scrapeJobId: "job-pool-1",
        dailyLimit: 50,
        monthlyLimit: 500,
        channels: ["email"],
      });

      const deliveredIds = poolRes.delivered.map((d) => d.businessId);
      assert.ok(!deliveredIds.includes("biz-active-cooldown"), "Active cooldown business must NOT be delivered to User B");
      assert.ok(deliveredIds.includes("biz-expired-cooldown"), "Expired cooldown business must be eligible again");
      assert.ok(deliveredIds.includes("biz-never-delivered"), "Fresh business with null cooldown_until must be delivered");
      assert.equal(deliveredIds.length, 2);

      // Verify that delivering biz-never-delivered stamped a new future cooldown_until on it
      const updatedFresh = db.businesses.find((b) => b.id === "biz-never-delivered")!;
      assert.ok(updatedFresh.cooldown_until, "Delivering a business must stamp cooldown_until");
      assert.ok(Date.parse(updatedFresh.cooldown_until) > Date.now() + 14 * 24 * 60 * 60 * 1000);
    } finally {
      restore();
    }
  });

  it("getCooldownSnapshotForTask loads placeIds, brand domains, and instagrams for 0ms pre-click & pre-enrichment skip", async () => {
    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        const builder: any = {
          select: () => builder,
          gt: (col: string, val: string) => {
            assert.equal(col, "cooldown_until");
            assert.ok(val.length > 0);
            return builder;
          },
          or: () => builder,
          order: () => builder,
          limit: async () => ({
            data: [
              {
                id: "b1",
                place_id: "ChIJp8X00DwsDogRfY6fChsuPUw",
                fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"],
                website: "https://www.BlueBottleSoho.com/menu",
                instagram: "https://instagram.com/BlueBottleSoho/",
                cooldown_until: new Date(Date.now() + 10 * 86400_000).toISOString(),
              },
            ],
            error: null,
          }),
        };
        return builder;
      },
    };

    const snapshot = await getCooldownSnapshotForTask(mockDb, "US");
    assert.ok(snapshot.placeIds.includes("ChIJp8X00DwsDogRfY6fChsuPUw"), "Must include direct place_id");
    assert.ok(
      snapshot.placeIds.some((id) => id.includes("0x880fcd7f8fee01b5")),
      "Must include place: fingerprint and expanded forms",
    );
    assert.ok(snapshot.domains.has("bluebottlesoho.com"), "Must normalize and include brand domain");
    assert.ok(snapshot.instagrams.has("bluebottlesoho"), "Must normalize and include brand Instagram handle");
  });

  it("Migration 050 SQL enforces partial cooldown index, pool_lookup filter, and atomic deliver_lead_for_user cooldown guard", () => {
    const sqlPath = path.resolve(__dirname, "../../../migrations/050_lead_cooldown_protection.sql");
    const sql = readFileSync(sqlPath, "utf8");

    assert.match(sql, /ADD COLUMN IF NOT EXISTS cooldown_until timestamptz/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_businesses_cooldown_until/i);
    assert.match(sql, /b\.cooldown_until IS NULL OR b\.cooldown_until <= now\(\)/i);
    assert.match(sql, /SELECT b\.cooldown_until INTO v_cooldown_until[\s\S]*?FOR UPDATE/i);
    assert.match(sql, /SET cooldown_until = pg_catalog\.now\(\) \+ pg_catalog\.make_interval\(days => v_cooldown_days\)/i);
  });
});
