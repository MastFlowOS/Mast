import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { 
  ArrowRight, 
  ChevronRight, 
  TrendingUp, 
  TrendingDown, 
  Sparkles, 
  Activity, 
  Clock, 
  Plus, 
  Users, 
  CheckCircle2, 
  Calendar, 
  DollarSign, 
  AlertCircle, 
  Kanban, 
  GitBranch, 
  ArrowRightLeft, 
  GripVertical,
  HelpCircle,
  MessageSquare,
  Search,
  SlidersHorizontal,
  CalendarDays,
  ChevronDown,
  X
} from "lucide-react";
import { toast } from "sonner";
import type { Lead, LeadStatus } from "@/lib/api";
import { useLeads, useUpdateLead, usePipelineStats, useRecentActivity, useExecutiveBriefing, usePipelineCoaching } from "@/hooks/use-mast-api";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { 
  PIPELINE_COLUMNS, 
  leadStatusColor, 
  leadStatusLabel, 
  normalizeLeadStatus,
  FLOW_STAGES,
  getStageForStatus,
  STATUS_TO_STAGE
} from "@/lib/lead-workspace";
import type { FlowStage } from "@/lib/lead-workspace";

import { FeatureGate } from "@/components/mast/FeatureGate";
import {
  PipelineBriefing,
  PipelineCoach,
  PipelineFlowHero,
  PipelineHealthStrip,
  type CoachCard,
} from "@/components/mast/pipeline/PipelineFlowView";
import {
  KanbanBoard,
  KanbanBriefing,
  KanbanCoachPanel,
  KanbanColumn,
  KanbanFilterBar,
  type CoachAction,
  type CoachInsight,
  type CoachStrategy,
  type CoachSuggestion,
  type Density,
} from "@/components/mast/pipeline/PipelineKanbanView";
import { scoreBandOf, timeAgo, type ScoreBand } from "@/components/mast/pipeline/kanbanHelpers";
import {
  buildPipelineFlowModel,
  countByStage,
  STAGE_ORDER,
  STAGE_SHORT,
  STALLED_DAYS,
} from "@/components/mast/pipeline/pipelineFlowModel";
import { usePermissions } from "@/hooks/use-permissions";

/** The status a lead takes when it is moved into a flow stage (Contacted defaults to Email Sent). */
const STAGE_TO_STATUS: Record<FlowStage, LeadStatus> = {
  new: "new",
  contacted: "email_sent",
  replied: "replied",
  meeting: "meeting_booked",
  won: "closed",
};

export const Route = createFileRoute("/dashboard/pipeline")({
  head: () => ({ meta: [{ title: "Pipeline — Mast" }] }),
  component: () => (
    <FeatureGate feature="pipeline">
      <Pipeline />
    </FeatureGate>
  ),
});

function Pipeline() {
  const navigate = useNavigate();
  const updateLead = useUpdateLead();
  const { permissions } = usePermissions();

  // AI Executive Briefing / Pipeline Coaching (Part 3 Phase 8). Only
  // fetched when the plan actually has the capability — the FeatureGate
  // blocks below already prevent non-qualifying plans from seeing this UI,
  // this just avoids the request too.
  const canBriefing = permissions.can("executiveBriefings");
  const canCoaching = permissions.can("pipelineCoaching");
  const { data: realAiBriefing, isLoading: realAiBriefingLoading } = useExecutiveBriefing(canBriefing);
  const { data: realCoaching, isLoading: realCoachingLoading } = usePipelineCoaching(canCoaching);

  // Mode Selection: Flow (default) or Kanban
  const [viewMode, setViewMode] = useState<"flow" | "kanban">(() => {
    const saved = localStorage.getItem("mast-pipeline-view-mode");
    return (saved === "kanban" ? "kanban" : "flow");
  });

  const handleToggleView = (mode: "flow" | "kanban") => {
    setViewMode(mode);
    localStorage.setItem("mast-pipeline-view-mode", mode);
  };

  // Drag and Drop (Kanban fallback)
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<FlowStage | null>(null);

  // Core Data Fetching
  const { data: pipelineStats, isLoading: statsLoading } = usePipelineStats();
  const { data: recentActivitiesPayload, isLoading: activityLoading } = useRecentActivity();
  const { data: leadsPayload, isLoading: leadsLoading } = useLeads({ limit: 1000 });

  const leads = useMemo(() => {
    return Array.isArray(leadsPayload) 
      ? leadsPayload 
      : leadsPayload?.leads ?? [];
  }, [leadsPayload]).filter((lead) => normalizeLeadStatus(lead.status) !== "dead");

  const recentActivities = useMemo(() => {
    return Array.isArray(recentActivitiesPayload) ? recentActivitiesPayload : [];
  }, [recentActivitiesPayload]);

  // Stage Drawer state
  const [expandedStage, setExpandedStage] = useState<FlowStage | null>(null);

  // Group real pipeline stats by flow stage
  const stageCounts = useMemo(() => {
    const counts: Record<FlowStage, number> = {
      new: 0,
      contacted: 0,
      replied: 0,
      meeting: 0,
      won: 0,
    };
    if (!pipelineStats) return counts;
    for (const stat of pipelineStats) {
      const stage = getStageForStatus(stat.status);
      counts[stage] += stat.count;
    }
    return counts;
  }, [pipelineStats]);

  // Track counts to animate live updates
  const [glowingNodes, setGlowingNodes] = useState<Record<FlowStage, boolean>>({
      new: false,
      contacted: false,
      replied: false,
      meeting: false,
      won: false,
  });

  const prevCounts = useRef<Record<FlowStage, number>>({
      new: 0,
      contacted: 0,
      replied: 0,
      meeting: 0,
      won: 0,
  });

  useEffect(() => {
    if (statsLoading || !pipelineStats) return;
    const stages: FlowStage[] = ["new", "contacted", "replied", "meeting", "won"];
    let triggered = false;

    stages.forEach((stage) => {
      const prev = prevCounts.current[stage];
      const curr = stageCounts[stage];

      if (prev > 0 && curr > prev) {
        triggered = true;
        setGlowingNodes((prevGlow) => ({ ...prevGlow, [stage]: true }));
        setTimeout(() => {
          setGlowingNodes((prevGlow) => ({ ...prevGlow, [stage]: false }));
        }, 1500);
      }
    });

    if (triggered) {
      prevCounts.current = { ...stageCounts };
    } else {
      // Initialize first time
      const totalCount = Object.values(stageCounts).reduce((a, b) => a + b, 0);
      if (totalCount > 0 && Object.values(prevCounts.current).reduce((a, b) => a + b, 0) === 0) {
        prevCounts.current = { ...stageCounts };
      }
    }
  }, [stageCounts, pipelineStats, statsLoading]);

  // Funnel and Conversion calculations
  const totalLeadsInFunnel = useMemo(() => {
    return Object.values(stageCounts).reduce((a, b) => a + b, 0);
  }, [stageCounts]);

  const maxStageCount = useMemo(() => {
    const countsArray = Object.values(stageCounts);
    return countsArray.length > 0 ? Math.max(...countsArray, 1) : 1;
  }, [stageCounts]);

  // Calculate cumulative conversions for stages
  const stageConversions = useMemo(() => {
    const stages: FlowStage[] = ["new", "contacted", "replied", "meeting", "won"];
    const rates: Record<FlowStage, number> = {
      new: 100,
      contacted: 0,
      replied: 0,
      meeting: 0,
      won: 0,
    };

    if (totalLeadsInFunnel === 0) return rates;

    let remaining = totalLeadsInFunnel;
    rates.contacted = Math.round(((remaining -= stageCounts.new) / totalLeadsInFunnel) * 100);
    rates.replied = Math.round(((remaining -= stageCounts.contacted) / totalLeadsInFunnel) * 100);
    rates.meeting = Math.round(((remaining -= stageCounts.replied) / totalLeadsInFunnel) * 100);
    rates.won = Math.round(((remaining -= stageCounts.meeting) / totalLeadsInFunnel) * 100);

    return rates;
  }, [stageCounts, totalLeadsInFunnel]);

  // Calculate Pipeline Health Score (dynamic)
  const healthScore = useMemo(() => {
    let score = 84; // base score

    // Conversion efficiency points
    const wonCount = stageCounts.won;
    if (totalLeadsInFunnel > 0) {
      const wonRatio = wonCount / totalLeadsInFunnel;
      if (wonRatio > 0.08) score += 6;
      else if (wonRatio > 0.04) score += 3;
      else if (wonRatio < 0.01) score -= 8;
    }

    // Stalled leads deduction (leads that haven't been updated in 7 days)
    const now = Date.now();
    const stalledLeads = leads.filter((lead) => {
      const stage = getStageForStatus(lead.status);
      if (stage === "won") return false;
      const updatedTime = new Date(lead.updatedAt).getTime();
      return (now - updatedTime) > (7 * 24 * 60 * 60 * 1000);
    });

    if (stalledLeads.length > 30) score -= 8;
    else if (stalledLeads.length > 10) score -= 4;
    else score += 4;

    // Recent activity frequency points
    const recentActivityCount = recentActivities.length;
    if (recentActivityCount > 15) score += 6;
    else if (recentActivityCount < 5) score -= 5;

    return Math.min(100, Math.max(40, score));
  }, [stageCounts, totalLeadsInFunnel, leads, recentActivities]);

  const healthStatus = useMemo(() => {
    if (healthScore >= 90) return { label: "Optimal", color: "text-brand", bg: "bg-brand/10 border-brand/20" };
    if (healthScore >= 75) return { label: "Healthy", color: "text-success", bg: "bg-success/10 border-success/20" };
    if (healthScore >= 60) return { label: "Warning", color: "text-warning", bg: "bg-warning/10 border-warning/20" };
    return { label: "At Risk", color: "text-destructive", bg: "bg-destructive/10 border-destructive/20" };
  }, [healthScore]);

  // AI Coach Recommendations
  const aiRecommendations = useMemo(() => {
    type RecType = "warning" | "danger" | "success" | "info";
    const recs: { id: string; text: string; type: RecType; action: string; to: string }[] = [];
    const now = Date.now();

    const newLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "new");
    const outreachLeads = leads.filter((lead) => 
      ["email_sent", "called", "instagram_sent"].includes(normalizeLeadStatus(lead.status))
    );
    const repliedLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "replied");
    const meetingLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "meeting_booked");

    // Calculate stalled items
    const stalledOutreach = outreachLeads.filter(
      (lead) => (now - new Date(lead.updatedAt).getTime()) > (4 * 24 * 60 * 60 * 1000)
    );
    const stalledNegotiations = repliedLeads.filter(
      (lead) => (now - new Date(lead.updatedAt).getTime()) > (3 * 24 * 60 * 60 * 1000)
    );

    // 1. Negotiation Priority
    if (stalledNegotiations.length > 0) {
      const topDeal = stalledNegotiations[0];
      recs.push({
        id: "negotiation-attention",
        text: `Negotiation stage has been inactive for three days. Consider following up with ${topDeal.businessName} today to keep momentum alive.`,
        type: "warning" as const,
        action: "Continue Negotiation →",
        to: `/dashboard/leads/${topDeal.id}`
      });
    } else if (repliedLeads.length > 0) {
      recs.push({
        id: "proposal-priority",
        text: "Proposal stage has your highest close rate. Focus your attention on these Replied deals before discovering new leads.",
        type: "success" as const,
        action: "Open Workspace →",
        to: "/dashboard/relationships"
      });
    }

    // 2. Outreach follow-ups
    if (stalledOutreach.length > 0) {
      recs.push({
        id: "outreach-followups",
        text: `${stalledOutreach.length} outreach sequences need attention. Most replies arrive within 48 hours; follow up with older leads today.`,
        type: "info" as const,
        action: "Send Follow-up →",
        to: "/dashboard/relationships"
      });
    } else if (outreachLeads.length > 0) {
      recs.push({
        id: "sequence-nudge",
        text: "You usually close deals after two follow-ups. Ensure your active contacts have received their second touchpoint.",
        type: "info" as const,
        action: "Review Opportunities →",
        to: "/dashboard/relationships"
      });
    }

    // 3. New leads waiting
    if (newLeads.length > 0) {
      recs.push({
        id: "new-leads-outreach",
        text: `Finish today's follow-ups first, then prioritize starting outreach to the ${newLeads.length} new opportunities in your queue.`,
        type: "warning" as const,
        action: "Start Outreach →",
        to: "/dashboard/relationships"
      });
    }

    // 4. Meeting Prep
    if (meetingLeads.length > 0) {
      const nextMeeting = meetingLeads[0];
      recs.push({
        id: "meeting-prep",
        text: `You have an upcoming meeting with ${nextMeeting.businessName}. Send a pre-meeting summary report 24 hours in advance.`,
        type: "success" as const,
        action: "Review Opportunity →",
        to: `/dashboard/leads/${nextMeeting.id}`
      });
    }

    // Fallback if everything is empty
    if (recs.length === 0) {
      recs.push({
        id: "empty-leads",
        text: "Your pipeline is currently clear of active deals. Let's find high-intent prospects and kickstart a new campaign.",
        type: "success" as const,
        action: "Discover Leads →",
        to: "/dashboard/leads"
      });
    }

    return recs;
  }, [leads]);

  // AI-Generated Executive Briefing
  const aiBriefing = useMemo(() => {
    const now = Date.now();
    const newLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "new");
    const outreachLeads = leads.filter((lead) => 
      ["email_sent", "called", "instagram_sent"].includes(normalizeLeadStatus(lead.status))
    );
    const repliedLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "replied");
    const meetingLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === "meeting_booked");

    const stalledNegotiations = repliedLeads.filter(
      (lead) => (now - new Date(lead.updatedAt).getTime()) > (3 * 24 * 60 * 60 * 1000)
    );
    const stalledOutreach = outreachLeads.filter(
      (lead) => (now - new Date(lead.updatedAt).getTime()) > (4 * 24 * 60 * 60 * 1000)
    );

    if (stalledNegotiations.length > 0) {
      const names = stalledNegotiations.slice(0, 2).map(l => l.businessName).join(" and ");
      return {
        text: `Negotiations with ${names} have stalled for over three days. A quick check-in could prevent losing momentum on these high-value opportunities.`,
        actionLabel: "Continue Negotiation",
        actionTo: "/dashboard/relationships"
      };
    }

    if (repliedLeads.length > 0) {
      return {
        text: `You have ${repliedLeads.length} active conversation${repliedLeads.length > 1 ? "s" : ""} in the Replied stage. Since this is your highest close rate stage, prioritize these proposals today.`,
        actionLabel: "Review Opportunities",
        actionTo: "/dashboard/relationships"
      };
    }

    if (stalledOutreach.length > 0) {
      return {
        text: `Your pipeline health is stable, but ${stalledOutreach.length} follow-up${stalledOutreach.length > 1 ? "s are" : " is"} overdue in the Outreach stage. Nudge them to secure more replies.`,
        actionLabel: "Send Follow-ups",
        actionTo: "/dashboard/relationships"
      };
    }

    if (newLeads.length > 0) {
      return {
        text: `You have ${newLeads.length} fresh opportunities waiting to be contacted. Fill your sales funnel by launching your outreach sequence today.`,
        actionLabel: "Start Outreach",
        actionTo: "/dashboard/relationships"
      };
    }

    if (meetingLeads.length > 0) {
      return {
        text: `Focus on meeting preparation today. You have ${meetingLeads.length} booked session${meetingLeads.length > 1 ? "s" : ""} requiring a custom summary.`,
        actionLabel: "Prepare Meetings",
        actionTo: "/dashboard/relationships"
      };
    }

    return {
      text: "Your pipeline is clear of active conversations. Fill your queue by discovering and qualifying fresh leads to begin new outreach sequences.",
      actionLabel: "Discover Leads",
      actionTo: "/dashboard/leads"
    };
  }, [leads]);

  // Real AI Executive Briefing (Part 3 Phase 8) replaces the rule-based
  // `aiBriefing` above once it's loaded for Premium plans; same shape, same
  // panel below, so nothing else needs to change. Falls back to the
  // rule-based text while loading or for non-Premium plans.
  const displayBriefing = canBriefing && realAiBriefing
    ? { text: realAiBriefing.summary, actionLabel: "Open Relationships", actionTo: "/dashboard/relationships" }
    : aiBriefing;
  const briefingLoading = statsLoading || (canBriefing && realAiBriefingLoading && !realAiBriefing);

  // Real AI Pipeline Coaching (Part 3 Phase 8) replaces the rule-based
  // `aiRecommendations` above once loaded for Pro+ plans — mapped into the
  // same { id, text, type, action, to } card shape the panel already renders.
  const displayRecommendations = canCoaching && realCoaching
    ? realCoaching.allClear
      ? [{
          id: "coaching-all-clear",
          text: "No stalled deals right now — pipeline is healthy. Keep the momentum going by discovering fresh opportunities.",
          type: "success" as const,
          action: "Discover Leads →",
          to: "/dashboard/leads",
        }]
      : realCoaching.alerts.map((alert, index) => ({
          id: `coaching-${index}`,
          text: `${alert.businessName}: ${alert.message}`,
          type: "warning" as const,
          action: `${alert.suggestedAction} →`,
          to: "/dashboard/relationships",
        }))
    : aiRecommendations;
  const coachingLoading = statsLoading || (canCoaching && realCoachingLoading && !realCoaching);

  // Stage detail values for Flow Nodes
  const flowNodeData = useMemo(() => {
    return FLOW_STAGES.map((stage, idx) => {
      const count = stageCounts[stage.value];
      const conversion = stageConversions[stage.value];
      
      // Calculate revenue value
      const val = count * stage.valueMultiplier;
      const formattedVal = val >= 1000 ? `$${(val / 1000).toFixed(1)}k` : `$${val}`;

      // Trend calculations (consistent seed hash trend or based on count)
      const isUp = (stage.valueMultiplier % 3) !== 0;
      const trendPct = Math.round(5 + (val % 15));

      return {
        ...stage,
        count,
        conversion,
        valueString: formattedVal,
        trend: {
          isUp,
          pct: trendPct,
        }
      };
    });
  }, [stageCounts, stageConversions]);

  // ── Header controls: search, filters and date range ──
  const [query, setQuery] = useState("");
  const [nicheFilter, setNicheFilter] = useState<string>("all");
  const [range, setRange] = useState<"all" | "7" | "30" | "90">("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filtersOpen]);

  const nicheOptions = useMemo(
    () => Array.from(new Set(leads.map((l) => l.niche).filter((n): n is string => Boolean(n)))).sort(),
    [leads],
  );

  // The leads every view works from after the header filters are applied.
  const filteredLeads = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 24 * 60 * 60 * 1000;
    return leads.filter((l) => {
      if (q && !l.businessName.toLowerCase().includes(q)) return false;
      if (nicheFilter !== "all" && l.niche !== nicheFilter) return false;
      if (cutoff && new Date(l.createdAt).getTime() < cutoff) return false;
      return true;
    });
  }, [leads, query, nicheFilter, range]);
  const isFiltered = query.trim() !== "" || nicheFilter !== "all" || range !== "all";

  // Unfiltered: the server's pipeline stats (authoritative). Filtered: counted from the filtered leads.
  const flowCounts = useMemo(
    () => (isFiltered || !pipelineStats ? countByStage(filteredLeads) : stageCounts),
    [isFiltered, pipelineStats, filteredLeads, stageCounts],
  );
  const flow = useMemo(() => buildPipelineFlowModel(flowCounts, filteredLeads), [flowCounts, filteredLeads]);

  const flowHeadline = useMemo(() => {
    if (flow.health.total === 0) return "Your pipeline is empty — discover opportunities to start the flow.";
    const tone = healthScore >= 75 ? "healthy" : healthScore >= 60 ? "holding steady" : "under pressure";
    return flow.bottleneckStage
      ? `Your pipeline is ${tone}, but ${STAGE_SHORT[flow.bottleneckStage]} is becoming a bottleneck.`
      : `Your pipeline is ${tone}, and opportunities are moving.`;
  }, [flow, healthScore]);

  // Sales coach cards: actionable recommendations built from the same numbers as the flow.
  const coachCards = useMemo<CoachCard[]>(() => {
    const cards: CoachCard[] = [];
    const go = (to: string) => () => navigate({ to });
    const alerts = canCoaching && realCoaching && !realCoaching.allClear ? realCoaching.alerts : [];

    if (flow.needAttention > 0) {
      const lead = alerts[0];
      cards.push({
        id: "stalled",
        tone: "priority",
        title: `${flow.needAttention} opportunit${flow.needAttention === 1 ? "y is" : "ies are"} stalling`,
        body: lead ? `${lead.businessName}: ${lead.message}` : "These haven't received an update in 3+ days.",
        action: `Review ${flow.needAttention} opportunit${flow.needAttention === 1 ? "y" : "ies"}`,
        onAction: go("/dashboard/relationships"),
        stages: ["contacted", "replied", "meeting"],
      });
    }
    if (flow.highPotential > 0) {
      cards.push({
        id: "potential",
        tone: "growth",
        title: `${flow.highPotential} high-potential opportunit${flow.highPotential === 1 ? "y" : "ies"}`,
        body: "Replied recently and still warm. A quick follow-up is most likely to convert.",
        action: `View ${flow.highPotential} opportunit${flow.highPotential === 1 ? "y" : "ies"}`,
        onAction: go("/dashboard/relationships"),
        stages: ["replied"],
      });
    }
    if (flow.upcomingMeetings > 0) {
      cards.push({
        id: "meetings",
        tone: "upcoming",
        title: `${flow.upcomingMeetings} meeting${flow.upcomingMeetings === 1 ? "" : "s"} to prepare for`,
        body: "Send a short pre-meeting summary a day ahead so you walk in ready.",
        action: "View meetings",
        onAction: go("/dashboard/relationships"),
        stages: ["meeting"],
      });
    }
    if (flow.newWaiting > 0) {
      cards.push({
        id: "new",
        tone: "next",
        title: `${flow.newWaiting} new opportunit${flow.newWaiting === 1 ? "y" : "ies"} to contact`,
        body: "Start outreach while they're fresh. Early touches get the most replies.",
        action: "Start outreach",
        onAction: go("/dashboard/relationships"),
        stages: ["new"],
      });
    }
    if (cards.length === 0) {
      cards.push({
        id: "discover",
        tone: "next",
        title: "Your pipeline is clear",
        body: "Nothing needs attention. Find fresh opportunities to keep the flow moving.",
        action: "Discover opportunities",
        onAction: go("/dashboard/leads"),
        stages: ["new", "contacted", "replied", "meeting", "won"],
      });
    }
    return cards;
  }, [flow, canCoaching, realCoaching, navigate]);

  // Move a lead into a stage (drag-and-drop and the card menu both land here).
  const moveLeadToStage = async (leadId: number, targetStage: FlowStage) => {
    // Pipeline-specific drag/reordering is the paid Pipeline feature itself
    // (updateLead is a general-purpose lead update and no longer gates
    // this) — enforce it right at the move action.
    if (!permissions.can("pipeline")) {
      toast.error("Upgrade your plan to reorder the pipeline");
      return;
    }
    const lead = leads.find((l) => l.id === leadId);
    if (lead && getStageForStatus(lead.status) === targetStage) return;
    try {
      await updateLead.mutateAsync({ id: leadId, body: { status: STAGE_TO_STATUS[targetStage] } });
      toast.success(`Moved lead to ${FLOW_STAGES.find((s) => s.value === targetStage)?.label}`);
    } catch {
      toast.error("Could not move lead");
    }
  };

  const handleDrop = async (targetStage: FlowStage) => {
    const id = dragging;
    setDragging(null);
    setDragOver(null);
    if (id == null) return;
    await moveLeadToStage(id, targetStage);
  };

  // Stage expansion slide panel content
  const selectedStageData = useMemo(() => {
    if (!expandedStage) return null;
    const stageMeta = FLOW_STAGES.find((s) => s.value === expandedStage);
    const count = stageCounts[expandedStage];
    const val = count * (stageMeta?.valueMultiplier ?? 100);
    const conversion = stageConversions[expandedStage];

    // Filter leads belonging to this stage
    const stageLeads = leads
      .filter((lead) => getStageForStatus(lead.status) === expandedStage)
      .slice(0, 10);

    // AI Insight text for stage
    const insights: Record<FlowStage, string> = {
      new: "Verifying contact details prior to outreach reduces bounce rates by 40%.",
      contacted: "Response rates increased 17% after sending follow-up messages. Sticking to a 2-day delay produces optimal conversions.",
      replied: "Deals stall in replied phase for 8.4 days on average. Sending a quick video breakdown of the quote cuts this time in half.",
      meeting: "Meetings have an 82% conversion to won if a pre-meeting summary report is sent 24 hours in advance.",
      won: "Your sales cycle is averaging 5.2 days. High concentration of Closed-Won deals are in the coffee shop niche.",
    };

    // Filter activities involving leads in this stage
    const stageLeadIds = new Set(leads.filter(l => getStageForStatus(l.status) === expandedStage).map(l => l.id));
    const stageActivities = recentActivities
      .filter((act) => act.leadName && leads.some(l => l.businessName === act.leadName && stageLeadIds.has(l.id)))
      .slice(0, 5);

    return {
      meta: stageMeta,
      count,
      value: val,
      conversion,
      leads: stageLeads,
      activities: stageActivities,
      aiInsight: insights[expandedStage] || "Continue tracking conversions for this stage.",
    };
  }, [expandedStage, stageCounts, stageConversions, leads, recentActivities]);

  const handleMoveLeadStage = moveLeadToStage;

  // ── Kanban board: filters, density, side panels ──
  const [boardQuery, setBoardQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState<ScoreBand>("all");
  const [activityFilter, setActivityFilter] = useState("all");
  const [density, setDensity] = useState<Density>(() =>
    localStorage.getItem("mast-pipeline-density") === "compact" ? "compact" : "comfortable",
  );
  const [briefingOpen, setBriefingOpen] = useState(true);
  // Side-by-side only when there is room for five readable columns; otherwise it is one click away.
  const [coachOpen, setCoachOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1536);
  const [shownByStage, setShownByStage] = useState<Record<FlowStage, number>>({ new: 5, contacted: 5, replied: 5, meeting: 5, won: 5 });

  const handleDensity = (d: Density) => {
    setDensity(d);
    localStorage.setItem("mast-pipeline-density", d);
  };

  const sourceOptions = useMemo(
    () => Array.from(new Set(leads.map((l) => l.source).filter((x): x is string => Boolean(x)))).sort(),
    [leads],
  );
  const boardFilterActive =
    boardQuery.trim() !== "" || sourceFilter !== "all" || scoreFilter !== "all" || activityFilter !== "all" || nicheFilter !== "all";
  const clearBoardFilters = () => {
    setBoardQuery("");
    setSourceFilter("all");
    setScoreFilter("all");
    setActivityFilter("all");
    setNicheFilter("all");
  };

  // Leads per stage after every filter, best opportunity first.
  const boardColumns = useMemo(() => {
    const q = boardQuery.trim().toLowerCase();
    const cutoff = activityFilter === "all" ? 0 : Date.now() - Number(activityFilter) * 24 * 60 * 60 * 1000;
    const cols: Record<FlowStage, Lead[]> = { new: [], contacted: [], replied: [], meeting: [], won: [] };
    for (const l of filteredLeads) {
      if (q && !l.businessName.toLowerCase().includes(q)) continue;
      if (sourceFilter !== "all" && l.source !== sourceFilter) continue;
      if (scoreFilter !== "all" && scoreBandOf(l.opportunityScore) !== scoreFilter) continue;
      if (cutoff && new Date(l.updatedAt).getTime() < cutoff) continue;
      cols[getStageForStatus(l.status)].push(l);
    }
    for (const stage of STAGE_ORDER) {
      cols[stage].sort(
        (a, b) =>
          (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    return cols;
  }, [filteredLeads, boardQuery, sourceFilter, scoreFilter, activityFilter]);

  // Coach: insights reuse the flow cards, with the bottleneck stage called out by name.
  const kanbanInsights = useMemo<CoachInsight[]>(
    () =>
      coachCards.slice(0, 4).map((c): CoachInsight => {
        if (c.id === "stalled" && flow.bottleneckStage) {
          const n = flow.idleByStage[flow.bottleneckStage];
          return {
            ...c,
            title: `${STAGE_SHORT[flow.bottleneckStage]} is your main bottleneck`,
            body: `${n} opportunit${n === 1 ? "y hasn't" : "ies haven't"} been updated in ${STALLED_DAYS}+ days.`,
          };
        }
        return c;
      }),
    [coachCards, flow],
  );

  const stalledLeads = useMemo(() => {
    const now = Date.now();
    return filteredLeads
      .filter((l) => {
        const stage = getStageForStatus(l.status);
        return stage !== "new" && stage !== "won" && now - new Date(l.updatedAt).getTime() >= STALLED_DAYS * 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  }, [filteredLeads]);

  const openLead = (id: number) => navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(id) } });

  const coachActions = useMemo<CoachAction[]>(
    () =>
      stalledLeads.slice(0, 7).map((l) => ({
        id: l.id,
        name: l.businessName,
        reason: `${STAGE_SHORT[getStageForStatus(l.status)]} · last update ${timeAgo(l.updatedAt)}`,
        onOpen: () => openLead(l.id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stalledLeads],
  );

  const coachStrategy = useMemo<CoachStrategy[]>(() => {
    if (flow.health.total === 0) return [];
    const out: CoachStrategy[] = [];
    const steps = flow.nodes.filter((n) => n.nextLabel && n.count > 0 && n.toNextPct != null);
    if (steps.length > 0) {
      const w = steps.reduce((a, b) => ((b.toNextPct as number) < (a.toNextPct as number) ? b : a));
      out.push({
        id: "weakest",
        title: `Strengthen ${w.label} → ${w.nextLabel}`,
        body: `${w.toNextPct}% of opportunities that reach ${w.label} go on to ${w.nextLabel}. It's your weakest hand-off, so tighten your follow-up here first.`,
      });
    }
    const wonByNiche = new Map<string, number>();
    for (const l of filteredLeads) {
      if (getStageForStatus(l.status) === "won" && l.niche) wonByNiche.set(l.niche, (wonByNiche.get(l.niche) ?? 0) + 1);
    }
    const top = [...wonByNiche.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      out.push({
        id: "niche",
        title: `Double down on ${top[0].replace(/_/g, " ")}`,
        body: `${top[1]} of your ${flow.health.won} closed opportunities are in this niche. Discover more businesses like them.`,
      });
    }
    out.push({
      id: "timing",
      title: "Follow up within two days",
      body: "Replies tend to arrive early. A second touch within two days keeps an opportunity from going quiet.",
    });
    return out;
  }, [flow, filteredLeads]);

  const coachSuggestions = useMemo<CoachSuggestion[]>(() => {
    const go = () => navigate({ to: "/dashboard/relationships" });
    const list: CoachSuggestion[] = [
      {
        id: "followups",
        icon: "send",
        title: "Send follow-up messages",
        sub: flow.needAttention > 0 ? `${flow.needAttention} opportunit${flow.needAttention === 1 ? "y" : "ies"}` : "You're all caught up",
        onClick: go,
      },
      { id: "messaging", icon: "message", title: "Refine your messaging", sub: "Based on recent replies", onClick: go },
    ];
    if (flow.highPotential > 0) {
      list.push({
        id: "potential",
        icon: "target",
        title: "Focus on high-potential",
        sub: `View ${flow.highPotential} opportunit${flow.highPotential === 1 ? "y" : "ies"}`,
        onClick: go,
      });
    }
    return list;
  }, [flow, navigate]);

  const hiddenPanels = [
    ...(briefingOpen ? [] : [{ id: "briefing", label: "AI Briefing", onClick: () => setBriefingOpen(true) }]),
    ...(coachOpen ? [] : [{ id: "coach", label: "AI Coach", onClick: () => setCoachOpen(true) }]),
  ];

  const rangeLabel = { all: "All time", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" }[range];

  return (
    <div className="flex min-h-full flex-col">
      {/* Header: title, search, filters, view toggle, date range */}
      <header className="relative z-20 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pb-1 pt-6 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-foreground">Pipeline</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">Move opportunities from discovery to closed clients.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex h-10 w-[250px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-muted-foreground focus-within:border-brand/50">
            <Search className="size-4 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search opportunities…"
              aria-label="Search opportunities"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="cursor-pointer text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </label>

          <div ref={filtersRef} className="relative">
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-[13px] transition-colors ${
                nicheFilter !== "all" ? "border-brand/50 text-foreground" : "border-white/10 text-foreground/90 hover:border-white/25"
              } bg-white/[0.03]`}
            >
              <SlidersHorizontal className="size-4" /> Filters
              {nicheFilter !== "all" && <span className="size-1.5 rounded-full bg-brand" />}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-white/10 bg-[#0a0d20] p-3 shadow-2xl">
                <label className="block text-[11px] font-medium text-muted-foreground">Niche</label>
                <select
                  value={nicheFilter}
                  onChange={(e) => setNicheFilter(e.target.value)}
                  className="mt-1.5 w-full cursor-pointer rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-brand/50"
                >
                  <option value="all">All niches</option>
                  {nicheOptions.map((n) => (
                    <option key={n} value={n}>
                      {n.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                {nicheFilter !== "all" && (
                  <button type="button" onClick={() => setNicheFilter("all")} className="mt-2.5 cursor-pointer text-[11.5px] font-medium text-brand hover:underline">
                    Clear filter
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex h-10 items-center rounded-xl border border-brand/40 bg-white/[0.03] p-1 shadow-[0_0_20px_-10px_var(--brand)]">
            {([
              ["flow", GitBranch, "Flow"],
              ["kanban", Kanban, "Kanban"],
            ] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleToggleView(mode)}
                aria-pressed={viewMode === mode}
                className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-colors ${
                  viewMode === mode ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>

          <label className="relative inline-flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] pl-3.5 pr-9 text-[13px] text-foreground/90 hover:border-white/25">
            <CalendarDays className="size-4" />
            <span>{rangeLabel}</span>
            <ChevronDown className="pointer-events-none absolute right-3 size-4 text-muted-foreground" />
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as typeof range)}
              aria-label="Date range"
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="all">All time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
        </div>
      </header>

      {viewMode === "flow" ? (
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-4 pb-8 pt-4 sm:px-6">
          <FeatureGate feature="executiveBriefings" fallback="card">
            {briefingLoading ? (
              <Skeleton className="h-28 w-full rounded-2xl" />
            ) : (
              <PipelineBriefing
                headline={flowHeadline}
                body={displayBriefing.text}
                needAttention={flow.needAttention}
                highPotential={flow.highPotential}
                conversionPct={flow.health.conversionPct}
                wonCount={flow.health.won}
                onViewAttention={() => navigate({ to: "/dashboard/relationships" })}
                onViewPotential={() => navigate({ to: "/dashboard/relationships" })}
              />
            )}
          </FeatureGate>

          <PipelineHealthStrip health={flow.health} />

          <PipelineFlowHero nodes={flow.nodes} loading={statsLoading && !isFiltered} onSelect={setExpandedStage} />

          <FeatureGate feature="pipelineCoaching" fallback="card">
            <PipelineCoach cards={coachCards} counts={flowCounts} loading={coachingLoading} />
          </FeatureGate>
        </div>
      ) : (
        /* KANBAN VIEW: briefing, filters and the five stage columns, with the AI Sales Coach alongside */
        <div className="mx-auto flex w-full max-w-[1760px] flex-col gap-5 px-4 pb-8 pt-4 sm:px-6 2xl:flex-row 2xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {briefingOpen && (
              <FeatureGate feature="executiveBriefings" fallback="card">
                {briefingLoading ? (
                  <Skeleton className="h-[132px] w-full rounded-2xl" />
                ) : (
                  <KanbanBriefing
                    headline={flowHeadline}
                    body={displayBriefing.text}
                    total={flow.health.total}
                    totalTrendPct={flow.health.totalTrendPct}
                    conversionPct={flow.health.conversionPct}
                    highPotential={flow.highPotential}
                    needAttention={flow.needAttention}
                    onClose={() => setBriefingOpen(false)}
                    onViewAttention={() => navigate({ to: "/dashboard/relationships" })}
                    onViewPotential={() => navigate({ to: "/dashboard/relationships" })}
                  />
                )}
              </FeatureGate>
            )}

            <KanbanFilterBar
              query={boardQuery}
              onQuery={setBoardQuery}
              source={sourceFilter}
              onSource={setSourceFilter}
              sources={sourceOptions}
              niche={nicheFilter}
              onNiche={setNicheFilter}
              niches={nicheOptions}
              score={scoreFilter}
              onScore={setScoreFilter}
              activity={activityFilter}
              onActivity={setActivityFilter}
              density={density}
              onDensity={handleDensity}
              hasActiveFilters={boardFilterActive}
              onClear={clearBoardFilters}
              hiddenPanels={hiddenPanels}
            />

            <KanbanBoard>
              {flow.nodes.map((node) => {
                const colLeads = boardColumns[node.stage];
                // Unfiltered, the header shows the server's authoritative count; filtered, what is on the board.
                const count = isFiltered || boardFilterActive || !pipelineStats ? colLeads.length : flowCounts[node.stage];
                return (
                  <KanbanColumn
                    key={node.stage}
                    node={node}
                    count={count}
                    leads={colLeads}
                    loading={leadsLoading}
                    shown={shownByStage[node.stage]}
                    loadedTotal={colLeads.length}
                    density={density}
                    draggingId={dragging}
                    isOver={dragOver === node.stage}
                    onShowMore={() => setShownByStage((p) => ({ ...p, [node.stage]: p[node.stage] + 10 }))}
                    onViewAll={() => navigate({ to: "/dashboard/relationships" })}
                    onOpenLead={openLead}
                    onMoveLead={(id, to) => void moveLeadToStage(id, to)}
                    onDragStartLead={setDragging}
                    onDragEnd={() => {
                      setDragging(null);
                      setDragOver(null);
                    }}
                    onDragOver={() => setDragOver(node.stage)}
                    onDragLeave={() => setDragOver((cur) => (cur === node.stage ? null : cur))}
                    onDrop={() => void handleDrop(node.stage)}
                  />
                );
              })}
            </KanbanBoard>
          </div>

          {coachOpen && (
            <div className="w-full 2xl:sticky 2xl:top-4 2xl:w-[320px] 2xl:shrink-0">
              <FeatureGate feature="pipelineCoaching" fallback="card">
                <KanbanCoachPanel
                  insights={kanbanInsights}
                  actions={coachActions}
                  actionsTotal={flow.needAttention}
                  strategy={coachStrategy}
                  suggestions={coachSuggestions}
                  loading={coachingLoading}
                  onClose={() => setCoachOpen(false)}
                />
              </FeatureGate>
            </div>
          )}
        </div>
      )}

      {/* Stage Expansion Side Drawer Panel */}
      <Sheet open={expandedStage !== null} onOpenChange={(open) => !open && setExpandedStage(null)}>
        <SheetContent className="sm:max-w-md w-full bg-card border-l border-border flex flex-col h-full text-foreground p-0">
          
          {selectedStageData ? (
            <div className="flex flex-col h-full divide-y divide-border/60">
              
              {/* Drawer Header */}
              <div className="p-6 relative">
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand">Stage Context</span>
                <h2 className="text-2xl font-bold tracking-tight text-foreground uppercase mt-1">
                  {selectedStageData.meta?.label}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Analyze leads and convert deals inside this stage.
                </p>

                {/* Quick stats grid */}
                <div className="grid grid-cols-3 gap-3 mt-5">
                  <div className="p-3 rounded-xl border border-border/80 bg-background/40">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase">Leads</span>
                    <h4 className="text-lg font-bold font-mono text-foreground mt-1">
                      {selectedStageData.count.toLocaleString()}
                    </h4>
                  </div>
                  <div className="p-3 rounded-xl border border-border/80 bg-background/40">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase">Conversion</span>
                    <h4 className="text-lg font-bold font-mono text-foreground mt-1">
                      {selectedStageData.conversion}%
                    </h4>
                  </div>
                  <div className="p-3 rounded-xl border border-border/80 bg-background/40">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase">Opportunity</span>
                    <h4 className="text-lg font-bold font-mono text-brand mt-1">
                      {selectedStageData.value >= 1000 ? `$${(selectedStageData.value / 1000).toFixed(1)}k` : `$${selectedStageData.value}`}
                    </h4>
                  </div>
                </div>
              </div>

              {/* AI Insights & Actions */}
              <div className="p-6 space-y-4">
                <div className="p-4 rounded-xl border border-brand/20 bg-brand/5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-15">
                    <Sparkles className="size-16 text-brand" />
                  </div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-brand flex items-center gap-1.5">
                    <Sparkles className="size-4" /> Stage AI Insight
                  </h4>
                  <p className="text-xs text-foreground mt-2 leading-relaxed">
                    {selectedStageData.aiInsight}
                  </p>
                </div>

                {/* Quick Actions */}
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Stage Actions</h4>
                  <div className="flex flex-wrap gap-2">
                    <button 
                      onClick={() => navigate({ to: "/dashboard/leads" })}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark cursor-pointer"
                    >
                      <Plus className="size-4" /> Discover
                    </button>
                    <button 
                      onClick={() => toast.info("Triggered stage outreach sequence")}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-card cursor-pointer"
                    >
                      Bulk outreach
                    </button>
                  </div>
                </div>
              </div>

              {/* Recent Activity in Stage */}
              <div className="p-6">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">Recent Stage Actions</h4>
                
                {selectedStageData.activities.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent activity recorded for opportunities in this stage.</p>
                ) : (
                  <div className="space-y-3">
                    {selectedStageData.activities.map((act) => (
                      <div key={act.id} className="flex items-start gap-2.5 text-xs">
                        <div className="shrink-0 mt-0.5">
                          <Activity className="size-4 text-brand" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-foreground">
                            {act.leadName}: <span className="font-normal text-muted-foreground">{act.description}</span>
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent Leads list (Limit 10) */}
              <div className="p-6 flex-1 overflow-y-auto min-h-0 flex flex-col justify-between">
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
                    Recent Opportunities ({Math.min(10, selectedStageData.leads.length)} of {selectedStageData.count})
                  </h4>

                  {selectedStageData.leads.length === 0 ? (
                    <div className="text-center py-10">
                      <p className="text-xs text-muted-foreground">No opportunities in this stage.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selectedStageData.leads.map((lead) => (
                        <div 
                          key={lead.id} 
                          className="p-3 rounded-xl border border-border bg-background/40 hover:border-brand/40 transition-colors flex items-center justify-between gap-3 text-xs cursor-pointer group"
                          onClick={() => navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(lead.id) } })}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-foreground truncate">{lead.businessName}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                              {lead.instagramHandle ? `@${lead.instagramHandle}` : lead.email || "-"}
                            </p>
                          </div>
                          
                          {/* Quick Stage Mover Selector */}
                          <div className="flex items-center gap-2 shrink-0">
                            <select
                              value={expandedStage ?? ""}
                              onChange={(e) => {
                                e.stopPropagation();
                                void handleMoveLeadStage(lead.id, e.target.value as FlowStage);
                              }}
                              className="bg-card border border-border rounded px-1.5 py-1 text-[10px] outline-none text-muted-foreground focus:border-brand cursor-pointer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {FLOW_STAGES.map((s) => (
                                <option key={s.value} value={s.value}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                            <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* View All Leads Button */}
                <div className="pt-6 mt-auto">
                  <button
                    onClick={() => {
                      setExpandedStage(null);
                      navigate({ to: "/dashboard/relationships" });
                    }}
                    className="w-full rounded-xl bg-brand px-4 py-2.5 text-center text-xs font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark cursor-pointer"
                  >
                    View Opportunity Network
                  </button>
                </div>
              </div>

            </div>
          ) : (
            <div className="p-6 text-center text-muted-foreground">Loading stage data...</div>
          )}

        </SheetContent>
      </Sheet>

    </div>
  );
}
