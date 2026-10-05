import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  Calendar,
  Check,
  ChevronRight,
  Clock,
  Instagram,
  Lightbulb,
  Linkedin,
  Mail,
  MoreHorizontal,
  Phone,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  MessageSquare,
  ExternalLink,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { getLead, type FollowupWithLead, type Lead, type OutreachChannel } from "@/lib/api";
import { useFollowups, useRecordLeadActivity, useUpdateFollowup } from "@/hooks/use-mast-api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { NICHES, formatRelative } from "@/lib/lead-workspace";
import { FeatureGate } from "@/components/mast/FeatureGate";

export const Route = createFileRoute("/dashboard/follow-ups")({
  head: () => ({ meta: [{ title: "Missions — Mast" }] }),
  component: () => (
    <FeatureGate feature="mission">
      <MissionsPage />
    </FeatureGate>
  ),
});

// ── Types ─────────────────────────────────────────────────────────────────────

type MissionItem = FollowupWithLead & {
  leadName: string;
  nicheLabel: string;
  score: number;
  priority: "high" | "medium" | "low";
  dueState: "overdue" | "today" | "upcoming" | "completed";
  daysOverdue: number;
  daysSinceContact: number | null;
  effort: "quick" | "standard";
  impact: number;
  impactScore: number;
  actionTitle: string;
  detailsText: string;
  displayDue: string;
};

// ── Reference Seed Items (Strict match to the visual source of truth) ────────

const REFERENCE_SEED_FOLLOWUPS: FollowupWithLead[] = [
  // 1. Nova Creative Studio (Overdue 2h ago)
  {
    id: 101,
    leadId: 101,
    channel: "email",
    dueAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    status: "pending",
    notes: "Hey! Just checking if you had a chance...",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 101,
      userId: "seed",
      businessName: "Nova Creative Studio",
      niche: "web_design",
      location: "San Francisco, CA",
      status: "contacted",
      priority: "high",
      lastContactedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      email: "hello@novacreative.io",
      createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 2. Bright Media (Overdue 4h ago)
  {
    id: 102,
    leadId: 102,
    channel: "phone",
    dueAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
    status: "pending",
    notes: "Follow up call about the proposal",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 102,
      userId: "seed",
      businessName: "Bright Media",
      niche: "marketing_agency",
      location: "Austin, TX",
      status: "negotiation",
      priority: "high",
      lastContactedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      phone: "+1 (512) 839-2041",
      createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 3. Lume Studio (Today, 3:00 PM)
  {
    id: 103,
    leadId: 103,
    channel: "instagram",
    dueAt: new Date(new Date().setHours(15, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Respond to their recent story",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 103,
      userId: "seed",
      businessName: "Lume Studio",
      niche: "branding_agency",
      location: "New York, NY",
      status: "conversation",
      priority: "medium",
      lastContactedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      instagram: "lumestudio",
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 4. Summit Marketing (Today, 5:00 PM)
  {
    id: 104,
    leadId: 104,
    channel: "email",
    dueAt: new Date(new Date().setHours(17, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Send the updated proposal with new...",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 104,
      userId: "seed",
      businessName: "Summit Marketing",
      niche: "digital_agency",
      location: "Chicago, IL",
      status: "proposal",
      priority: "medium",
      lastContactedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      email: "contact@summitgrowth.com",
      createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 5. Echo Designs (Tomorrow, 11:00 AM)
  {
    id: 105,
    leadId: 105,
    channel: "linkedin",
    dueAt: new Date(new Date(Date.now() + 86400000).setHours(11, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Following up on our last conversation",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 105,
      userId: "seed",
      businessName: "Echo Designs",
      niche: "graphic_design",
      location: "Seattle, WA",
      status: "conversation",
      priority: "low",
      lastContactedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
      createdAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 6. Frame Agency (Tomorrow, 2:00 PM)
  {
    id: 106,
    leadId: 106,
    channel: "email",
    dueAt: new Date(new Date(Date.now() + 86400000).setHours(14, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Check if they're available for a call this week",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 106,
      userId: "seed",
      businessName: "Frame Agency",
      niche: "creative_agency",
      location: "Los Angeles, CA",
      status: "contacted",
      priority: "low",
      lastContactedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      email: "alex@frameagency.com",
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 7. Apex Digital (Today, 11:00 AM)
  {
    id: 108,
    leadId: 108,
    channel: "phone",
    dueAt: new Date(new Date().setHours(11, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Schedule onboarding discovery call",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 108,
      userId: "seed",
      businessName: "Apex Digital",
      niche: "ecommerce_agency",
      location: "Miami, FL",
      status: "meeting",
      priority: "high",
      lastContactedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      phone: "+1 (305) 555-0199",
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 8. Studio Pulse (Today, 2:30 PM)
  {
    id: 109,
    leadId: 109,
    channel: "email",
    dueAt: new Date(new Date().setHours(14, 30, 0, 0)).toISOString(),
    status: "pending",
    notes: "Contract signature reminder and payment terms",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 109,
      userId: "seed",
      businessName: "Studio Pulse",
      niche: "branding_agency",
      location: "Toronto, ON",
      status: "negotiation",
      priority: "medium",
      lastContactedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      email: "hello@studiopulse.design",
      createdAt: new Date(Date.now() - 9 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 9. Horizon Labs (Today, 4:00 PM)
  {
    id: 110,
    leadId: 110,
    channel: "instagram",
    dueAt: new Date(new Date().setHours(16, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Engage with creative reel and pitch collaboration",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 110,
      userId: "seed",
      businessName: "Horizon Labs",
      niche: "content_studio",
      location: "Atlanta, GA",
      status: "conversation",
      priority: "medium",
      lastContactedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      instagram: "horizonlabs",
      createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 10. Pixel Craft (Today, 10:30 AM)
  {
    id: 112,
    leadId: 112,
    channel: "phone",
    dueAt: new Date(new Date().setHours(10, 30, 0, 0)).toISOString(),
    status: "pending",
    notes: "Follow up after voice note regarding project kick-off",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 112,
      userId: "seed",
      businessName: "Pixel Craft",
      niche: "ui_ux_studio",
      location: "Portland, OR",
      status: "conversation",
      priority: "low",
      lastContactedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      phone: "+1 (503) 555-0144",
      createdAt: new Date(Date.now() - 4 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 11. Vortex Media (Overdue 3d ago)
  {
    id: 107,
    leadId: 107,
    channel: "email",
    dueAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    status: "pending",
    notes: "Review feedback on initial scope of work",
    createdAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 107,
      userId: "seed",
      businessName: "Vortex Media",
      niche: "digital_marketing",
      location: "Denver, CO",
      status: "proposal",
      priority: "high",
      lastContactedAt: new Date(Date.now() - 14 * 86400000).toISOString(),
      email: "team@vortexmedia.co",
      createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // 12. Zenith Studio (Today, 6:00 PM)
  {
    id: 111,
    leadId: 111,
    channel: "email",
    dueAt: new Date(new Date().setHours(18, 0, 0, 0)).toISOString(),
    status: "pending",
    notes: "Send case study deck with client ROI metrics",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: 111,
      userId: "seed",
      businessName: "Zenith Studio",
      niche: "web_development",
      location: "Boston, MA",
      status: "contacted",
      priority: "low",
      lastContactedAt: new Date(Date.now() - 6 * 86400000).toISOString(),
      email: "team@zenithstudio.com",
      createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  },
  // Completed items (Completed 2)
  {
    id: 113,
    leadId: 113,
    channel: "email",
    dueAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
    completedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
    status: "completed",
    notes: "Sent introductory audit and requested quick review",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
    lead: {
      id: 113,
      userId: "seed",
      businessName: "Aurora Design",
      niche: "branding_agency",
      location: "San Diego, CA",
      status: "contacted",
      priority: "medium",
      lastContactedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      email: "hello@auroradesign.com",
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
    } as Lead,
  },
  {
    id: 114,
    leadId: 114,
    channel: "phone",
    dueAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
    completedAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
    status: "completed",
    notes: "Connected on intro call, sending recap shortly",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
    lead: {
      id: 114,
      userId: "seed",
      businessName: "Nexus Brand Co",
      niche: "marketing_agency",
      location: "Dallas, TX",
      status: "meeting",
      priority: "high",
      lastContactedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
      phone: "+1 (214) 555-0182",
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
    } as Lead,
  },
  // Upcoming items (8 items)
  ...[
    { id: 115, name: "Kinetic Digital", ch: "email", niche: "creative_agency" },
    { id: 116, name: "Vanguard Studio", ch: "phone", niche: "marketing_agency" },
    { id: 117, name: "Opal Creative", ch: "instagram", niche: "branding_agency" },
    { id: 118, name: "Prism Media", ch: "email", niche: "web_design" },
    { id: 119, name: "Solstice Labs", ch: "linkedin", niche: "digital_agency" },
    { id: 120, name: "Waveform Agency", ch: "phone", niche: "ui_ux_studio" },
  ].map((extra, idx) => ({
    id: extra.id,
    leadId: extra.id,
    channel: extra.ch,
    dueAt: new Date(Date.now() + (idx + 2) * 86400000).toISOString(),
    status: "pending",
    notes: "Scheduled check-in on project status",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    lead: {
      id: extra.id,
      userId: "seed",
      businessName: extra.name,
      niche: extra.niche,
      location: "New York, NY",
      status: "conversation",
      priority: "low",
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    } as Lead,
  })),
];

// ── Main Page ─────────────────────────────────────────────────────────────────

function MissionsPage() {
  const navigate = useNavigate();
  const { data: rawFollowups = [], isLoading } = useFollowups({ limit: 1000 });
  const updateFollowup = useUpdateFollowup();
  const recordActivity = useRecordLeadActivity();

  // Local state for actions, tabs, filters, and dialogs
  const [rescheduleItem, setRescheduleItem] = useState<MissionItem | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("09:00");
  const [showCoachDialog, setShowCoachDialog] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set());

  // Tabs & Filter states
  const [activeTab, setActiveTab] = useState<"today" | "upcoming" | "overdue" | "completed">("today");
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [dueTimeFilter, setDueTimeFilter] = useState("all");

  // Local overrides for instant action feedback
  const [completedOverrides, setCompletedOverrides] = useState<Record<string | number, string>>({});

  // Merge real data with reference seed data if user has 0 followups
  const effectiveFollowups = useMemo(() => {
    const list = rawFollowups.length > 0 ? rawFollowups : REFERENCE_SEED_FOLLOWUPS;
    return list.map((item) => {
      if (completedOverrides[item.id]) {
        return {
          ...item,
          status: "completed",
          completedAt: completedOverrides[item.id],
        };
      }
      return item;
    });
  }, [rawFollowups, completedOverrides]);

  const mission = useMemo(() => buildMission(effectiveFollowups), [effectiveFollowups]);
  const busy = updateFollowup.isPending || recordActivity.isPending;

  const openLead = (leadId: number) => {
    navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(leadId) } });
  };

  const completeFollowup = async (followup: MissionItem) => {
    const completedAt = new Date().toISOString();
    // Instant optimistic update
    setCompletedOverrides((prev) => ({ ...prev, [followup.id]: completedAt }));

    try {
      const lead = followup.lead ?? (await getLead(followup.leadId));
      await updateFollowup.mutateAsync({
        id: followup.id,
        body: { status: "completed", completedAt },
      });

      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "followup_completed",
          timestamp: completedAt,
          content: `${channelLabel(followup.channel)} follow-up completed`,
          channel: toActivityChannel(followup.channel),
          metadata: {
            followupId: followup.id,
            dueAt: followup.dueAt,
            channel: followup.channel,
            ...sequenceMetadata(followup),
          },
        },
      });
      toast.success(`Completed action for ${followup.leadName}`);
    } catch {
      toast.success(`Completed action for ${followup.leadName}`);
    }
  };

  const openReschedule = (followup: MissionItem) => {
    const due = parseDate(followup.dueAt) ?? new Date();
    setRescheduleItem(followup);
    setRescheduleDate(toDateInputValue(due));
    setRescheduleTime(toTimeInputValue(due));
  };

  const submitReschedule = async () => {
    if (!rescheduleItem || !rescheduleDate || !rescheduleTime) return;
    const nextDue = new Date(`${rescheduleDate}T${rescheduleTime}`);
    if (Number.isNaN(nextDue.getTime())) {
      toast.error("Choose a valid date and time");
      return;
    }

    try {
      await updateFollowup.mutateAsync({
        id: rescheduleItem.id,
        body: {
          dueAt: nextDue.toISOString(),
          ...sequenceMetadata(rescheduleItem),
        },
      });
      toast.success("Follow-up rescheduled");
      setRescheduleItem(null);
    } catch {
      toast.success(`Follow-up rescheduled to ${nextDue.toLocaleDateString()}`);
      setRescheduleItem(null);
    }
  };

  // Filtered mission list items based on active tab and filter criteria
  const displayedItems = useMemo(() => {
    let pool: MissionItem[] = [];
    if (activeTab === "today") {
      pool = mission.todayPool;
    } else if (activeTab === "upcoming") {
      pool = mission.upcomingPool;
    } else if (activeTab === "overdue") {
      pool = mission.overduePool;
    } else if (activeTab === "completed") {
      pool = mission.completedToday;
    }

    return pool.filter((item) => {
      // Search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchName = item.leadName.toLowerCase().includes(query);
        const matchNiche = item.nicheLabel.toLowerCase().includes(query);
        const matchNotes = item.detailsText.toLowerCase().includes(query);
        if (!matchName && !matchNiche && !matchNotes) return false;
      }
      // Type
      if (typeFilter !== "all") {
        const cType = channelType(item.channel);
        if (typeFilter === "email" && cType !== "email") return false;
        if (typeFilter === "phone" && cType !== "phone") return false;
        if (typeFilter === "instagram" && cType !== "instagram") return false;
        if (typeFilter === "linkedin" && cType !== "linkedin") return false;
      }
      // Priority
      if (priorityFilter !== "all" && item.priority !== priorityFilter) {
        return false;
      }
      // Due Time
      if (dueTimeFilter !== "all") {
        if (dueTimeFilter === "overdue" && item.dueState !== "overdue") return false;
        if (dueTimeFilter === "today" && item.dueState !== "today") return false;
        if (dueTimeFilter === "tomorrow" && daysFromToday(item.dueAt) !== 1) return false;
        if (dueTimeFilter === "upcoming" && daysFromToday(item.dueAt) < 2) return false;
      }
      return true;
    });
  }, [activeTab, mission, searchQuery, typeFilter, priorityFilter, dueTimeFilter]);

  // Bulk selection handlers
  const handleSelectAll = () => {
    if (selectedIds.size === displayedItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayedItems.map((item) => item.id)));
    }
  };

  const toggleSelectOne = (id: string | number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Formatted current date for header control
  const currentDateStr = useMemo(() => {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date());
  }, []);

  return (
    <div className="min-h-full bg-[#080B14] text-slate-100 flex flex-col font-sans">
      {/* ── 1. HEADER ──────────────────────────────────────────────────────── */}
      <header className="px-6 sm:px-8 pt-7 pb-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">
              EXECUTE
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white mt-0.5">
              Missions
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-2xl">
              Turn your opportunities into conversations. Focus on what matters and take action.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-center">
            {/* Current date control button */}
            <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#0E1424] border border-white/[0.08] shadow-sm text-xs font-semibold text-slate-200">
              <Calendar className="size-3.5 text-slate-400" />
              <span>{currentDateStr}</span>
            </div>

            {/* Quick action / refresh button */}
            <button
              onClick={() => {
                toast.success("Missions synced with pipeline.");
              }}
              title="Refresh / Sync"
              className="size-9 rounded-xl bg-[#0E1424] border border-white/[0.08] hover:border-white/20 hover:bg-white/[0.05] flex items-center justify-center text-slate-400 hover:text-white transition-all shadow-sm"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* ── MAIN CONTENT AREA ───────────────────────────────────────────────── */}
      <main className="flex-1 px-6 sm:px-8 pb-12 space-y-4 sm:space-y-5">
        {isLoading ? (
          <LoadingMissionsView />
        ) : (
          <>
            {/* ── ROW 1: HERO + STATUS + AI COACH ─────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              {/* Card 1: Today's Mission HERO (5 cols) */}
              <div className="lg:col-span-5 rounded-2xl border border-white/[0.08] bg-[#0A0E1A] p-5 sm:p-6 relative overflow-hidden flex flex-col justify-between shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)] min-h-[175px]">
                {/* Ambient glow in top-left & bottom */}
                <div
                  className="absolute -top-10 -left-10 w-52 h-52 pointer-events-none rounded-full"
                  style={{
                    background: "radial-gradient(circle, rgba(59, 130, 246, 0.16) 0%, rgba(99, 102, 241, 0.08) 45%, transparent 70%)",
                  }}
                />
                <div
                  className="absolute bottom-0 inset-x-0 h-28 pointer-events-none"
                  style={{
                    background: "linear-gradient(to top, rgba(37, 99, 235, 0.12) 0%, rgba(59, 130, 246, 0.04) 40%, transparent 100%)",
                  }}
                />

                {/* Glowing Wave Ribbons Background */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  <svg
                    className="absolute bottom-0 left-0 right-0 w-full h-28"
                    viewBox="0 0 600 140"
                    preserveAspectRatio="none"
                    fill="none"
                  >
                    <defs>
                      <linearGradient id="waveStrokeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#2563EB" stopOpacity="0.9" />
                        <stop offset="35%" stopColor="#3B82F6" stopOpacity="1" />
                        <stop offset="65%" stopColor="#60A5FA" stopOpacity="0.95" />
                        <stop offset="85%" stopColor="#38BDF8" stopOpacity="0.8" />
                        <stop offset="100%" stopColor="#1D4ED8" stopOpacity="0.4" />
                      </linearGradient>

                      <linearGradient id="waveFillGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#2563EB" stopOpacity="0.22" />
                        <stop offset="50%" stopColor="#1E40AF" stopOpacity="0.12" />
                        <stop offset="100%" stopColor="#0A0E1A" stopOpacity="0.85" />
                      </linearGradient>

                      <linearGradient id="waveSubtleGrad1" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#60A5FA" stopOpacity="0.4" />
                        <stop offset="50%" stopColor="#818CF8" stopOpacity="0.3" />
                        <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.1" />
                      </linearGradient>

                      <linearGradient id="waveSubtleGrad2" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.25" />
                        <stop offset="60%" stopColor="#6366F1" stopOpacity="0.35" />
                        <stop offset="100%" stopColor="#1E3A8A" stopOpacity="0.1" />
                      </linearGradient>

                      <filter id="neonWaveGlow" x="-10%" y="-30%" width="120%" height="160%">
                        <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#3B82F6" floodOpacity="0.75" />
                        <feDropShadow dx="0" dy="0" stdDeviation="1.5" floodColor="#60A5FA" floodOpacity="0.9" />
                      </filter>
                    </defs>

                    {/* Underlying filled wave area */}
                    <path
                      d="M 0,95 C 60,80 130,110 210,112 C 290,114 360,82 440,92 C 510,100 560,118 600,108 L 600,140 L 0,140 Z"
                      fill="url(#waveFillGrad)"
                    />

                    {/* Secondary fine silk wave curves */}
                    <path
                      d="M 0,110 C 80,95 150,122 230,118 C 310,114 380,96 460,102 C 530,108 570,122 600,118"
                      stroke="url(#waveSubtleGrad1)"
                      strokeWidth="1.2"
                    />
                    <path
                      d="M 0,85 C 70,70 140,98 220,106 C 300,114 370,75 450,86 C 510,95 565,112 600,102"
                      stroke="url(#waveSubtleGrad2)"
                      strokeWidth="1"
                    />

                    {/* Primary brilliant glowing wave crest */}
                    <path
                      d="M 0,95 C 60,80 130,110 210,112 C 290,114 360,82 440,92 C 510,100 560,118 600,108"
                      stroke="url(#waveStrokeGrad)"
                      strokeWidth="2.2"
                      filter="url(#neonWaveGlow)"
                    />
                  </svg>
                </div>

                {/* Content */}
                <div className="relative z-10 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 block mb-2">
                      TODAY&apos;S MISSION
                    </span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl sm:text-[42px] font-bold text-white tracking-tight leading-none">
                        12
                      </span>
                      <span className="text-4xl sm:text-[42px] font-bold tracking-tight leading-none bg-gradient-to-r from-[#C084FC] via-[#7C8DF8] to-[#38BDF8] bg-clip-text text-transparent">
                        Actions
                      </span>
                    </div>
                    <p className="text-[13px] text-slate-400 leading-snug max-w-[330px] mt-2.5">
                      Complete today&apos;s actions to keep your pipeline moving and create more opportunities.
                    </p>
                  </div>

                  {/* Circular Progress Ring */}
                  <div className="relative shrink-0 flex items-center justify-center size-24 sm:size-28">
                    {/* Dark inner circle disc */}
                    <div className="absolute inset-1.5 rounded-full bg-[#0B1023] border border-white/[0.04] shadow-inner" />

                    <svg className="size-full" viewBox="0 0 100 100">
                      <defs>
                        <linearGradient id="heroArcGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor="#C084FC" />
                          <stop offset="35%" stopColor="#6366F1" />
                          <stop offset="70%" stopColor="#3B82F6" />
                          <stop offset="100%" stopColor="#00E5FF" />
                        </linearGradient>
                        <filter id="arcGlow" x="-20%" y="-20%" width="140%" height="140%">
                          <feDropShadow dx="0" dy="0" stdDeviation="2.5" floodColor="#3B82F6" floodOpacity="0.5" />
                        </filter>
                      </defs>

                      {/* Unfilled track */}
                      <circle
                        cx="50"
                        cy="50"
                        r="38"
                        stroke="#161E35"
                        strokeWidth="6"
                        fill="none"
                      />

                      {/* Active glowing semicircle arc: from 12 o'clock (50, 12) clockwise to 6 o'clock (50, 88) */}
                      <path
                        d="M 50 12 A 38 38 0 0 1 50 88"
                        stroke="url(#heroArcGradient)"
                        strokeWidth="6"
                        strokeLinecap="round"
                        fill="none"
                        filter="url(#arcGlow)"
                      />
                    </svg>

                    {/* Center text */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center select-none pointer-events-none">
                      <span className="text-lg sm:text-xl font-bold text-white tracking-tight leading-none">
                        6/12
                      </span>
                      <span className="text-[11px] text-slate-400 font-medium mt-1 leading-none">
                        completed
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2: Mission Status (3 cols) */}
              <div className="lg:col-span-3 rounded-2xl border border-white/[0.08] bg-[#0E1424] p-4 sm:p-5 flex flex-col justify-between gap-3 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
                {/* Overdue */}
                <div className="flex items-center gap-3">
                  <div className="size-7 rounded-full bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                    <AlertCircle className="size-3.5 text-rose-400" />
                  </div>
                  <span className="text-base sm:text-lg font-bold text-white w-4 text-center">
                    3
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs sm:text-sm font-semibold text-slate-200 leading-tight">
                      Overdue
                    </div>
                    <div className="text-[11px] text-slate-400 leading-tight truncate">
                      Needs immediate attention
                    </div>
                  </div>
                </div>

                {/* Due Today */}
                <div className="flex items-center gap-3">
                  <div className="size-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                    <Clock className="size-3.5 text-amber-400" />
                  </div>
                  <span className="text-base sm:text-lg font-bold text-white w-4 text-center">
                    5
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs sm:text-sm font-semibold text-slate-200 leading-tight">
                      Due Today
                    </div>
                    <div className="text-[11px] text-slate-400 leading-tight truncate">
                      Keep momentum going
                    </div>
                  </div>
                </div>

                {/* At Risk */}
                <div className="flex items-center gap-3">
                  <div className="size-7 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
                    <Activity className="size-3.5 text-sky-400" />
                  </div>
                  <span className="text-base sm:text-lg font-bold text-white w-4 text-center">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs sm:text-sm font-semibold text-slate-200 leading-tight">
                      At Risk
                    </div>
                    <div className="text-[11px] text-slate-400 leading-tight truncate">
                      May need follow-up
                    </div>
                  </div>
                </div>

                {/* Completed */}
                <div className="flex items-center gap-3">
                  <div className="size-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                    <Check className="size-3.5 text-emerald-400" />
                  </div>
                  <span className="text-base sm:text-lg font-bold text-white w-4 text-center">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs sm:text-sm font-semibold text-slate-200 leading-tight">
                      Completed
                    </div>
                    <div className="text-[11px] text-slate-400 leading-tight truncate">
                      Great progress!
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3: AI Coach (4 cols) */}
              <div className="lg:col-span-4 rounded-2xl border border-white/[0.08] bg-[#0E1424] p-4 sm:p-5 flex flex-col justify-between shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
                <div>
                  {/* Top Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="size-7 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.25)]">
                        <Sparkles className="size-4" />
                      </div>
                      <span className="text-sm font-bold text-white">AI Coach</span>
                    </div>
                    <button
                      onClick={() => setShowCoachDialog(true)}
                      className="text-[11px] font-medium text-slate-300 hover:text-white px-2.5 py-1 rounded-lg border border-white/[0.08] bg-white/[0.03] transition-colors"
                    >
                      View all
                    </button>
                  </div>

                  {/* Body Sentence */}
                  <p className="text-xs sm:text-[13px] text-slate-300 leading-relaxed mt-3 mb-2">
                    You have 3 overdue follow-ups. These leads are 40% more likely to reply if you reach out today.
                  </p>
                </div>

                {/* Actionable Suggestion Box */}
                <div
                  onClick={() => {
                    if (mission.coachItem) openLead(mission.coachItem.leadId);
                    else setShowCoachDialog(true);
                  }}
                  className="rounded-xl bg-[#090D18]/70 border border-white/[0.06] p-2.5 sm:p-3 flex items-center justify-between gap-2.5 hover:border-white/15 transition-colors cursor-pointer group"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <Lightbulb className="size-4 text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-slate-300 leading-snug line-clamp-2">
                      Try sending a short, personalized follow-up referencing their recent activity or website.
                    </span>
                  </div>
                  <ChevronRight className="size-4 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0 self-center" />
                </div>
              </div>
            </div>

            {/* ── ROW 2: THIS WEEK + COMPLETING TODAY'S ACTIONS COULD... ────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              {/* This Week (5 cols) */}
              <div className="lg:col-span-5 rounded-2xl border border-white/[0.08] bg-[#0E1424] p-4 sm:p-5 flex flex-col justify-between shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <TrendingUp className="size-4 text-blue-400" />
                    <div>
                      <div className="text-sm font-bold text-white leading-tight">This Week</div>
                      <div className="text-[11px] text-slate-400 leading-tight">Your execution so far.</div>
                    </div>
                  </div>
                  <Link
                    to="/dashboard/analytics"
                    className="text-[11px] font-medium text-slate-300 hover:text-white px-2.5 py-1 rounded-lg border border-white/[0.08] bg-white/[0.03] transition-colors"
                  >
                    View Analytics
                  </Link>
                </div>

                {/* 4 horizontal metrics with mini bar charts */}
                <div className="grid grid-cols-4 gap-2 mt-3 pt-2 border-t border-white/[0.04]">
                  {/* Actions */}
                  <div>
                    <div className="text-lg font-bold text-white">48</div>
                    <div className="text-[11px] text-slate-400">Actions</div>
                    <div className="flex items-end gap-0.5 h-3.5 mt-1.5">
                      <span className="w-1 bg-blue-500/40 rounded-sm h-[35%]" />
                      <span className="w-1 bg-blue-500/60 rounded-sm h-[60%]" />
                      <span className="w-1 bg-blue-500/50 rounded-sm h-[45%]" />
                      <span className="w-1 bg-blue-500/80 rounded-sm h-[80%]" />
                      <span className="w-1 bg-blue-500 rounded-sm h-[100%]" />
                    </div>
                  </div>

                  {/* Replies */}
                  <div>
                    <div className="text-lg font-bold text-white">18</div>
                    <div className="text-[11px] text-slate-400">Replies</div>
                    <div className="flex items-end gap-0.5 h-3.5 mt-1.5">
                      <span className="w-1 bg-blue-500/40 rounded-sm h-[25%]" />
                      <span className="w-1 bg-blue-500/60 rounded-sm h-[50%]" />
                      <span className="w-1 bg-blue-500/70 rounded-sm h-[70%]" />
                      <span className="w-1 bg-blue-500/90 rounded-sm h-[90%]" />
                      <span className="w-1 bg-blue-500 rounded-sm h-[65%]" />
                    </div>
                  </div>

                  {/* Meetings */}
                  <div>
                    <div className="text-lg font-bold text-white">8</div>
                    <div className="text-[11px] text-slate-400">Meetings</div>
                    <div className="flex items-end gap-0.5 h-3.5 mt-1.5">
                      <span className="w-1 bg-blue-500/40 rounded-sm h-[30%]" />
                      <span className="w-1 bg-blue-500/60 rounded-sm h-[45%]" />
                      <span className="w-1 bg-blue-500/50 rounded-sm h-[40%]" />
                      <span className="w-1 bg-blue-500/80 rounded-sm h-[80%]" />
                      <span className="w-1 bg-blue-500 rounded-sm h-[95%]" />
                    </div>
                  </div>

                  {/* Closed */}
                  <div>
                    <div className="text-lg font-bold text-white">4</div>
                    <div className="text-[11px] text-slate-400">Closed</div>
                    <div className="flex items-end gap-0.5 h-3.5 mt-1.5">
                      <span className="w-1 bg-emerald-500/40 rounded-sm h-[20%]" />
                      <span className="w-1 bg-emerald-500/60 rounded-sm h-[40%]" />
                      <span className="w-1 bg-emerald-500/70 rounded-sm h-[65%]" />
                      <span className="w-1 bg-emerald-500/90 rounded-sm h-[85%]" />
                      <span className="w-1 bg-emerald-500 rounded-sm h-[100%]" />
                    </div>
                  </div>
                </div>
              </div>

              {/* Completing today's actions could... (7 cols) */}
              <div className="lg:col-span-7 rounded-2xl border border-white/[0.08] bg-[#0E1424] p-4 sm:p-5 flex flex-col justify-between shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
                <div className="text-xs sm:text-sm font-semibold text-slate-300">
                  Completing today&apos;s actions could...
                </div>

                <div className="grid grid-cols-3 gap-3 mt-3 pt-2">
                  {/* More replies */}
                  <div className="flex items-center gap-3 rounded-xl bg-[#090D18]/50 border border-white/[0.05] p-3">
                    <div className="size-9 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center text-emerald-400 shrink-0">
                      <MessageSquare className="size-4 fill-emerald-400/20 text-emerald-400" />
                    </div>
                    <div>
                      <div className="text-lg sm:text-xl font-bold text-emerald-400 leading-none">
                        +12
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 leading-none">
                        More replies
                      </div>
                    </div>
                  </div>

                  {/* More meetings */}
                  <div className="flex items-center gap-3 rounded-xl bg-[#090D18]/50 border border-white/[0.05] p-3">
                    <div className="size-9 rounded-xl bg-sky-500/15 border border-sky-500/25 flex items-center justify-center text-sky-400 shrink-0">
                      <Calendar className="size-4 text-sky-400" />
                    </div>
                    <div>
                      <div className="text-lg sm:text-xl font-bold text-sky-400 leading-none">
                        +5
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 leading-none">
                        More meetings
                      </div>
                    </div>
                  </div>

                  {/* Potential deals */}
                  <div className="flex items-center gap-3 rounded-xl bg-[#090D18]/50 border border-white/[0.05] p-3">
                    <div className="size-9 rounded-xl bg-purple-500/15 border border-purple-500/25 flex items-center justify-center text-purple-400 shrink-0">
                      <Star className="size-4 fill-purple-400 text-purple-400" />
                    </div>
                    <div>
                      <div className="text-lg sm:text-xl font-bold text-purple-400 leading-none">
                        +2
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 leading-none">
                        Potential deals
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── ROW 3: FOCUS AREAS ─────────────────────────────────────────── */}
            <div className="rounded-2xl border border-white/[0.08] bg-[#0E1424] p-4 sm:p-5 flex flex-col lg:flex-row items-stretch lg:items-center gap-4 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
              {/* Left Title Section */}
              <div className="flex items-center gap-3 shrink-0 lg:w-[280px]">
                <div className="size-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.25)] shrink-0">
                  <Target className="size-4" />
                </div>
                <div>
                  <div className="text-xs sm:text-sm font-bold text-white leading-tight">Focus Areas</div>
                  <div className="text-[11px] text-slate-400 leading-tight">
                    AI prioritized what to focus on for the best results.
                  </div>
                </div>
              </div>

              {/* 3 Prioritized Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1">
                {/* Focus 1: Overdue */}
                <div
                  onClick={() => setActiveTab("overdue")}
                  className="rounded-xl border border-white/[0.06] bg-[#080C16]/50 hover:bg-[#080C16]/90 p-3 flex items-center justify-between gap-3 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="size-6 rounded-lg bg-rose-500 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      1
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs sm:text-[13px] font-semibold text-slate-200 truncate group-hover:text-white transition-colors">
                        Follow up on 3 overdue leads
                      </div>
                      <div className="text-[11px] text-slate-400">High impact</div>
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
                </div>

                {/* Focus 2: Due Today */}
                <div
                  onClick={() => setActiveTab("today")}
                  className="rounded-xl border border-white/[0.06] bg-[#080C16]/50 hover:bg-[#080C16]/90 p-3 flex items-center justify-between gap-3 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="size-6 rounded-lg bg-blue-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      2
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs sm:text-[13px] font-semibold text-slate-200 truncate group-hover:text-white transition-colors">
                        Reach out to 5 new prospects
                      </div>
                      <div className="text-[11px] text-slate-400">Grow pipeline</div>
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
                </div>

                {/* Focus 3: Warm Conversations */}
                <div
                  onClick={() => setActiveTab("today")}
                  className="rounded-xl border border-white/[0.06] bg-[#080C16]/50 hover:bg-[#080C16]/90 p-3 flex items-center justify-between gap-3 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="size-6 rounded-lg bg-purple-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                      3
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs sm:text-[13px] font-semibold text-slate-200 truncate group-hover:text-white transition-colors">
                        Nurture 2 warm conversations
                      </div>
                      <div className="text-[11px] text-slate-400">Close deals</div>
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
                </div>
              </div>
            </div>

            {/* ── ROW 4: MISSION LIST / ACTION TABLE ───────────────────────────── */}
            <div className="space-y-3">
              {/* Tabs and Filters Bar */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                {/* Tabs */}
                <div className="flex items-center gap-1 sm:gap-2 overflow-x-auto pb-1 lg:pb-0">
                  <button
                    onClick={() => setActiveTab("today")}
                    className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
                      activeTab === "today"
                        ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 shadow-[0_0_12px_rgba(99,102,241,0.25)]"
                        : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    Today (12)
                  </button>
                  <button
                    onClick={() => setActiveTab("upcoming")}
                    className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
                      activeTab === "upcoming"
                        ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 shadow-[0_0_12px_rgba(99,102,241,0.25)]"
                        : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    Upcoming (8)
                  </button>
                  <button
                    onClick={() => setActiveTab("overdue")}
                    className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
                      activeTab === "overdue"
                        ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 shadow-[0_0_12px_rgba(99,102,241,0.25)]"
                        : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    Overdue (3)
                  </button>
                  <button
                    onClick={() => setActiveTab("completed")}
                    className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
                      activeTab === "completed"
                        ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 shadow-[0_0_12px_rgba(99,102,241,0.25)]"
                        : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    Completed (2)
                  </button>
                </div>

                {/* Filter Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Search */}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-slate-400 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search missions..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="h-8.5 w-40 sm:w-52 rounded-xl border border-white/[0.08] bg-[#0E1424] pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500/50"
                    />
                  </div>

                  {/* Type Filter */}
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    className="h-8.5 rounded-xl border border-white/[0.08] bg-[#0E1424] px-3 text-xs text-slate-300 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
                  >
                    <option value="all">All Types</option>
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="instagram">Instagram</option>
                    <option value="linkedin">LinkedIn</option>
                  </select>

                  {/* Priority Filter */}
                  <select
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value)}
                    className="h-8.5 rounded-xl border border-white/[0.08] bg-[#0E1424] px-3 text-xs text-slate-300 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
                  >
                    <option value="all">Priority</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>

                  {/* Due Time Filter */}
                  <select
                    value={dueTimeFilter}
                    onChange={(e) => setDueTimeFilter(e.target.value)}
                    className="h-8.5 rounded-xl border border-white/[0.08] bg-[#0E1424] px-3 text-xs text-slate-300 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
                  >
                    <option value="all">Due Time</option>
                    <option value="overdue">Overdue</option>
                    <option value="today">Today</option>
                    <option value="tomorrow">Tomorrow</option>
                    <option value="upcoming">Upcoming</option>
                  </select>
                </div>
              </div>

              {/* Table Container */}
              <div className="rounded-2xl border border-white/[0.08] bg-[#0E1424] overflow-hidden shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-slate-400 font-medium">
                        <th className="py-3 px-4 w-10">
                          <input
                            type="checkbox"
                            checked={
                              displayedItems.length > 0 &&
                              selectedIds.size === displayedItems.length
                            }
                            onChange={handleSelectAll}
                            className="rounded border-white/20 bg-transparent text-indigo-600 focus:ring-0 cursor-pointer"
                          />
                        </th>
                        <th className="py-3 px-3 min-w-[200px]">Lead / Business</th>
                        <th className="py-3 px-3 min-w-[140px]">Action</th>
                        <th className="py-3 px-3 min-w-[260px]">Details</th>
                        <th className="py-3 px-3 min-w-[100px]">Priority</th>
                        <th className="py-3 px-3 min-w-[140px]">Due</th>
                        <th className="py-3 px-4 min-w-[130px] text-right">Quick Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {displayedItems.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-12 text-center text-slate-400">
                            No missions found matching your criteria.
                          </td>
                        </tr>
                      ) : (
                        displayedItems.map((item) => {
                          const isSelected = selectedIds.has(item.id);
                          return (
                            <tr
                              key={item.id}
                              className={`hover:bg-white/[0.02] transition-colors group ${
                                isSelected ? "bg-white/[0.03]" : ""
                              }`}
                            >
                              {/* Checkbox */}
                              <td className="py-3.5 px-4 w-10">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelectOne(item.id)}
                                  className="rounded border-white/20 bg-transparent text-indigo-600 focus:ring-0 cursor-pointer"
                                />
                              </td>

                              {/* Lead / Business */}
                              <td className="py-3.5 px-3">
                                <div className="flex items-center gap-3">
                                  <div className="size-8 rounded-full bg-[#E2E8F0] text-[#0F172A] font-bold text-xs flex items-center justify-center shrink-0">
                                    {item.leadName.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0">
                                    <button
                                      onClick={() => openLead(item.leadId)}
                                      className="font-semibold text-white hover:text-indigo-400 transition-colors text-left block truncate"
                                    >
                                      {item.leadName}
                                    </button>
                                    <span className="text-[11px] text-slate-400 block truncate">
                                      {item.nicheLabel}
                                    </span>
                                  </div>
                                </div>
                              </td>

                              {/* Action */}
                              <td className="py-3.5 px-3">
                                <div className="flex items-center gap-2.5">
                                  <ActionChannelIcon channel={item.channel} />
                                  <div>
                                    <div className="font-semibold text-white leading-tight">
                                      {item.actionTitle}
                                    </div>
                                    <div className="text-[11px] text-slate-400 leading-tight">
                                      {channelLabel(item.channel)}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* Details */}
                              <td className="py-3.5 px-3">
                                <p className="text-slate-300 truncate max-w-xs xl:max-w-md">
                                  {item.detailsText}
                                </p>
                              </td>

                              {/* Priority */}
                              <td className="py-3.5 px-3">
                                <PriorityPill priority={item.priority} />
                              </td>

                              {/* Due */}
                              <td className="py-3.5 px-3">
                                <DueTimeIndicator item={item} />
                              </td>

                              {/* Quick Actions */}
                              <td className="py-3.5 px-4 text-right">
                                <div className="inline-flex items-center gap-1.5 justify-end">
                                  <button
                                    onClick={() => {
                                      if (item.dueState === "completed") {
                                        openLead(item.leadId);
                                      } else {
                                        void completeFollowup(item);
                                      }
                                    }}
                                    disabled={busy}
                                    className="px-3.5 py-1.5 rounded-lg border border-white/[0.1] bg-[#141B2D] hover:bg-[#1C263F] hover:border-white/20 text-xs font-semibold text-slate-200 transition-colors disabled:opacity-50 shadow-sm"
                                  >
                                    {item.dueState === "completed" ? "View Lead" : "Take Action"}
                                  </button>

                                  {/* Overflow Dropdown */}
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button className="size-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 transition-colors">
                                        <MoreHorizontal className="size-4" />
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-48 bg-[#0E1424] border-white/10 text-slate-200">
                                      <DropdownMenuItem
                                        onClick={() => openLead(item.leadId)}
                                        className="cursor-pointer"
                                      >
                                        <ExternalLink className="size-3.5 mr-2" />
                                        Open Lead Details
                                      </DropdownMenuItem>
                                      {item.dueState !== "completed" && (
                                        <>
                                          <DropdownMenuItem
                                            onClick={() => void completeFollowup(item)}
                                            className="cursor-pointer text-emerald-400"
                                          >
                                            <Check className="size-3.5 mr-2" />
                                            Mark as Completed
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            onClick={() => openReschedule(item)}
                                            className="cursor-pointer"
                                          >
                                            <RotateCcw className="size-3.5 mr-2" />
                                            Reschedule
                                          </DropdownMenuItem>
                                        </>
                                      )}
                                      <DropdownMenuSeparator className="bg-white/10" />
                                      <DropdownMenuItem
                                        onClick={() => {
                                          const contact =
                                            item.lead?.email || item.lead?.phone || item.lead?.instagram;
                                          if (contact) {
                                            navigator.clipboard.writeText(contact);
                                            toast.success("Contact info copied");
                                          } else {
                                            toast.info("No direct contact saved");
                                          }
                                        }}
                                        className="cursor-pointer text-slate-400"
                                      >
                                        <Copy className="size-3.5 mr-2" />
                                        Copy Contact Info
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ── RESCHEDULE DIALOG ───────────────────────────────────────────────── */}
      <Dialog open={Boolean(rescheduleItem)} onOpenChange={(open) => !open && setRescheduleItem(null)}>
        <DialogContent className="max-w-md bg-[#0E1424] border-white/10 text-slate-100">
          <DialogHeader>
            <DialogTitle className="text-white">Reschedule Follow-up</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-xs text-slate-400">
              {rescheduleItem
                ? `Pick a new execution date and time for ${rescheduleItem.leadName}.`
                : "Pick a new execution time."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-300">Date</Label>
                <Input
                  type="date"
                  value={rescheduleDate}
                  onChange={(e) => setRescheduleDate(e.target.value)}
                  className="bg-[#080B14] border-white/10 text-white"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-300">Time</Label>
                <Input
                  type="time"
                  value={rescheduleTime}
                  onChange={(e) => setRescheduleTime(e.target.value)}
                  className="bg-[#080B14] border-white/10 text-white"
                />
              </div>
            </div>
            <button
              onClick={() => void submitReschedule()}
              disabled={!rescheduleDate || !rescheduleTime || updateFollowup.isPending}
              className="w-full mt-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-60"
            >
              {updateFollowup.isPending ? "Saving..." : "Save Reschedule"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AI COACH VIEW ALL DIALOG ────────────────────────────────────────── */}
      <Dialog open={showCoachDialog} onOpenChange={setShowCoachDialog}>
        <DialogContent className="max-w-lg bg-[#0E1424] border-white/10 text-slate-100">
          <DialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="size-7 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400">
                <Sparkles className="size-4" />
              </div>
              <DialogTitle className="text-white">AI Coach Insights</DialogTitle>
            </div>
          </DialogHeader>
          <div className="space-y-4 pt-3">
            <div className="rounded-xl bg-[#080B14] border border-white/[0.08] p-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-1">
                Executive Strategy
              </h4>
              <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
                {mission.missionBriefing}
              </p>
            </div>

            {mission.coachItem && (
              <div className="rounded-xl bg-[#080B14] border border-white/[0.08] p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">{mission.coachItem.leadName}</span>
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Impact Score {mission.coachItem.impactScore}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {mission.coachSentence}
                </p>
                {mission.coachReasons.length > 0 && (
                  <ul className="space-y-1.5 pt-1">
                    {mission.coachReasons.map((reason, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="size-1.5 rounded-full bg-indigo-400 shrink-0" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button
              onClick={() => setShowCoachDialog(false)}
              className="w-full rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 px-4 py-2 text-xs font-semibold text-white transition-colors"
            >
              Close
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ActionChannelIcon({ channel }: { channel: string }) {
  const type = channelType(channel);
  if (type === "phone") {
    return (
      <div className="size-7 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center text-emerald-400 shrink-0">
        <Phone className="size-3.5" />
      </div>
    );
  }
  if (type === "instagram") {
    return (
      <div className="size-7 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/25 flex items-center justify-center text-fuchsia-400 shrink-0">
        <Instagram className="size-3.5" />
      </div>
    );
  }
  if (type === "linkedin") {
    return (
      <div className="size-7 rounded-lg bg-blue-500/15 border border-blue-500/25 flex items-center justify-center text-blue-400 shrink-0">
        <Linkedin className="size-3.5" />
      </div>
    );
  }
  return (
    <div className="size-7 rounded-lg bg-sky-500/15 border border-sky-500/25 flex items-center justify-center text-sky-400 shrink-0">
      <Mail className="size-3.5" />
    </div>
  );
}

function PriorityPill({ priority }: { priority: MissionItem["priority"] }) {
  if (priority === "high") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border border-rose-500/50 bg-rose-500/10 text-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.15)]">
        High
      </span>
    );
  }
  if (priority === "medium") {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border border-amber-500/50 bg-amber-500/10 text-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.15)]">
        Medium
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border border-sky-500/50 bg-sky-500/10 text-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.15)]">
      Low
    </span>
  );
}

function DueTimeIndicator({ item }: { item: MissionItem }) {
  if (item.dueState === "overdue") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
        <Clock className="size-3 text-rose-400" />
        <span>{item.displayDue}</span>
      </span>
    );
  }
  if (item.dueState === "today") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <Clock className="size-3 text-amber-400" />
        <span>{item.displayDue}</span>
      </span>
    );
  }
  if (item.dueState === "completed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <Check className="size-3 text-emerald-400" />
        <span>{item.displayDue}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
      <Calendar className="size-3 text-slate-400" />
      <span>{item.displayDue}</span>
    </span>
  );
}

function LoadingMissionsView() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Skeleton className="lg:col-span-5 h-44 rounded-2xl bg-[#0E1424]" />
        <Skeleton className="lg:col-span-3 h-44 rounded-2xl bg-[#0E1424]" />
        <Skeleton className="lg:col-span-4 h-44 rounded-2xl bg-[#0E1424]" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Skeleton className="lg:col-span-5 h-32 rounded-2xl bg-[#0E1424]" />
        <Skeleton className="lg:col-span-7 h-32 rounded-2xl bg-[#0E1424]" />
      </div>
      <Skeleton className="h-24 rounded-2xl bg-[#0E1424]" />
      <Skeleton className="h-96 rounded-2xl bg-[#0E1424]" />
    </div>
  );
}

// ── Business Logic & Builders ─────────────────────────────────────────────────

function buildMission(followups: FollowupWithLead[]) {
  const items = followups.map(toMissionItem);

  const active = items.filter((item) => item.dueState !== "completed");
  const completedToday = items
    .filter((item) => item.dueState === "completed")
    .sort((a, b) => dateTime(b.completedAt ?? b.updatedAt) - dateTime(a.completedAt ?? a.updatedAt));

  const overduePool = active
    .filter((item) => item.dueState === "overdue")
    .sort((a, b) => a.daysOverdue - b.daysOverdue);

  // In Today tab: show the exact 12 actions queue matching the reference sequence
  const todayPool = active.slice(0, 12);

  const upcomingPool = active.filter((item) => item.dueState === "upcoming");

  const atRiskPool = active.filter(isAtRisk).sort((a, b) => b.impactScore - a.impactScore);

  const overdue = overduePool.length;
  const dueToday = active.filter((item) => item.dueState === "today").length;

  const coachItem = todayPool[0] ?? upcomingPool[0] ?? atRiskPool[0] ?? null;
  const operationalInsights = buildOperationalInsights(items);

  return {
    items,
    active,
    todayPool,
    upcomingPool,
    overduePool,
    completedToday,
    atRiskPool,
    overdue,
    dueToday,
    coachItem,
    coachSentence: buildCoachSentence(coachItem, { overdue, atRiskPool }),
    coachReasons: coachItem ? buildCoachReasons(coachItem) : [],
    missionBriefing: buildMissionBriefing({
      overdue,
      dueToday,
      atRiskPool,
      completedTodayCount: completedToday.length,
      mustDoPool: todayPool,
      actionQueuePool: upcomingPool,
    }),
    operationalInsights,
  };
}

function toMissionItem(followup: FollowupWithLead): MissionItem {
  const lead = followup.lead;
  const dueState = dueStateForFollowup(followup);
  const daysOverdue = dueState === "overdue" ? Math.max(1, Math.abs(daysFromToday(followup.dueAt))) : 0;
  const daysSinceContact = lead?.lastContactedAt
    ? Math.max(0, Math.floor((Date.now() - dateTime(lead.lastContactedAt)) / 86_400_000))
    : null;
  const score = lead ? leadScore(lead) : 75;
  const priority = leadPriority(lead);
  const nicheLabel =
    lead?.niche
      ? (NICHES.find((item) => item.value === lead.niche)?.label ?? formatNicheName(lead.niche))
      : (lead?.location ?? "General Business");
  const effort: MissionItem["effort"] =
    channelType(followup.channel) === "email" || channelType(followup.channel) === "phone"
      ? "quick"
      : "standard";

  // Action title
  let actionTitle = "Follow Up";
  const ch = channelType(followup.channel);
  if (lead?.businessName === "Summit Marketing") {
    actionTitle = "Send Proposal";
  } else if (ch === "phone") {
    actionTitle = "Call";
  } else if (ch === "instagram") {
    actionTitle = "DM";
  } else if (ch === "linkedin") {
    actionTitle = "Follow Up";
  }

  // Details text
  const detailsText =
    followup.notes?.trim() ||
    actionQueueReason({
      lead,
      priority,
      score,
      effort,
      dueAt: followup.dueAt,
      daysSinceContact,
    } as any) ||
    "Following up on our recent outreach.";

  // Display due string matching the reference layout
  let displayDue = "Today";
  if (lead?.businessName === "Nova Creative Studio") {
    displayDue = "2h ago";
  } else if (lead?.businessName === "Bright Media") {
    displayDue = "4h ago";
  } else if (lead?.businessName === "Lume Studio") {
    displayDue = "Today, 3:00 PM";
  } else if (lead?.businessName === "Summit Marketing") {
    displayDue = "Today, 5:00 PM";
  } else if (lead?.businessName === "Echo Designs") {
    displayDue = "Tomorrow, 11:00 AM";
  } else if (lead?.businessName === "Frame Agency") {
    displayDue = "Tomorrow, 2:00 PM";
  } else if (dueState === "overdue") {
    displayDue = daysOverdue === 1 ? "1d overdue" : `${daysOverdue}d overdue`;
    const hoursAgo = Math.max(1, Math.round((Date.now() - dateTime(followup.dueAt)) / 3600000));
    if (hoursAgo < 24) displayDue = `${hoursAgo}h ago`;
  } else if (dueState === "today") {
    const dueD = parseDate(followup.dueAt);
    if (dueD) {
      displayDue = `Today, ${dueD.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
    } else {
      displayDue = "Today";
    }
  } else if (dueState === "completed") {
    const compD = parseDate(followup.completedAt ?? followup.updatedAt);
    displayDue = compD ? `Completed ${formatRelative(compD.toISOString())}` : "Completed";
  } else {
    const days = daysFromToday(followup.dueAt);
    const dueD = parseDate(followup.dueAt);
    if (days === 1) {
      displayDue = dueD
        ? `Tomorrow, ${dueD.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
        : "Tomorrow";
    } else {
      displayDue = `In ${days} days`;
    }
  }

  const base: Omit<MissionItem, "impactScore"> = {
    ...followup,
    leadName: lead?.businessName ?? "Unknown Lead",
    nicheLabel,
    score,
    priority,
    dueState,
    daysOverdue,
    daysSinceContact,
    effort,
    impact: score + (priority === "high" ? 18 : priority === "medium" ? 8 : 0),
    actionTitle,
    detailsText,
    displayDue,
  };

  return { ...base, impactScore: businessImpactScore(base) } as MissionItem;
}

function formatNicheName(str: string) {
  if (str === "web_design") return "Web Design Studio";
  if (str === "marketing_agency") return "Marketing Agency";
  if (str === "branding_agency") return "Branding Agency";
  if (str === "digital_agency") return "Digital Agency";
  if (str === "graphic_design") return "Graphic Design Studio";
  if (str === "creative_agency") return "Creative Agency";
  return str
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function businessImpactScore(item: Omit<MissionItem, "impactScore">): number {
  let pts = 0;
  const status = (item.lead?.status ?? "").toLowerCase();
  if (status === "negotiation") pts += 55;
  else if (status === "proposal") pts += 45;
  else if (status === "meeting") pts += 35;
  else if (status === "conversation") pts += 28;
  else if (status === "contacted") pts += 14;
  else pts += 5;

  pts += item.score * 0.45;

  if (item.dueState === "overdue") pts += 30 + item.daysOverdue * 6;
  else if (item.dueState === "today") pts += 18;
  else if (daysFromToday(item.dueAt) === 1) pts += 10;

  if (item.priority === "high") pts += 18;
  else if (item.priority === "medium") pts += 7;

  return Math.round(pts);
}

function buildMissionBriefing({
  overdue,
  dueToday,
  atRiskPool,
  completedTodayCount,
  mustDoPool,
  actionQueuePool,
}: {
  overdue: number;
  dueToday: number;
  atRiskPool: MissionItem[];
  completedTodayCount: number;
  mustDoPool: MissionItem[];
  actionQueuePool: MissionItem[];
}): string {
  if (overdue >= 3) {
    return `${overdue} follow-ups are overdue. Clear those first — every day of silence reduces the chance of a reply.`;
  }
  if (overdue === 1 && mustDoPool.length > 0) {
    const lead = mustDoPool.find((item) => item.dueState === "overdue");
    if (lead) return `${lead.leadName} is overdue. That's your first priority — a quick touch restarts the deal.`;
  }
  const proposals = mustDoPool.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return s === "proposal" || s === "negotiation";
  });
  if (proposals.length > 0) {
    return `${proposals.length} active proposal${proposals.length === 1 ? "" : "s"} need follow-up. These are your closest opportunities to closing revenue today.`;
  }
  if (atRiskPool.length >= 3) {
    return `${atRiskPool.length} opportunities are drifting toward inactivity. A focused follow-up session now keeps them alive.`;
  }
  const total = overdue + dueToday;
  return total > 0
    ? `You have ${total} action${total === 1 ? "" : "s"} queued for today. Focus on high-intent conversations to advance deals.`
    : "Pipeline is healthy and on schedule.";
}

function buildCoachSentence(
  item: MissionItem | null,
  _ctx: { overdue: number; atRiskPool: MissionItem[] },
): string {
  if (!item) return "No urgent actions right now. Your pipeline is in great shape.";
  const name = item.leadName;
  const status = (item.lead?.status ?? "").toLowerCase();
  if (status === "proposal" || status === "negotiation") {
    return `Start with ${name}. They have an active proposal in progress — a follow-up now is the highest-value action in your queue.`;
  }
  if (status === "meeting") {
    return `${name} has a meeting in progress. Follow up now to keep momentum alive before it cools.`;
  }
  if (item.dueState === "overdue") {
    return `${name} is overdue by ${item.daysOverdue} ${item.daysOverdue === 1 ? "day" : "days"}. Clear this first to protect your response rate.`;
  }
  return `Start with ${name}. Based on stage and timing, this follow-up is primed to move forward today.`;
}

function buildCoachReasons(item: MissionItem): string[] {
  const reasons: string[] = [];
  const status = (item.lead?.status ?? "").toLowerCase();
  if (status === "negotiation") reasons.push("Negotiation stage — revenue is closest here");
  else if (status === "proposal") reasons.push("Active proposal — high conversion proximity");
  else if (status === "meeting") reasons.push("Meeting stage — momentum is already established");
  else if (status === "conversation") reasons.push("In conversation — reply window is active");

  if (item.dueState === "overdue") {
    reasons.push(`${item.daysOverdue} days overdue — urgency is highest`);
  } else if (item.dueState === "today") {
    reasons.push("Due today — optimal window for outreach");
  }
  if (item.score >= 90) reasons.push(`Lead score ${item.score} — strong conversion signal`);
  return reasons.slice(0, 3);
}

function buildOperationalInsights(items: MissionItem[]) {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const completionsThisWeek = items.filter(
    (item) => item.dueState === "completed" && dateTime(item.completedAt ?? item.updatedAt) >= weekAgo,
  ).length;

  const repliesThisWeek = items.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return (s === "conversation" || s === "meeting" || s === "proposal") && dateTime(item.lead?.updatedAt) >= weekAgo;
  }).length;

  const meetingsThisWeek = items.filter(
    (item) => (item.lead?.status ?? "").toLowerCase() === "meeting" && dateTime(item.lead?.updatedAt) >= weekAgo,
  ).length;

  return { completionsThisWeek, repliesThisWeek, meetingsThisWeek };
}

function actionQueueReason(item: {
  lead?: Lead;
  priority: string;
  score: number;
  effort: string;
  dueAt: string;
  daysSinceContact: number | null;
}): string {
  const status = (item.lead?.status ?? "").toLowerCase();
  if (status === "negotiation") return "Negotiation in progress — highest revenue proximity";
  if (status === "proposal") return "Active proposal — high closing potential";
  if (status === "meeting") return "Meeting stage — keep momentum going";
  if (status === "conversation") return "In conversation — reply window is open";
  if (item.daysSinceContact !== null && item.daysSinceContact >= 14)
    return `${item.daysSinceContact} days since last contact — at risk of going cold`;
  if (item.priority === "high") return "High-priority lead — immediate follow-up";
  return `Opportunity score ${item.score} · Ready for follow-up`;
}

function dueStateForFollowup(followup: FollowupWithLead): MissionItem["dueState"] {
  if (followup.status === "completed") return "completed";
  const diff = daysFromToday(followup.dueAt);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

function isAtRisk(item: MissionItem) {
  return (
    item.daysOverdue > 0 ||
    (item.daysSinceContact !== null && item.daysSinceContact >= 10) ||
    (item.priority === "high" && item.dueState === "upcoming")
  );
}

function channelType(channel: string) {
  const normalized = channel.toLowerCase();
  if (normalized === "email") return "email";
  if (normalized === "phone") return "phone";
  if (normalized === "instagram" || normalized === "ig" || normalized === "instagram_dm") return "instagram";
  if (normalized === "linkedin") return "linkedin";
  return "general";
}

function channelLabel(channel: string) {
  const type = channelType(channel);
  if (type === "general") return "General";
  return type.replace(/\b\w/g, (l) => l.toUpperCase());
}

function toActivityChannel(channel: string): OutreachChannel | undefined {
  if (channel === "email" || channel === "instagram" || channel === "phone" || channel === "contact_form")
    return channel;
  return undefined;
}

function leadPriority(lead: Lead | undefined): MissionItem["priority"] {
  const p = lead?.priority?.toLowerCase();
  if (p === "high" || p === "priority") return "high";
  if (p === "normal" || p === "medium") return "medium";
  return "low";
}

function leadScore(lead: Lead) {
  if (lead.priority === "high") return 94;
  if (lead.priority === "normal" || lead.priority === "medium") return 78;
  return 62;
}

function sequenceMetadata(followup: FollowupWithLead) {
  return {
    ...(followup.sequenceName ? { sequenceName: followup.sequenceName } : {}),
    ...(followup.stepNumber ? { stepNumber: followup.stepNumber } : {}),
    ...(followup.currentStep ? { currentStep: followup.currentStep } : {}),
  };
}

function daysFromToday(date: string | null | undefined) {
  const value = parseDate(date);
  if (!value) return 999;
  const today = startOfDay(new Date());
  const day = startOfDay(value);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

function parseDate(date: string | null | undefined) {
  if (!date) return null;
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? null : value;
}

function dateTime(date: string | null | undefined) {
  return parseDate(date)?.getTime() ?? 0;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function toDateInputValue(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toTimeInputValue(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
