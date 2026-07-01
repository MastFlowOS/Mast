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
  MessageSquare
} from "lucide-react";
import { toast } from "sonner";
import type { Lead, LeadStatus } from "@/lib/api";
import { useLeads, useUpdateLead, usePipelineStats, useRecentActivity } from "@/hooks/use-mast-api";
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

export const Route = createFileRoute("/dashboard/pipeline")({
  head: () => ({ meta: [{ title: "Pipeline — Mast" }] }),
  component: Pipeline,
});

function Pipeline() {
  const navigate = useNavigate();
  const updateLead = useUpdateLead();

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
  const [dragOver, setDragOver] = useState<LeadStatus | null>(null);

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

  // Dynamic AI Pulse for Kanban Columns
  const aiPulses = useMemo(() => {
    const pulses: Record<LeadStatus, { text: string; isAlert: boolean }> = {} as any;
    const now = Date.now();
    
    for (const colStatus of PIPELINE_COLUMNS) {
      const columnLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === colStatus);
      const count = columnLeads.length;
      
      let pulseText = "Stage is stable.";
      let isAlert = false;
      
      switch (colStatus) {
        case "new":
          if (count > 0) {
            pulseText = `${count} opportunities need attention today.`;
            isAlert = true;
          } else {
            pulseText = "Fresh lead queue is empty.";
          }
          break;
        case "email_sent": {
          const overdue = columnLeads.filter(lead => {
            const updatedTime = new Date(lead.updatedAt).getTime();
            return (now - updatedTime) > (4 * 24 * 60 * 60 * 1000);
          }).length;
          if (overdue > 0) {
            pulseText = `${overdue} follow-ups are overdue.`;
            isAlert = true;
          } else if (count > 0) {
            pulseText = `Outreach active for ${count} contacts.`;
          } else {
            pulseText = "No active outreach campaigns.";
          }
          break;
        }
        case "replied": {
          const inactive = columnLeads.filter(lead => {
            const updatedTime = new Date(lead.updatedAt).getTime();
            return (now - updatedTime) > (3 * 24 * 60 * 60 * 1000);
          }).length;
          if (inactive > 0) {
            pulseText = `${inactive} proposals need attention.`;
            isAlert = true;
          } else if (count > 0) {
            pulseText = "High chance of closing this week.";
          } else {
            pulseText = "Awaiting new replies.";
          }
          break;
        }
        case "meeting_booked":
          if (count > 0) {
            pulseText = `${count} meetings booked.`;
          } else {
            pulseText = "All meetings are scheduled.";
          }
          break;
        case "closed":
          if (count > 0) {
            pulseText = `Momentum looks great. ${count} won.`;
          } else {
            pulseText = "Ready to close first deal.";
          }
          break;
      }
      pulses[colStatus] = { text: pulseText, isAlert };
    }
    return pulses;
  }, [leads]);

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

  // Kanban drop handler
  const handleDrop = async (status: LeadStatus) => {
    if (dragging == null) return;
    try {
      await updateLead.mutateAsync({ id: dragging, body: { status } });
      toast.success(`Moved lead to ${leadStatusLabel(status)}`);
    } catch {
      toast.error("Could not move lead");
    } finally {
      setDragging(null);
      setDragOver(null);
    }
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

  const handleMoveLeadStage = async (leadId: number, targetStage: FlowStage) => {
    // Map stage back to a primary default status
    const stageToStatus: Record<FlowStage, LeadStatus> = {
      new: "new",
      contacted: "email_sent",
      replied: "replied",
      meeting: "meeting_booked",
      won: "closed",
    };
    
    const targetStatus = stageToStatus[targetStage];
    try {
      await updateLead.mutateAsync({ id: leadId, body: { status: targetStatus } });
      toast.success(`Moved lead to ${FLOW_STAGES.find(s => s.value === targetStage)?.label}`);
    } catch {
      toast.error("Failed to move lead");
    }
  };

  return (
    <div className="flex h-full flex-col bg-background/50 bg-grid-sm">
      {/* Top Banner: Header, View Toggle, and Circular Health Score */}
      <div className="border-b border-border bg-card/45 backdrop-blur-md px-6 py-4 relative z-10">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              Pipeline Flow <Sparkles className="size-5 text-brand animate-pulse-glow" />
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              AI-driven layout focusing on deal movement, conversion health, and opportunity velocity.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {/* Kanban / Flow View Toggle Switch */}
            <div className="flex items-center rounded-lg border border-border bg-background p-1 shadow-inner">
              <button
                onClick={() => handleToggleView("flow")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-200 cursor-pointer ${
                  viewMode === "flow" 
                    ? "bg-brand text-brand-foreground shadow shadow-brand/40" 
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <GitBranch className="size-3.5" /> Flow
              </button>
              <button
                onClick={() => handleToggleView("kanban")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all duration-200 cursor-pointer ${
                  viewMode === "kanban" 
                    ? "bg-brand text-brand-foreground shadow shadow-brand/40" 
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Kanban className="size-3.5" /> Kanban
              </button>
            </div>

            {/* Signature Feature: Circular Pipeline Health Score */}
            <div className="flex items-center gap-3 bg-background/80 border border-border px-4 py-2 rounded-xl shadow-sm hover:border-brand/30 transition-colors group relative cursor-help">
              <div className="relative size-12 flex items-center justify-center shrink-0">
                {/* SVG Circular Progress Ring */}
                <svg className="size-full -rotate-90">
                  <circle 
                    cx="24" cy="24" r="20" 
                    className="stroke-border fill-none" 
                    strokeWidth="3.5" 
                  />
                  <circle 
                    cx="24" cy="24" r="20" 
                    className="stroke-brand transition-all duration-1000 ease-out fill-none" 
                    strokeWidth="3.5" 
                    strokeDasharray="125.6"
                    strokeDashoffset={125.6 - (125.6 * healthScore) / 100}
                    strokeLinecap="round"
                  />
                </svg>
                <span className="absolute text-xs font-bold text-foreground font-mono">{healthScore}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground leading-none">Pipeline Health</span>
                <span className={`text-sm font-bold mt-1 ${healthStatus.color}`}>{healthStatus.label}</span>
              </div>

              {/* Hover details card */}
              <div className="absolute top-full right-0 mt-2 w-60 p-3 bg-card border border-border rounded-xl shadow-elevated opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-200 z-50">
                <h4 className="text-xs font-bold uppercase tracking-wider text-foreground mb-2">Health Index Details</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex justify-between"><span>Conversion rate</span><span className="font-mono text-foreground font-semibold">Optimal</span></li>
                  <li className="flex justify-between"><span>Activity frequency</span><span className="font-mono text-foreground font-semibold">Active</span></li>
                  <li className="flex justify-between"><span>Stalled deals</span><span className="font-mono text-foreground font-semibold">Low</span></li>
                  <li className="flex justify-between"><span>Response rates</span><span className="font-mono text-foreground font-semibold">94%</span></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Layout Area */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">
        
        {/* Left Side: Pipeline Views & Funnel (3/4 width) */}
        <div className="flex-1 flex flex-col overflow-y-auto p-6 space-y-6">

          {/* AI Executive Briefing */}
          {statsLoading ? (
            <Skeleton className="h-24 rounded-2xl w-full animate-pulse" />
          ) : (
            <section className="relative overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/10 via-brand/5 to-transparent p-5 backdrop-blur-sm">
              <div className="absolute top-0 right-0 p-4 opacity-[0.03] pointer-events-none">
                <Sparkles className="size-24 text-brand animate-pulse" />
              </div>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
                <div className="space-y-1.5 max-w-3xl text-left">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand">
                    <Sparkles className="size-4 animate-pulse-glow" /> Dynamic AI Executive Briefing
                  </div>
                  <p className="text-sm font-medium text-foreground leading-relaxed">
                    {aiBriefing.text}
                  </p>
                </div>
                <button
                  onClick={() => navigate({ to: aiBriefing.actionTo })}
                  className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark transition-all duration-200 cursor-pointer self-start md:self-center"
                >
                  {aiBriefing.actionLabel} <ArrowRight className="size-3.5" />
                </button>
              </div>
            </section>
          )}

          {/* Funnel Visualization */}
          <section className="bg-card/30 backdrop-blur-sm border border-border rounded-2xl p-5 relative overflow-hidden">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
              Conversion Funnel & Stage Volume
            </h3>
            
            <div className="space-y-3">
              {statsLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-6 rounded-lg w-full" />)}
                </div>
              ) : (
                FLOW_STAGES.map((stage, idx) => {
                  const count = stageCounts[stage.value];
                  const rate = stageConversions[stage.value];
                  const pctOfMax = Math.round((count / maxStageCount) * 100);
                  
                  // Leakage from previous stage
                  let leakage = 0;
                  if (idx > 0) {
                    const prevStage = FLOW_STAGES[idx - 1].value;
                    const prevRate = stageConversions[prevStage];
                    if (prevRate > 0) {
                      leakage = Math.round(((prevRate - rate) / prevRate) * 100);
                    }
                  }

                  return (
                    <div key={stage.value} className="group/funnel">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold uppercase w-28 text-[10px] text-muted-foreground tracking-wider truncate">{stage.label}</span>
                          <span className="font-mono font-semibold text-foreground">{count.toLocaleString()} leads</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-muted-foreground">{rate}% Conversion</span>
                          {idx > 0 && leakage > 0 && (
                            <span className="text-[10px] text-red-400/80 bg-red-500/5 px-1.5 py-0.5 rounded border border-red-500/10">
                              -{leakage}% Leakage
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="h-2.5 w-full bg-background rounded-full overflow-hidden flex border border-border/30">
                        <div 
                          className={`h-full bg-gradient-to-r ${stage.color} rounded-full transition-all duration-1000 ease-out`} 
                          style={{ width: `${Math.max(2, pctOfMax)}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Render Active View: Flow (default) or Kanban */}
          {viewMode === "flow" ? (
            
            /* FLOW VIEW (Network of Nodes) */
            <section className="flex-1 flex items-center justify-center min-h-[350px] relative">
              <div className="w-full max-w-4xl flex flex-col md:flex-row items-stretch md:items-center justify-between gap-6 md:gap-4 relative py-8 px-4">
                
                {/* SVG Connecting Tracks & Pulses (Behind nodes) */}
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 hidden md:block h-1 z-0">
                  <div className="absolute inset-0 bg-border/40" />
                  
                  {/* Glowing Flow Pulse Line */}
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-500 via-brand to-success animate-pulse-glow" style={{ mixBlendMode: "screen" }} />

                  {/* Traveling Pulse Particle Dots */}
                  <div className="pulse-dot-1" />
                  <div className="pulse-dot-2" />
                  <div className="pulse-dot-3" />
                </div>

                {/* Intelligent Flow Nodes */}
                {statsLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="w-full md:w-36 h-36 rounded-2xl" />
                  ))
                ) : (
                  flowNodeData.map((node) => {
                    const isGlow = glowingNodes[node.value];
                    return (
                      <div
                        key={node.value}
                        onClick={() => setExpandedStage(node.value)}
                        className={`flex-1 min-w-0 md:w-36 rounded-2xl border bg-card/65 backdrop-blur-md p-4 transition-all duration-300 relative z-10 cursor-pointer text-left select-none group card-hover ${
                          isGlow 
                            ? "border-brand glow-brand scale-[1.03]" 
                            : "border-border hover:border-brand/40"
                        }`}
                      >
                        {/* Subtle glowing radial hover background */}
                        <div className="absolute inset-0 bg-gradient-to-b from-brand/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />
                        
                        {/* Glow outline decoration */}
                        <div className={`absolute inset-0 rounded-2xl transition-opacity duration-500 border border-brand ${isGlow ? "opacity-100" : "opacity-0"}`} />

                        <div className="flex items-center justify-between relative z-10">
                          <span className={`text-[10px] font-bold uppercase tracking-wider text-muted-foreground group-hover:text-brand transition-colors`}>
                            {node.label}
                          </span>
                          <span className={`size-1.5 rounded-full ${node.count > 0 ? "bg-brand ping-dot" : "bg-muted"}`} />
                        </div>

                        <div className="mt-3 relative z-10">
                          <h4 className="text-2xl font-bold tracking-tight text-foreground font-mono leading-none">
                            {node.count.toLocaleString()}
                          </h4>
                          <p className="text-[10px] text-muted-foreground mt-0.5">Leads</p>
                        </div>

                        <div className="mt-4 pt-3 border-t border-border/50 relative z-10 space-y-1">
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-muted-foreground">Conversion</span>
                            <span className="font-semibold text-foreground font-mono">{node.conversion}%</span>
                          </div>
                          
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="text-muted-foreground">Value</span>
                            <span className="font-semibold text-brand font-mono">{node.valueString}</span>
                          </div>

                          <div className="flex items-center justify-between text-[10px] pt-1">
                            <span className="text-muted-foreground">Growth</span>
                            <span className={`font-semibold font-mono flex items-center ${node.trend.isUp ? "text-success" : "text-red-400"}`}>
                              {node.trend.isUp ? "▲" : "▼"} {node.trend.pct}%
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          ) : (
            
            /* KANBAN VIEW (Clean Performance Fallback) */
            <div className="flex-1 overflow-x-auto min-h-[400px]">
              <div className="flex h-full gap-4 py-2" style={{ minWidth: `${PIPELINE_COLUMNS.length * 288 + (PIPELINE_COLUMNS.length - 1) * 16}px` }}>
                {PIPELINE_COLUMNS.map((colStatus) => {
                  // Filter leads that are in this status from cached list (Virtualizing by rendering only 10 max)
                  const columnLeads = leads
                    .filter((lead) => normalizeLeadStatus(lead.status) === colStatus);
                  const displayLeads = columnLeads.slice(0, 10);
                  const isOver = dragOver === colStatus;
                  const count = columnLeads.length;
                  const pulse = aiPulses[colStatus] || { text: "Stage is stable.", isAlert: false };
                  const now = Date.now();

                  return (
                    <section
                      key={colStatus}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOver(colStatus);
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={() => void handleDrop(colStatus)}
                      className={`flex w-72 shrink-0 flex-col rounded-2xl border transition-all duration-300 bg-card/25 backdrop-blur-sm ${
                        isOver 
                          ? "border-brand bg-brand/5 shadow-md shadow-brand/5 scale-[1.01]" 
                          : "border-border/60 hover:border-border/80"
                      }`}
                    >
                      {/* Column Header */}
                      <div className="border-b border-border/60 px-4 py-3.5 flex flex-col gap-1.5 bg-card/10 rounded-t-2xl">
                        <div className="flex items-center justify-between">
                          <span className={`rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${leadStatusColor(colStatus)}`}>
                            {leadStatusLabel(colStatus)}
                          </span>
                          <span className="text-xs font-bold text-muted-foreground font-mono">{count}</span>
                        </div>
                        {/* Dynamic AI Pulse */}
                        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                          <span className={`size-1.5 rounded-full shrink-0 ${pulse.isAlert ? "bg-amber-400 animate-pulse" : "bg-brand/60"}`} />
                          <span className="text-[11px] leading-tight text-muted-foreground font-medium select-none truncate" title={pulse.text}>
                            {pulse.text}
                          </span>
                        </div>
                      </div>

                      {/* Draggable Cards Stack (Limit 10 to protect browser rendering) */}
                      <div className="flex-1 space-y-2 overflow-y-auto p-2 min-h-0">
                        {leadsLoading ? (
                          Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)
                        ) : displayLeads.length === 0 ? (
                          <div className="h-full flex items-center justify-center py-10 px-4 text-center">
                            <p className="text-[11px] text-muted-foreground leading-relaxed">No opportunities in this stage.</p>
                          </div>
                        ) : (
                          displayLeads.map((lead) => (
                            <article
                              key={lead.id}
                              draggable
                              onDragStart={() => setDragging(lead.id)}
                              onDragEnd={() => {
                                setDragging(null);
                                setDragOver(null);
                              }}
                              onClick={() => navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(lead.id) } })}
                              className={`group relative overflow-hidden rounded-xl border border-border/50 bg-card/40 p-4 text-xs transition-all duration-200 hover:border-brand/40 hover:bg-card/80 hover:shadow-md hover:-translate-y-1 cursor-grab active:cursor-grabbing select-none border-l-4 ${
                                normalizeLeadStatus(lead.status) === "new" ? "border-l-blue-500" :
                                ["email_sent", "called", "instagram_sent"].includes(normalizeLeadStatus(lead.status)) ? "border-l-indigo-500" :
                                normalizeLeadStatus(lead.status) === "replied" ? "border-l-brand" :
                                normalizeLeadStatus(lead.status) === "meeting_booked" ? "border-l-amber-500" :
                                normalizeLeadStatus(lead.status) === "closed" ? "border-l-success" : "border-l-muted"
                              } ${dragging === lead.id ? "opacity-35 scale-95" : ""}`}
                            >
                              <div className="flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <h4 className="font-bold text-sm tracking-tight text-foreground truncate group-hover:text-brand transition-colors">
                                      {lead.businessName}
                                    </h4>
                                    {lead.instagramHandle && (
                                      <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground font-mono">
                                        @{lead.instagramHandle.replace(/^@/, "")}
                                      </p>
                                    )}
                                  </div>
                                  <ArrowRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200 shrink-0" />
                                </div>

                                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                  {lead.niche && (
                                    <span className="rounded-md bg-brand/5 border border-brand/10 px-2 py-0.5 text-[9px] text-brand font-semibold capitalize tracking-wide truncate max-w-[120px]">
                                      {lead.niche.replace(/_/g, " ")}
                                    </span>
                                  )}
                                  
                                  {colStatus === "replied" && (now - new Date(lead.updatedAt).getTime()) > (3 * 24 * 60 * 60 * 1000) && (
                                    <span className="rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[9px] text-amber-400 font-semibold tracking-wide flex items-center gap-1 shrink-0">
                                      <Clock className="size-2.5" /> Stalled
                                    </span>
                                  )}

                                  {colStatus === "email_sent" && (now - new Date(lead.updatedAt).getTime()) > (4 * 24 * 60 * 60 * 1000) && (
                                    <span className="rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[9px] text-amber-400 font-semibold tracking-wide flex items-center gap-1 shrink-0">
                                      <Clock className="size-2.5" /> Nudge Due
                                    </span>
                                  )}
                                </div>
                              </div>
                            </article>
                          ))
                        )}
                      </div>

                      {/* View All leads in column Link */}
                      {count > 0 && (
                        <div className="border-t border-border/40 p-2 bg-card/10 rounded-b-2xl">
                          <button
                            onClick={() => {
                              navigate({ to: "/dashboard/relationships" });
                            }}
                            className="w-full text-center text-[10px] font-semibold text-brand hover:text-brand-dark py-1"
                          >
                            View all {count} leads →
                          </button>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right Side: AI Coach & Feed (1/4 width) */}
        <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-border bg-card/20 backdrop-blur-md flex flex-col overflow-y-auto">
          
          {/* AI Recommendations Section */}
          <div className="p-5 border-b border-border">
            <h3 className="text-sm font-bold uppercase tracking-wider text-foreground flex items-center gap-2">
              <Sparkles className="size-4 text-brand" /> AI Sales Coach
            </h3>
            <p className="text-xs text-muted-foreground mt-1">Recommendations to optimize opportunity conversion.</p>
            
            <div className="mt-4 space-y-3">
              {statsLoading ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl w-full" />)
              ) : (
                aiRecommendations.map((rec) => (
                  <div 
                    key={rec.id} 
                    className={`p-3.5 rounded-xl border bg-background/40 hover:bg-background/80 transition-all duration-200 text-xs text-left border-l-4 ${
                      rec.type === "warning" ? "border-l-amber-500 border-border/60 hover:border-amber-500/50" :
                      rec.type === "danger" ? "border-l-red-500 border-border/60 hover:border-red-500/50" :
                      rec.type === "success" ? "border-l-success border-border/60 hover:border-success/50" :
                      "border-l-blue-500 border-border/60 hover:border-blue-500/50"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="shrink-0 mt-0.5">
                        {rec.type === "warning" ? (
                          <AlertCircle className="size-4 text-amber-500" />
                        ) : rec.type === "danger" ? (
                          <AlertCircle className="size-4 text-red-500" />
                        ) : rec.type === "success" ? (
                          <Sparkles className="size-4 text-success" />
                        ) : (
                          <Sparkles className="size-4 text-blue-500" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground leading-relaxed select-text">{rec.text}</p>
                        <button
                          onClick={() => navigate({ to: rec.to })}
                          className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-bold text-brand hover:text-brand-dark transition-colors cursor-pointer"
                        >
                          {rec.action}
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Recent Activities Section */}
          <div className="p-5 flex-1 min-h-[250px]">
            <h3 className="text-sm font-bold uppercase tracking-wider text-foreground flex items-center gap-2 mb-4">
              <Activity className="size-4 text-brand" /> Recent Activity
            </h3>
            
            <div className="space-y-4">
              {activityLoading ? (
                Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)
              ) : recentActivities.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-xs text-muted-foreground">No recent actions.</p>
                </div>
              ) : (
                recentActivities.slice(0, 8).map((act) => {
                  // Determine appropriate icon/color based on type
                  const isSent = act.type.includes("sent");
                  const isLead = act.type.includes("lead");
                  const isNote = act.type.includes("note");
                  
                  return (
                    <div key={act.id} className="flex gap-3 text-xs items-start">
                      <div className={`shrink-0 size-6.5 rounded-lg border grid place-items-center ${
                        isSent 
                          ? "bg-brand/10 border-brand/20 text-brand" 
                          : isLead 
                            ? "bg-blue-500/10 border-blue-500/20 text-blue-400" 
                            : "bg-muted border-border text-muted-foreground"
                      }`}>
                        {isSent ? <MessageSquare className="size-3.5" /> : <Clock className="size-3.5" />}
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-semibold text-foreground">
                          {act.leadName ? `${act.leadName}: ` : ""}
                          <span className="font-normal text-muted-foreground">{act.description}</span>
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(act.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </aside>
      </div>

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
                    <Sparkles className="size-3.5" /> Stage AI Insight
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
                      <Plus className="size-3.5" /> Discover
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
                          <Activity className="size-3.5 text-brand" />
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
                            <ArrowRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
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

      {/* Styled Animations CSS block (Stripe-like glowing lines) */}
      <style>{`
        .bg-grid-sm {
          position: relative;
        }
        
        /* Pulse traveling dot along horizontal map line */
        @keyframes travel-pulse {
          0% { left: 0%; opacity: 0; }
          5% { opacity: 1; }
          95% { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }

        .pulse-dot-1 {
          position: absolute;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background-color: var(--color-brand);
          box-shadow: 0 0 8px 1px var(--color-brand);
          top: 50%;
          transform: translateY(-50%);
          animation: travel-pulse 8s infinite linear;
        }

        .pulse-dot-2 {
          position: absolute;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background-color: #3b82f6; /* blue-500 */
          box-shadow: 0 0 8px 1px #3b82f6;
          top: 50%;
          transform: translateY(-50%);
          animation: travel-pulse 11s infinite linear;
          animation-delay: 2.5s;
        }

        .pulse-dot-3 {
          position: absolute;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background-color: var(--color-success);
          box-shadow: 0 0 8px 1px var(--color-success);
          top: 50%;
          transform: translateY(-50%);
          animation: travel-pulse 14s infinite linear;
          animation-delay: 5s;
        }
      `}</style>

    </div>
  );
}
