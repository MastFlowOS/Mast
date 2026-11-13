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
const {
  insertLeadForUser,
  resolveLeadCooldownDays,
  resolveLeadCooldownMaxUsers,
} = await import("../../scraperBridge/deliverLead.js");
const { lookupAndDeliverFromPool } = await import("../../lib/poolLookup.js");
const { getCooldownSnapshotForTask } = await import("../../jobs/discoveryPlanJob.js");
const { FakeDb, installFakeSupabase } = await import("../../lib/__tests__/helpers/fakeSupabaseAdmin.js");

describe("Per-Profession 5-User Lead Cooldown Protection (15-Day Window)", () => {
  it("resolveLeadCooldownDays defaults to 15 and resolveLeadCooldownMaxUsers defaults to 5", () => {
    const prevDays = process.env.LEAD_COOLDOWN_DAYS;
    const prevMax = process.env.LEAD_COOLDOWN_MAX_USERS;
    try {
      delete process.env.LEAD_COOLDOWN_DAYS;
      delete process.env.LEAD_COOLDOWN_MAX_USERS;
      assert.equal(resolveLeadCooldownDays(), 15);
      assert.equal(resolveLeadCooldownMaxUsers(), 5);

      process.env.LEAD_COOLDOWN_DAYS = "21";
      process.env.LEAD_COOLDOWN_MAX_USERS = "8";
      assert.equal(resolveLeadCooldownDays(), 21);
      assert.equal(resolveLeadCooldownMaxUsers(), 8);
    } finally {
      if (prevDays === undefined) delete process.env.LEAD_COOLDOWN_DAYS;
      else process.env.LEAD_COOLDOWN_DAYS = prevDays;
      if (prevMax === undefined) delete process.env.LEAD_COOLDOWN_MAX_USERS;
      else process.env.LEAD_COOLDOWN_MAX_USERS = prevMax;
    }
  });

  it("insertLeadForUser forwards cooldown_days=15 and cooldown_max_users=5 in p_lead_row to deliver_lead_for_user RPC", async () => {
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
      assert.equal(capturedArgs.p_lead_row.cooldown_max_users, 5);
    } finally {
      (supabaseAdmin as any).rpc = originalRpc;
      (supabaseAdmin as any).from = originalFrom;
    }
  });

  it("allows 5 different users in the same profession before triggering 15-day cooldown, while isolating other professions", async () => {
    const db = new FakeDb();
    const restore = installFakeSupabase(supabaseAdmin, db);

    try {
      db.businesses.push({
        id: "biz-shared-5",
        name: "SoHo Espresso Bar",
        niche: "Coffee Shop",
        region: "New York",
        country_code: "US",
        address: "10 Mercer St, NY",
        website: "https://sohoespresso.com",
        email: "hello@sohoespresso.com",
        phone: "+12125550199",
        instagram: "sohoespresso",
        is_disqualified: false,
        first_discovered_at: "2026-11-10T00:00:00Z",
      });

      // Users 1 through 5 in `web_design` should all receive the lead
      for (let i = 1; i <= 5; i++) {
        const res = await lookupAndDeliverFromPool({
          userId: `web-designer-${i}`,
          region: "United States",
          niche: "Coffee Shop",
          quantity: 5,
          professionSlug: "web_design",
          rank: false,
          scrapeJobId: `job-wd-${i}`,
          dailyLimit: 50,
          monthlyLimit: 500,
          channels: ["email"],
        });

        assert.equal(res.delivered.length, 1, `Web designer #${i} must receive the lead`);
        const bpc = db.business_profession_cooldowns.find(
          (r) => r.business_id === "biz-shared-5" && r.profession_slug === "web_design",
        );
        assert.ok(bpc, "Cooldown tracker row must exist for web_design");
        assert.equal(bpc.delivery_count, i);
        if (i < 5) {
          assert.equal(bpc.cooldown_until, null, `Cooldown must NOT be active after ${i}/5 deliveries`);
        } else {
          assert.ok(bpc.cooldown_until, "Cooldown MUST be stamped on the 5th delivery");
          assert.ok(Date.parse(bpc.cooldown_until) > Date.now() + 14 * 86400_000);
        }
      }

      // User #6 in `web_design` is blocked by the 15-day cooldown
      const sixthWebDesigner = await lookupAndDeliverFromPool({
        userId: "web-designer-6",
        region: "United States",
        niche: "Coffee Shop",
        quantity: 5,
        professionSlug: "web_design",
        rank: false,
        scrapeJobId: "job-wd-6",
        dailyLimit: 50,
        monthlyLimit: 500,
        channels: ["email"],
      });
      assert.equal(
        sixthWebDesigner.delivered.length,
        0,
        "6th user in web_design must NOT receive the business while on 15-day cooldown",
      );

      // Meanwhile, User #1 in a DIFFERENT profession (`video_editing`) is NOT blocked!
      const videoEditorRes = await lookupAndDeliverFromPool({
        userId: "video-editor-1",
        region: "United States",
        niche: "Coffee Shop",
        quantity: 5,
        professionSlug: "video_editing",
        rank: false,
        scrapeJobId: "job-ve-1",
        dailyLimit: 50,
        monthlyLimit: 500,
        channels: ["email"],
      });
      assert.equal(
        videoEditorRes.delivered.length,
        1,
        "User in a different profession (video_editing) must still receive the business",
      );

      // Simulate cooldown expiration for `web_design`: counter resets to 1 and becomes eligible again
      const wdCooldown = db.business_profession_cooldowns.find(
        (r) => r.business_id === "biz-shared-5" && r.profession_slug === "web_design",
      )!;
      wdCooldown.cooldown_until = new Date(Date.now() - 1000).toISOString();

      const afterExpiryRes = await lookupAndDeliverFromPool({
        userId: "web-designer-6",
        region: "United States",
        niche: "Coffee Shop",
        quantity: 5,
        professionSlug: "web_design",
        rank: false,
        scrapeJobId: "job-wd-6-retry",
        dailyLimit: 50,
        monthlyLimit: 500,
        channels: ["email"],
      });
      assert.equal(afterExpiryRes.delivered.length, 1, "Must be eligible again after 15-day cooldown expires");
      assert.equal(wdCooldown.delivery_count, 1, "Delivery counter must reset to 1 for the new window");
      assert.equal(wdCooldown.cooldown_until, null, "Cooldown must be cleared until 5 new deliveries occur");
    } finally {
      restore();
    }
  });

  it("getCooldownSnapshotForTask scopes strictly to the requesting user's profession_slug", async () => {
    let queriedProfession = "";
    let queriedGtCol = "";

    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        const builder: any = {
          select: (cols: string) => {
            assert.ok(cols.includes("business_profession_cooldowns!inner"));
            return builder;
          },
          eq: (col: string, val: string) => {
            if (col === "business_profession_cooldowns.profession_slug") {
              queriedProfession = val;
            }
            return builder;
          },
          gt: (col: string) => {
            queriedGtCol = col;
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
              },
            ],
            error: null,
          }),
        };
        return builder;
      },
    };

    const snapshot = await getCooldownSnapshotForTask(mockDb, "US", "web_design");
    assert.equal(queriedProfession, "web_design");
    assert.equal(queriedGtCol, "business_profession_cooldowns.cooldown_until");
    assert.ok(snapshot.placeIds.includes("ChIJp8X00DwsDogRfY6fChsuPUw"));
    assert.ok(snapshot.domains.has("bluebottlesoho.com"));
    assert.ok(snapshot.instagrams.has("bluebottlesoho"));
  });

  it("Migration 050 SQL enforces business_profession_cooldowns table, partial index, pool_lookup filter, and 5-user threshold", () => {
    const sqlPath = path.resolve(__dirname, "../../../migrations/050_lead_cooldown_protection.sql");
    const sql = readFileSync(sqlPath, "utf8");

    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.business_profession_cooldowns/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_bpc_active_cooldown/i);
    assert.match(sql, /FROM public\.business_profession_cooldowns bpc/i);
    assert.match(sql, /v_cooldown_max_users := GREATEST\(\s*1,\s*COALESCE\(NULLIF\(p_lead_row->>'cooldown_max_users', ''\)::integer, 5\)/i);
  });
});
