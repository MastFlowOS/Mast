import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runEngineVerify } from "../scraperBridge/pythonBridge.js";
import { isValidEmail, isValidPhone } from "../lib/leadValidation.js";
import { computeAndStoreBusinessHealth } from "../scoring/storeBusinessHealth.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
import { toJson, isJsonObject } from "../lib/json.js";
import type { Json } from "../types/database.types.js";

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
 */
async function claimOrCreateProcessingTask(businessId: string, kind: ProcessingKind): Promise<{ id: string } | null> {
  const { data: existing, error: fetchError } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, status").eq("business_id", businessId).eq("kind", kind).maybeSingle();
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
  const { data: claimed } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "running", attempts: (task.attempts ?? 0) + 1, started_at: new Date().toISOString(), error: null })
    .eq("id", task.id).eq("status", "queued").select("id").maybeSingle();
  if (!claimed) return;

  try {
    if (task.kind === "enrich") await enrichBusiness(task.business_id);
    else {
      await computeAndStoreOpportunityScores(task.business_id);
      await computeAndStoreBusinessHealth(task.business_id);
    }
    await supabaseAdmin.from("business_processing_tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", task.id);
  } catch (err) {
    // Resetting to queued lets pg-boss retry the same wake-up and leaves a
    // durable, inspectable record for a dispatcher if the process dies.
    await supabaseAdmin.from("business_processing_tasks").update({ status: "queued", error: err instanceof Error ? err.message : String(err) }).eq("id", task.id);
    throw err;
  }
}

const ENRICH_WAIT_INTERVAL_MS = 1000;
const ENRICH_WAIT_TIMEOUT_MS = 30000;

/**
 * Synchronously ensures a business has been through enrichment. For most
 * callers enrichment can stay purely background (the `business.enrich`
 * queue above). But handleDiscoveryTask (see audit Broken #1) needs to see
 * crawled email/instagram data BEFORE deciding whether a lead satisfies a
 * user's requested channels, and can't wait for an arbitrary future queue
 * cycle to make that call.
 *
 * This coordinates with the async worker via the exact same durable
 * business_processing_tasks row and claim (`status = "queued" ->
 * "running"`) used by handleBusinessProcessingJob, so the crawl only ever
 * runs once — whichever side (this inline call, the queued worker, or
 * another concurrent lead for the same business) claims the row first does
 * the work; everyone else waits for/reads the result instead of re-crawling
 * the same website/Instagram profile.
 */
export async function ensureEnriched(businessId: string): Promise<void> {
  const { data: task, error } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, status, attempts").eq("business_id", businessId).eq("kind", "enrich").maybeSingle();
  if (error) throw error;
  if (!task || task.status === "completed") return; // nothing pending, or already done

  const { data: claimed } = await supabaseAdmin.from("business_processing_tasks")
    .update({ status: "running", attempts: (task.attempts ?? 0) + 1, started_at: new Date().toISOString(), error: null })
    .eq("id", task.id).eq("status", "queued").select("id, attempts").maybeSingle();

  if (claimed) {
    try {
      await enrichBusiness(businessId);
      await supabaseAdmin.from("business_processing_tasks").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", claimed.id);
    } catch (err) {
      await supabaseAdmin.from("business_processing_tasks").update({ status: "queued", error: err instanceof Error ? err.message : String(err) }).eq("id", claimed.id);
      throw err;
    }
    return;
  }

  // Someone else already owns this task (the queue worker beat us to the
  // claim, or another concurrent lead for the same business) — wait for
  // them rather than racing a second crawl.
  const deadline = Date.now() + ENRICH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ENRICH_WAIT_INTERVAL_MS));
    const { data: current } = await supabaseAdmin.from("business_processing_tasks").select("status").eq("id", task.id).maybeSingle();
    if (!current || current.status === "completed") return;
    if (current.status === "queued") {
      // Whoever held the claim reset it (failed) — take another shot for
      // the remainder of our budget.
      return ensureEnriched(businessId);
    }
  }
  // Timed out still "running" — give up waiting rather than blocking a
  // whole discovery task indefinitely on one slow crawl. The caller's
  // post-enrichment channel check will correctly treat still-missing
  // fields as not-yet-satisfied (fail closed), and the business itself
  // isn't lost — the async worker will still finish enriching it in the
  // background for future deliveries/pool use.
}

async function enrichBusiness(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin.from("businesses")
    .select("email, phone, website, instagram, emails, phones, field_provenance")
    .eq("id", businessId).single();
  if (error) throw error;
  if (!business.website && !business.instagram) {
    await enqueueBusinessProcessing(businessId, "score");
    return;
  }

  const result = await runEngineVerify({ website: business.website ?? "", instagram: business.instagram ?? "" });
  const site = result.website_data ?? {};
  const social = result.instagram_data ?? {};

  // Audit Broken #3 fix: the crawl found this data, but nothing checked it
  // for the same format/placeholder problems leadValidation.ts already
  // guards against at discovery time — a malformed or placeholder
  // email/phone left in a template (e.g. test@example.com) could reach a
  // delivered lead un-vetted. Drop just the offending value rather than
  // failing the whole business: the crawl may still have found a good
  // website/other channel worth keeping.
  const siteEmail = isValidEmail(site.email) ? site.email : undefined;
  const sitePhone = isValidPhone(site.phone) ? site.phone : undefined;
  const siteEmails = (site.emails ?? []).map((entry) => entry.email).filter((email) => isValidEmail(email));
  const sitePhones = (site.phones ?? []).filter((phone) => isValidPhone(phone));

  // `emails`/`phones` are stored either as bare strings or (older rows) as
  // `{ email, role }`-shaped objects — pull just the string out of either
  // shape rather than assuming one.
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
    // Don't attribute provenance for a value we just dropped as invalid.
    if ((field === "email" && !siteEmail) || (field === "phone" && !sitePhone)) continue;
    provenance[field] = toJson(source);
  }

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
    signals: toJson({ tech_stack: site.tech_stack ?? {}, ig_followers: social.followers ?? null, ig_last_post_days: social.last_post_days ?? null }),
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", businessId);
  if (updateError) throw updateError;
  await enqueueBusinessProcessing(businessId, "score");
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
