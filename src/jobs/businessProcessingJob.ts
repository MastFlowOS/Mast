import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { runEngineVerify, runEngineEnrich, runEngineScore } from "../scraperBridge/pythonBridge.js";
import { trySharedPidAdmission } from "../lib/resourceCapacity.js";
import { isValidEmail, isValidPhone, validateLead } from "../lib/leadValidation.js";
import { computeAndStoreBusinessHealth } from "../scoring/storeBusinessHealth.js";
import { computeAndStoreOpportunityScores } from "../scoring/storeOpportunityScores.js";
import { toJson, isJsonObject } from "../lib/json.js";
import type { Json } from "../types/database.types.js";
import { env } from "../config/env.js";
import { aiEnabled, generateJSON, AI_MODEL } from "../lib/ai.js";
import { PROFESSION_SLUGS } from "../scoring/professionWeights.js";
import { trackActiveEnrichment, trackActiveIntelligence } from "../lib/enrichmentTelemetry.js";
import {
  ADMISSION_BLOCKED_TASK_ERROR_PREFIX,
  isRecoverableAdmissionBlockedTask,
} from "../lib/businessTaskRecovery.js";

export type ProcessingKind = "enrich" | "score";
export type BusinessProcessingPayload = { taskId: string };

/**
 * P0 — SHARED LIVE PID ADMISSION: thrown when trySharedPidAdmission()
 * (resourceCapacity.ts) denies enrichment/score subprocess admission at the
 * moment of spawn. Deliberately just a plain Error subclass, not a new
 * retry mechanism — handleBusinessProcessingJob()'s existing `catch` block
 * below already resets the durable business_processing_tasks row back to
 * "queued" (never "failed") and rethrows for pg-boss's own retry policy on
 * ANY thrown error, which is exactly the "preserve queue items, don't mark
 * a legitimate candidate rejected, let the scheduler retry later" behavior
 * the P0 admission-control fix requires — reusing it here is the smallest
 * safe way to get that behavior, not a new one.
 */
export class PidAdmissionUnavailableError extends Error {
  constructor(reason: string) {
    super(`enrichment subprocess admission unavailable: ${reason}`);
    this.name = "PidAdmissionUnavailableError";
  }
}

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
  await boss.send(
    kind === "enrich" ? QUEUES.businessEnrich : QUEUES.businessScore,
    { taskId: task.id },
    { singletonKey: `business-processing:${kind}:${task.id}` },
  );
}

/**
 * Re-dispatch durable task rows that were left queued after the known
 * transient PID-admission guard rejected their subprocess. pg-boss exhausts
 * its own retries independently from business_processing_tasks, so without
 * this sweep a failed/expired queue job can leave a queued DB row forever.
 *
 * The narrow error prefix avoids repeatedly retrying unrelated permanent
 * errors. singletonKey keeps one queued/active pg-boss job per task even when
 * the sweep runs again before a worker has claimed the DB row.
 */
export async function requeueAdmissionBlockedBusinessTasks(
  maxTasks = 500,
): Promise<{ candidates: number; enqueued: number }> {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const { data, error } = await supabaseAdmin.from("business_processing_tasks")
    .select("id, kind, status, error, created_at")
    .eq("status", "queued")
    .in("kind", ["enrich", "score"])
    .like("error", `${ADMISSION_BLOCKED_TASK_ERROR_PREFIX}%`)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(maxTasks);
  if (error) throw error;

  const nowMs = Date.now();
  const candidates = (data ?? []).filter((task) =>
    isRecoverableAdmissionBlockedTask(task, nowMs),
  );
  if (candidates.length === 0) return { candidates: 0, enqueued: 0 };

  const boss = await getBoss();
  let enqueued = 0;
  for (const task of candidates) {
    const queueName = task.kind === "enrich" ? QUEUES.businessEnrich : QUEUES.businessScore;
    const jobId = await boss.send(
      queueName,
      { taskId: task.id },
      { singletonKey: `business-processing:${task.kind}:${task.id}` },
    );
    if (jobId) enqueued++;
  }

  return { candidates: candidates.length, enqueued };
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