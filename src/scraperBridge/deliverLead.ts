import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import type { EngineLead } from "./pythonBridge.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
import { applyRediscoverySuccess, CONFIDENCE_DEFAULT, VERIFICATION_INTERVAL_MS } from "../scoring/confidenceModel.js";

export type DeliveryContext = {
  /** null for background pool.expand jobs that aren't attached to a user */
  userId: string | null;
  professionSlug: string | null;
  discoveryMode: "live" | "instant_pool" | "instant_pool_ranked";
  scrapeJobId: string;
  /** snapshot from business_opportunity_scores, set only for instant_pool_ranked deliveries */
  opportunityScore?: number | null;
  /**
   * Plan limits, needed by insertLeadForUser to atomically reserve usage
   * (see migrations/005_usage_hardening.sql::try_increment_lead_usage).
   * Required whenever userId is set — a delivery attached to a user must
   * always know what it's allowed to charge against.
   */
  dailyLimit?: number;
  monthlyLimit?: number;
};

export type DeliveryResult = {
  businessId: string;
  /** false when this business already existed for this user (no credit charged) */
  wasNewForUser: boolean;
  /** true when this business WOULD have been new, but the user is out of daily/monthly credit */
  limitReached?: boolean;
};

export type PoolBusiness = {
  id: string;
  name: string;
  niche: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  instagram: string | null;
};

function extractSignals(lead: EngineLead) {
  // Everything scoring needs that doesn't have its own column — kept as a
  // jsonb bag rather than growing the businesses table schema every time a
  // new signal matters to the Opportunity Score.
  return {
    tech_stack: lead.tech_stack,
    ig_activity: lead.ig_activity,
    ig_legitimacy: lead.ig_legitimacy,
    ig_last_post_days: lead.ig_last_post_days,
    owner_responds_to_reviews: lead.owner_responds_to_reviews,
    growth_signals: lead.growth_signals ?? null,
    is_google_verified: lead.is_google_verified,
    multi_location: lead.multi_location,
    has_popular_times: lead.has_popular_times,
    price_range: lead.price_range,
    legacy_lead_score: lead.score, // Part 1's current (non-Opportunity) score, kept for comparison once Phase 6 lands
    legacy_tier: lead.tier,
  };
}

/**
 * Finds an existing business by fingerprint overlap, using the exact
 * fingerprint set the engine itself computed (storage/dedup.py). No
 * normalization is reimplemented here — we only ever compare fingerprint
 * strings the engine produced.
 */
async function findExistingBusiness(fingerprints: string[]) {
  if (fingerprints.length === 0) return null;

  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select("id, confidence")
    .overlaps("fingerprints", fingerprints)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function upsertBusinessFromEngineLead(lead: EngineLead, region: string) {
  const existing = await findExistingBusiness(lead.fingerprints);

  if (existing) {
    // Phase 7: naturally turning up again in a normal search IS a
    // successful lightweight verification — per the product requirement,
    // this should extend the verification window exactly like a real
    // verification job would, so businesses under constant organic
    // search traffic never need a full re-crawl at all.
    const nextConfidence = applyRediscoverySuccess(existing.confidence ?? CONFIDENCE_DEFAULT);
    await supabaseAdmin
      .from("businesses")
      .update({
        last_verified_at: new Date().toISOString(),
        verification_due_at: new Date(Date.now() + VERIFICATION_INTERVAL_MS).toISOString(),
        last_verification_kind: "rediscovery",
        confidence: nextConfidence,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return existing.id as string;
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("businesses")
    .insert({
      name: lead.name,
      category: lead.category,
      niche: lead.niche,
      query_used: lead.query,
      region: region || lead.region,
      address: lead.address,
      website: lead.website || null,
      email: lead.email || null,
      phone: lead.phone || null,
      instagram: lead.instagram || null,
      facebook: lead.facebook || null,
      reviews_count: lead.reviews ?? 0,
      reviews_rating: lead.rating,
      has_photos: lead.has_photos,
      is_disqualified: Boolean(lead.is_disqualified),
      last_verification_kind: "full",
      signals: extractSignals(lead),
      raw_data: lead,
      fingerprints: lead.fingerprints,
    })
    .select("id")
    .single();

  if (error) throw error;

  // Phase 6: score this business for all 12 professions right away — the
  // very first time a business is discovered, not just on some later
  // verification pass. `instant_pool_ranked` reads this table via
  // pool_lookup() (migrations/003_pool_lookup.sql), so a business is
  // ranking-eligible the moment it enters the pool.
  await computeAndStoreOpportunityScores(inserted.id as string);

  return inserted.id as string;
}

function toLeadRow(
  business: PoolBusiness,
  ctx: DeliveryContext,
  extra: { igFollowers?: string | null; igBio?: string | null; igLastPost?: string | null } = {},
) {
  return {
    user_id: ctx.userId,
    business_id: business.id,
    profession_slug: ctx.professionSlug,
    opportunity_score: ctx.opportunityScore ?? null,
    discovery_mode: ctx.discoveryMode,
    scrape_job_id: ctx.scrapeJobId || null,
    credit_charged: true,

    business_name: business.name,
    instagram_handle: business.instagram || null,
    email: business.email || null,
    website: business.website || null,
    phone: business.phone || null,
    niche: business.niche || null,
    location: business.address || null,
    status: "new",
    ig_followers: extra.igFollowers ?? null,
    ig_bio: extra.igBio ?? null,
    ig_last_post: extra.igLastPost ?? null,
    source: `discover_${ctx.discoveryMode}`,
  };
}

/**
 * Inserts the CRM row (`leads`) linking a user to a business already in the
 * Global Lead Pool, charging a credit only if this is genuinely new for
 * this user. Shared by:
 *  - deliverLead() below, right after a fresh scrape upserts the business
 *  - poolLookup.ts (Phase 3), which finds an existing business and never
 *    touches the scraper at all
 * so "what it means to deliver an opportunity to a user" is defined once.
 *
 * PHASE 5 hardening: credit is reserved atomically (row-locked, see
 * migrations/005_usage_hardening.sql) BEFORE the CRM row is inserted, so a
 * long-running Live Discovery job — or two concurrent requests — can never
 * jointly deliver more than the plan actually allows. The unique
 * (user_id, business_id) index remains a second line of defense for the
 * rare race between the pre-check and the insert; if it fires, the
 * reservation is refunded so the user isn't charged for a duplicate.
 */
export async function insertLeadForUser(
  business: PoolBusiness,
  ctx: DeliveryContext,
  extra?: { igFollowers?: string | null; igBio?: string | null; igLastPost?: string | null },
): Promise<DeliveryResult> {
  if (!ctx.userId) {
    return { businessId: business.id, wasNewForUser: false };
  }
  if (ctx.dailyLimit == null || ctx.monthlyLimit == null) {
    throw new Error("insertLeadForUser: dailyLimit/monthlyLimit are required when userId is set");
  }

  // Skip the reservation entirely for a business this user already has —
  // avoids charging-then-refunding on the common case (re-discovering the
  // same business across requests), not just the rare race.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) {
    return { businessId: business.id, wasNewForUser: false };
  }

  const { data: reservation, error: reserveError } = await supabaseAdmin
    .rpc("try_increment_lead_usage", {
      p_user_id: ctx.userId,
      p_daily_limit: ctx.dailyLimit,
      p_monthly_limit: ctx.monthlyLimit,
      p_count: 1,
    })
    .single();
  if (reserveError) throw reserveError;
  if (!(reservation as { allowed: boolean }).allowed) {
    return { businessId: business.id, wasNewForUser: false, limitReached: true };
  }

  const { data: insertedLead, error } = await supabaseAdmin
    .from("leads")
    .insert(toLeadRow(business, ctx, extra))
    .select("id")
    .maybeSingle(); // null (not an error) if the unique (user_id, business_id) index rejected a dup

  if (error && !error.message.includes("duplicate key")) {
    // Insert failed for a real reason — refund the reservation, we didn't
    // actually deliver anything.
    await supabaseAdmin.rpc("try_increment_lead_usage", {
      p_user_id: ctx.userId,
      p_daily_limit: ctx.dailyLimit,
      p_monthly_limit: ctx.monthlyLimit,
      p_count: -1,
    });
    throw error;
  }

  const wasNewForUser = Boolean(insertedLead);

  if (!wasNewForUser) {
    // Lost the race between the existence check above and this insert —
    // someone else delivered this exact business to this user in between.
    // Refund the reservation we just made; it was never actually used.
    await supabaseAdmin.rpc("try_increment_lead_usage", {
      p_user_id: ctx.userId,
      p_daily_limit: ctx.dailyLimit,
      p_monthly_limit: ctx.monthlyLimit,
      p_count: -1,
    });
    return { businessId: business.id, wasNewForUser: false };
  }

  // Seed one timeline event so the CRM/Relationships view isn't empty the
  // moment a real opportunity lands — the existing UI already reads
  // `lead_activities` for this. This states what actually happened
  // (how/when it was found), not a fabricated AI analysis — that's
  // Phase 8's job, on top of this same table.
  const sourceLabel =
    ctx.discoveryMode === "live"
      ? "Live Discovery"
      : ctx.discoveryMode === "instant_pool_ranked"
        ? "Instant Discovery (Opportunity-ranked)"
        : "Instant Discovery";

  const { error: activityError } = await supabaseAdmin.from("lead_activities").insert({
    lead_id: insertedLead!.id,
    user_id: ctx.userId,
    type: "opportunity_discovered",
    timestamp: new Date().toISOString(),
    content: `Opportunity discovered via ${sourceLabel}.`,
  });
  if (activityError) {
    // Non-fatal — the lead itself was already delivered and charged
    // correctly; a missing timeline entry shouldn't fail the delivery.
    console.error("[deliverLead] failed to seed lead_activities:", activityError.message);
  }

  return { businessId: business.id, wasNewForUser };
}

/**
 * Writes one engine lead into the Global Lead Pool, and — if this delivery
 * is attached to a user (i.e. not a background pool.expand job) — into that
 * user's CRM (`leads`), charging a credit only if they haven't already
 * received this exact business (enforced by the DB-level unique index from
 * migration 001, not just this check — this is belt-and-suspenders against
 * races between concurrent deliveries).
 */
export async function deliverLead(lead: EngineLead, ctx: DeliveryContext, region: string): Promise<DeliveryResult> {
  const businessId = await upsertBusinessFromEngineLead(lead, region);

  return insertLeadForUser(
    {
      id: businessId,
      name: lead.name,
      niche: lead.niche || null,
      address: lead.address || null,
      website: lead.website || null,
      email: lead.email || null,
      phone: lead.phone || null,
      instagram: lead.instagram || null,
    },
    ctx,
    {
      igFollowers: lead.ig_followers != null ? String(lead.ig_followers) : null,
      igBio: lead.ig_bio || null,
      igLastPost: lead.ig_last_post_days != null ? `${lead.ig_last_post_days}d ago` : null,
    },
  );
}
