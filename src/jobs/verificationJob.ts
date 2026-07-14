import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineVerify } from "../scraperBridge/pythonBridge.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
import { computeAndStoreBusinessHealth } from "../scoring/storeBusinessHealth.js";
import {
  applyFullVerificationSuccess,
  applyVerificationFailure,
  shouldArchive,
  VERIFICATION_INTERVAL_MS,
  FAILED_VERIFICATION_RECHECK_MS,
} from "../scoring/confidenceModel.js";

export type VerificationJobPayload = {
  batchSize: number;
};

type DueBusiness = {
  id: string;
  website: string | null;
  instagram: string | null;
  confidence: number;
};

/**
 * PHASE 7. Re-checks businesses whose verification window has lapsed by
 * calling the engine's verify_business (a direct website/Instagram
 * re-check, no Maps search — see scraper-bridge/README.md), then applies
 * the gradual confidence model:
 *
 *  - Both checked channels resolve fine (or there was nothing to check) ->
 *    confidence increases, verification_due_at pushed out a full interval.
 *  - Any checked channel no longer resolves -> confidence decreases. If
 *    that drops confidence to/below the archive threshold, the business is
 *    ARCHIVED (never deleted — pool_lookup excludes it, nothing else does).
 *    Otherwise it's rescheduled sooner for closer monitoring.
 *
 * Businesses naturally rediscovered during normal searches
 * (deliverLead.ts's `upsertBusinessFromEngineLead`) already got this exact
 * treatment as a lightweight success and pushed their own
 * `verification_due_at` out — so by construction, this job only ever picks
 * up businesses that have NOT been organically observed within the
 * window, which is the whole point of running it at all.
 *
 * Each business is isolated in its own try/catch — one bad crawl (or a
 * subprocess crash) must not abort the rest of the batch.
 */
export async function handleVerificationJob(payload: VerificationJobPayload): Promise<void> {
  const { data: due, error } = await supabaseAdmin
    .from("businesses")
    .select("id, website, instagram, confidence")
    .lte("verification_due_at", new Date().toISOString())
    .eq("is_disqualified", false)
    .is("archived_at", null)
    .order("verification_due_at", { ascending: true })
    .limit(payload.batchSize);
  if (error) throw error;

  const businesses = (due ?? []) as DueBusiness[];
  console.log(`[verificationJob] ${businesses.length} businesses due for re-verification`);

  let succeeded = 0;
  let failed = 0;
  let archived = 0;

  // Sequential on purpose: this is a background batch job with no
  // user-facing latency to protect, and going one at a time is the
  // simplest way to avoid hammering many different real-world sites and
  // Instagram concurrently from one worker. Straightforward to bound with
  // a small concurrency pool later if 200/batch proves too slow.
  for (const business of businesses) {
    try {
      const outcome = await verifyOne(business);
      if (outcome === "success") succeeded += 1;
      else if (outcome === "failure") failed += 1;
      else if (outcome === "archived") archived += 1;
    } catch (err) {
      console.error(`[verificationJob] business=${business.id} verification threw, treating as failure:`, err);
      await applyFailureAndMaybeArchive(business);
      failed += 1;
    }
  }

  console.log(`[verificationJob] done — succeeded=${succeeded} failed=${failed} archived=${archived}`);
}

async function verifyOne(business: DueBusiness): Promise<"success" | "failure" | "archived" | "inconclusive"> {
  const result = await runEngineVerify({
    website: business.website ?? undefined,
    instagram: business.instagram ?? undefined,
  });

  const checked: { channel: "website" | "instagram"; ok: boolean }[] = [];
  if (result.website_ok !== null) checked.push({ channel: "website", ok: result.website_ok });
  if (result.instagram_ok !== null) checked.push({ channel: "instagram", ok: result.instagram_ok });

  if (checked.length === 0) {
    // Nothing on file to check (no website AND no instagram) — can't
    // conclude anything either way. Still worth confirming we looked, so
    // don't leave it stuck at the same due date forever, but don't touch
    // confidence for something we didn't actually verify.
    await supabaseAdmin
      .from("businesses")
      .update({
        last_verified_at: new Date().toISOString(),
        verification_due_at: new Date(Date.now() + VERIFICATION_INTERVAL_MS).toISOString(),
        last_verification_kind: "full",
        updated_at: new Date().toISOString(),
      })
      .eq("id", business.id);
    return "inconclusive";
  }

  // C1 fix (audit root cause): this used to compute one whole-business
  // `allOk = checkedResults.every(ok => ok)` verdict across every channel
  // that was checked. If a business had a perfectly live, reachable
  // website but its Instagram handle had merely changed or gone private,
  // `allOk` was false, the business went down the FAILURE path, confidence
  // dropped, and — after enough cycles — it was silently ARCHIVED for
  // every user, forever, over an Instagram-only problem. A rebranded or
  // deleted IG handle is unrelated to whether the phone/email/website
  // still work.
  //
  // Fix: any channel that is still confirmed alive counts as a real,
  // positive verification result for the business as a whole. Archiving
  // (the failure path) is now reserved for the case the audit's "best
  // solution" describes as the minimum bar: every channel that was checked
  // has failed — i.e. there is no live channel left at all, not "one
  // channel among several."
  const anyChannelAlive = checked.some((c) => c.ok);

  if (anyChannelAlive) {
    const websiteAlive = checked.find((c) => c.channel === "website")?.ok ?? null;
    const instagramAlive = checked.find((c) => c.channel === "instagram")?.ok ?? null;

    const refreshedFields: Record<string, unknown> = {};
    // Only refresh fields belonging to a channel that's actually alive —
    // a dead Instagram channel should never get to overwrite/clear website
    // fields, and vice versa. Only overwrite with genuinely new, truthy
    // values — a temporary extraction miss on an otherwise-reachable site
    // shouldn't blank out previously-known good data.
    if (websiteAlive) {
      if (result.website_data.email) refreshedFields.email = result.website_data.email;
      if (result.website_data.phone) refreshedFields.phone = result.website_data.phone;
      if (result.website_data.instagram) refreshedFields.instagram = result.website_data.instagram;
      if (result.website_data.facebook) refreshedFields.facebook = result.website_data.facebook;
      if (result.website_data.linkedin) refreshedFields.linkedin = result.website_data.linkedin;
      if (result.website_data.emails?.length) refreshedFields.emails = result.website_data.emails;
      if (result.website_data.phones?.length) refreshedFields.phones = result.website_data.phones;
      if (result.website_data.ssl_valid !== undefined) refreshedFields.ssl_valid = result.website_data.ssl_valid;
      if (result.website_data.load_time_ms != null) refreshedFields.load_time_ms = result.website_data.load_time_ms;
      if (result.website_data.seo) refreshedFields.seo = result.website_data.seo;
      if (result.website_data.blog) refreshedFields.blog = result.website_data.blog;
    }

    const { data: current } = await supabaseAdmin.from("businesses").select("signals").eq("id", business.id).single();
    const mergedSignals = {
      ...(current?.signals ?? {}),
      ...(websiteAlive && result.website_data.tech_stack ? { tech_stack: result.website_data.tech_stack } : {}),
      ...(websiteAlive && result.website_data.growth_signals && Object.keys(result.website_data.growth_signals).length > 0
        ? { growth_signals: result.website_data.growth_signals }
        : {}),
      ...(instagramAlive
        ? {
            ig_activity: result.instagram_data.private ? "PRIVATE" : "VERIFIED",
            ig_last_post_days: result.instagram_data.last_post_days ?? null,
            ig_legitimacy: result.instagram_data.legitimacy_score ?? 0,
          }
        : instagramAlive === false
          ? { ig_activity: "UNREACHABLE" } // record the dead channel without touching whole-record confidence
          : {}),
    };

    await supabaseAdmin
      .from("businesses")
      .update({
        ...refreshedFields,
        signals: mergedSignals,
        confidence: applyFullVerificationSuccess(business.confidence),
        last_verified_at: new Date().toISOString(),
        verification_due_at: new Date(Date.now() + VERIFICATION_INTERVAL_MS).toISOString(),
        last_verification_kind: "full",
        updated_at: new Date().toISOString(),
      })
      .eq("id", business.id);

    await computeAndStoreOpportunityScores(business.id);
    await computeAndStoreBusinessHealth(business.id);
    return "success";
  }

  // Every channel that was checked has failed — no live channel remains.
  // This IS a real archival candidate.
  const archivedNow = await applyFailureAndMaybeArchive(business);
  return archivedNow ? "archived" : "failure";
}

/** Returns true if this failure pushed the business into being archived. */
async function applyFailureAndMaybeArchive(business: DueBusiness): Promise<boolean> {
  const nextConfidence = applyVerificationFailure(business.confidence);
  const archive = shouldArchive(nextConfidence);

  if (archive) {
    await supabaseAdmin
      .from("businesses")
      .update({
        confidence: nextConfidence,
        archived_at: new Date().toISOString(),
        archived_reason: "Repeated verification failures — confidence bottomed out. Not deleted; excluded from delivery.",
        last_verified_at: new Date().toISOString(),
        last_verification_kind: "full",
        updated_at: new Date().toISOString(),
      })
      .eq("id", business.id);
  } else {
    await supabaseAdmin
      .from("businesses")
      .update({
        confidence: nextConfidence,
        last_verified_at: new Date().toISOString(),
        // Closer monitoring than the standard interval — this business
        // just failed a check but isn't archived yet.
        verification_due_at: new Date(Date.now() + FAILED_VERIFICATION_RECHECK_MS).toISOString(),
        last_verification_kind: "full",
        updated_at: new Date().toISOString(),
      })
      .eq("id", business.id);
  }

  // Rescore regardless — a failed channel (e.g. website now unreachable)
  // is itself a signal change worth reflecting in the Opportunity Score.
  await computeAndStoreOpportunityScores(business.id);
  await computeAndStoreBusinessHealth(business.id);

  return archive;
}
