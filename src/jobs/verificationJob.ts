import { supabaseAdmin } from "../lib/supabase.js";
import { runEngineVerify } from "../scraperBridge/pythonBridge.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
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

  const checkedResults = [result.website_ok, result.instagram_ok].filter((v) => v !== null) as boolean[];

  if (checkedResults.length === 0) {
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

  const allOk = checkedResults.every((ok) => ok);

  if (allOk) {
    const refreshedFields: Record<string, unknown> = {};
    // Only overwrite with genuinely new, truthy values — a temporary
    // extraction miss on an otherwise-reachable site shouldn't blank out
    // previously-known good data.
    if (result.website_data.email) refreshedFields.email = result.website_data.email;
    if (result.website_data.phone) refreshedFields.phone = result.website_data.phone;
    if (result.website_data.instagram) refreshedFields.instagram = result.website_data.instagram;
    if (result.website_data.facebook) refreshedFields.facebook = result.website_data.facebook;

    const { data: current } = await supabaseAdmin.from("businesses").select("signals").eq("id", business.id).single();
    const mergedSignals = {
      ...(current?.signals ?? {}),
      ...(result.website_data.tech_stack ? { tech_stack: result.website_data.tech_stack } : {}),
      ...(result.instagram_ok
        ? {
            ig_activity: result.instagram_data.private ? "PRIVATE" : "VERIFIED",
            ig_last_post_days: result.instagram_data.last_post_days ?? null,
            ig_legitimacy: result.instagram_data.legitimacy_score ?? 0,
          }
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
    return "success";
  }

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

  return archive;
}
