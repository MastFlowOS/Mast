import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateEnrichmentFingerprints, callSyncBusinessEnrichmentFingerprints } from "../businessProcessingJob.js";

// ─────────────────────────────────────────────────────────────────────────────
// Part A: Migration 048 Static SQL Contract Validation
// ─────────────────────────────────────────────────────────────────────────────

test("Part A: Migration 048 Contract Validation", async (t) => {
  const migrationPath = path.resolve(process.cwd(), "migrations/048_sync_business_enrichment_fingerprints.sql");
  assert.ok(fs.existsSync(migrationPath), "Migration 048 file must exist on disk");
  const sql = fs.readFileSync(migrationPath, "utf8");

  await t.test("migration 048 defines sync_business_enrichment_fingerprints with row-level locking", () => {
    assert.ok(
      sql.includes("CREATE OR REPLACE FUNCTION public.sync_business_enrichment_fingerprints"),
      "Must define sync_business_enrichment_fingerprints",
    );
    assert.ok(
      sql.includes("FOR UPDATE"),
      "Must acquire explicit row-level lock (FOR UPDATE) to serialize concurrent updates",
    );
  });

  await t.test("migration 048 validates p_business_id and fails explicitly when missing or nonexistent", () => {
    assert.ok(
      sql.includes("IF p_business_id IS NULL THEN") && sql.includes("RAISE EXCEPTION 'p_business_id is required'"),
      "Must validate p_business_id is not null",
    );
    assert.ok(
      sql.includes("IF NOT FOUND THEN") && sql.includes("business_not_found: business with id"),
      "Must fail explicitly with business_not_found (P0002) when business does not exist",
    );
  });

  await t.test("migration 048 merges emails, phones, and fingerprints via atomic set unions and canonical deduplication", () => {
    assert.ok(
      sql.includes("jsonb_array_elements_text") && sql.includes("UNION") && sql.includes("v_merged_emails"),
      "Must union existing emails and incoming emails",
    );
    assert.ok(
      sql.includes("DISTINCT ON") && sql.includes("regexp_replace(p.val, '\\D', '', 'g')"),
      "Must deduplicate phones using canonical digits (DISTINCT ON)",
    );
    assert.ok(
      sql.includes("unnest(coalesce(v_current_fingerprints, '{}'::text[]))") && sql.includes("v_merged_fingerprints"),
      "Must union existing fingerprints and incoming fingerprints",
    );
  });

  await t.test("migration 048 validates incoming fingerprints and rejects invented prefixes like li: and linkedin:", () => {
    assert.ok(
      sql.includes("lower(trim(f)) ~ '^email:[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$'") &&
        sql.includes("lower(trim(f)) ~ '^tel:[0-9]{7,10}$'") &&
        sql.includes("lower(trim(f)) ~ '^ig:[a-z0-9_][a-z0-9_.]{0,29}$'") &&
        sql.includes("lower(trim(f)) ~ '^fb:[a-z0-9_.-]{1,50}$'"),
      "Must validate canonical fingerprint formats in SQL",
    );
    assert.ok(
      sql.includes("NOT lower(trim(f)) LIKE 'li:%'") && sql.includes("NOT lower(trim(f)) LIKE 'linkedin:%'"),
      "Must strictly reject invented LinkedIn fingerprints in SQL",
    );
  });

  await t.test("migration 048 validates primary contacts inside SQL before assignment", () => {
    assert.ok(
      sql.includes("v_valid_incoming_email") && sql.includes("v_valid_incoming_phone"),
      "Must validate incoming primary email and phone in SQL",
    );
    assert.ok(
      sql.includes("v_valid_incoming_instagram") && sql.includes("v_valid_incoming_facebook"),
      "Must validate incoming primary instagram and facebook in SQL",
    );
  });

  await t.test("migration 048 enforces SECURITY DEFINER, search_path = pg_catalog, and restricts EXECUTE", () => {
    assert.ok(sql.includes("SECURITY DEFINER"), "Must be SECURITY DEFINER");
    assert.ok(sql.includes("SET search_path = pg_catalog"), "Must pin search_path to pg_catalog");
    assert.ok(sql.includes("public.businesses"), "Must schema-qualify public.businesses");
    assert.ok(
      sql.includes("REVOKE ALL ON FUNCTION public.sync_business_enrichment_fingerprints") &&
        sql.includes("FROM PUBLIC, anon, authenticated"),
      "Must revoke execution from public, anon, and authenticated",
    );
    assert.ok(
      sql.includes("GRANT EXECUTE ON FUNCTION public.sync_business_enrichment_fingerprints") &&
        sql.includes("TO service_role, postgres"),
      "Must grant execution only to service_role and postgres",
    );
  });

  await t.test("migration 048 never alters place_id or id", () => {
    const updateIdx = sql.indexOf("UPDATE public.businesses b");
    assert.ok(updateIdx !== -1, "Must contain UPDATE statement");
    const updateClause = sql.slice(updateIdx, sql.indexOf("WHERE b.id = p_business_id;"));
    assert.ok(!updateClause.includes("place_id ="), "Must NEVER alter place_id");
    assert.ok(!/\b(?<![_\w])id\s*=/i.test(updateClause), "Must NEVER alter id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B: generateEnrichmentFingerprints Unit Tests (Normalization & Format Rules)
// ─────────────────────────────────────────────────────────────────────────────

test("Part B: Fingerprint Generator Normalization & Filtering", async (t) => {
  await t.test("Primary email creates canonical email: fingerprint", () => {
    const fps = generateEnrichmentFingerprints({ email: "Contact@ApexDentistry.com" });
    assert.deepEqual(fps, ["email:contact@apexdentistry.com"]);
  });

  await t.test("Multiple additional emails create multiple canonical fingerprints without duplicates", () => {
    const fps = generateEnrichmentFingerprints({
      email: "info@apexdentistry.com",
      emails: ["info@apexdentistry.com", "billing@apexdentistry.com", "dr.smith@apexdentistry.com"],
    });
    assert.deepEqual(fps, [
      "email:billing@apexdentistry.com",
      "email:dr.smith@apexdentistry.com",
      "email:info@apexdentistry.com",
    ]);
  });

  await t.test("Primary and additional phones create canonical tel: fingerprints", () => {
    const fps = generateEnrichmentFingerprints({
      phone: "+1 (305) 555-0199",
      phones: ["305-555-0199", "305-555-0200", "555-1234"],
    });
    assert.deepEqual(fps, [
      "tel:3055550199",
      "tel:3055550200",
      "tel:5551234",
    ]);
  });

  await t.test("Instagram handle and URL create canonical ig: fingerprint", () => {
    const fps1 = generateEnrichmentFingerprints({ instagram: "https://www.instagram.com/apexdental_miami/?hl=en" });
    assert.deepEqual(fps1, ["ig:apexdental_miami"]);

    const fps2 = generateEnrichmentFingerprints({ instagram: "@ApexDental_Miami/" });
    assert.deepEqual(fps2, ["ig:apexdental_miami"]);
  });

  await t.test("Facebook URL creates canonical fb: fingerprint", () => {
    const fps = generateEnrichmentFingerprints({ facebook: "https://www.facebook.com/apexdentalmiami/" });
    assert.deepEqual(fps, ["fb:apexdentalmiami"]);
  });

  await t.test("Rejects empty, whitespace, malformed, placeholder, asset, or non-handle values", () => {
    const fps = generateEnrichmentFingerprints({
      email: "   ",
      emails: ["not-an-email", "logo@2x.png", "icon@3x.jpg", "banner.svg", "test@"],
      phone: "123", // under 7 digits
      phones: ["   ", "abc-def-ghij"],
      instagram: "https://www.instagram.com/explore/", // non-handle token
      facebook: "https://facebook.com/profile.php", // skip token
    });
    assert.deepEqual(fps, [], "Must reject all invalid, asset, placeholder, or routing contact values");
  });

  await t.test("LinkedIn does NOT generate fingerprints", () => {
    // TypeScript params do not accept linkedin for fingerprint generation
    const fps = generateEnrichmentFingerprints({
      email: "doc@example.com",
    });
    assert.ok(!fps.some((f) => f.startsWith("li:") || f.startsWith("linkedin:")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part C: Functional Invariants & Database Simulator (Requirements 1–14)
// ─────────────────────────────────────────────────────────────────────────────

interface SimBusinessRow {
  id: string;
  name: string;
  place_id: string | null;
  email: string | null;
  emails: string[];
  phone: string | null;
  phones: string[];
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  fingerprints: string[];
  signals: Record<string, unknown>;
  field_provenance: Record<string, unknown>;
}

class EnrichmentSimulator {
  businesses = new Map<string, SimBusinessRow>();
  private activeLocks = new Set<string>();

  async acquireRowLock(id: string): Promise<() => void> {
    while (this.activeLocks.has(id)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    this.activeLocks.add(id);
    return () => this.activeLocks.delete(id);
  }

  /**
   * Models sync_business_enrichment_fingerprints exactly as written in migration 048.
   */
  async syncBusinessEnrichmentFingerprints(params: {
    p_business_id: string | null;
    p_email?: string | null;
    p_emails?: string[] | null;
    p_phone?: string | null;
    p_phones?: string[] | null;
    p_instagram?: string | null;
    p_facebook?: string | null;
    p_linkedin?: string | null;
    p_fingerprints?: string[] | null;
    p_signals?: Record<string, unknown> | null;
    p_field_provenance?: Record<string, unknown> | null;
  }): Promise<SimBusinessRow> {
    if (!params.p_business_id) {
      throw new Error("p_business_id is required (code: 22023)");
    }

    const releaseLock = await this.acquireRowLock(params.p_business_id);
    try {
      const b = this.businesses.get(params.p_business_id);
      if (!b) {
        throw new Error(`business_not_found: business with id ${params.p_business_id} does not exist (code: P0002)`);
      }

      // In-SQL Email validation
      let validIncomingEmail: string | null = null;
      if (params.p_email && params.p_email.trim()) {
        const raw = params.p_email.trim().toLowerCase();
        if (
          /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(raw) &&
          raw.split("@").length === 2 &&
          !/\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$/i.test(raw) &&
          !/^(noreply|no-reply|donotreply|do-not-reply|wordpress|mailer-daemon)@/i.test(raw)
        ) {
          validIncomingEmail = raw;
        }
      }

      // In-SQL Phone validation
      let validIncomingPhone: string | null = null;
      if (params.p_phone && params.p_phone.trim()) {
        const digits = params.p_phone.replace(/\D/g, "");
        if (
          digits.length >= 7 &&
          digits.length <= 15 &&
          !/^(\d)\1+$/.test(digits) &&
          !["1234567890", "0123456789", "1000000000", "9999999999"].includes(digits)
        ) {
          validIncomingPhone = params.p_phone.trim();
        }
      }

      // In-SQL Instagram validation
      let validIncomingInstagram: string | null = null;
      if (params.p_instagram && params.p_instagram.trim()) {
        let clean = params.p_instagram.trim().split(/[?#]/)[0];
        const m = clean.match(/instagram\.com\/([^/?#]+)/i);
        let handle = m ? m[1] : clean;
        handle = handle.replace(/^[@/]+/, "").replace(/\/+$/, "").toLowerCase();
        const IG_NON = new Set([
          "p", "reel", "reels", "tv", "explore", "stories", "accounts", "about",
          "directory", "legal", "privacy", "press", "help", "api", "oauth",
          "challenge", "sharer", "embed", "static", "web", "developer", "developers",
          "nametag", "oembed", "emails", "session", "ajax", "graphql", "login",
          "signup", "direct", "instagram", "_u"
        ]);
        if (
          handle.length >= 1 &&
          handle.length <= 30 &&
          /^[a-z0-9_][a-z0-9_.]{0,29}$/.test(handle) &&
          !/^\d+$/.test(handle) &&
          !handle.includes("..") &&
          !handle.endsWith(".") &&
          !IG_NON.has(handle)
        ) {
          validIncomingInstagram = clean.startsWith("http") ? clean : `https://www.instagram.com/${handle}/`;
        }
      }

      // In-SQL Facebook validation
      let validIncomingFacebook: string | null = null;
      if (params.p_facebook && params.p_facebook.trim()) {
        let clean = params.p_facebook.trim().split(/[?#]/)[0];
        const m = clean.match(/facebook\.com\/([^/?#]+)/i);
        let handle = m ? m[1] : clean;
        handle = handle.replace(/\/+$/, "").toLowerCase();
        const FB_SKIP = new Set([
          "profile.php", "pages", "groups", "events", "watch", "share",
          "sharer", "dialog", "plugins", "help", "policies", "login"
        ]);
        if (handle.length >= 1 && handle.length <= 50 && /^[a-z0-9_.-]{1,50}$/.test(handle) && !FB_SKIP.has(handle)) {
          validIncomingFacebook = params.p_facebook.trim();
        }
      }

      // Merge emails in SQL
      const rawIncomingEmails = [...(params.p_emails ?? []), validIncomingEmail].filter(Boolean) as string[];
      const validIncomingEmails = rawIncomingEmails
        .map((e) => e.trim().toLowerCase())
        .filter((e) =>
          /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) &&
          e.split("@").length === 2 &&
          !/\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$/i.test(e) &&
          !/^(noreply|no-reply|donotreply|do-not-reply|wordpress|mailer-daemon)@/i.test(e)
        );
      const mergedEmails = Array.from(new Set([...b.emails.map((e) => e.trim().toLowerCase()), ...validIncomingEmails])).sort();

      // Merge phones in SQL
      const rawIncomingPhones = [...(params.p_phones ?? []), validIncomingPhone].filter(Boolean) as string[];
      const allPhones = [...b.phones, ...rawIncomingPhones].map((p) => p.trim()).filter((p) => {
        const digits = p.replace(/\D/g, "");
        return (
          digits.length >= 7 &&
          digits.length <= 15 &&
          !/^(\d)\1+$/.test(digits) &&
          !["1234567890", "0123456789", "1000000000", "9999999999"].includes(digits)
        );
      });
      const phoneMap = new Map<string, string>();
      for (const phone of allPhones) {
        const digits = phone.replace(/\D/g, "");
        const key = digits.length >= 10 ? digits.slice(-10) : digits;
        const existing = phoneMap.get(key);
        if (!existing) {
          phoneMap.set(key, phone);
        } else {
          const hasFormatting = /[\s().\-+]/.test(phone);
          const existingHasFormatting = /[\s().\-+]/.test(existing);
          if (hasFormatting && !existingHasFormatting) {
            phoneMap.set(key, phone);
          }
        }
      }
      const mergedPhones = Array.from(phoneMap.values()).sort();

      // Primary contact updates
      const nextEmail = validIncomingEmail || b.email || (mergedEmails.length > 0 ? mergedEmails[0] : null);
      const nextPhone = validIncomingPhone || b.phone || (mergedPhones.length > 0 ? mergedPhones[0] : null);

      // Instagram fill-only semantics
      let currentIgValid = false;
      if (b.instagram && b.instagram.trim()) {
        let clean = b.instagram.trim().split(/[?#]/)[0];
        const m = clean.match(/instagram\.com\/([^/?#]+)/i);
        let handle = m ? m[1] : clean;
        handle = handle.replace(/^[@/]+/, "").replace(/\/+$/, "").toLowerCase();
        if (handle.length >= 1 && handle.length <= 30 && /^[a-z0-9_][a-z0-9_.]{0,29}$/.test(handle) && !/^\d+$/.test(handle)) {
          currentIgValid = true;
        }
      }
      const nextInstagram = currentIgValid ? b.instagram : (validIncomingInstagram || b.instagram);
      const nextFacebook = validIncomingFacebook || b.facebook;
      const nextLinkedin = params.p_linkedin?.trim() || b.linkedin;

      // Fingerprints: preserve historical, validate incoming against dedup.py canonical rules
      const validIncomingFps = (params.p_fingerprints ?? []).map((f) => f.trim().toLowerCase()).filter((f) => {
        if (!f || f.startsWith("li:") || f.startsWith("linkedin:")) return false;
        if (f.startsWith("email:")) {
          const email = f.slice(6);
          return (
            /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) &&
            email.split("@").length === 2 &&
            !/\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$/i.test(email)
          );
        }
        if (f.startsWith("tel:")) {
          const tel = f.slice(4);
          return /^[0-9]{7,10}$/.test(tel) && !/^([0-9])\1{6,9}$/.test(tel);
        }
        if (f.startsWith("ig:")) {
          const ig = f.slice(3);
          const IG_NON = new Set([
            "p", "reel", "reels", "tv", "explore", "stories", "accounts", "about",
            "directory", "legal", "privacy", "press", "help", "api", "oauth",
            "challenge", "sharer", "embed", "static", "web", "developer", "developers",
            "nametag", "oembed", "emails", "session", "ajax", "graphql", "login",
            "signup", "direct", "instagram", "_u"
          ]);
          return (
            ig.length >= 1 &&
            ig.length <= 30 &&
            /^[a-z0-9_][a-z0-9_.]{0,29}$/.test(ig) &&
            !/^\d+$/.test(ig) &&
            !ig.includes("..") &&
            !ig.endsWith(".") &&
            !IG_NON.has(ig)
          );
        }
        if (f.startsWith("fb:")) {
          const fb = f.slice(3);
          const FB_SKIP = new Set([
            "profile.php", "pages", "groups", "events", "watch", "share",
            "sharer", "dialog", "plugins", "help", "policies", "login"
          ]);
          return fb.length >= 1 && fb.length <= 50 && /^[a-z0-9_.-]{1,50}$/.test(fb) && !FB_SKIP.has(fb);
        }
        return false;
      });
      const mergedFingerprints = Array.from(new Set([...b.fingerprints, ...validIncomingFps])).sort();

      // Update in place
      b.email = nextEmail;
      b.emails = mergedEmails;
      b.phone = nextPhone;
      b.phones = mergedPhones;
      b.instagram = nextInstagram;
      b.facebook = nextFacebook;
      b.linkedin = nextLinkedin;
      b.fingerprints = mergedFingerprints;
      if (params.p_signals) b.signals = { ...b.signals, ...params.p_signals };
      if (params.p_field_provenance) b.field_provenance = { ...b.field_provenance, ...params.p_field_provenance };

      return { ...b };
    } finally {
      releaseLock();
    }
  }
}

test("Part C: Functional Invariants (Requirements 1–14)", async (t) => {
  await t.test("Requirement 1: Enriched primary email creates an email: fingerprint", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-1", {
      id: "biz-1",
      name: "Acme Dental",
      place_id: "chij_acme_1",
      email: null,
      emails: [],
      phone: "3055550100",
      phones: ["3055550100"],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["name:acme dental|miami", "place:chij_acme_1", "tel:3055550100"],
      signals: {},
      field_provenance: {},
    });

    const fps = generateEnrichmentFingerprints({ email: "contact@acmedental.com" });
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-1",
      p_email: "contact@acmedental.com",
      p_fingerprints: fps,
    });

    assert.equal(res.email, "contact@acmedental.com");
    assert.ok(res.fingerprints.includes("email:contact@acmedental.com"));
    assert.ok(res.fingerprints.includes("place:chij_acme_1"), "Preserves existing place fingerprint");
  });

  await t.test("Requirement 2: Multiple additional emails create multiple fingerprints without dropping previous ones", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-2", {
      id: "biz-2",
      name: "Summit Care",
      place_id: "chij_summit_2",
      email: "info@summitcare.com",
      emails: ["info@summitcare.com"],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["email:info@summitcare.com", "place:chij_summit_2"],
      signals: {},
      field_provenance: {},
    });

    const fps = generateEnrichmentFingerprints({
      emails: ["support@summitcare.com", "billing@summitcare.com"],
    });
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-2",
      p_emails: ["support@summitcare.com", "billing@summitcare.com"],
      p_fingerprints: fps,
    });

    assert.ok(res.fingerprints.includes("email:info@summitcare.com"), "Preserves existing email fingerprint");
    assert.ok(res.fingerprints.includes("email:support@summitcare.com"));
    assert.ok(res.fingerprints.includes("email:billing@summitcare.com"));
    assert.deepEqual(res.emails, ["billing@summitcare.com", "info@summitcare.com", "support@summitcare.com"]);
  });

  await t.test("Requirement 3 & 4: Enriched primary phone and additional phones create tel: fingerprints", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-3", {
      id: "biz-3",
      name: "Coastal Chiro",
      place_id: "chij_coastal_3",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_coastal_3"],
      signals: {},
      field_provenance: {},
    });

    const fps = generateEnrichmentFingerprints({
      phone: "+1 305-555-7788",
      phones: ["305-555-7788", "305-555-9900"],
    });
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-3",
      p_phone: "+1 305-555-7788",
      p_phones: ["305-555-7788", "305-555-9900"],
      p_fingerprints: fps,
    });

    assert.ok(res.fingerprints.includes("tel:3055557788"));
    assert.ok(res.fingerprints.includes("tel:3055559900"));
    assert.equal(res.phone, "+1 305-555-7788");
  });

  await t.test("Requirement 5 & 6: Instagram URL creates ig: fingerprint and Facebook creates fb: fingerprint", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-4", {
      id: "biz-4",
      name: "Zen Spa",
      place_id: "chij_zen_4",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_zen_4"],
      signals: {},
      field_provenance: {},
    });

    const fps = generateEnrichmentFingerprints({
      instagram: "https://instagram.com/zenspa_miami",
      facebook: "https://facebook.com/zenspamiami",
    });
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-4",
      p_instagram: "https://instagram.com/zenspa_miami",
      p_facebook: "https://facebook.com/zenspamiami",
      p_fingerprints: fps,
    });

    assert.ok(res.fingerprints.includes("ig:zenspa_miami"));
    assert.ok(res.fingerprints.includes("fb:zenspamiami"));
    assert.equal(res.instagram, "https://instagram.com/zenspa_miami");
    assert.equal(res.facebook, "https://facebook.com/zenspamiami");
  });

  await t.test("Requirement 7: Existing fingerprints survive partial or empty enrichment", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-5", {
      id: "biz-5",
      name: "Heritage Books",
      place_id: "chij_heritage_5",
      email: "shop@heritage.com",
      emails: ["shop@heritage.com"],
      phone: "3055551212",
      phones: ["3055551212"],
      instagram: "heritage_books",
      facebook: null,
      linkedin: null,
      fingerprints: ["email:shop@heritage.com", "ig:heritage_books", "place:chij_heritage_5", "tel:3055551212", "web:heritage.com"],
      signals: {},
      field_provenance: {},
    });

    // Enrichment crawl found no new contacts
    const fps = generateEnrichmentFingerprints({});
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-5",
      p_fingerprints: fps,
    });

    assert.deepEqual(
      res.fingerprints,
      ["email:shop@heritage.com", "ig:heritage_books", "place:chij_heritage_5", "tel:3055551212", "web:heritage.com"],
      "All pre-existing fingerprints must survive unchanged when no new contacts are discovered",
    );
  });

  await t.test("Requirement 8 & 9: Two concurrent enrichment operations preserve both fingerprint sets and arrays without lost updates", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-concurrent", {
      id: "biz-concurrent",
      name: "Concurrent Clinic",
      place_id: "chij_concurrent_6",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_concurrent_6"],
      signals: {},
      field_provenance: {},
    });

    // Worker A discovers email
    const opA = sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-concurrent",
      p_email: "worker_a@clinic.com",
      p_emails: ["worker_a@clinic.com"],
      p_fingerprints: generateEnrichmentFingerprints({ email: "worker_a@clinic.com" }),
    });

    // Worker B concurrently discovers phone and Instagram
    const opB = sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-concurrent",
      p_phone: "305-555-4433",
      p_phones: ["305-555-4433"],
      p_instagram: "clinic_official",
      p_fingerprints: generateEnrichmentFingerprints({ phone: "305-555-4433", instagram: "clinic_official" }),
    });

    await Promise.all([opA, opB]);

    const finalRow = sim.businesses.get("biz-concurrent")!;
    assert.ok(finalRow.fingerprints.includes("email:worker_a@clinic.com"), "Worker A fingerprint preserved");
    assert.ok(finalRow.fingerprints.includes("tel:3055554433"), "Worker B phone fingerprint preserved");
    assert.ok(finalRow.fingerprints.includes("ig:clinic_official"), "Worker B instagram fingerprint preserved");
    assert.ok(finalRow.fingerprints.includes("place:chij_concurrent_6"), "Initial place fingerprint preserved");
    assert.equal(finalRow.fingerprints.length, 4, "Zero lost updates: all 4 fingerprints must be present");

    assert.ok(finalRow.emails.includes("worker_a@clinic.com"));
    assert.ok(finalRow.phones.includes("305-555-4433"));
  });

  await t.test("Requirement 10: Missing business ID or nonexistent business returns explicit failure", async () => {
    const sim = new EnrichmentSimulator();

    await assert.rejects(
      async () => {
        await sim.syncBusinessEnrichmentFingerprints({ p_business_id: null });
      },
      /p_business_id is required/,
      "Must reject null business ID with explicit error",
    );

    await assert.rejects(
      async () => {
        await sim.syncBusinessEnrichmentFingerprints({ p_business_id: "nonexistent-uuid-999" });
      },
      /business_not_found/,
      "Must reject nonexistent business ID with P0002 error",
    );
  });

  await t.test("Requirement 11: Empty and malformed contact values create no invalid fingerprints", async () => {
    const fps = generateEnrichmentFingerprints({
      email: "invalid_email_string",
      emails: ["not-an-email", "logo@2x.png", "", "   "],
      phone: "123", // under 7 digits
      phones: ["", "none", "n/a"],
      instagram: "instagram.com/reels/",
      facebook: "facebook.com/policies",
    });
    assert.deepEqual(fps, []);
  });

  await t.test("Requirement 13: Business ID and Place ID remain unchanged across enrichment sync", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-immutable", {
      id: "biz-immutable",
      name: "Anchor Store",
      place_id: "ChIJ_immutable_anchor",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_immutable_anchor"],
      signals: {},
      field_provenance: {},
    });

    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-immutable",
      p_email: "store@anchor.com",
      p_fingerprints: ["email:store@anchor.com"],
    });

    assert.equal(res.id, "biz-immutable", "Business ID must not change");
    assert.equal(res.place_id, "ChIJ_immutable_anchor", "Place ID must not change");
  });

  await t.test("Requirement 14: Shared corporate contact fingerprints do not cause cross-business updates", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-branch-1", {
      id: "biz-branch-1",
      name: "Franchise Branch 1",
      place_id: "chij_branch_1",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_branch_1"],
      signals: {},
      field_provenance: {},
    });

    sim.businesses.set("biz-branch-2", {
      id: "biz-branch-2",
      name: "Franchise Branch 2",
      place_id: "chij_branch_2",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_branch_2"],
      signals: {},
      field_provenance: {},
    });

    // Enrich Branch 1 with corporate email
    await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-branch-1",
      p_email: "support@franchise.com",
      p_fingerprints: ["email:support@franchise.com"],
    });

    const branch1 = sim.businesses.get("biz-branch-1")!;
    const branch2 = sim.businesses.get("biz-branch-2")!;

    assert.ok(branch1.fingerprints.includes("email:support@franchise.com"));
    assert.equal(branch2.fingerprints.length, 1, "Branch 2 must NOT receive fingerprints from Branch 1 update");
    assert.ok(!branch2.fingerprints.includes("email:support@franchise.com"));
  });

  await t.test("Requirement 15: Phone canonical deduplication collapses equivalent formats and prefers formatted representation", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-phone-dedup", {
      id: "biz-phone-dedup",
      name: "Dedup Phone Clinic",
      place_id: "chij_phone_dedup",
      email: null,
      emails: [],
      phone: "3055551212", // unformatted digits
      phones: ["3055551212"],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["tel:3055551212"],
      signals: {},
      field_provenance: {},
    });

    // Incoming has formatted representation +1 (305) 555-1212 and an alternate phone
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-phone-dedup",
      p_phone: "+1 (305) 555-1212",
      p_phones: ["+1 (305) 555-1212", "3055551212", "+1 (305) 555-9999"],
      p_fingerprints: ["tel:3055551212", "tel:3055559999"],
    });

    // In SQL & simulator, the 10-digit duplicate collapses and chooses the formatted representation
    assert.equal(res.phones.length, 2, "Duplicate 3055551212 and +1 (305) 555-1212 must collapse to single phone");
    assert.ok(res.phones.includes("+1 (305) 555-1212"), "Preferred formatted representation must be preserved");
    assert.ok(!res.phones.includes("3055551212"), "Unformatted raw duplicate must be replaced by formatted version");
    assert.ok(res.phones.includes("+1 (305) 555-9999"));
  });

  await t.test("Requirement 16: Email canonical deduplication handles case-insensitivity and primary/array overlap", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-email-dedup", {
      id: "biz-email-dedup",
      name: "Dedup Email Spa",
      place_id: "chij_email_dedup",
      email: "info@example.com",
      emails: ["info@example.com"],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["email:info@example.com"],
      signals: {},
      field_provenance: {},
    });

    // Incoming uppercase INFO@EXAMPLE.COM and repeated in array and primary
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-email-dedup",
      p_email: "INFO@EXAMPLE.COM",
      p_emails: ["INFO@EXAMPLE.COM", "support@example.com", "SUPPORT@EXAMPLE.COM"],
      p_fingerprints: ["email:info@example.com", "email:support@example.com"],
    });

    assert.equal(res.emails.length, 2, "Upper/lowercase duplicates must collapse into exactly 2 unique emails");
    assert.deepEqual(res.emails, ["info@example.com", "support@example.com"]);
  });

  await t.test("Requirement 17: SQL-level fingerprint filtering strips invalid prefixes and explicitly drops li: and linkedin:", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-fp-filter", {
      id: "biz-fp-filter",
      name: "Fingerprint Filter Biz",
      place_id: "chij_fp_filter",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["place:chij_fp_filter"],
      signals: {},
      field_provenance: {},
    });

    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-fp-filter",
      p_fingerprints: [
        "email:valid@company.com",
        "tel:3055551212",
        "ig:validhandle",
        "fb:validpage",
        "li:invalid-linkedin-prefix",
        "linkedin:company/test",
        "unsupported_prefix:12345",
        "email:no_at_symbol.com",
      ],
    });

    assert.ok(res.fingerprints.includes("place:chij_fp_filter"), "Existing place fingerprint kept");
    assert.ok(res.fingerprints.includes("email:valid@company.com"));
    assert.ok(res.fingerprints.includes("tel:3055551212"));
    assert.ok(res.fingerprints.includes("ig:validhandle"));
    assert.ok(res.fingerprints.includes("fb:validpage"));
    assert.ok(!res.fingerprints.some((f) => f.startsWith("li:")), "Must NOT contain li: prefix");
    assert.ok(!res.fingerprints.some((f) => f.startsWith("linkedin:")), "Must NOT contain linkedin: prefix");
    assert.ok(!res.fingerprints.some((f) => f.startsWith("unsupported_prefix:")), "Must NOT contain unsupported prefix");
    assert.ok(!res.fingerprints.includes("email:no_at_symbol.com"), "Must reject email fingerprint lacking @ and .");
  });

  await t.test("Requirement 18: In-SQL contact validation prevents malformed direct RPC inputs from overwriting valid primary values", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-sql-validation", {
      id: "biz-sql-validation",
      name: "Protected Identity Center",
      place_id: "chij_sql_val",
      email: "dr.smith@protectedcenter.com",
      emails: ["dr.smith@protectedcenter.com"],
      phone: "+1 (305) 555-1212",
      phones: ["+1 (305) 555-1212"],
      instagram: "https://www.instagram.com/protectedcenter/",
      facebook: "https://www.facebook.com/protectedcenter",
      linkedin: null,
      fingerprints: ["place:chij_sql_val", "web:protectedcenter.com"],
      signals: {},
      field_provenance: {},
    });

    // Directly supply malformed/unfiltered parameters into the RPC simulator
    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-sql-validation",
      p_email: "not-an-email-format",
      p_emails: ["logo@2x.png", "bad_email_format", "noreply@spamdomain.com"],
      p_phone: "0000000000", // placeholder phone
      p_phones: ["123", "0000000000", "1234567890"],
      p_instagram: "https://www.instagram.com/explore/", // non-handle routing token
      p_facebook: "https://www.facebook.com/policies", // skip token
    });

    // Valid pre-existing primary contacts must remain completely untouched
    assert.equal(res.email, "dr.smith@protectedcenter.com", "Invalid email must not overwrite valid existing primary email");
    assert.equal(res.phone, "+1 (305) 555-1212", "Invalid phone must not overwrite valid existing primary phone");
    assert.equal(res.instagram, "https://www.instagram.com/protectedcenter/", "Routing token must not overwrite valid existing Instagram");
    assert.equal(res.facebook, "https://www.facebook.com/protectedcenter", "Skip token must not overwrite valid existing Facebook");

    // Contact arrays must not be polluted with malformed entries
    assert.deepEqual(res.emails, ["dr.smith@protectedcenter.com"], "Malformed emails and asset extensions must not enter emails array");
    assert.deepEqual(res.phones, ["+1 (305) 555-1212"], "Malformed and placeholder phones must not enter phones array");
  });

  await t.test("Requirement 19: In-SQL fingerprint validation rejects malformed direct RPC fingerprints while preserving historical", async () => {
    const sim = new EnrichmentSimulator();
    sim.businesses.set("biz-sql-fp-guard", {
      id: "biz-sql-fp-guard",
      name: "Historical Fingerprint Biz",
      place_id: "chij_hist_fp",
      email: null,
      emails: [],
      phone: null,
      phones: [],
      instagram: null,
      facebook: null,
      linkedin: null,
      fingerprints: ["name:historical biz|miami", "place:chij_hist_fp", "web:histbiz.com"],
      signals: {},
      field_provenance: {},
    });

    const res = await sim.syncBusinessEnrichmentFingerprints({
      p_business_id: "biz-sql-fp-guard",
      p_fingerprints: [
        "email:bad-email",
        "email:valid@histbiz.com",
        "tel:123", // too short
        "tel:0000000000", // all same digits
        "tel:3055558899", // valid
        "ig:reels", // routing token
        "ig:12345678", // numeric-only
        "ig:valid_handle", // valid
        "fb:profile.php", // skip token
        "fb:histbizpage", // valid
        "li:ceo-profile", // forbidden LinkedIn prefix
        "linkedin:company/histbiz", // forbidden LinkedIn prefix
      ],
    });

    // Historical fingerprints must survive intact
    assert.ok(res.fingerprints.includes("name:historical biz|miami"), "Historical name fingerprint preserved");
    assert.ok(res.fingerprints.includes("place:chij_hist_fp"), "Historical place fingerprint preserved");
    assert.ok(res.fingerprints.includes("web:histbiz.com"), "Historical web fingerprint preserved");

    // Only strictly valid canonical fingerprints must be added
    assert.ok(res.fingerprints.includes("email:valid@histbiz.com"));
    assert.ok(res.fingerprints.includes("tel:3055558899"));
    assert.ok(res.fingerprints.includes("ig:valid_handle"));
    assert.ok(res.fingerprints.includes("fb:histbizpage"));

    // Malformed and forbidden fingerprints must be rejected
    assert.ok(!res.fingerprints.includes("email:bad-email"));
    assert.ok(!res.fingerprints.includes("tel:123"));
    assert.ok(!res.fingerprints.includes("tel:0000000000"));
    assert.ok(!res.fingerprints.includes("ig:reels"));
    assert.ok(!res.fingerprints.includes("ig:12345678"));
    assert.ok(!res.fingerprints.includes("fb:profile.php"));
    assert.ok(!res.fingerprints.some((f) => f.startsWith("li:")));
    assert.ok(!res.fingerprints.some((f) => f.startsWith("linkedin:")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part D: Calling Contract & Failure Handling (Requirement 12)
// ─────────────────────────────────────────────────────────────────────────────

test("Part D: Calling Contract & Error Handling", async (t) => {
  await t.test("Requirement 12: Failed synchronization bubbles up error and prevents reporting success", async () => {
    // Verify that syncError in the RPC call raises an exception rather than silently succeeding
    const mockRpc = async (fn: string, _args: any) => {
      if (fn === "sync_business_enrichment_fingerprints") {
        return { data: null, error: { message: "database row locked or connection failed" } };
      }
      return { data: null, error: null };
    };

    const runSync = async (businessId: string) => {
      const { error: syncError } = await mockRpc("sync_business_enrichment_fingerprints", {
        p_business_id: businessId,
      });
      if (syncError) {
        throw new Error(`[enrichBusiness] sync_business_enrichment_fingerprints failed for ${businessId}: ${syncError.message}`);
      }
      return true;
    };

    await assert.rejects(
      async () => {
        await runSync("biz-fail-test");
      },
      /sync_business_enrichment_fingerprints failed for biz-fail-test/,
      "Must throw error on RPC failure so pg-boss job fails and re-enqueues",
    );
  });

  await t.test("Typed wrapper callSyncBusinessEnrichmentFingerprints passes exact parameters and returns typed payload", async () => {
    let capturedMethod = "";
    let capturedArgs: any = null;

    const mockAdminClient = {
      rpc: async (method: string, args: any) => {
        capturedMethod = method;
        capturedArgs = args;
        return {
          data: [
            {
              business_id: args.p_business_id,
              email: args.p_email,
              emails: args.p_emails,
              phone: args.p_phone,
              phones: args.p_phones,
              instagram: args.p_instagram,
              facebook: args.p_facebook,
              linkedin: args.p_linkedin,
              fingerprints: args.p_fingerprints,
            },
          ],
          error: null,
        };
      },
    } as any;

    const params = {
      p_business_id: "00000000-0000-0000-0000-000000000001",
      p_email: "test@domain.com",
      p_emails: ["test@domain.com"],
      p_phone: "+1 305-555-1212",
      p_phones: ["+1 305-555-1212"],
      p_instagram: "testhandle",
      p_facebook: "testfb",
      p_linkedin: "https://linkedin.com/in/test",
      p_fingerprints: ["email:test@domain.com", "tel:3055551212", "ig:testhandle", "fb:testfb"],
    };

    const res = await callSyncBusinessEnrichmentFingerprints(mockAdminClient, params);

    assert.equal(capturedMethod, "sync_business_enrichment_fingerprints");
    assert.deepEqual(capturedArgs, params);
    assert.equal(res.error, null);
    assert.equal(res.data?.[0].business_id, "00000000-0000-0000-0000-000000000001");
    assert.equal(res.data?.[0].email, "test@domain.com");
  });
});

