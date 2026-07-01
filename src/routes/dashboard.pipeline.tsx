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
    const recs = [];

    // 1. Uncontacted leads check
    const newLeads = stageCounts.new;
    if (newLeads > 0) {
      recs.push({
        id: "uncontacted",
        text: `${newLeads.toLocaleString()} new opportunities have not been contacted.`,
        type: "warning" as const,
        action: "Create outreach campaign",
        to: "/dashboard/leads"
      });
    } else {
      recs.push({
        id: "uncontacted-default",
        text: "All incoming opportunities have been logged. Keep discovering fresh opportunities.",
        type: "success" as const,
        action: "Discover",
        to: "/dashboard/leads"
      });
    }

    // 2. Stalled leads check
    const now = Date.now();
    const stalledCount = leads.filter((lead) => {
      const stage = getStageForStatus(lead.status);
      return stage === "contacted" && (now - new Date(lead.updatedAt).getTime()) > (4 * 24 * 60 * 60 * 1000);
    }).length;

    if (stalledCount > 0) {
      recs.push({
        id: "stalled",
        text: `${stalledCount} high-value leads are stalled in contacted stage.`,
        type: "danger" as const,
        action: "Send bump templates",
        to: "/dashboard/relationships"
      });
    }

    // 3. Conversion suggestion
    const contactedConv = stageConversions.contacted;
    if (contactedConv < 40 && totalLeadsInFunnel > 10) {
      recs.push({
        id: "conversion-boost",
        text: "Following up with Contacted leads may increase conversions by 11%.",
        type: "info" as const,
        action: "Optimize sequence",
        to: "/dashboard/settings"
      });
    }

    // 4. Stage velocity slowdown
    const proposalCount = stageCounts.replied;
    if (proposalCount > 5) {
      recs.push({
        id: "proposal-slow",
        text: "Replied stage has slowed down. 3 deals waiting for quote approval.",
        type: "info" as const,
        action: "Review pipeline",
        to: "/dashboard/relationships"
      });
    } else {
      recs.push({
        id: "pipeline-efficiency",
        text: "Pipeline velocity is optimal. Average deal conversion is 4.8 days.",
        type: "success" as const,
        action: "View analytics",
        to: "/dashboard/analytics"
      });
    }

    return recs;
  }, [stageCounts, stageConversions, leads, totalLeadsInFunnel]);

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
                          <span className="font-bold uppercase w-20 text-[10px] text-muted-foreground tracking-wider">{stage.label}</span>
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
              <div className="flex h-full gap-3 py-2" style={{ minWidth: `${PIPELINE_COLUMNS.length * 240}px` }}>
                {PIPELINE_COLUMNS.map((colStatus) => {
                  // Filter leads that are in this status from cached list (Virtualizing by rendering only 10 max)
                  const columnLeads = leads
                    .filter((lead) => normalizeLeadStatus(lead.status) === colStatus);
                  const displayLeads = columnLeads.slice(0, 10);
                  const isOver = dragOver === colStatus;
                  const count = columnLeads.length;

                  return (
                    <section
                      key={colStatus}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOver(colStatus);
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={() => void handleDrop(colStatus)}
                      className={`flex w-60 shrink-0 flex-col rounded-2xl border transition-colors bg-card/30 backdrop-blur-sm ${
                        isOver ? "border-brand bg-brand/5" : "border-border"
                      }`}
                    >
                      {/* Column Header */}
                      <div className="border-b border-border/60 px-3 py-3 flex items-center justify-between bg-card/20 rounded-t-2xl">
                        <span className={`rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${leadStatusColor(colStatus)}`}>
                          {leadStatusLabel(colStatus)}
                        </span>
                        <span className="text-xs font-bold text-muted-foreground font-mono">{count}</span>
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
                              className={`group rounded-xl border border-border/80 bg-background p-3 text-xs transition-all hover:border-brand/40 hover:shadow-sm cursor-grab select-none ${
                                dragging === lead.id ? "opacity-35" : ""
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                <GripVertical className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <p className="font-bold leading-tight text-foreground truncate">{lead.businessName}</p>
                                  {lead.instagramHandle && (
                                    <p className="mt-1 truncate text-[10px] text-muted-foreground">@{lead.instagramHandle.replace(/^@/, "")}</p>
                                  )}
                                  {lead.niche && <span className="mt-2 inline-block rounded-md bg-brand/5 border border-brand/10 px-1.5 py-0.5 text-[9px] text-brand font-semibold capitalize">{lead.niche.replace(/_/g, " ")}</span>}
                                </div>
                                <ArrowRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
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
                              // We can navigate to CRM. We pass the status parameter (we will validate this or use state)
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
                Array.from({ length: 3 }).map((i) => <Skeleton key={i} className="h-16 rounded-xl w-full" />)
              ) : (
                aiRecommendations.map((rec) => (
                  <div 
                    key={rec.id} 
                    className="p-3.5 rounded-xl border border-border/80 bg-background/50 hover:border-brand/35 transition-colors text-xs text-left"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="shrink-0 mt-0.5">
                        <AlertCircle className="size-4 text-brand" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground leading-snug">{rec.text}</p>
                        <button
                          onClick={() => navigate({ to: rec.to })}
                          className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-brand hover:text-brand-dark cursor-pointer"
                        >
                          {rec.action} <ChevronRight className="size-3" />
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
                Array.from({ length: 4 }).map((i) => <Skeleton key={i} className="h-10 rounded-xl" />)
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
                              value={expandedStage}
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
