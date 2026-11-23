import { useState, useRef, useEffect, useMemo } from "react";
import {
  Mail,
  Phone,
  Globe,
  Instagram,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Star,
  Lightbulb,
  Target,
  Clock,
  FileText,
  Sparkles,
  ShieldCheck,
  Zap,
  AlertTriangle,
  Link as LinkIcon,
  Calendar,
  Compass,
  Activity,
  RefreshCw,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { leadNicheLabel, stripActivityMarkers } from "@/lib/lead-workspace";
import {
  useOpportunityExplanation,
  useOpportunityInsight,
  useLeadTrust,
  useUpdateLead,
  useLeadFollowups,
  useLeadBusinessActivity,
  useCheckLeadInstagramActivity,
} from "@/hooks/use-mast-api";
import { computeBusinessActivity } from "@/lib/businessActivity";
import {
  checkDesktopIgProfile,
  getDesktopIgWatcherStatus,
  isDesktopApp,
  openDesktopIgWatcher,
} from "@/lib/desktop";
import {
  canAutoCheckIgHandle,
  IG_AUTO_CHECK_DWELL_MS,
  isRateLimitNote,
  recordIgCheckAttempt,
} from "@/lib/igActivitySafety";
import { openExternalPopup } from "@/lib/externalPopup";
import { normalizeInstagram } from "@/lib/instagram";
import {
  getFieldTrustEntry,
  resolveDisqualificationDisplay,
  resolveScoreDisplay,
  resolveContactVerificationBadge,
} from "@/lib/trustPanel";
import { nicheImage } from "@/components/mast/discover/nicheImages";
import { getBusinessLogoUrl } from "@/lib/businessLogo";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { ActivityTimeline } from "./components/ActivityTimeline";
import { NoteForm } from "./components/NoteForm";
import { FollowUpsTab } from "./FollowUpsTab";

export type NormalizedReason = {
  id: string;
  label: string;
  detail: string;
  weight: number;
  value: number;
  impact: number;
};

function inferReasonLabel(detail: string, index: number): string {
  const lower = detail.toLowerCase();
  if (lower.includes("website") || lower.includes("ssl") || lower.includes("domain") || lower.includes("load")) {
    return "Website Opportunity";
  }
  if (lower.includes("seo") || lower.includes("brand") || lower.includes("photo") || lower.includes("identity")) {
    return "Branding & SEO";
  }
  if (lower.includes("social") || lower.includes("instagram") || lower.includes("facebook") || lower.includes("post")) {
    return "Social Presence";
  }
  if (lower.includes("growth") || lower.includes("hiring") || lower.includes("location") || lower.includes("budget")) {
    return "Growth Signals";
  }
  if (lower.includes("review") || lower.includes("rating") || lower.includes("reputation")) {
    return "Market Reputation";
  }
  if (lower.includes("tool") || lower.includes("booking") || lower.includes("chat") || lower.includes("analytic")) {
    return "Tooling & Automation";
  }
  return `Opportunity Factor #${index + 1}`;
}

export function normalizeReason(raw: unknown, index: number): NormalizedReason {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0 && colonIdx < 35) {
      const label = trimmed.slice(0, colonIdx).trim();
      const detail = trimmed.slice(colonIdx + 1).trim();
      return {
        id: `reason-${index}`,
        label: label || inferReasonLabel(detail, index),
        detail: detail || label,
        weight: 1,
        value: 1,
        impact: 100 - index,
      };
    }
    return {
      id: `reason-${index}`,
      label: inferReasonLabel(trimmed, index),
      detail: trimmed,
      weight: 1,
      value: 1,
      impact: 100 - index,
    };
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rawDetail =
      typeof obj.detail === "string" && obj.detail.trim()
        ? obj.detail.trim()
        : typeof obj.summary === "string" && obj.summary.trim()
          ? obj.summary.trim()
          : typeof obj.label === "string" && obj.label.trim()
            ? obj.label.trim()
            : "";

    const rawLabel =
      typeof obj.label === "string" && obj.label.trim()
        ? obj.label.trim()
        : typeof obj.component === "string" && obj.component.trim()
          ? obj.component.trim().charAt(0).toUpperCase() + obj.component.trim().slice(1)
          : inferReasonLabel(rawDetail, index);

    const weight = typeof obj.weight === "number" && Number.isFinite(obj.weight) ? obj.weight : 1;
    const value = typeof obj.value === "number" && Number.isFinite(obj.value) ? obj.value : 1;
    const impact = weight * value > 1 ? weight * value : 100 - index;

    return {
      id: typeof obj.component === "string" && obj.component ? obj.component : `reason-${index}`,
      label: rawLabel,
      detail: rawDetail || rawLabel,
      weight,
      value,
      impact,
    };
  }

  return {
    id: `reason-${index}`,
    label: `Opportunity Factor #${index + 1}`,
    detail: String(raw ?? ""),
    weight: 0,
    value: 0,
    impact: 0,
  };
}

function BusinessProfileAvatar({ lead }: { lead: Lead }) {
  const logoUrl = useMemo(() => getBusinessLogoUrl(lead.website, 256), [lead.website]);
  const fallbackStockImage = useMemo(() => nicheImage(lead.niche || ""), [lead.niche]);
  const [stage, setStage] = useState<"logo" | "stock" | "initials">(logoUrl ? "logo" : "stock");

  useEffect(() => {
    setStage(logoUrl ? "logo" : "stock");
  }, [lead.id, logoUrl]);

  if (stage === "initials" || (!logoUrl && !fallbackStockImage)) {
    return (
      <div className="size-14 rounded-xl grid place-items-center text-sm font-bold text-brand bg-brand/10 shrink-0">
        {lead.businessName.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  if (stage === "logo" && logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={lead.businessName}
        className="size-14 rounded-xl object-contain shrink-0"
        onError={() => {
          if (fallbackStockImage) setStage("stock");
          else setStage("initials");
        }}
      />
    );
  }

  return (
    <img
      src={fallbackStockImage}
      alt={lead.businessName}
      className="size-14 rounded-xl object-cover shrink-0"
      onError={() => setStage("initials")}
    />
  );
}

export function LeftSidebar({
  lead,
  channel,
  setChannel,
}: {
  lead: Lead;
  channel: Channel;
  setChannel: (channel: Channel) => void;
}) {
  const updateLeadMutation = useUpdateLead();
  const [copied, setCopied] = useState<string | null>(null);
  const [contactMethodsOpen, setContactMethodsOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    businessActivity: true,
    insights: false,
    why: false,
    followups: false,
    activity: false,
    notes: false,
  });

  // Scroll container and section references for auto-scroll on expand
  const sidebarRef = useRef<HTMLElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [pendingScrollSection, setPendingScrollSection] = useState<string | null>(null);

  // Reset expansion states / scroll queues when lead changes
  useEffect(() => {
    setPendingScrollSection(null);
  }, [lead.id]);

  // Auto-scroll newly expanded section into view if it extends below the visible container
  useEffect(() => {
    if (!pendingScrollSection) return;

    const timer = requestAnimationFrame(() => {
      const container = sidebarRef.current;
      const target = sectionRefs.current[pendingScrollSection];
      if (!container || !target) {
        setPendingScrollSection(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const padding = 16;

      const isBelow = targetRect.bottom > containerRect.bottom;
      const isAbove = targetRect.top < containerRect.top;

      if (isBelow) {
        if (targetRect.height > containerRect.height - padding * 2) {
          // If section is taller than container, align top of section to top of container
          const delta = targetRect.top - containerRect.top - padding;
          scrollContainer(container, delta);
        } else {
          // Scroll down just enough to bring the bottom into view
          const delta = targetRect.bottom - containerRect.bottom + padding;
          scrollContainer(container, delta);
        }
      } else if (isAbove) {
        const delta = targetRect.top - containerRect.top - padding;
        scrollContainer(container, delta);
      }

      setPendingScrollSection(null);
    });

    return () => cancelAnimationFrame(timer);
  }, [pendingScrollSection, openSections, contactMethodsOpen]);

  function scrollContainer(container: HTMLElement, delta: number) {
    if (Math.abs(delta) < 2) return;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollBy({
      top: delta,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = !prev[key];
      if (next) {
        setPendingScrollSection(key);
      }
      return { ...prev, [key]: next };
    });
  };

  const toggleContactMethods = () => {
    setContactMethodsOpen((prev) => {
      const next = !prev;
      if (next) {
        setPendingScrollSection("contactMethods");
      }
      return next;
    });
  };

  const handleCopy = async (text: string | null | undefined, label: string) => {
    if (!text || !text.trim()) return;
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopied(label);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  };

  // Opportunity Score
  const scoreInfo = resolveScoreDisplay(lead.opportunityScore);

  const { data: followups = [] } = useLeadFollowups(lead.id);
  const activeFollowupCount = Array.isArray(followups)
    ? followups.filter((f) => f.status !== "completed" && f.status !== "cancelled").length
    : 0;
  const nicheLabel = leadNicheLabel(lead.niche);
  const ig = normalizeInstagram(lead.instagramHandle);

  // Real Opportunity Explanation read
  const { data: explanation } = useOpportunityExplanation(lead.id, Boolean(lead.businessId));

  // Trust / Business Health read
  const { data: trust } = useLeadTrust(lead.id, Boolean(lead.businessId));
  const disqualification = resolveDisqualificationDisplay(trust);

  // AI Opportunity Insight read
  const { data: insight } = useOpportunityInsight(lead.businessId);

  // Business Activity & Instagram Activity read + live check mutation
  const { data: activityPayload } = useLeadBusinessActivity(lead.id);
  const checkIgActivity = useCheckLeadInstagramActivity(lead.id);
  const [desktopIgChecking, setDesktopIgChecking] = useState(false);
  const [desktopIgNeedsLogin, setDesktopIgNeedsLogin] = useState(false);
  const [desktopIgNote, setDesktopIgNote] = useState<string | null>(null);

  useEffect(() => {
    setDesktopIgNeedsLogin(false);
    setDesktopIgNote(null);
  }, [lead.id]);

  const businessActivity = useMemo(() => {
    if (activityPayload?.activity) return activityPayload.activity;
    return computeBusinessActivity({
      email: lead.email,
      phone: lead.phone,
      website: lead.website,
      instagramHandle: lead.instagramHandle,
      igFollowers: lead.igFollowers,
      igLastPost: lead.igLastPost,
    });
  }, [
    activityPayload?.activity,
    lead.email,
    lead.phone,
    lead.website,
    lead.instagramHandle,
    lead.igFollowers,
    lead.igLastPost,
  ]);

  const isCheckingIg = desktopIgChecking || checkIgActivity.isPending;
  const inDesktopApp = isDesktopApp();

  const runDesktopIgProfileCheck = async (handle: string, isAuto: boolean) => {
    setDesktopIgChecking(true);
    try {
      const desktopRes = await checkDesktopIgProfile(handle);
      if (!desktopRes) return;

      if (desktopRes.needsLogin) {
        setDesktopIgNeedsLogin(true);
        setDesktopIgNote(
          desktopRes.note || "Connect Instagram once to auto-check posts & live stories.",
        );
        return;
      }

      const rateLimited = isRateLimitNote(desktopRes.note);
      recordIgCheckAttempt(handle, { ok: desktopRes.ok, rateLimited });

      if (desktopRes.ok) {
        setDesktopIgNote(null);
        await checkIgActivity.mutateAsync({ liveIg: desktopRes });
        return;
      }

      if (rateLimited) {
        setDesktopIgNote("Paused auto-checks for 1 hour to keep your IG account safe.");
      } else if (!isAuto && desktopRes.note) {
        setDesktopIgNote(desktopRes.note);
      }
    } catch {
      if (!isAuto) {
        setDesktopIgNote("Could not check Instagram right now — try again.");
      }
    } finally {
      setDesktopIgChecking(false);
    }
  };

  // Safe automatic Instagram check on Mast Desktop:
  // Waits 2.2s after opening a lead (cancelled if you flip past quickly),
  // skips if checked within 24h, enforces an 8s cooldown & 20/hr safety cap,
  // and only runs if the user's IG session is already connected.
  useEffect(() => {
    const handle = businessActivity.instagram.handle;
    if (!inDesktopApp || !handle) return;
    if (businessActivity.instagram.source === "live") return;

    const decision = canAutoCheckIgHandle(handle);
    if (!decision.allowed) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        const watcher = await getDesktopIgWatcherStatus();
        if (cancelled) return;
        if (!watcher?.connected) {
          setDesktopIgNeedsLogin(true);
          setDesktopIgNote("Connect Instagram once to auto-check posts & live stories.");
          return;
        }
        await runDesktopIgProfileCheck(handle, true);
      })();
    }, IG_AUTO_CHECK_DWELL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lead.id, inDesktopApp, businessActivity.instagram.handle, businessActivity.instagram.source]);

  const handleCheckInstagramActivity = async () => {
    if (isCheckingIg) return;
    setDesktopIgNote(null);
    setDesktopIgNeedsLogin(false);

    const handle = businessActivity.instagram.handle;
    if (!handle) return;

    if (!inDesktopApp) {
      setDesktopIgNote("Live Instagram post & story checks require the MAST Desktop app.");
      return;
    }

    const decision = canAutoCheckIgHandle(handle);
    if (!decision.allowed && decision.reason === "backoff") {
      setDesktopIgNote("Paused briefly to keep your Instagram account safe — try again later.");
      return;
    }
    if (!decision.allowed && decision.reason === "cooldown") {
      setDesktopIgNote("Pacing checks (8s cooldown) to keep your Instagram account safe.");
      return;
    }

    await runDesktopIgProfileCheck(handle, false);
  };

  const handleConnectInstagramDesktop = async () => {
    try {
      await openDesktopIgWatcher(true);
      setDesktopIgNeedsLogin(false);
      setDesktopIgNote("Sign in to Instagram in the popup — MAST will auto-check leads after.");
    } catch {
      setDesktopIgNote("Could not open Instagram login window.");
    }
  };

  // Extract AI Overview and Suggested Action if present in notes
  let aiOverview = "";
  let suggestedAction = "";
  if (lead.notes) {
    const rawNotes = stripActivityMarkers(lead.notes);
    const overviewMatch = rawNotes.match(/AI Overview:\s*([\s\S]*?)(?=\n\nSuggested First Action:|$)/i);
    const actionMatch = rawNotes.match(/Suggested First Action:\s*([\s\S]*?)$/i);
    if (overviewMatch) aiOverview = overviewMatch[1].trim();
    if (actionMatch) suggestedAction = actionMatch[1].trim();
  }

  // Derive bio / description
  const cleanDomain = lead.website ? lead.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";
  const displayDescription =
    lead.igBio ||
    lead.brandingNotes ||
    (explanation?.summary ? explanation.summary : null) ||
    (lead.websiteNotes || null) ||
    `Local ${nicheLabel || "business"} in ${lead.location || "your market"} with verified outreach opportunities.`;

  const contactFormUrl = cleanDomain ? `${cleanDomain}/contact` : lead.website || "Website contact";

  // Contact items configuration with dedicated 2-row layout specs
  const contactItems = [
    {
      key: "email" as const,
      label: "Email",
      rawValue: lead.email?.trim() || null,
      displayValue: lead.email || "No email available",
      hasValue: Boolean(lead.email?.trim()),
      copyMenuText: "Copy email address",
      icon: Mail,
      iconClass: "bg-blue-500/15 border-blue-500/25 text-blue-400",
      channelKey: "email" as Channel,
      badge: resolveContactVerificationBadge(
        lead.email,
        getFieldTrustEntry(trust?.fieldTrust, "email"),
      ),
    },
    {
      key: "instagram" as const,
      label: "Instagram",
      rawValue: ig?.handle ? `@${ig.handle}` : lead.instagramHandle ? `@${lead.instagramHandle}` : null,
      displayValue: ig?.handle ? `@${ig.handle}` : lead.instagramHandle ? `@${lead.instagramHandle}` : "Not connected",
      hasValue: Boolean(ig?.handle || lead.instagramHandle?.trim()),
      copyMenuText: "Copy Instagram handle",
      icon: Instagram,
      iconClass: "bg-pink-500/15 border-pink-500/25 text-pink-400",
      channelKey: "instagram" as Channel,
      badge: resolveContactVerificationBadge(
        lead.instagramHandle,
        getFieldTrustEntry(trust?.fieldTrust, "instagram"),
      ),
    },
    {
      key: "phone" as const,
      label: "Phone",
      rawValue: lead.phone?.trim() || null,
      displayValue: lead.phone || "Not connected",
      hasValue: Boolean(lead.phone?.trim()),
      copyMenuText: "Copy phone number",
      icon: Phone,
      iconClass: "bg-emerald-500/15 border-emerald-500/25 text-emerald-400",
      channelKey: "phone" as Channel,
      badge: resolveContactVerificationBadge(
        lead.phone,
        getFieldTrustEntry(trust?.fieldTrust, "phone"),
      ),
    },
    {
      key: "contact_form" as const,
      label: "Contact Form",
      rawValue: lead.website?.trim() || null,
      displayValue: contactFormUrl,
      hasValue: Boolean(lead.website?.trim()),
      copyMenuText: "Copy website",
      icon: LinkIcon,
      iconClass: "bg-sky-500/15 border-sky-500/25 text-sky-400",
      channelKey: "contact_form" as Channel,
      badge: resolveContactVerificationBadge(
        lead.website,
        getFieldTrustEntry(trust?.fieldTrust, "website"),
      ),
    },
  ];

  // Business Insights data availability check
  const hasBusinessInsights = Boolean(
    insight?.headline ||
      (Array.isArray(insight?.talking_points) && insight.talking_points.length > 0) ||
      insight?.opening_line ||
      aiOverview ||
      suggestedAction ||
      lead.websiteNotes ||
      lead.brandingNotes ||
      explanation?.summary ||
      (trust?.businessHealth && typeof trust.businessHealth.score === "number"),
  );

  // Ranked reasons for "Why This Opportunity" — type safe for both string[] and ExplanationReason[]
  const sortedReasons = useMemo(() => {
    if (!explanation?.reasons || !Array.isArray(explanation.reasons) || explanation.reasons.length === 0) {
      return [];
    }
    const normalized = explanation.reasons.map((r, i) => normalizeReason(r, i));
    return normalized.sort((a, b) => b.impact - a.impact);
  }, [explanation?.reasons]);

  const strongestReason = sortedReasons[0];
  const supportingReasons = sortedReasons.slice(1);

  return (
    <aside
      ref={sidebarRef}
      className="w-full shrink-0 border-b border-border bg-[#0d121d]/80 lg:w-[320px] lg:border-b-0 lg:border-r overflow-y-auto flex flex-col p-4 space-y-4"
    >
      {/* ─── 1. LEAD PROFILE CARD ─── */}
      <div className="rounded-2xl border border-border/80 bg-card/40 p-4 space-y-3.5 shadow-xs">
        <div className="flex items-start gap-3">
          {/* Business Logo / Profile Avatar */}
          <BusinessProfileAvatar lead={lead} />

          {/* Business Name, Category, Location, Star */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <h2 className="font-semibold text-sm text-foreground truncate" title={lead.businessName}>
                {lead.businessName}
              </h2>
              <div className="flex items-center shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    const next = lead.priority === "high" ? "normal" : "high";
                    await updateLeadMutation.mutateAsync({ id: lead.id, body: { priority: next } });
                    toast.success(next === "high" ? "Marked as favorite" : "Removed from favorites");
                  }}
                  className="p-1 text-muted-foreground hover:text-amber-400 transition-colors"
                  title="Favorite"
                  aria-label="Toggle favorite"
                >
                  <Star className={`size-3.5 ${lead.priority === "high" ? "text-amber-400 fill-amber-400" : ""}`} />
                </button>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
              {nicheLabel || "Business"} • {lead.location || "Local"} 🇺🇸
            </p>
          </div>
        </div>

        {/* Bio / Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 font-normal">
          {displayDescription}
        </p>

        {/* Opportunity Score Badges */}
        <div className="flex items-center gap-2 pt-0.5">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold ${
              scoreInfo.isScored
                ? "bg-emerald-500/10 border border-emerald-500/25 text-emerald-400"
                : "bg-muted/30 border border-border/60 text-muted-foreground"
            }`}
          >
            {scoreInfo.level}
          </span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-card/80 border border-border/80 text-foreground">
            Score{" "}
            <span
              className={`ml-1 font-mono font-bold ${
                scoreInfo.isScored ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {scoreInfo.label}
            </span>
          </span>
        </div>
      </div>

      {/* ─── 2. CONTACT METHODS SECTION ─── */}
      <div
        ref={(el) => {
          sectionRefs.current.contactMethods = el;
        }}
        className="rounded-2xl border border-border/80 bg-card/40 p-4 space-y-3 shadow-xs"
      >
        <button
          type="button"
          onClick={toggleContactMethods}
          className="flex w-full items-center justify-between text-left text-xs font-semibold text-foreground hover:text-white transition-colors"
        >
          <span>Contact Methods</span>
          {contactMethodsOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {contactMethodsOpen && (
          <div className="space-y-2 pt-1">
            {contactItems.map((item) => {
              const Icon = item.icon;
              const badgeClass =
                item.badge.status === "verified"
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : item.badge.status === "available"
                    ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                    : "bg-muted/40 text-muted-foreground border border-border/40";

              return (
                <ContextMenu key={item.key}>
                  <ContextMenuTrigger asChild disabled={!item.hasValue}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setChannel(item.channelKey)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setChannel(item.channelKey);
                        }
                      }}
                      className={`group rounded-xl border p-3 cursor-pointer transition-all ${
                        channel === item.channelKey
                          ? "border-[#4f46e5]/50 bg-[#4f46e5]/10 shadow-sm"
                          : "border-border/60 bg-[#0d121d]/40 hover:border-border hover:bg-card/60"
                      }`}
                    >
                      {/* Row 1: Contact Icon, Contact Label, Availability Status, Copy Button, Chevron */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`size-7 rounded-lg ${item.iconClass} border grid place-items-center shrink-0`}
                          >
                            <Icon className="size-3.5" />
                          </div>
                          <span className="text-xs font-semibold text-foreground truncate">
                            {item.label}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${badgeClass}`}>
                            {item.badge.label}
                          </span>

                          {item.hasValue && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleCopy(item.rawValue, item.label);
                              }}
                              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                              title={item.copyMenuText}
                              aria-label={item.copyMenuText}
                            >
                              {copied === item.label ? (
                                <Check className="size-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="size-3.5" />
                              )}
                            </button>
                          )}

                          <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
                        </div>
                      </div>

                      {/* Row 2: Complete Contact Value with full horizontal width */}
                      <div className="mt-2 pt-2 border-t border-border/30">
                        <p
                          title={item.hasValue ? item.displayValue : undefined}
                          className={`text-xs select-all ${
                            item.hasValue
                              ? "text-foreground font-medium"
                              : "text-muted-foreground/60 italic"
                          } ${
                            item.key === "phone"
                              ? "whitespace-nowrap overflow-x-auto scrollbar-none"
                              : "break-words"
                          }`}
                          style={
                            item.key === "email" || item.key === "contact_form"
                              ? { wordBreak: "break-word", overflowWrap: "anywhere" }
                              : undefined
                          }
                        >
                          {item.displayValue}
                        </p>
                      </div>
                    </div>
                  </ContextMenuTrigger>

                  {item.hasValue && (
                    <ContextMenuContent className="w-52 bg-[#101726] border border-border text-foreground shadow-xl">
                      <ContextMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCopy(item.rawValue, item.label);
                        }}
                        className="text-xs cursor-pointer focus:bg-brand/20 focus:text-foreground flex items-center gap-2"
                      >
                        <Copy className="size-3.5 text-muted-foreground" />
                        <span>{item.copyMenuText}</span>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  )}
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 3. SECONDARY ACCORDIONS ─── */}
      <div className="space-y-2">
        {/* Accordion 0: Business Activity & Best Outreach Channel */}
        <div
          ref={(el) => {
            sectionRefs.current.businessActivity = el;
          }}
          data-testid="business-activity-card"
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("businessActivity")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Activity className="size-4 text-emerald-400 shrink-0" />
              <span className="truncate">Business Activity</span>
              {businessActivity.mostActiveOn && (
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-brand/15 text-brand border border-brand/25 shrink-0">
                  {businessActivity.mostActiveLabel}
                </span>
              )}
            </div>
            {openSections.businessActivity ? (
              <ChevronUp className="size-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground shrink-0" />
            )}
          </button>

          {openSections.businessActivity && (
            <div className="p-3.5 pt-2.5 border-t border-border/40 space-y-2.5 text-xs">
              {/* Most Active On / Best Channel Recommendation */}
              <div className="rounded-xl border border-brand/25 bg-brand/5 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-brand block">
                      Most Active On
                    </span>
                    <p className="text-xs font-semibold text-foreground mt-0.5 truncate">
                      {businessActivity.mostActiveLabel}
                    </p>
                  </div>
                  {businessActivity.mostActiveOn && (
                    <button
                      type="button"
                      onClick={() => setChannel(businessActivity.mostActiveOn as Channel)}
                      disabled={channel === businessActivity.mostActiveOn}
                      className={
                        channel === businessActivity.mostActiveOn
                          ? "px-2 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0 cursor-default"
                          : "px-2 py-1 rounded-md text-[10px] font-semibold bg-brand text-white hover:bg-brand/90 transition-colors shrink-0 cursor-pointer"
                      }
                    >
                      {channel === businessActivity.mostActiveOn ? "Selected" : "Use Channel"}
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {businessActivity.recommendationReason}
                </p>
              </div>

              {/* Instagram Activity Checker */}
              <div className="rounded-xl border border-border/60 bg-background/40 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Instagram className="size-3.5 text-pink-400 shrink-0" />
                    <span className="text-[11px] font-semibold text-foreground truncate">
                      Instagram Activity
                    </span>
                  </div>
                  <span
                    className={
                      businessActivity.instagram.status === "very_active" ||
                      businessActivity.instagram.status === "active"
                        ? "px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0"
                        : businessActivity.instagram.status === "slow"
                          ? "px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0"
                          : businessActivity.instagram.status === "inactive" ||
                              businessActivity.instagram.status === "private"
                            ? "px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 shrink-0"
                            : "px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-muted/60 text-muted-foreground border border-border shrink-0"
                    }
                  >
                    {businessActivity.instagram.statusLabel}
                  </span>
                </div>

                {businessActivity.instagram.handle ? (
                  <>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      <div className="rounded-lg border border-border/50 bg-card/40 px-2 py-1.5">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground block">
                          Last Post
                        </span>
                        <span className="text-foreground font-medium block truncate mt-0.5">
                          {businessActivity.instagram.lastPostLabel ?? "Not checked yet"}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border/50 bg-card/40 px-2 py-1.5">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground block">
                          Story
                        </span>
                        <span className="text-foreground font-medium flex items-center gap-1 truncate mt-0.5">
                          {businessActivity.instagram.hasActiveStory === true && (
                            <span className="size-1.5 rounded-full bg-pink-400 animate-pulse shrink-0" />
                          )}
                          <span className="truncate">{businessActivity.instagram.storyLabel}</span>
                        </span>
                      </div>
                    </div>

                    {(businessActivity.instagram.followersCount !== null ||
                      businessActivity.instagram.postsCount !== null) && (
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground px-0.5">
                        {businessActivity.instagram.followersCount !== null && (
                          <span>
                            <strong className="text-foreground font-semibold">
                              {businessActivity.instagram.followersCount.toLocaleString()}
                            </strong>{" "}
                            followers
                          </span>
                        )}
                        {businessActivity.instagram.postsCount !== null && (
                          <span>
                            <strong className="text-foreground font-semibold">
                              {businessActivity.instagram.postsCount.toLocaleString()}
                            </strong>{" "}
                            posts
                          </span>
                        )}
                      </div>
                    )}

                    {businessActivity.instagram.worthDming === false && (
                      <p className="text-[10px] text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5 leading-snug">
                        Low IG activity — save time and reach out on Email or Phone instead.
                      </p>
                    )}

                    {!inDesktopApp && (
                      <p className="text-[10px] text-muted-foreground leading-snug bg-card/40 border border-border/50 rounded-lg px-2 py-1.5">
                        Live Instagram post &amp; story checks require the <strong className="text-foreground">MAST Desktop app</strong>.
                      </p>
                    )}

                    {inDesktopApp && (desktopIgNote || businessActivity.instagram.liveCheckNote) && (
                      <p className="text-[10px] text-muted-foreground leading-snug">
                        {desktopIgNote || businessActivity.instagram.liveCheckNote}
                      </p>
                    )}

                    <div className="flex items-center gap-1.5 pt-0.5">
                      {inDesktopApp &&
                        (desktopIgNeedsLogin ? (
                          <button
                            type="button"
                            onClick={() => void handleConnectInstagramDesktop()}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 h-7 px-2 rounded-lg bg-brand hover:bg-brand/90 text-[11px] font-semibold text-white transition-colors cursor-pointer"
                          >
                            <Instagram className="size-3" />
                            <span>Connect IG</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleCheckInstagramActivity()}
                            disabled={isCheckingIg}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 h-7 px-2 rounded-lg border border-border/70 bg-card/60 hover:bg-card text-[11px] font-medium text-foreground transition-colors cursor-pointer disabled:opacity-60"
                          >
                            {isCheckingIg ? (
                              <>
                                <Loader2 className="size-3 animate-spin" />
                                <span>Checking...</span>
                              </>
                            ) : (
                              <>
                                <RefreshCw className="size-3" />
                                <span>Refresh IG</span>
                              </>
                            )}
                          </button>
                        ))}
                      {businessActivity.instagram.profileUrl && (
                        <button
                          type="button"
                          onClick={() => openExternalPopup(businessActivity.instagram.profileUrl!)}
                          className={`${inDesktopApp ? "" : "flex-1 "}inline-flex items-center justify-center gap-1 h-7 px-2.5 rounded-lg border border-border/70 bg-card/40 hover:bg-card text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer`}
                        >
                          <span>Open IG</span>
                          <ExternalLink className="size-3" />
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No Instagram profile on file for this business.
                  </p>
                )}
              </div>

              {/* Quick Channel Activity Breakdown */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block">
                  Channel Signals
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  {businessActivity.channels.map((ch) => (
                    <button
                      key={ch.channel}
                      type="button"
                      disabled={!ch.available}
                      onClick={() => setChannel(ch.channel as Channel)}
                      title={ch.summary}
                      className={`flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors ${
                        !ch.available
                          ? "border-border/40 bg-background/20 text-muted-foreground/50 cursor-not-allowed"
                          : ch.status === "best"
                            ? "border-brand/40 bg-brand/10 text-foreground hover:bg-brand/15 cursor-pointer"
                            : "border-border/60 bg-card/30 text-foreground hover:bg-card/60 cursor-pointer"
                      }`}
                    >
                      <span className="truncate font-medium">{ch.label}</span>
                      <span
                        className={`text-[9px] font-bold uppercase shrink-0 ${
                          ch.status === "best"
                            ? "text-brand"
                            : ch.status === "active"
                              ? "text-emerald-400"
                              : ch.status === "weak"
                                ? "text-rose-400"
                                : ch.status === "available"
                                  ? "text-muted-foreground"
                                  : "text-muted-foreground/40"
                        }`}
                      >
                        {ch.status === "best"
                          ? "Best"
                          : ch.status === "active"
                            ? "Active"
                            : ch.status === "weak"
                              ? "Slow"
                              : ch.status === "available"
                                ? "Ready"
                                : "None"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Accordion 1: Business Insights */}
        <div
          ref={(el) => {
            sectionRefs.current.insights = el;
          }}
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("insights")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-amber-400" />
              <span>Business Insights</span>
            </div>
            {openSections.insights ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.insights && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-3 text-xs">
              {!hasBusinessInsights ? (
                <div className="rounded-xl border border-border/50 bg-card/20 p-4 text-center space-y-1.5 my-1">
                  <Lightbulb className="size-5 mx-auto text-muted-foreground/50" />
                  <p className="text-xs font-semibold text-foreground">No business insights available yet</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Specific intelligence is populated when this lead undergoes automated discovery or web analysis.
                  </p>
                </div>
              ) : (
                <>
                  {/* Primary intelligence callout */}
                  {(insight?.headline || aiOverview || explanation?.summary) && (
                    <div className="rounded-xl border border-brand/25 bg-brand/5 p-3 space-y-1.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-brand">
                        <Sparkles className="size-3.5" />
                        <span>Primary Intelligence</span>
                      </div>
                      <p className="text-[11px] text-foreground leading-relaxed font-medium">
                        {insight?.headline || aiOverview || explanation?.summary}
                      </p>
                    </div>
                  )}

                  {/* Core Specialty */}
                  {(nicheLabel || lead.brandingNotes) && (
                    <div className="rounded-lg border border-border/60 bg-card/30 p-2.5 space-y-1">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        <Compass className="size-3 text-blue-400" />
                        <span>Core Specialty</span>
                      </div>
                      <p className="text-[11px] text-foreground leading-relaxed">
                        {nicheLabel || "Local business"}
                        {lead.location ? ` based in ${lead.location}` : ""}
                        {lead.brandingNotes ? ` — ${lead.brandingNotes}` : ""}
                      </p>
                    </div>
                  )}

                  {/* Online Presence & Website Observation */}
                  {(lead.websiteNotes || lead.website || lead.igBio) && (
                    <div className="rounded-lg border border-border/60 bg-card/30 p-2.5 space-y-1">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        <Globe className="size-3 text-cyan-400" />
                        <span>Digital Presence Observation</span>
                      </div>
                      <p className="text-[11px] text-foreground leading-relaxed">
                        {lead.websiteNotes ||
                          (lead.website
                            ? `Active domain registered at ${cleanDomain || lead.website}.`
                            : "No dedicated website detected on record — prime candidate for web presence development.")}
                      </p>
                    </div>
                  )}

                  {/* Personalization Hook / First Action */}
                  {(insight?.opening_line || suggestedAction) && (
                    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-1">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-500">
                        <Zap className="size-3.5" />
                        <span>Personalization Hook</span>
                      </div>
                      <p className="text-[11px] text-foreground leading-relaxed font-medium">
                        {insight?.opening_line || suggestedAction}
                      </p>
                    </div>
                  )}

                  {/* Talking points */}
                  {Array.isArray(insight?.talking_points) && insight.talking_points.length > 0 && (
                    <div className="space-y-1.5 pt-0.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Key Talking Points
                      </p>
                      <ul className="space-y-1 text-[11px] text-muted-foreground list-disc list-inside">
                        {insight.talking_points.slice(0, 3).map((pt, i) => (
                          <li key={i} className="text-foreground leading-snug">
                            {typeof pt === "string" ? pt : String(pt)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Health Score */}
                  {trust?.businessHealth && typeof trust.businessHealth.score === "number" && !Number.isNaN(trust.businessHealth.score) && (
                    <div className="rounded-lg border border-border/70 bg-background/50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <ShieldCheck className="size-3.5 text-brand" /> Business Health
                        </span>
                        <span className="font-mono font-bold text-foreground">
                          {Math.round(trust.businessHealth.score)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand rounded-full transition-all duration-300"
                          style={{ width: `${Math.round(trust.businessHealth.score)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Accordion 2: Why This Opportunity */}
        <div
          ref={(el) => {
            sectionRefs.current.why = el;
          }}
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("why")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Target className="size-4 text-rose-400" />
              <span>Why This Opportunity</span>
            </div>
            {openSections.why ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.why && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-3 text-xs">
              {/* Disqualification warning if disqualified */}
              {disqualification && (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 p-3">
                  <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
                  <div className="text-[11px] text-destructive space-y-0.5">
                    <p className="font-bold">{disqualification.label}</p>
                    <p className="text-foreground leading-relaxed">{disqualification.reason}</p>
                  </div>
                </div>
              )}

              {explanation ? (
                <div className="space-y-3">
                  {/* Profession Match Badge & Summary */}
                  <div className="space-y-1.5">
                    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-brand/10 text-brand border border-brand/20">
                      <Sparkles className="size-3" />
                      <span>
                        {explanation.professionMatch === "strong"
                          ? "Strong match for your freelance services"
                          : "Service match identified"}
                      </span>
                    </div>
                    {explanation.summary && (
                      <p className="text-[11px] text-foreground leading-relaxed font-normal">
                        {explanation.summary}
                      </p>
                    )}
                  </div>

                  {/* Strongest Reason Highlighted First */}
                  {strongestReason && (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
                          <Target className="size-3" /> Strongest Reason
                        </span>
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                          Primary Driver
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-foreground">{strongestReason.label}</p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {strongestReason.detail}
                      </p>
                    </div>
                  )}

                  {/* Supporting signals */}
                  {supportingReasons.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Supporting Signals
                      </p>
                      <ul className="space-y-2">
                        {supportingReasons.map((r) => (
                          <li
                            key={r.id}
                            className="rounded-lg border border-border/50 bg-card/25 p-2 space-y-0.5 text-[11px]"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-foreground">{r.label}</span>
                              {r.impact > 1 && (
                                <span className="text-[9px] font-mono text-muted-foreground">
                                  Score impact: {Math.round(r.impact)}
                                </span>
                              )}
                            </div>
                            <p className="text-muted-foreground leading-relaxed">{r.detail}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Verified evidence distinction */}
                  <div className="rounded-lg border border-border/60 bg-card/30 p-2.5 space-y-1 text-[11px]">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      <ShieldCheck className="size-3 text-emerald-400" />
                      <span>Verified Verification Signals</span>
                    </div>
                    <div className="space-y-1 pt-0.5 text-muted-foreground">
                      <p>
                        • Email:{" "}
                        <span className="text-foreground">
                          {lead.email ? "Direct email verified" : "No email available"}
                        </span>
                      </p>
                      <p>
                        • Phone:{" "}
                        <span className="text-foreground">
                          {lead.phone ? "Phone line on file" : "No phone available"}
                        </span>
                      </p>
                      <p>
                        • Web Domain:{" "}
                        <span className="text-foreground">
                          {lead.website ? "Custom domain discovered" : "No website detected"}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Recommended next step */}
                  <div className="rounded-lg border border-brand/20 bg-brand/5 p-2.5 space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-brand">
                      Recommended Next Step
                    </p>
                    <p className="text-[11px] text-foreground leading-relaxed">
                      {suggestedAction ||
                        (lead.email
                          ? `Send a tailored pitch focusing on ${strongestReason?.label ? strongestReason.label.toLowerCase() : "their online presence"}.`
                          : lead.phone
                            ? "Conduct a brief discovery phone call to explore their service needs."
                            : "Reach out via Instagram direct message to establish contact.")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/60 bg-card/25 p-4 text-center space-y-2.5">
                  <div className="size-9 rounded-xl bg-muted/30 border border-border/50 grid place-items-center mx-auto text-muted-foreground">
                    <Target className="size-4" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-foreground">Opportunity Not Yet Scored</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      This opportunity has not been evaluated by the Opportunity Engine yet. Detailed qualification signals and tailored reasons are generated when leads are processed through automated pipeline discovery.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Accordion 3: Follow-ups */}
        <div
          ref={(el) => {
            sectionRefs.current.followups = el;
          }}
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("followups")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Calendar className="size-4 text-brand" />
              <span>Follow-ups</span>
              {activeFollowupCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  {activeFollowupCount}
                </span>
              )}
            </div>
            {openSections.followups ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.followups && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2 text-xs">
              <FollowUpsTab lead={lead} />
            </div>
          )}
        </div>

        {/* Accordion 4: Recent Activity */}
        <div
          ref={(el) => {
            sectionRefs.current.activity = el;
          }}
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("activity")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-indigo-400" />
              <span>Recent Activity</span>
            </div>
            {openSections.activity ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.activity && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2 text-xs">
              <ActivityTimeline lead={lead} />
            </div>
          )}
        </div>

        {/* Accordion 5: Notes (Left alone as requested in Issue 6) */}
        <div
          ref={(el) => {
            sectionRefs.current.notes = el;
          }}
          className="rounded-xl border border-border/80 bg-card/40 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => toggleSection("notes")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-sky-400" />
              <span>Notes</span>
            </div>
            {openSections.notes ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.notes && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2 text-xs">
              <NoteForm lead={lead} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
