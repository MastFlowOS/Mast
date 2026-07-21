import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runEngineVerify } from "../scraperBridge/pythonBridge.js";
import { isValidEmail, isValidPhone, validateLead } from "../lib/leadValidation.js";
import { computeAndStoreBusinessHealth } from "../scoring/storeBusinessHealth.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
import { toJson, isJsonObject } from "../lib/json.js";
import type { Json } from "../types/database.types.js";
import { env } from "../config/env.js";
import { aiEnabled, generateJSON, AI_MODEL } from "../lib/ai.js";
import { computeOpportunityScores, type ScorableBusiness } from "../scoring/opportunityScore.js";
import { explainOpportunity } from "../scoring/explainOpportunity.js";
import { type ProfessionSlug, PROFESSION_SLUGS } from "../scoring/professionWeights.js";

export type ProcessingKind = "enrich" | "score";
export type BusinessProcessingPayload = { taskId: string };

/**
 * Finds (or creates) the durable business_processing_tasks row for this
 * business+kind and returns it only if IT needs a fresh wake-up sent.
 *
 * Audit Broken #2 fix: the old version used
 * `.upsert(..., { onConflict: "business_id,kind", ignoreDuplicates: true })`.
 * Because business_processing_tasks has a unique (business_id, kind)
 * constraint, ON CONFLICT DO NOTHING meant that once a row for this
 * business+kind existed in ANY state — including "completed" — every
 * subsequent legitimate request to (re)process it (most notably
 * enrichBusiness()'s own post-enrichment re-score) silently no-op'd:
 * `data` came back null, so the guard `if (!data || data.status !== "queued")
 * return;` treated "someone already completed this" and "the correct
 * re-score request was just dropped" as the same thing.
 *
 * Here, a "completed"/"failed" row is a genuine new request and gets
 * reopened; a "queued"/"running" row already has a wake-up in flight (or
 * about to be claimed) and is left alone so we don't spam duplicate
 * messages for the same row.
 *
 * HEARTBEAT CRASH RECOVERY: a task stuck in "running" with a heartbeat
 * older than STALE_BUSINESS_TASK_TIMEOUT_MS belongs to a crashed worker.
 * It is treated as "completed" was never reached, i.e. we re-queue it,
 * so the business's enrichment/scoring is not silently lost.
 */
async function claimOrCreateProcessingTask(businessId: string, kind: ProcessingKind): Promise<{ id: string } | null> {
  const { data: existing, error: fetchError } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, status, last_heartbeat_at").eq("business_id", businessId).eq("kind", kind).maybeSingle();
  if (fetchError) throw fetchError;

  if (!existing) {
    const { data: inserted, error: insertError } = await supabaseAdmin.from("business_processing_tasks")
      .insert({ business_id: businessId, kind }).select("id").maybeSingle();
    if (insertError) {
      if (insertError.code === "23505") {
        // Lost a race with a concurrent enqueue for the same business+kind
        // (e.g. two discovery tasks discovering the same business at once)
        // — whoever landed the insert owns it now, defer to it.
        return claimOrCreateProcessingTask(businessId, kind);
      }
      throw insertError;
    }
    return inserted; // brand new row — definitely needs a wake-up
  }

  // Heartbeat-based stale detection: a running task with an old heartbeat
  // belongs to a crashed worker — treat it as needing a fresh wake-up.
  const staleMs = env.STALE_BUSINESS_TASK_TIMEOUT_MS;
  const isStaleRunning =
    existing.status === "running" &&
    existing.last_heartbeat_at != null &&
    Date.now() - Date.parse(existing.last_heartbeat_at) > staleMs;

  if (isStaleRunning) {
    const { data: reopened, error: staleUpdateErr } = await supabaseAdmin.from("business_processing_tasks")
      .update({ status: "queued", error: "stale: assumed crashed worker", completed_at: null })
      .eq("id", existing.id).eq("status", "running")
      .select("id").maybeSingle();
    if (staleUpdateErr) throw staleUpdateErr;
    if (!reopened) return claimOrCreateProcessingTask(businessId, kind);
    return reopened;
  }

  if (existing.status === "queued" || existing.status === "running") return null;

  // "completed" or "failed" — reopen instead of leaving it permanently
  // satisfied by whatever finished it last time.
  const { data: reopened, error: updateError } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "queued", error: null, completed_at: null })
    .eq("id", existing.id).eq("status", existing.status)
    .select("id").maybeSingle();
  if (updateError) throw updateError;
  if (!reopened) return claimOrCreateProcessingTask(businessId, kind); // status moved under us — recheck
  return reopened;
}


/** Persist first, then wake a specialised worker.  The row remains queued if
 * publishing fails, which makes this safe to replay from an operations job. */
export async function enqueueBusinessProcessing(businessId: string, kind: ProcessingKind): Promise<void> {
  const task = await claimOrCreateProcessingTask(businessId, kind);
  if (!task) return; // already queued or running — no new wake-up needed
  const boss = await getBoss();
  await boss.send(kind === "enrich" ? QUEUES.businessEnrich : QUEUES.businessScore, { taskId: task.id });
}

export async function handleBusinessProcessingJob(payload: BusinessProcessingPayload): Promise<void> {
  const { data: task, error } = await supabaseAdmin.from("business_processing_tasks").select("*").eq("id", payload.taskId).single();
  if (error) throw error;

  // Heartbeat-based stale re-claim: if this task is 'running' but its
  // heartbeat is older than STALE_BUSINESS_TASK_TIMEOUT_MS, the original
  // worker crashed — we may safely take it over.
  const staleMs = env.STALE_BUSINESS_TASK_TIMEOUT_MS;
  const isStale =
    task.status === "running" &&
    task.last_heartbeat_at != null &&
    Date.now() - Date.parse(task.last_heartbeat_at) > staleMs;

  const { data: claimed } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "running", attempts: (task.attempts ?? 0) + 1, started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), error: null })
    .eq("id", task.id)
    .in("status", isStale ? ["running"] : ["queued"])
    .select("id").maybeSingle();
  if (!claimed) return;

  // Heartbeat pulse — updates last_heartbeat_at so stale-detector knows
  // this worker is still alive during a long enrichment crawl.
  const heartbeatInterval = setInterval(() => {
    supabaseAdmin.from("business_processing_tasks")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", task.id)
      .then(() => {/* fire-and-forget */}, (e: unknown) => console.warn("[businessProcessing] heartbeat failed", e));
  }, 15_000);

  try {
    if (task.kind === "enrich") {
      await enrichBusiness(task.business_id);
    } else {
      await scoreBusiness(task.business_id);
    }
    clearInterval(heartbeatInterval);
    await supabaseAdmin.from("business_processing_tasks").update({ status: "completed", completed_at: new Date().toISOString(), last_heartbeat_at: null }).eq("id", task.id);
  } catch (err) {
    clearInterval(heartbeatInterval);
    // Resetting to queued lets pg-boss retry the same wake-up and leaves a
    // durable, inspectable record for a dispatcher if the process dies.
    await supabaseAdmin.from("business_processing_tasks").update({ status: "queued", error: err instanceof Error ? err.message : String(err), last_heartbeat_at: null }).eq("id", task.id);
    throw err;
  }
}

const ENRICH_WAIT_INTERVAL_MS = 1000;
const ENRICH_WAIT_TIMEOUT_MS = 30000;

/**
 * Synchronously ensures a business has been through enrichment (website crawl/email extraction).
 */
export async function ensureEnriched(businessId: string): Promise<void> {
  const { data: task, error } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, status, attempts").eq("business_id", businessId).eq("kind", "enrich").maybeSingle();
  if (error) throw error;
  if (!task || task.status === "completed") return; // nothing pending, or already done

  const { data: claimed } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "running", attempts: (task.attempts ?? 0) + 1, started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), error: null })
    .eq("id", task.id).eq("status", "queued").select("id, attempts").maybeSingle();

  if (claimed) {
    try {
      await enrichBusiness(businessId);
      await supabaseAdmin.from("business_processing_tasks").update({ status: "completed", completed_at: new Date().toISOString(), last_heartbeat_at: null }).eq("id", claimed.id);
    } catch (err) {
      await supabaseAdmin.from("business_processing_tasks").update({ status: "queued", error: err instanceof Error ? err.message : String(err), last_heartbeat_at: null }).eq("id", claimed.id);
      throw err;
    }
    return;
  }

  // Someone else already owns this task — wait for them rather than racing.
  const deadline = Date.now() + ENRICH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ENRICH_WAIT_INTERVAL_MS));
    const { data: current } = await supabaseAdmin.from("business_processing_tasks").select("status").eq("id", task.id).maybeSingle();
    if (!current || current.status === "completed") return;
    if (current.status === "queued") {
      return ensureEnriched(businessId);
    }
  }
}

/**
 * Synchronously ensures a business has been through the intelligence pass (Instagram crawl/AI caching).
 */
export async function ensureIntelligence(businessId: string): Promise<void> {
  const { data: task, error } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, status, attempts").eq("business_id", businessId).eq("kind", "score").maybeSingle();
  if (error) throw error;
  if (!task || task.status === "completed") return; // nothing pending, or already done

  const { data: claimed } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "running", attempts: (task.attempts ?? 0) + 1, started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), error: null })
    .eq("id", task.id).eq("status", "queued").select("id, attempts").maybeSingle();

  if (claimed) {
    try {
      await scoreBusiness(businessId);
      await supabaseAdmin.from("business_processing_tasks").update({ status: "completed", completed_at: new Date().toISOString(), last_heartbeat_at: null }).eq("id", claimed.id);
    } catch (err) {
      await supabaseAdmin.from("business_processing_tasks").update({ status: "queued", error: err instanceof Error ? err.message : String(err), last_heartbeat_at: null }).eq("id", claimed.id);
      throw err;
    }
    return;
  }

  // Someone else already owns this task — wait for them rather than racing.
  const deadline = Date.now() + ENRICH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ENRICH_WAIT_INTERVAL_MS));
    const { data: current } = await supabaseAdmin.from("business_processing_tasks").select("status").eq("id", task.id).maybeSingle();
    if (!current || current.status === "completed") return;
    if (current.status === "queued") {
      return ensureIntelligence(businessId);
    }
  }
}

async function enrichBusiness(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin.from("businesses")
    .select("name, email, phone, website, instagram, emails, phones, field_provenance")
    .eq("id", businessId).single();
  if (error) throw error;

  let site: any = {};
  if (business.website) {
    const result = await runEngineVerify({ website: business.website });
    site = result.website_data ?? {};
  }

  // Audit Broken #3 fix
  const siteEmail = isValidEmail(site.email) ? site.email : undefined;
  const sitePhone = isValidPhone(site.phone) ? site.phone : undefined;
  const siteEmails = (site.emails ?? []).map((entry: any) => entry.email).filter((email: any) => isValidEmail(email));
  const sitePhones = (site.phones ?? []).filter((phone: any) => isValidPhone(phone));

  const existingEmails: string[] = Array.isArray(business.emails)
    ? business.emails.map(extractStoredEmail).filter((email): email is string => typeof email === "string")
    : [];
  const existingPhones: string[] = Array.isArray(business.phones)
    ? business.phones.filter((phone): phone is string => typeof phone === "string")
    : [];
  const emails: string[] = Array.from(
    new Set([...existingEmails, siteEmail, ...siteEmails].filter((email): email is string => typeof email === "string")),
  );
  const phones: string[] = Array.from(
    new Set([...existingPhones, sitePhone, ...sitePhones].filter((phone): phone is string => typeof phone === "string")),
  );

  const provenance: Record<string, Json | undefined> = isJsonObject(business.field_provenance) ? { ...business.field_provenance } : {};
  for (const [field, source] of Object.entries(site.field_sources ?? {})) {
    if ((field === "email" && !siteEmail) || (field === "phone" && !sitePhone)) continue;
    provenance[field] = toJson(source);
  }

  // Update business with website data
  const { error: updateError } = await supabaseAdmin.from("businesses").update({
    email: siteEmail || undefined,
    phone: sitePhone || undefined,
    instagram: site.instagram || undefined,
    facebook: site.facebook || undefined,
    linkedin: site.linkedin || undefined,
    emails,
    phones,
    field_provenance: provenance,
    ssl_valid: site.ssl_valid ?? undefined,
    load_time_ms: site.load_time_ms ?? undefined,
    seo: site.seo ? toJson(site.seo) : undefined,
    blog: site.blog ? toJson(site.blog) : undefined,
    signals: toJson({ tech_stack: site.tech_stack ?? {} }), // only tech stack from site enrichment
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", businessId);
  if (updateError) throw updateError;

  // Validation
  const validation = validateLead({
    name: business.name,
    email: siteEmail || business.email,
    phone: sitePhone || business.phone,
    website: business.website,
    instagram: site.instagram || business.instagram,
  });
  if (!validation.valid) {
    console.log(`[enrichBusiness] businessId=${businessId} failed validation: ${validation.reason} — dropping`);
    return;
  }

  // Scoring
  await computeAndStoreOpportunityScores(businessId);
  await computeAndStoreBusinessHealth(businessId);

  // Push to intelligence queue
  await enqueueBusinessProcessing(businessId, "score");
}

async function scoreBusiness(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin.from("businesses")
    .select("name, website, instagram, email, phone, emails, phones, field_provenance, signals")
    .eq("id", businessId).single();
  if (error) throw error;

  let social: any = {};
  if (business.instagram) {
    const result = await runEngineVerify({ instagram: business.instagram });
    social = result.instagram_data ?? {};
  }

  // Remaining enrichment: update business with Instagram data
  const currentSignals = isJsonObject(business.signals) ? { ...business.signals } : {};
  const updatedSignals = {
    ...currentSignals,
    ig_followers: social.followers ?? null,
    ig_last_post_days: social.last_post_days ?? null,
    ig_activity: social.activity ?? null,
    ig_legitimacy: social.legitimacy_score ?? null,
  };

  const { error: updateError } = await supabaseAdmin.from("businesses").update({
    signals: toJson(updatedSignals),
    updated_at: new Date().toISOString(),
  }).eq("id", businessId);
  if (updateError) throw updateError;

  // Final scoring & health
  await computeAndStoreOpportunityScores(businessId);
  await computeAndStoreBusinessHealth(businessId);

  // AI intelligence: pre-generate opportunity insights if AI is enabled
  if (aiEnabled()) {
    try {
      await generateBackgroundOpportunityInsights(businessId);
    } catch (aiErr) {
      console.warn(`[scoreBusiness] AI opportunity insight pre-generation failed for businessId=${businessId}`, aiErr);
    }
  }
}

async function generateBackgroundOpportunityInsights(businessId: string): Promise<void> {
  const { data: topScore, error: scoreErr } = await supabaseAdmin
    .from("business_opportunity_scores")
    .select("profession_slug, opportunity_score")
    .eq("business_id", businessId)
    .order("opportunity_score", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scoreErr || !topScore || topScore.opportunity_score < 50) {
    return;
  }

  // Narrow the DB string to the branded ProfessionSlug type so TypeScript can
  // index the scores map safely. Unknown values are silently skipped — this is
  // a best-effort background cache fill, not a hard requirement.
  const slugRaw = topScore.profession_slug as string;
  if (!(PROFESSION_SLUGS as readonly string[]).includes(slugRaw)) return;
  const professionSlug = slugRaw as ProfessionSlug;

  const { data: business, error: bizError } = await supabaseAdmin
    .from("businesses")
    .select("name, niche, website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, is_disqualified, website_is_weak, ssl_valid, load_time_ms, seo, blog, signals")
    .eq("id", businessId)
    .single();
  if (bizError) throw bizError;

  const scores = computeOpportunityScores(business as ScorableBusiness);
  const result = scores[professionSlug];
  const explanation = explainOpportunity(business as ScorableBusiness, result, professionSlug);

  const insight = await generateJSON<{ headline: string; talkingPoints: string[]; openingLine: string }>({
    system:
      "You are MAST's Opportunity Intelligence assistant, helping a freelancer understand why a business " +
      "was surfaced as a sales opportunity. You are given real, already-computed facts — do not invent " +
      "anything not present in the input. Respond with ONLY a JSON object: " +
      '{"headline": string (<=12 words, why this is a good opportunity), ' +
      '"talkingPoints": string[] (2-4 short, concrete, non-generic points a freelancer could raise), ' +
      '"openingLine": string (one natural first-contact message opener, no greeting/signature, <=2 sentences)}. ' +
      "Keep tone professional and specific, never salesy or exaggerated.",
    user: JSON.stringify({
      businessName: business.name,
      niche: business.niche,
      profession: professionSlug,
      opportunityScore: result.score,
      reasons: explanation.reasons,
      summary: explanation.summary,
    }),
    maxTokens: 512,
  });

  const row = {
    business_id: businessId,
    profession_slug: professionSlug,
    headline: typeof insight.headline === "string" ? insight.headline : `A fresh opportunity: ${business.name}`,
    talking_points: Array.isArray(insight.talkingPoints) ? insight.talkingPoints : [],
    opening_line: typeof insight.openingLine === "string" ? insight.openingLine : "Hi — I came across your business and had a few ideas.",
    score_snapshot: result.score,
    model: AI_MODEL,
    generated_at: new Date().toISOString(),
  };

  await supabaseAdmin
    .from("business_opportunity_insights")
    .upsert(row, { onConflict: "business_id,profession_slug" });
}

/** `business.emails`/`business.phones` rows may be bare strings or `{
 * email, role }`-shaped objects (see EngineLead["emails"] in
 * pythonBridge.ts) — this pulls the string out of either shape, or returns
 * `undefined` for anything else so the caller's `.filter()` can drop it. */
function extractStoredEmail(entry: Json): string | undefined {
  if (typeof entry === "string") return entry;
  if (isJsonObject(entry) && typeof entry.email === "string") return entry.email;
  return undefined;
}
