import { supabaseAdmin } from "./supabaseAdmin.js";

/**
 * Gathers the real numbers every Phase 8 AI prompt is grounded in. Nothing
 * here is AI-generated — it's a plain aggregation over `leads` (the CRM
 * table Relationships/Pipeline/Mission already read from) plus
 * `business_opportunity_scores`. lib/ai.ts is only ever handed the output
 * of this function, never raw DB access, so a prompt can't accidentally
 * pull in more than it should.
 *
 * Stage mapping mirrors the frontend's `src/lib/lead-workspace.ts`
 * STATUS_TO_STAGE (same drift-risk note as config/plans.ts: no shared
 * package between frontend and gateway yet).
 */

type FlowStage = "new" | "contacted" | "replied" | "meeting" | "won";

const STATUS_TO_STAGE: Record<string, FlowStage> = {
  new: "new",
  email_sent: "contacted",
  called: "contacted",
  instagram_sent: "contacted",
  replied: "replied",
  meeting_booked: "meeting",
  closed: "won",
  dead: "new",
};

function stageFor(status: string | null): FlowStage {
  return STATUS_TO_STAGE[(status ?? "new").toLowerCase().trim().replace(/\s+/g, "_")] ?? "new";
}

type LeadRow = {
  id: number;
  business_name: string;
  status: string | null;
  priority: string | null;
  opportunity_score: number | null;
  follow_up_at: string | null;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PipelineSnapshot = {
  totalLeads: number;
  stageCounts: Record<FlowStage, number>;
  overdueFollowups: number;
  uncontactedCount: number;
  wonThisPeriod: number;
  stalledDeals: Array<{ businessName: string; stage: FlowStage; daysSinceUpdate: number; priority: string | null }>;
  topUncontactedOpportunities: Array<{ businessName: string; opportunityScore: number | null }>;
};

const STALL_THRESHOLD_DAYS = 7;

export async function buildPipelineSnapshot(userId: string, sinceIso?: string): Promise<PipelineSnapshot> {
  let query = supabaseAdmin
    .from("leads")
    .select("id, business_name, status, priority, opportunity_score, follow_up_at, last_contacted_at, created_at, updated_at")
    .eq("user_id", userId);
  if (sinceIso) query = query.gte("created_at", sinceIso);

  const { data, error } = await query;
  if (error) throw error;

  const leads = (data ?? []) as LeadRow[];
  const now = Date.now();

  const stageCounts: Record<FlowStage, number> = { new: 0, contacted: 0, replied: 0, meeting: 0, won: 0 };
  const stalledDeals: PipelineSnapshot["stalledDeals"] = [];
  let overdueFollowups = 0;
  let uncontactedCount = 0;
  let wonThisPeriod = 0;

  for (const lead of leads) {
    const stage = stageFor(lead.status);
    stageCounts[stage] += 1;

    if (stage === "won") wonThisPeriod += 1;
    if (!lead.last_contacted_at) uncontactedCount += 1;

    if (lead.follow_up_at && new Date(lead.follow_up_at).getTime() < now && stage !== "won") {
      overdueFollowups += 1;
    }

    const daysSinceUpdate = (now - new Date(lead.updated_at).getTime()) / 86_400_000;
    if (stage !== "new" && stage !== "won" && daysSinceUpdate >= STALL_THRESHOLD_DAYS) {
      stalledDeals.push({ businessName: lead.business_name, stage, daysSinceUpdate: Math.round(daysSinceUpdate), priority: lead.priority });
    }
  }

  const topUncontactedOpportunities = leads
    .filter((l) => !l.last_contacted_at && l.opportunity_score != null)
    .sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0))
    .slice(0, 5)
    .map((l) => ({ businessName: l.business_name, opportunityScore: l.opportunity_score }));

  stalledDeals.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

  return {
    totalLeads: leads.length,
    stageCounts,
    overdueFollowups,
    uncontactedCount,
    wonThisPeriod,
    stalledDeals: stalledDeals.slice(0, 5),
    topUncontactedOpportunities,
  };
}
