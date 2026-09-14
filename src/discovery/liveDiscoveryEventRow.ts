/**
 * MAST — Live Discovery UI (Task 3 of 3).
 *
 * Pure row -> DiscoveryLiveEvent mapping, extracted out of
 * use-live-discovery.ts so it has zero runtime dependencies (no
 * `@/lib/supabase`, no `import.meta.env`) and can be unit tested with the
 * plain node:test runner the rest of this codebase's test:server suite
 * uses — src/hooks/use-live-discovery.ts itself cannot be, since importing
 * it pulls in the Vite-only `import.meta.env` read in src/lib/supabase.ts.
 *
 * This is the ONLY place Task 3 translates between the wire (DB row) shape
 * and Task 1's DiscoveryLiveEvent shape — no second copy of this mapping
 * exists anywhere else.
 */
import type { DiscoveryLiveEvent, DiscoveryLiveEventType } from "./liveDiscoveryEvent.js";

export type DiscoveryLiveEventRow = {
  plan_id: string;
  event_id: string;
  event_type: DiscoveryLiveEventType;
  scout_id: number | null;
  area_label: string | null;
  pipeline_id: string | null;
  business_name: string | null;
  reason: string | null;
  delivered_count: number | null;
  target: number | null;
  area_outcome: DiscoveryLiveEvent["areaOutcome"] | null;
  failure_reason: string | null;
  event_timestamp: string;
};

/** Every nullable DB column becomes `undefined` (never `null`), matching DiscoveryLiveEvent's optional-field contract exactly. */
export function rowToDiscoveryLiveEvent(row: DiscoveryLiveEventRow): DiscoveryLiveEvent {
  return {
    id: row.event_id,
    timestamp: new Date(row.event_timestamp).getTime(),
    planId: row.plan_id,
    type: row.event_type,
    scoutId: row.scout_id ?? undefined,
    areaLabel: row.area_label ?? undefined,
    pipelineId: row.pipeline_id ?? undefined,
    businessName: row.business_name ?? undefined,
    reason: row.reason ?? undefined,
    deliveredCount: row.delivered_count ?? undefined,
    target: row.target ?? undefined,
    areaOutcome: row.area_outcome ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}
