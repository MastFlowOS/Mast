/**
 * Phase S1 — Pipeline Accounting & Invariant Tracking (Node half).
 *
 * Mirrors mast-lead-engine/utils/pipeline_trace.py on this side of the
 * process boundary. The Python engine mints a temporary pipeline id
 * ("#1", "#2", ...) the moment MapsScraper yields a business and threads
 * it through every stage until the lead crosses over to Node as JSON
 * (see EngineLead["_pipeline_id"] in pythonBridge.ts). This tracer picks
 * that same id up and keeps recording transitions through channel
 * filtering, validation, business creation, and lead insertion, so a
 * single business can be traced end-to-end across both processes by
 * grepping its id in the Python engine's logs and this worker's logs.
 *
 * This is observability only:
 *  - Lives entirely in process memory for the lifetime of exactly one
 *    discover/pool-expand job run — never persisted, no new table.
 *  - Recording a transition never changes what the job does — it is
 *    called alongside existing decision points, never in place of them.
 */

export type Outcome = "DELIVERED" | "REJECTED" | "FAILED";

/** Canonical stage order for this process's half of the pipeline — purely
 * descriptive, used only to report which stage a stuck business never
 * reached. Has no effect on any decision this worker makes.
 *
 * REALTIME_ELIGIBLE has no dedicated code path of its own: Supabase
 * Realtime broadcasts any INSERT on a table in the `supabase_realtime`
 * publication automatically (see migrations/004_realtime.sql, which adds
 * `leads`) — there is no separate application-level "send" call that can
 * fail independently of the INSERT itself, so it is recorded in the same
 * transition as DATABASE_INSERTED. */
const STAGE_ORDER = [
  "NODE_RECEIVED",
  "DATABASE_INSERT_STARTED",
  "DATABASE_INSERTED",
  "REALTIME_ELIGIBLE",
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

interface TraceRecord {
  pid: string;
  name: string;
  history: string[];
  outcome: Outcome | null;
  reason: string | null;
}

function nextStage(last: string): string {
  const idx = STAGE_ORDER.indexOf(last as Stage);
  if (idx === -1) return "<unknown — stage not in canonical order>";
  if (idx + 1 < STAGE_ORDER.length) return STAGE_ORDER[idx + 1];
  return "<end of this process's pipeline — FRONTEND_DELIVERED cannot be confirmed server-side, see Phase S1 write-up>";
}

/** One instance per job run (one handleDiscoverJob / handlePoolExpandJob call). */
export class PipelineTracer {
  private records = new Map<string, TraceRecord>();
  private unkeyedCounter = 0;

  /**
   * Call the moment a lead is received from runEngineQuery(). `pid` should
   * be `lead._pipeline_id` as sent by the Python engine; if it's ever
   * missing (should not happen for a real production lead, only possible
   * for a hand-rolled/mocked one), a local fallback id is minted so the
   * business still gets a first-class entry instead of being dropped from
   * this accounting silently — the same "never let it vanish" rule this
   * whole system exists to enforce.
   */
  receive(pid: string | undefined | null, name: string): string {
    let id = pid || "";
    if (!id) {
      this.unkeyedCounter += 1;
      id = `unkeyed:${this.unkeyedCounter}`;
      console.warn(
        `[pipeline][${id}] received a lead with no _pipeline_id from the engine (name=${JSON.stringify(name)}) — ` +
          `assigning a local fallback id so it still gets accounted for`,
      );
    }
    const rec: TraceRecord = { pid: id, name: name || "<unnamed>", history: ["NODE_RECEIVED"], outcome: null, reason: null };
    this.records.set(id, rec);
    console.log(`[pipeline][${id}] NODE_RECEIVED`);
    return id;
  }

  transition(pid: string, stage: Stage): void {
    const rec = this.records.get(pid);
    if (!rec) {
      console.warn(`[pipeline][${pid}] transition to ${stage} for an UNKNOWN pipeline id`);
      return;
    }
    if (rec.outcome !== null) {
      console.warn(`[pipeline][${pid}] transition to ${stage} requested AFTER terminal outcome ${rec.outcome} — ignored`);
      return;
    }
    rec.history.push(stage);
    console.log(`[pipeline][${pid}] ${stage}`);
  }

  reject(pid: string, reason: string): void {
    this.close(pid, "REJECTED", reason);
  }

  fail(pid: string, reason: string): void {
    this.close(pid, "FAILED", reason);
  }

  deliver(pid: string): void {
    this.close(pid, "DELIVERED", null);
  }

  private close(pid: string, outcome: Outcome, reason: string | null): void {
    const rec = this.records.get(pid);
    if (!rec) {
      console.warn(`[pipeline][${pid}] ${outcome} for an UNKNOWN pipeline id (reason=${reason})`);
      return;
    }
    if (rec.outcome !== null) {
      console.warn(
        `[pipeline][${pid}] duplicate terminal outcome — already ${rec.outcome} (${rec.reason}); ` +
          `also tried ${outcome} (${reason}) — keeping the first`,
      );
      return;
    }
    rec.outcome = outcome;
    rec.reason = reason;
    console.log(`[pipeline][${pid}] ${outcome}${reason ? ` reason=${reason}` : ""}`);
  }

  /**
   * Force-close every record that never reached a terminal outcome as
   * REJECTED with the given reason. Call this from a `finally` around the
   * whole job so an uncaught exception mid-run (or a deliberate early
   * `break`/abort) still leaves every received business accounted for
   * instead of just cutting the reconciliation report off mid-way.
   */
  sweepIncomplete(reason: string): number {
    let swept = 0;
    for (const rec of this.records.values()) {
      if (rec.outcome === null) {
        rec.outcome = "REJECTED";
        rec.reason = reason;
        swept += 1;
      }
    }
    if (swept) console.log(`[pipeline] swept ${swept} in-flight business(es) -> REJECTED (reason=${reason})`);
    return swept;
  }

  /** Build the end-of-run reconciliation summary plus, if the invariant
   * was violated, one explicit violation block per missing business. */
  reconcile(): string {
    const all = [...this.records.values()];
    const received = all.length;
    const delivered = all.filter((r) => r.outcome === "DELIVERED").length;
    const rejected = all.filter((r) => r.outcome === "REJECTED").length;
    const failed = all.filter((r) => r.outcome === "FAILED").length;
    const missing = all.filter((r) => r.outcome === null);

    const lines = [
      "=====================================",
      `Businesses received from engine : ${received}`,
      `Delivered                       : ${delivered}`,
      `Rejected                        : ${rejected}`,
      `Failed                          : ${failed}`,
      `Missing                         : ${missing.length}`,
      "=====================================",
    ];

    if (missing.length) {
      lines.push("");
      for (const rec of missing) {
        const lastStage = rec.history[rec.history.length - 1] ?? "<never recorded>";
        lines.push("PIPELINE INVARIANT VIOLATION");
        lines.push(`Business ${rec.pid} (${rec.name})`);
        lines.push("Last Seen:");
        lines.push(`  ${lastStage}`);
        lines.push("Never reached:");
        lines.push(`  ${nextStage(lastStage)}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}
