import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Zap,
  Sparkles,
  Mail,
  Phone,
  Link2,
  Instagram,
  X,
  Search,
  Check,
  Lock,
  ArrowRight,
  BarChart3,
  Globe,
  Gauge,
  Warehouse,
  Database,
  Building2,
  TrendingUp,
  Lightbulb,
  Eye,
  MapPin,
} from "lucide-react";
import { ApiError, subscribeToDiscoverJob, cancelDiscoverJob, type Lead } from "@/lib/api";

import { useAccount, useAnalytics, useGenerateLeads, useLeads, useSettings, queryKeys } from "@/hooks/use-mast-api";
import { useLiveDiscoveryState } from "@/hooks/use-live-discovery";
import { buildDiscoverRequest, summarizeDiscoverRequest, type DiscoverRequestPayload } from "@/lib/discoverRequest";
import { describeDiscoverOutcome, type DiscoverOutcome, type DiscoverRunStatus, type PoolRankingInfo } from "@/lib/discoverProgress";
import { channelPresence, type LeadChannelSource } from "@/lib/leadChannels";
import { LiveDiscoveryScreen } from "@/components/mast/LiveDiscoveryScreen";
import { useQueryClient } from "@tanstack/react-query";
import { buildDiscoverInsights, type DiscoverInsight } from "@/lib/discover-insights";
import { buildNextSearchSuggestions, type NextSearchSuggestions } from "@/lib/discover-suggestions";
import { usePermissions } from "@/hooks/use-permissions";
import { FeatureGate } from "@/components/mast/FeatureGate";
import { type FeatureId } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { DiscoverGlobe } from "@/components/mast/discover/DiscoverGlobe";
import { DiscoverAtmosphere } from "@/components/mast/discover/DiscoverAtmosphere";
import { NicheCarousel } from "@/components/mast/discover/NicheCarousel";
import { TargetRegionCard } from "@/components/mast/discover/TargetRegionCard";
import {
  AmountSlider,
  PlanCard,
  StepCard,
  SummaryCard,
  panelSurface,
  type SummaryRow,
} from "@/components/mast/discover/DiscoverPanels";
import { GLOBAL_SCOPE, isLocalGeoToken, parseGeoScope } from "@/lib/geo/scope";
import {
  DISCOVERY_METHODS,
  discoveryMethodForPlan,
  generationModeFor,
  isDiscoveryMethodEligible,
  nextDiscoveryMethod,
} from "@/lib/discoveryMethod";
import type { DiscoveryMode } from "@/config/plans";
import { addNotification } from "@/lib/notifications";
import {
  DEFAULT_CHANNELS,
  channelsForRequest,
  toggleChannelSelection,
} from "@/lib/channelSelection";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/leads")({
  head: () => ({ meta: [{ title: "Discover — Mast" }] }),
  component: GetLeadsWrapper,
});

/** Wrapper that renders the child workspace route or the main form */
function GetLeadsWrapper() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (/^\/dashboard\/leads\/\d+/.test(pathname)) {
    return <Outlet />;
  }
  return <GetLeads />;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** A scope token: a country name, a continent, or "Global" (see
 * src/lib/geo/scope.ts — the same parser the server uses). */
type Region = string;

/** Region selected before the user (or their saved settings) picks one. */
const DEFAULT_REGION: Region = "United States";

/** Full niche catalog — supports prefix search */
const NICHE_CATALOG = [
  "Accounting Firm",
  "Advertising Agency",
  "Architecture Studio",
  "Auto Dealership",
  "Auto Repair",
  "Bakery",
  "Beauty Salon",
  "Branding Studio",
  "Catering Company",
  "Chiropractic Clinic",
  "Coffee Shop",
  "Construction Company",
  "Consulting Firm",
  "Coworking Space",
  "Dental Clinic",
  "E-commerce",
  "Education Center",
  "Event Planning",
  "Financial Advisor",
  "Fitness Studio",
  "Florist",
  "Food Truck",
  "Freelance Designer",
  "Funeral Home",
  "Gym",
  "Hair Salon",
  "Health Clinic",
  "Home Improvement",
  "Hotel",
  "HR Consulting",
  "HVAC Company",
  "Insurance Agency",
  "Interior Design Studio",
  "IT Services",
  "Jewelry Store",
  "Landscaping",
  "Law Firm",
  "Local Services",
  "Logistics Company",
  "Manufacturing",
  "Marketing Agency",
  "Medical Clinic",
  "Mortgage Broker",
  "Moving Company",
  "Music School",
  "Non-profit",
  "Optometry Clinic",
  "Personal Trainer",
  "Pet Services",
  "Photography Studio",
  "Physical Therapy",
  "Plumbing",
  "Print Shop",
  "Property Management",
  "Psychotherapy Practice",
  "Public Relations",
  "Real Estate",
  "Recruitment Agency",
  "Repair Services",
  "Restaurant",
  "Retail",
  "Roofing",
  "SaaS Founders",
  "Security Company",
  "Software Agency",
  "Spa & Wellness",
  "Sports Club",
  "Tax Services",
  "Travel Agency",
  "Tutoring",
  "Veterinary Clinic",
  "Video Production",
  "Web Design Agency",
  "Wedding Planner",
  "Yoga Studio",
];

// Channel definitions — ordered: Email > Phone > Instagram > Website
const channelOptions = [
  {
    id: "email",
    short: "Email",
    label: "Verified Email",
    icon: Mail,
    costLabel: "Lowest cost",
    description: "Highest deliverability for first-touch outreach",
  },
  {
    id: "phone",
    short: "Phone",
    label: "Phone Number",
    icon: Phone,
    costLabel: "Low cost",
    description: "Direct line for faster conversations",
  },
  {
    id: "instagram",
    short: "Instagram",
    label: "Instagram",
    icon: Instagram,
    costLabel: "Med cost",
    description: "Social handle for visual-first brands",
  },
  {
    id: "website",
    short: "Website",
    label: "Website",
    icon: Link2,
    costLabel: "High cost",
    description: "Contact forms and site intelligence",
  },
] as const;

type ChannelId = (typeof channelOptions)[number]["id"];

// Quantity slider steps: 1 5 10 15 20 25 ... 100
const QUANTITY_STEPS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

/** Map a slider index to an actual quantity step value */
function sliderIndexToQty(index: number): number {
  const clamped = Math.max(0, Math.min(QUANTITY_STEPS.length - 1, index));
  return QUANTITY_STEPS[clamped];
}

function qtyToSliderIndex(qty: number): number {
  let closest = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < QUANTITY_STEPS.length; i++) {
    const diff = Math.abs(QUANTITY_STEPS[i] - qty);
    if (diff < closestDiff) { closestDiff = diff; closest = i; }
  }
  return closest;
}

// ─── Cost engine ──────────────────────────────────────────────────────────────

// ─── Main Component ────────────────────────────────────────────────────────────

function GetLeads() {
  const navigate = useNavigate();

  const { data: account } = useAccount();
  const { data: settings } = useSettings();
  const { data: analytics } = useAnalytics();
  const { data: leadsPayload } = useLeads({ limit: 1000 });
  const generate = useGenerateLeads();
  const { permissions } = usePermissions();
  const queryClient = useQueryClient();

  // Live-streaming plumbing for Phase 4: the unsubscribe fn for whatever
  // discover job is currently being watched, and a set of lead ids already
  // shown, so a realtime INSERT can never produce a visible duplicate.
  const unsubscribeJobRef = useRef<(() => void) | null>(null);
  const seenLeadIdsRef = useRef<Set<number>>(new Set());

  const maxQuantity = permissions.limits.dailyOpportunities;
  const maxSliderIndex = qtyToSliderIndex(maxQuantity);

  // Quantity state — stored as step index; clamped to plan max when account loads
  const [qtyIndex, setQtyIndex] = useState<number>(qtyToSliderIndex(10));
  const quantity = sliderIndexToQty(qtyIndex);

  // Multi-select regions
  const [regions, setRegions] = useState<Region[]>([DEFAULT_REGION]);

  const hasInitializedRef = useRef(false);

  // Set default regions from settings when they load
  useEffect(() => {
    if (settings?.defaultRegions && !hasInitializedRef.current) {
      // Saved defaults may be continents (Settings page) or countries; only
      // tokens the backend actually understands are applied.
      const stored: Region[] = parseGeoScope(settings.defaultRegions).tokens;
      if (stored.length > 0) {
        setRegions(stored);
        hasInitializedRef.current = true;
      }
    }
  }, [settings]);

  // Multi-select niches. The search box filters the carousel; the most
  // recently picked niche (last in the array) is the one brought into focus.
  const [niches, setNiches] = useState<string[]>([]);
  const [nicheSearch, setNicheSearch] = useState("");

  // Channels & generation mode
  // Lead-Yield Waste Fix: DEFAULT_CHANNELS is empty on purpose — see
  // src/lib/channelSelection.ts's module docstring. The audit found the
  // previous ["email","phone"] default silently pre-selected the most
  // expensive AND-combination (64.6% of discovered candidates were pruned
  // for missing one of those two channels); `canGenerate` below already
  // requires channels.length > 0, so starting empty simply means the user
  // must make an explicit choice before launching a session — no channel
  // requirement is ever silently assumed on their behalf.
  const [channels, setChannels] = useState<ChannelId[]>(DEFAULT_CHANNELS as ChannelId[]);

  // Loading & completion states
  const [isGenerating, setIsGenerating] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);
  const [newOpportunities, setNewOpportunities] = useState<Lead[]>([]);
  const [firstOpportunityId, setFirstOpportunityId] = useState<number | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  // Tracks the active scrapeJobId so the Cancel button can reference it
  // even after the discovery subscription has been removed.
  const activeJobIdRef = useRef<string | null>(null);
  // The discovery_plans.id for the CURRENT Live Discovery run, if any. Only
  // a live run has one: Instant Pool / Ranked Instant are pool-only, return
  // synchronously, and never show the scouting screen.
  const [planId, setPlanId] = useState<string | null>(null);
  // What the live run was actually asked for (the server's clamped
  // `requested`, not the slider). Live and pool runs are separate jobs with
  // separate counters, so the live state always starts from 0.
  const [liveTarget, setLiveTarget] = useState(quantity);
  const liveDiscoveryState = useLiveDiscoveryState(planId, liveTarget, 0);
  // The last finished run: its truthful outcome (requested / delivered /
  // shortfall), the exact request sent, and whether a Live follow-up is offered.
  const [lastRun, setLastRun] = useState<LastDiscoverRun | null>(null);


  const dailyRemaining = account?.dailyUsage.remaining ?? 0;
  const monthlyRemaining = account?.monthlyUsage.remaining ?? 0;
  // Discovery Method is a real, user-chosen option — the user may pick any
  // method their plan is eligible for (see src/lib/discoveryMethod.ts /
  // src/config/plans.ts isDiscoveryModeAllowed, re-validated server-side).
  // `activeMethod` is only the plan's DEFAULT (its ceiling) — used to
  // preselect the picker and to describe "your plan" in the upgrade strip.
  const activeMethod = discoveryMethodForPlan(permissions.plan);
  const upgradeMethod = nextDiscoveryMethod(permissions.plan);
  // null until the user actually picks something; falls back to the
  // plan's default below. Also falls back automatically if a plan
  // change (e.g. a downgrade) makes the previous pick ineligible.
  const [selectedMethodId, setSelectedMethodId] = useState<DiscoveryMode | null>(null);
  const selectedMethod =
    (selectedMethodId && isDiscoveryMethodEligible(permissions.plan, selectedMethodId)
      ? DISCOVERY_METHODS.find((m) => m.id === selectedMethodId)
      : undefined) ?? activeMethod;

  const leads = Array.isArray(leadsPayload)
    ? leadsPayload
    : leadsPayload?.leads ?? [];

  const discoverInsights: DiscoverInsight[] =
    account && analytics
      ? buildDiscoverInsights({
          leads,
          analytics,
          account,
        })
      : [];

  // Clamp slider to plan max as soon as account loads (fixes stuck slider for new free users)
  useEffect(() => {
    setQtyIndex((prev) => Math.min(prev, maxSliderIndex));
  }, [maxSliderIndex]);

  const hasRegionalSearch = permissions.can("regionalSearch");

  const toggleRegion = (r: Region) => {
    // Same rule the server enforces (validateDiscoveryRegion): without
    // regionalSearch only the local region — North America and its
    // countries — is searchable.
    if (!hasRegionalSearch && !isLocalGeoToken(r)) {
      const meta = permissions.getFeatureMetadata("regionalSearch");
      toast.error(`${meta.title} requires the ${meta.requiredPlan.toUpperCase()} plan. Your plan is limited to local search (North America).`);
      return;
    }
    if (r === GLOBAL_SCOPE) {
      setRegions([GLOBAL_SCOPE]);
    } else {
      setRegions((prev) => {
        const withoutGlobal = prev.filter((x) => x !== GLOBAL_SCOPE);
        return withoutGlobal.includes(r)
          ? withoutGlobal.filter((x) => x !== r).length === 0
            ? [r] // keep at least one
            : withoutGlobal.filter((x) => x !== r)
          : [...withoutGlobal, r];
      });
    }
  };

  const toggleNiche = (n: string) => {
    setNiches((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]
    );
  };

  const removeNiche = (n: string) =>
    setNiches((prev) => prev.filter((x) => x !== n));

  const channelToFeature: Record<ChannelId, FeatureId> = {
    email: "emailChannel",
    phone: "phoneChannel",
    instagram: "instagramChannel",
    website: "websiteChannel",
  };

  const toggleChannel = (id: ChannelId) => {
    const feat = channelToFeature[id];
    if (!permissions.can(feat)) {
      const meta = permissions.getFeatureMetadata(feat);
      toast.error(`${meta.title} requires the ${meta.requiredPlan.toUpperCase()} plan.`);
      return;
    }
    setChannels((c) => toggleChannelSelection(c, id));
  };

  const nextSuggestions: NextSearchSuggestions = buildNextSearchSuggestions({
    leads,
    nicheCatalog: NICHE_CATALOG,
    isUsableRegion: (t) =>
      t !== GLOBAL_SCOPE &&
      parseGeoScope(t).invalid.length === 0 &&
      (permissions.can("regionalSearch") || isLocalGeoToken(t)),
    quantitySteps: QUANTITY_STEPS,
    maxQuantity: permissions.limits.dailyOpportunities,
    dailyRemaining,
    monthlyRemaining,
    allowedChannels: channelOptions
      .filter((c) => permissions.can(channelToFeature[c.id]))
      .map((c) => c.id),
  });

  const filteredNiches = NICHE_CATALOG.filter((n) =>
    n.toLowerCase().includes(nicheSearch.toLowerCase())
  );

  const channelRestricted = channels.some((c) => !permissions.can(channelToFeature[c]));
  const exceedsDailyLimit = account ? quantity > dailyRemaining : false;
  const exceedsMonthlyLimit = account ? quantity > monthlyRemaining : false;
  // Niche selection is required — the engine must never receive an empty
  // niche (which used to silently fall back to "General").
  const noNicheSelected = niches.length === 0;
  // Lead-Yield Waste Fix: named explicitly (rather than left as an
  // unlabeled part of canGenerate) so the warning block below can tell the
  // user WHY the button is disabled instead of leaving an empty selection
  // silently unexplained — see DEFAULT_CHANNELS's docstring for why the
  // form no longer pre-selects a default combination.
  const noChannelSelected = channels.length === 0;
  const canGenerate =
    !!account &&
    !noNicheSelected &&
    !noChannelSelected &&
    !channelRestricted &&
    !exceedsDailyLimit &&
    !exceedsMonthlyLimit &&
    !isGenerating;

  // The request is built by ONE function shared with the AI Overview's
  // "Your search" summary, so what the page shows is what gets sent.
  const handleGenerate = async () => {
    if (!canGenerate) return;
    await runDiscovery(
      buildDiscoverRequest({ quantity, regions, niches, channels, method: selectedMethod.id }),
    );
  };

  // EXPLICIT user action after a partial Instant result. It starts a
  // separate, clearly identified Live Discovery job for only the remaining
  // shortfall (server-validated via followsJobId, billed per delivered lead
  // under the normal plan rules). Never triggered automatically.
  const handleFindRemainingLive = async () => {
    const run = lastRun;
    if (isGenerating || !run?.liveFollowUp?.available || run.liveFollowUp.remaining <= 0) return;
    await runDiscovery({
      ...run.request,
      quantity: run.liveFollowUp.remaining,
      method: "live",
      mode: generationModeFor("live"),
      followsJobId: run.jobId,
    });
  };

  const runDiscovery = async (request: DiscoverRequestPayload) => {
    // Clean up any previous subscription before starting a new search.
    unsubscribeJobRef.current?.();
    unsubscribeJobRef.current = null;
    seenLeadIdsRef.current = new Set();
    activeJobIdRef.current = null;
    setIsCancelling(false);
    setPlanId(null);
    setLiveTarget(request.quantity);
    setLastRun(null);

    setIsGenerating(true);
    setShowCompletion(false);
    setNewOpportunities([]);

    const startTime = Date.now();

    // A very short minimum so an instant, fully-cached Instant Discovery
    // response doesn't flash the loading screen for a single frame — not a
    // fabricated delay, just enough to avoid visual flicker.
    const MIN_VISIBLE_MS = 700;

    // The ONE place a run ends. Wording and toast severity come from the
    // outcome, so "success" is only ever shown when delivered >= requested.
    const conclude = (
      outcome: DiscoverOutcome,
      meta: Pick<LastDiscoverRun, "jobId" | "source" | "ranking" | "liveFollowUp">,
    ) => {
      unsubscribeJobRef.current?.();
      unsubscribeJobRef.current = null;
      activeJobIdRef.current = null;
      setIsCancelling(false);

      const elapsed = Date.now() - startTime;
      const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);

      setTimeout(() => {
        setIsGenerating(false);
        // A run that delivered nothing and did not simply come up empty
        // (failed / cancelled) has no results screen — just the toast.
        const showResults = outcome.delivered > 0 || outcome.kind === "empty" || outcome.kind === "partial";
        if (showResults) {
          setLastRun({ outcome, request, ...meta });
          setShowCompletion(true);
        }
        if (outcome.toast === "success") toast.success(outcome.headline);
        else if (outcome.toast === "error") toast.error(outcome.headline, outcome.detail ? { description: outcome.detail } : undefined);
        else toast.info(outcome.headline, outcome.detail ? { description: outcome.detail } : undefined);
        if (outcome.delivered > 0) {
          addNotification({
            icon: "CheckCircle2",
            iconColor: "text-emerald-400",
            iconBg: "bg-emerald-400/10 border-emerald-400/20",
            title: outcome.kind === "complete" ? "Leads Generated" : "Leads Partially Generated",
            body: `Delivered ${outcome.delivered} of ${outcome.requested} requested opportunities to your pipeline.`,
            category: "notifyNewLead",
          });
        }
        // Final sync — credits/counters/CRM/analytics all reflect what was
        // actually delivered.
        queryClient.invalidateQueries({ queryKey: queryKeys.account });
        queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
        queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      }, wait);
    };

    const appendLead = (lead: Lead) => {
      if (seenLeadIdsRef.current.has(lead.id)) return; // no duplicate opportunities, ever
      seenLeadIdsRef.current.add(lead.id);
      setNewOpportunities((prev) => {
        const next = [...prev, lead];
        if (prev.length === 0) setFirstOpportunityId(lead.id);
        return next;
      });
      // Keep credits/counters live as each opportunity lands, not just at
      // the very end — this is what "stay synchronized" means for a
      // multi-second Live Discovery run.
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
    };

    try {
      // Niche selection is required — canGenerate already gates the button
      // on niches.length > 0, so this should never actually be empty. No
      // "General" fallback: an unselected niche must never reach the
      // backend/engine.
      const result = await generate.mutateAsync({
        quantity: request.quantity,
        region: request.region,
        niche: request.niche,
        // Legacy/informational field, kept for type back-compat only.
        mode: request.mode,
        // The actual chosen Discovery Method — this IS honored by the
        // server (re-validated there against the resolved plan).
        method: request.method,
        // Pass-through-unchanged contract — see channelsForRequest's
        // docstring (AND semantics: every selected channel is required).
        channels: request.channels,
        // Business Currency was removed from Discover. The request contract
        // still carries the field, so send the explicit empty default.
        currencies: [],
        ...(request.followsJobId ? { followsJobId: request.followsJobId } : {}),
      });

      // Whatever arrived synchronously (Instant Discovery's pool hit) shows
      // immediately.
      result.leads.forEach(appendLead);

      if (!result.pending) {
        // Instant Pool / Ranked Instant: the run is already over. Report
        // exactly what the pool delivered — full or partial — and OFFER (never
        // start) a Live Discovery follow-up for any shortfall.
        conclude(
          describeDiscoverOutcome({
            requested: result.requested ?? request.quantity,
            delivered: result.delivered ?? result.leads.length,
            status: result.status ?? "completed",
            shortfallReason: result.shortfallReason,
            source: "pool",
          }),
          { jobId: result.jobId, source: "pool", ranking: result.ranking, liveFollowUp: result.liveFollowUp },
        );
        return;
      }

      // Live Discovery (nothing delivered yet): watch the job until it
      // resolves. Its progress counts only leads this run delivered.
      activeJobIdRef.current = result.jobId;
      const liveRequested = result.requested ?? request.quantity;
      setLiveTarget(liveRequested);
      if (result.planId) {
        setPlanId(result.planId);
      }
      unsubscribeJobRef.current = subscribeToDiscoverJob(
        result.jobId,
        {
          onLead: appendLead,
          onStatusChange: (status) => {
            if (status !== "completed" && status !== "completed_partial" && status !== "cancelled" && status !== "failed") return;
            // Delivered = leads this run actually saved and the UI has seen.
            conclude(
              describeDiscoverOutcome({
                requested: liveRequested,
                delivered: seenLeadIdsRef.current.size,
                status: status as DiscoverRunStatus,
                shortfallReason: status === "completed_partial" ? "live_exhausted" : null,
                source: "live",
              }),
              { jobId: result.jobId, source: "live" },
            );
          },
        },
        { requestedQuantity: liveRequested },
      );

    } catch (err) {
      setIsGenerating(false);
      if (err instanceof ApiError) {
        if (err.message.includes("LIMIT_EXCEEDED_DAILY")) {
          toast.error("Daily capacity reached", { description: `You have ${dailyRemaining} opportunities remaining today.` });
        } else if (err.message.includes("LIMIT_EXCEEDED_MONTHLY")) {
          toast.error("Monthly capacity reached", { description: `You have ${monthlyRemaining} opportunities remaining this month.` });
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Discovery engine failed. Please try again.");
      }
    }
  };

  // Stop listening for a job's results if the user navigates away mid-search.
  useEffect(() => {
    return () => {
      unsubscribeJobRef.current?.();
    };
  }, []);

  const handleBeginOutreach = () => {
    if (firstOpportunityId) {
      navigate({
        to: "/dashboard/leads/$leadId",
        params: { leadId: String(firstOpportunityId) },
      });
    } else {
      navigate({ to: "/dashboard/relationships" });
    }
  };

  const handleCancelSearch = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId || isCancelling) return;
    setIsCancelling(true);
    try {
      await cancelDiscoverJob(jobId);
      // UI update comes via the Realtime subscription's
      // onStatusChange('cancelled') callback; we don't need to tear down
      // state here.
    } catch (err) {
      setIsCancelling(false);
      if (err instanceof ApiError && err.status === 409) {
        // Already terminal — treat as if we'd received the callback.
        toast.info("Search already completed.");
      } else {
        toast.error("Failed to cancel search. Please try again.");
      }
    }
  };

  // ─── 1. Live Discovery State ────────────────────────────────────────────────
  // Free's Live Discovery: a real discovery_plans row exists, so real Scout
  // events are streaming in — render the real live UI, driven entirely by
  // Task 2's DiscoveryLiveState (see useLiveDiscoveryState / LiveDiscoveryScreen).
  if (isGenerating && planId) {
    // Counters must never lag behind leads that are actually saved: if the
    // event stream is delayed, the number of leads the UI has received wins.
    const savedCount = newOpportunities.length;
    const liveScreenState =
      liveDiscoveryState && savedCount > liveDiscoveryState.delivered
        ? {
            ...liveDiscoveryState,
            delivered: savedCount,
            progressPercent: liveTarget > 0 ? Math.min(100, Math.round((savedCount / liveTarget) * 100)) : 0,
          }
        : liveDiscoveryState;
    return <LiveDiscoveryScreen state={liveScreenState} onCancel={handleCancelSearch} isCancelling={isCancelling} />;
  }

  // Instant Discovery (Starter/Pro/Premium) pool-shortfall backfill: no
  // discovery_plans row exists for this path, so there is no Scout-level
  // live event stream to show — a truthful minimal waiting state instead of
  // a 3-Scout screen with nothing real to drive it. newOpportunities here is
  // real (each one landed via an actual `leads` INSERT), not a fabricated count.
  if (isGenerating) {
    return (
      <div className="flex min-h-[75vh] items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-card/40 p-8 shadow-2xl backdrop-blur-md space-y-6 text-center relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand/20 via-brand to-brand/20 animate-pulse" />
          <div className="flex justify-center">
            <Sparkles className="size-8 text-brand animate-spin [animation-duration:8s]" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-xl font-bold text-foreground tracking-tight">Finding your opportunities</h2>
            <p className="text-sm text-muted-foreground">Pulling the best matches for you right now.</p>
          </div>
          {newOpportunities.length > 0 && (
            <div className="flex items-center justify-center gap-2 text-sm font-semibold text-brand animate-in fade-in">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-brand" />
              </span>
              {newOpportunities.length} opportunit{newOpportunities.length === 1 ? "y" : "ies"} found so far...
            </div>
          )}
          <button
            type="button"
            disabled={isCancelling}
            onClick={handleCancelSearch}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCancelling ? "Cancelling..." : "Cancel Search"}
          </button>
        </div>
      </div>
    );
  }

  // ─── 2. Premium Completion State ─────────────────────────────────────────────
  if (showCompletion) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-8 animate-in fade-in zoom-in-95 duration-500">
        <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-6 relative overflow-hidden shadow-2xl">
          <div
            className="pointer-events-none absolute inset-0 opacity-20"
            style={{
              background:
                "radial-gradient(ellipse at top, color-mix(in oklab, var(--brand) 25%, transparent), transparent 60%)",
            }}
          />

          {/* Outcome icon — a check ONLY when the request was fully delivered */}
          <div className="flex justify-center">
            <div
              className={cn(
                "size-16 rounded-full border flex items-center justify-center shadow-lg",
                lastRun?.outcome.kind === "complete"
                  ? "bg-brand/10 border-brand/20 shadow-brand/10 animate-bounce"
                  : "bg-amber-400/10 border-amber-400/25 shadow-amber-400/10",
              )}
            >
              <span className={cn("text-2xl font-bold", lastRun?.outcome.kind === "complete" ? "text-brand" : "text-amber-400")}>
                {lastRun?.outcome.kind === "complete" ? "✓" : "!"}
              </span>
            </div>
          </div>

          {/* Wording — driven by the run's real requested/delivered/shortfall */}
          <div className="space-y-2 max-w-md mx-auto" data-testid="discover-outcome" data-kind={lastRun?.outcome.kind ?? "unknown"}>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">
              {lastRun?.outcome.headline ?? `${newOpportunities.length} opportunities prepared`}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {lastRun?.outcome.kind === "complete" || !lastRun
                ? "Outreach channels have been verified and intelligence workspaces initialized. Everything is ready to launch outreach campaigns."
                : (lastRun.outcome.detail ?? "")}
            </p>
            {lastRun && (
              <p className="text-xs font-medium text-muted-foreground" data-testid="discover-counts">
                Requested {lastRun.outcome.requested} · Delivered {lastRun.outcome.delivered} · Shortfall {lastRun.outcome.shortfall}
              </p>
            )}
            {lastRun?.ranking?.requested && lastRun.ranking.status === "partial" && (
              <p className="text-xs text-amber-300/90" data-testid="discover-ranking-note">
                Not fully ranked: {lastRun.ranking.unscored} of {lastRun.ranking.scored + lastRun.ranking.unscored} had no Opportunity Score yet and are listed after the scored ones.
              </p>
            )}
            {lastRun?.ranking?.requested && lastRun.ranking.status === "unavailable" && (
              <p className="text-xs text-amber-300/90" data-testid="discover-ranking-note">
                Ranking unavailable: set your focus area in Settings to rank by Opportunity Score. Results are in recency order.
              </p>
            )}
          </div>

          {/* Explicit Live Discovery follow-up — never started automatically */}
          {lastRun?.source === "pool" && lastRun.liveFollowUp?.available && lastRun.liveFollowUp.remaining > 0 && (
            <div className="space-y-2 max-w-md mx-auto rounded-xl border border-border bg-background/40 p-4">
              <button
                type="button"
                onClick={handleFindRemainingLive}
                disabled={isGenerating}
                data-testid="find-remaining-live"
                className="w-full px-5 py-3 bg-brand/10 hover:bg-brand/20 text-brand font-semibold rounded-lg border border-brand/30 transition-colors cursor-pointer text-sm disabled:opacity-50"
              >
                Find remaining leads with Live Discovery
              </button>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Starts a separate Live Discovery run for the remaining {lastRun.liveFollowUp.remaining}. It is billed only for opportunities it actually delivers, under your plan's normal limits.
              </p>
            </div>
          )}

          {/* CTAs */}
          <div className="flex flex-sm-row items-center justify-center gap-3 pt-2">
            {(lastRun?.outcome.delivered ?? newOpportunities.length) > 0 && (
            <button
              onClick={handleBeginOutreach}
              className="w-full sm:w-auto px-8 py-3.5 bg-brand hover:bg-brand-dark text-brand-foreground font-bold rounded-xl shadow-brand hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer text-sm"
            >
              <Zap className="size-4" /> Begin Outreach
            </button>
            )}
            <button
              onClick={() => {
                setShowCompletion(false);
                setNewOpportunities([]);
                setLastRun(null);
              }}
              className="w-full sm:w-auto px-8 py-3.5 bg-background hover:bg-muted text-foreground font-semibold rounded-xl border border-border transition-colors cursor-pointer text-sm"
            >
              Continue Discovering
            </button>
          </div>
        </div>

        {/* Prepared Opportunities Preview Grid */}
        {newOpportunities.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Prepared Opportunities Preview
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Icons show the contact channels saved for each opportunity. A struck-through icon is a requested channel this record is missing.
            </p>
            <div className="grid sm:grid-cols-3 gap-4">
              {newOpportunities.slice(0, 3).map((opp, idx) => (
                <div
                  key={opp.id}
                  onClick={() => {
                    navigate({
                      to: "/dashboard/leads/$leadId",
                      params: { leadId: String(opp.id) },
                    });
                  }}
                  className={`bg-card border border-border rounded-xl p-5 hover:border-brand/40 hover:shadow-lg transition-all cursor-pointer space-y-3 relative group card-hover animate-fade-up ${
                    idx === 0 ? "delay-100" : idx === 1 ? "delay-200" : "delay-300"
                  }`}
                >
                  <div className="space-y-1">
                    <h4 className="font-bold text-sm text-foreground truncate group-hover:text-brand transition-colors">
                      {opp.businessName}
                    </h4>
                    <p className="text-xs text-muted-foreground truncate">{opp.location}</p>
                  </div>
                  <ContactChannelIcons lead={opp} requested={lastRun?.request.channels ?? []} />
                  <span className="absolute bottom-4 right-4 text-[10px] font-bold text-brand uppercase opacity-0 group-hover:opacity-100 transition-opacity">
                    Open Workspace →
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── 3. Main Discover Form ──────────────────────────────────────────────────
  // Composition: a cinematic hero (headline + globe wrapped in orbit lines)
  // over five numbered step cards, one launch bar, and a live summary rail.
  // Every control is wired to the same state/handlers as before; only the
  // presentation changed. The globe is a readout of that state — the last
  // selected region is what it flies to, the last selected niche is what the
  // carousel brings into focus.
  const nicheSummary =
    niches.length === 0
      ? null
      : niches.length <= 3
        ? niches.join(", ")
        : `${niches.slice(0, 3).join(", ")} +${niches.length - 3}`;
  const selectedChannelOptions = channelOptions.filter((c) => channels.includes(c.id));
  const channelSummary = selectedChannelOptions.map((c) => c.short).join(" · ");
  // Only real, user-actionable blockers are shown in red. A merely
  // incomplete form gets a quiet muted hint instead of a standing warning.
  const hardBlockMessage = exceedsDailyLimit
    ? `Daily limit: only ${dailyRemaining.toLocaleString()} remaining today.`
    : exceedsMonthlyLimit
      ? `Monthly limit: only ${monthlyRemaining.toLocaleString()} remaining.`
      : channelRestricted
        ? "Your plan does not support this configuration."
        : null;
  const incompleteHint = noNicheSelected
    ? "Select a niche to launch"
    : noChannelSelected
      ? "Select a contact channel to launch"
      : null;

  const focusedNiche = niches.length > 0 ? niches[niches.length - 1] : null;

  const summaryRows: SummaryRow[] = [
    {
      icon: Sparkles,
      label: "Business Niche",
      value: nicheSummary ?? "Choose a niche",
      empty: !nicheSummary,
    },
    {
      icon: BarChart3,
      label: "Opportunity Amount",
      value: `${quantity.toLocaleString()} ${quantity === 1 ? "business" : "businesses"}`,
    },
    { icon: MapPin, label: "Target Region", value: regions.join(", ") },
    {
      icon: Mail,
      label: "Contact Channels",
      empty: selectedChannelOptions.length === 0,
      value:
        selectedChannelOptions.length === 0 ? (
          "Choose channels"
        ) : (
          <span className="inline-flex items-center gap-2" title={channelSummary}>
            {selectedChannelOptions.map((c) => (
              <c.icon key={c.id} className="size-4 text-brand" aria-hidden="true" />
            ))}
            <span className="sr-only">{channelSummary}</span>
          </span>
        ),
    },
    {
      icon: Zap,
      label: "Discovery Method",
      value: `${selectedMethod.shortLabel} · ${selectedMethod.timeLabel}`,
    },
  ];

  return (
    <div className="relative mx-auto max-w-[1500px] animate-page-enter overflow-x-clip px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <DiscoverAtmosphere />
      <div className="relative z-10 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Left: hero + the five steps + launch ─────────────────── */}
        <div className="@container min-w-0">
          <div style={{ ["--g" as string]: "clamp(230px, 48cqw, 600px)" }}>
            {/* Hero — the globe is about half hidden: its lower half sits under the cards */}
            <div
              style={{ ["--hh" as string]: "max(calc(var(--g) * 0.5 + 2.25rem), 13.5rem)" }}
              className="relative flex flex-col items-center overflow-x-clip @2xl:block @2xl:overflow-visible @2xl:h-[var(--hh)]"
            >
              <div className="flex h-[calc(var(--g)*0.62+0.75rem)] w-full justify-center overflow-hidden pt-[calc(var(--g)*0.12)] @2xl:absolute @2xl:left-[66%] @2xl:top-[calc(var(--hh)-var(--g)*0.5-0.75rem)] @2xl:h-auto @2xl:w-auto @2xl:-translate-x-1/2 @2xl:overflow-visible @2xl:pt-0">
                <DiscoverGlobe />
              </div>
              <div className="relative z-10 mt-6 text-center @2xl:mt-0 @2xl:max-w-[30rem] @2xl:pt-7 @2xl:text-left">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">Discover</p>
                <h1 className="whitespace-nowrap text-[clamp(1.9rem,4.2cqw,3.2rem)] font-extrabold leading-[1.04] tracking-[-0.035em] text-foreground">
                  Find Businesses
                  <br />
                  for <span className="text-brand-gradient">Your Niche</span>
                </h1>
                <p className="mt-4 max-w-[26rem] text-[15px] leading-relaxed text-muted-foreground max-@2xl:mx-auto">
                  Tell Mast who to find. Verified businesses arrive with contact channels loaded.
                </p>
              </div>
            </div>

            <div className="relative z-10 mt-4 space-y-4 @2xl:mt-0">
              {/* Control-card grid — one 24-column grid so the five cards read
                  as a single composition (proportions from the design ref):
                  Row 1: Niche · Region (50 / 50)
                  Row 2: Amount · Channels
                  Row 3: Discovery Method (full width)
                  Below @2xl everything stacks full-width. */}
              <div className="grid items-stretch gap-3.5 @2xl:grid-cols-24">
                <StepCard
                  step={1}
                  icon={Warehouse}
                  title="Business Niche"
                  hint="Required · pick one or more"
                  className="relative z-10 @2xl:col-span-12"
                >
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Search niches… (e.g. Restaurant, Marketing Agency)"
                      aria-label="Search niches"
                      value={nicheSearch}
                      onChange={(e) => setNicheSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const target = filteredNiches[0];
                          if (target) {
                            toggleNiche(target);
                            setNicheSearch("");
                          }
                        } else if (e.key === "Escape") {
                          setNicheSearch("");
                        }
                      }}
                      className="h-12 w-full rounded-xl border border-white/10 bg-black/25 pl-11 pr-10 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-brand/35"
                    />
                    {nicheSearch && (
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setNicheSearch("")}
                        className="absolute right-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-4" />
                      </button>
                    )}
                  </div>

                  {niches.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {niches.map((n) => (
                        <span
                          key={n}
                          className="inline-flex items-center gap-1 rounded-lg border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-medium text-foreground"
                        >
                          {n}
                          <button
                            type="button"
                            onClick={() => removeNiche(n)}
                            aria-label={`Remove ${n}`}
                            className="ml-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="-mx-2 mt-1">
                    <NicheCarousel
                      niches={NICHE_CATALOG}
                      matches={filteredNiches}
                      selected={niches}
                      focused={focusedNiche}
                      query={nicheSearch}
                      onToggle={toggleNiche}
                    />
                  </div>
                </StepCard>

                {/* z-20 so the region dropdown floats over the cards below it. */}
                <TargetRegionCard
                  regions={regions}
                  onToggle={toggleRegion}
                  hasRegionalSearch={hasRegionalSearch}
                  className="relative z-20 @2xl:col-span-12"
                />

                <StepCard
                  step={3}
                  icon={Gauge}
                  title="Opportunity Amount"
                  hint={`Plan max: ${maxQuantity.toLocaleString()}`}
                  className="relative z-20 @2xl:col-span-10"
                >
                  <AmountSlider
                    steps={QUANTITY_STEPS}
                    index={qtyIndex}
                    maxIndex={maxSliderIndex}
                    onChange={setQtyIndex}
                  />
                </StepCard>

                <StepCard
                  step={4}
                  icon={Mail}
                  title="Contact Channels"
                  hint="More channels = stricter matching and fewer results"
                  className="@2xl:col-span-14"
                >
                  <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
                    {channelOptions.map((c) => {
                      const active = channels.includes(c.id);
                      const isLocked = !permissions.can(channelToFeature[c.id]);
                      return (
                        <ChannelCard
                          key={c.id}
                          id={c.id}
                          selected={active}
                          locked={isLocked}
                          onClick={() => toggleChannel(c.id)}
                          icon={<c.icon className="size-[17px]" strokeWidth={1.9} />}
                          title={c.short}
                          description={CHANNEL_BLURB[c.id]}
                        />
                      );
                    })}
                  </div>
                </StepCard>

                {/* Discovery Method — an actual selectable option, gated by plan
                    eligibility (isDiscoveryMethodEligible), re-validated by the
                    server. PLAN BADGE (min plan required) and SELECTED (the
                    user's current pick) are deliberately separate signals —
                    never conflate them. */}
                <StepCard
                  step={5}
                  icon={Zap}
                  title="Discovery Method"
                  hint="Choose how MAST finds your opportunities · 1 credit per opportunity"
                  className="@2xl:col-span-24"
                >
                  <ul className="grid grid-cols-3 gap-2" aria-label="Discovery methods">
                    {DISCOVERY_METHODS.map((m) => {
                      const isSelected = m.id === selectedMethod.id;
                      const isEligible = isDiscoveryMethodEligible(permissions.plan, m.id);
                      const look = METHOD_LOOK[m.id];
                      const MethodIcon = look.icon;
                      return (
                        <li key={m.id} className="flex min-w-0">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            aria-current={isSelected ? "true" : undefined}
                            onClick={() => {
                              if (!isEligible) {
                                toast.error(`${m.label} requires the ${m.minPlanLabel.toUpperCase()} plan.`);
                                return;
                              }
                              setSelectedMethodId(m.id);
                            }}
                            title={`${m.desc}${isEligible ? "" : ` — requires ${m.minPlanLabel}`}`}
                            className={cn(
                              "relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left outline-none transition-[border-color,box-shadow,background-color] duration-200 focus-visible:ring-2 focus-visible:ring-brand/60",
                              isSelected
                                ? "border-brand/70 bg-brand/[0.08] shadow-[0_0_22px_-8px_var(--brand)]"
                                : "border-white/10 bg-black/20 hover:border-white/25",
                              !isEligible && "opacity-60",
                            )}
                          >
                            {/* method icon, in its own circle */}
                            <span
                              aria-hidden="true"
                              style={{ background: look.disc, color: look.fg, boxShadow: `inset 0 0 0 1px ${look.ring}` }}
                              className="grid size-10 shrink-0 place-items-center rounded-full"
                            >
                              <MethodIcon className="size-[18px]" strokeWidth={1.8} />
                            </span>

                            <span className="flex min-w-0 flex-1 flex-col gap-1 pr-6">
                              <span className="whitespace-nowrap text-[13px] font-semibold leading-tight text-foreground">
                                <span aria-hidden="true">{m.shortLabel}</span>
                                <span className="sr-only">{m.label}</span>
                              </span>
                              <span className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
                                {/* PLAN BADGE — minimum plan required, always shown. */}
                                <span className="rounded-full bg-white/[0.07] px-1.5 py-px text-[9.5px] font-bold uppercase tracking-normal text-muted-foreground">
                                  {m.minPlanLabel}
                                </span>
                                <span
                                  style={{ background: look.badgeBg, color: look.badgeFg }}
                                  className="rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tabular-nums tracking-normal"
                                >
                                  {m.timeLabel}
                                </span>
                              </span>
                              <span className="text-[11px] leading-snug text-muted-foreground">{METHOD_BLURB[m.id]}</span>
                            </span>

                            {/* SELECTED — filled check; otherwise an empty ring (a lock when the plan can't run it). */}
                            <span
                              aria-hidden={isEligible ? true : undefined}
                              className={cn(
                                "absolute right-2.5 top-2.5 grid size-[18px] place-items-center rounded-full transition-colors",
                                isSelected ? "bg-brand text-brand-foreground" : "border border-white/20 text-muted-foreground",
                              )}
                            >
                              {!isEligible ? (
                                <Lock className="size-2.5" aria-label={`Locked — requires ${m.minPlanLabel}`} />
                              ) : isSelected ? (
                                <Check className="size-3" strokeWidth={3.4} />
                              ) : null}
                            </span>
                            {isSelected && <span className="sr-only">Selected</span>}

                            {/* Full detail copy stays available to assistive tech. */}
                            <span className="sr-only">
                              {m.desc}. {isSelected ? m.note : ""}
                              {isEligible ? "" : ` Requires ${m.minPlanLabel}`}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </StepCard>
              </div>

              {/* Launch */}
              <div>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className="group relative flex h-16 w-full cursor-pointer items-center justify-center gap-3 overflow-hidden rounded-2xl border border-white/15 text-base font-semibold text-white shadow-[0_18px_44px_-16px_color-mix(in_oklab,var(--brand)_80%,transparent)] outline-none transition-[filter,transform,box-shadow] duration-200 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none disabled:hover:brightness-100"
                  style={{
                    background:
                      "linear-gradient(100deg, oklch(0.4 0.19 275) 0%, oklch(0.55 0.23 283) 48%, oklch(0.5 0.2 262) 100%)",
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 1000 64"
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
                    fill="none"
                    stroke="white"
                    strokeWidth="1"
                  >
                    <path d="M0 44 C 160 4, 300 70, 470 34 S 760 8, 1000 40" opacity="0.5" />
                    <path d="M0 52 C 180 16, 320 72, 500 42 S 780 20, 1000 50" opacity="0.35" />
                    <path d="M0 30 C 200 -6, 340 60, 520 24 S 800 0, 1000 28" opacity="0.25" />
                  </svg>
                  <Search className="relative size-5 shrink-0" />
                  <span className="relative">{isGenerating ? "Analyzing..." : "Launch Discovery"}</span>
                  {!isGenerating && (
                    <ArrowRight className="relative size-5 shrink-0 transition-transform group-hover:translate-x-1" />
                  )}
                </button>
                {hardBlockMessage ? (
                  <p role="alert" className="mt-2 text-center text-xs leading-relaxed text-destructive">
                    {hardBlockMessage}
                  </p>
                ) : incompleteHint ? (
                  <p className="mt-2 text-center text-xs text-muted-foreground">{incompleteHint}</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* ── Right rail: live summary, plan, upgrade ─────────────── */}
        <aside className="space-y-4 lg:sticky lg:top-6">
          <SummaryCard rows={summaryRows} credits={{ amount: quantity }} />
          <PlanCard
            planName={account?.subscription?.name ?? permissions.plan}
            daily={{
              used: account?.dailyUsage?.used,
              limit: account?.dailyUsage?.limit,
              remaining: dailyRemaining,
            }}
            monthly={{
              used: account?.monthlyUsage?.used,
              limit: account?.monthlyUsage?.limit,
              remaining: monthlyRemaining,
            }}
          />

          {upgradeMethod && (
            <div className="flex items-center gap-3 rounded-xl border border-brand/15 bg-brand/[0.06] px-4 py-3">
              <Zap className="size-4 shrink-0 text-brand/70" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-brand/80">
                  {upgradeMethod.label}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {upgradeMethod.minPlanLabel}+ · {upgradeMethod.pitch}
                </p>
              </div>
              <Link
                to="/dashboard/subscription"
                title={`Runs on the ${upgradeMethod.minPlanLabel} plan and above`}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-foreground/80 px-3 py-1.5 text-xs font-bold text-background transition-colors hover:bg-foreground/90"
              >
                Upgrade <ArrowRight className="size-3.5" />
              </Link>
            </div>
          )}
        </aside>
      </div>

      {/* ── AI Overview band ─────────────────────────────────────── */}
      <div className="mt-6">
        <DiscoverAiOverview
          currentSetup={{
            ...summarizeDiscoverRequest(
              buildDiscoverRequest({ quantity, regions, niches, channels, method: selectedMethod.id }),
            ),
            methodLabel: selectedMethod.shortLabel,
          }}
          insights={discoverInsights}
          loading={!account || !analytics}
          suggestions={nextSuggestions}
          applied={{
            niche: !!nextSuggestions.niche && niches.includes(nextSuggestions.niche.value),
            region: !!nextSuggestions.region && regions.includes(nextSuggestions.region.value),
            amount: !!nextSuggestions.amount && quantity === nextSuggestions.amount.value,
            channel: !!nextSuggestions.channel && channels.includes(nextSuggestions.channel.value as ChannelId),
          }}
          onApply={{
            niche: () => {
              const v = nextSuggestions.niche?.value;
              if (v) setNiches((prev) => (prev.includes(v) ? prev.filter((n) => n !== v) : [...prev, v]));
            },
            region: () => {
              const v = nextSuggestions.region?.value;
              if (v) toggleRegion(v);
            },
            amount: () => {
              const v = nextSuggestions.amount?.value;
              if (v) setQtyIndex(qtyToSliderIndex(v));
            },
            channel: () => {
              const v = nextSuggestions.channel?.value as ChannelId | undefined;
              if (v) toggleChannel(v);
            },
          }}
        />
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

/** One-line display copy for each discovery method card. */
const METHOD_BLURB: Record<string, string> = {
  live: "Real-time search across the web.",
  instant_pool: "Search from a large pre-built pool.",
  instant_pool_ranked: "AI-ranked high quality opportunities.",
};

/** Each method keeps its own icon colour; selection is always the brand outline. */
const METHOD_LOOK: Record<
  string,
  { icon: typeof Globe; disc: string; fg: string; ring: string; badgeBg: string; badgeFg: string }
> = {
  live: {
    icon: Globe,
    disc: "rgba(94,72,214,0.34)",
    fg: "#a99bff",
    ring: "rgba(150,130,255,0.28)",
    badgeBg: "rgba(112,84,255,0.16)",
    badgeFg: "#8f86ff",
  },
  instant_pool: {
    icon: Database,
    disc: "rgba(26,92,150,0.34)",
    fg: "#43b4ee",
    ring: "rgba(70,170,235,0.28)",
    badgeBg: "rgba(40,110,230,0.16)",
    badgeFg: "#3f8cff",
  },
  instant_pool_ranked: {
    icon: BarChart3,
    disc: "rgba(150,34,100,0.32)",
    fg: "#ff5fb4",
    ring: "rgba(255,95,180,0.28)",
    badgeBg: "rgba(236,72,153,0.16)",
    badgeFg: "#ff58a8",
  },
};

const CHANNEL_BLURB: Record<ChannelId, string> = {
  email: "Find business email addresses",
  phone: "Find business phone numbers",
  instagram: "Find business Instagram profiles",
  website: "Find company websites",
};

/** Per-channel palette: outline, tinted glow, icon disc and check badge. */
const CHANNEL_THEME: Record<
  ChannelId,
  { border: string; glow: string; wash: string; disc: string; discRing: string; check: string; checkText: string }
> = {
  email: {
    border: "rgba(139,123,255,0.95)",
    glow: "rgba(124,92,255,0.45)",
    wash: "radial-gradient(120% 90% at 50% 0%, rgba(110,84,255,0.22), transparent 62%)",
    disc: "radial-gradient(circle at 50% 35%, rgba(120,90,240,0.75), rgba(70,48,170,0.75))",
    discRing: "rgba(150,130,255,0.35)",
    check: "#5f7cff",
    checkText: "#0b1030",
  },
  phone: {
    border: "rgba(56,104,224,0.85)",
    glow: "rgba(56,104,224,0.28)",
    wash: "radial-gradient(120% 90% at 50% 0%, rgba(50,96,220,0.18), transparent 62%)",
    disc: "radial-gradient(circle at 50% 35%, rgba(44,84,190,0.6), rgba(22,44,110,0.7))",
    discRing: "rgba(90,130,240,0.28)",
    check: "#5f8bff",
    checkText: "#0b1030",
  },
  instagram: {
    border: "rgba(236,72,153,0.95)",
    glow: "rgba(236,72,153,0.38)",
    wash: "radial-gradient(90% 70% at 0% 100%, rgba(255,110,40,0.38), transparent 62%), radial-gradient(120% 80% at 50% 0%, rgba(214,60,160,0.16), transparent 60%)",
    disc: "linear-gradient(145deg, #d6249f 10%, #e8345e 55%, #f58529 100%)",
    discRing: "rgba(255,120,150,0.4)",
    check: "#b65cff",
    checkText: "#1a0b2e",
  },
  website: {
    border: "rgba(22,163,134,0.85)",
    glow: "rgba(20,184,150,0.26)",
    wash: "radial-gradient(120% 90% at 50% 0%, rgba(20,170,140,0.16), transparent 62%)",
    disc: "radial-gradient(circle at 50% 35%, rgba(24,130,112,0.6), rgba(10,70,66,0.7))",
    discRing: "rgba(60,200,170,0.28)",
    check: "#38d3e6",
    checkText: "#05222a",
  },
};

/** Tall selectable channel card: colour-coded outline + glow, icon disc, title,
 * one-line blurb and a check badge. A locked card stays clickable on purpose:
 * the parent handler shows the plan-upgrade toast, exactly as before. */
function ChannelCard({
  id,
  selected,
  locked,
  onClick,
  icon,
  title,
  description,
}: {
  id: ChannelId;
  selected: boolean;
  locked?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  const t = CHANNEL_THEME[id];
  const on = selected && !locked;
  // The colour treatment is permanent; only the check badge reflects selection.
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        borderColor: t.border,
        boxShadow: `0 0 20px -8px ${t.glow}, inset 0 0 18px -12px ${t.glow}`,
        backgroundImage: `${t.wash}, linear-gradient(180deg, rgba(8,10,28,0.9), rgba(5,7,20,0.95))`,
      }}
      className={cn(
        "group relative flex min-w-0 cursor-pointer flex-col items-center rounded-2xl border px-2 pb-2.5 pt-3 text-center outline-none transition-[filter,opacity] duration-200",
        "hover:brightness-110 focus-visible:ring-2 focus-visible:ring-brand/60",
        locked && "opacity-60",
      )}
    >
      {/* selection indicator — a round dot in the channel's own colour (matches the round icon disc):
          a glowing filled check when selected, a hollow tinted ring when not */}
      <span
        aria-hidden="true"
        style={
          on
            ? {
                background: `radial-gradient(circle at 35% 30%, #fff3, transparent 55%), ${t.check}`,
                boxShadow: `0 0 0 2.5px ${t.glow}, 0 0 12px ${t.glow}`,
              }
            : { borderColor: t.discRing, background: "rgba(0,0,0,0.28)" }
        }
        className={cn(
          "absolute right-2 top-2 grid size-[15px] place-items-center rounded-full transition-[background,box-shadow,border-color] duration-200",
          on ? "" : "border-[1.5px]",
        )}
      >
        {locked ? (
          <Lock className="size-2.5 text-muted-foreground" aria-label="Locked on your plan" />
        ) : (
          <Check
            className={cn(
              "size-[9px] text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)] transition-[transform,opacity] duration-200",
              on ? "scale-100 opacity-100" : "scale-50 opacity-0",
            )}
            strokeWidth={4}
          />
        )}
      </span>

      {/* icon disc */}
      <span
        aria-hidden="true"
        style={{ background: t.disc, boxShadow: `0 0 0 1px ${t.discRing}, 0 4px 12px -5px ${t.glow}` }}
        className="grid size-9 place-items-center rounded-full text-white"
      >
        {icon}
      </span>

      <span className="mt-2 text-[13px] font-semibold leading-none tracking-[-0.01em] text-foreground">{title}</span>
      <span className="mt-1 text-balance text-[10px] leading-[1.25] text-muted-foreground">{description}</span>
    </button>
  );
}

const INSIGHT_ACTION_STYLES: Record<DiscoverInsight["tone"], string> = {
  brand: "text-brand hover:text-brand/80",
  success: "text-emerald-500 hover:text-emerald-400",
  warning: "text-amber-500 hover:text-amber-400",
  neutral: "text-muted-foreground hover:text-foreground",
};

const CONFIDENCE_STYLES: Record<DiscoverInsight["confidence"], string> = {
  "High Confidence": "text-emerald-500",
  "Recommended": "text-brand",
  "Worth Testing": "text-amber-500",
  "Watch Closely": "text-muted-foreground",
};

/** What the AI Overview shows as its main recommendation. Today it is built from
 * buildDiscoverInsights() (see insightToBriefing); a real AI service can return this
 * same shape and be passed as the `briefing` prop with no UI change. */
export type AiBriefing = {
  /** Small caps label above the headline. */
  label: string;
  headline: string;
  body: string;
  /** Trust signal shown at the right of the card, e.g. "High Confidence". */
  confidence: DiscoverInsight["confidence"];
  tone: DiscoverInsight["tone"];
  action?: { label: string; href: string };
};

function insightToBriefing(i: DiscoverInsight): AiBriefing {
  return {
    label: "Recommended",
    headline: i.title,
    body: i.reason,
    confidence: i.confidence,
    tone: i.tone,
    action: { label: i.actionLabel, href: i.actionHref },
  };
}

type SuggestionKey = "niche" | "region" | "amount" | "channel";
type AiApply = Record<SuggestionKey, () => void>;
type AiApplied = Record<SuggestionKey, boolean>;

const CONFIDENCE_ICON: Record<DiscoverInsight["confidence"], typeof TrendingUp> = {
  "High Confidence": TrendingUp,
  "Recommended": TrendingUp,
  "Worth Testing": Lightbulb,
  "Watch Closely": Eye,
};

function BriefingAction({ action, tone }: { action: { label: string; href: string }; tone: DiscoverInsight["tone"] }) {
  const cls = `inline-flex items-center text-xs font-semibold transition-colors cursor-pointer ${INSIGHT_ACTION_STYLES[tone]}`;
  if (action.href.startsWith("/")) {
    return (
      <a href={action.href} className={cls}>
        {action.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        const el = document.querySelector(action.href) as HTMLElement | null;
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        el?.focus?.();
      }}
      className={cls}
    >
      {action.label}
    </button>
  );
}

/** One compact "search next" tile. Clicking it applies the suggestion to the form. */
function SuggestionTile({
  icon: Icon,
  tint,
  label,
  value,
  reason,
  applied,
  removable = true,
  onApply,
}: {
  icon: typeof Sparkles;
  tint: { bg: string; fg: string };
  label: string;
  /** null = nothing to suggest yet */
  value: string | null;
  reason: string;
  applied: boolean;
  /** Whether clicking an already-applied suggestion un-selects it (an amount can't be un-selected). */
  removable?: boolean;
  onApply: () => void;
}) {
  const disabled = value === null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onApply}
      aria-pressed={applied}
      title={disabled ? reason : applied ? (removable ? `Click to remove ${value}` : `${value} is already selected`) : `Use ${value}`}
      className={cn(
        "group relative flex min-w-0 flex-col justify-center gap-1.5 rounded-xl border px-2.5 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/60",
        applied ? "border-brand/40 bg-brand/[0.07]" : "border-white/[0.06] bg-black/20",
        disabled ? "cursor-default" : "cursor-pointer hover:border-white/20",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          style={{ background: tint.bg, color: tint.fg }}
          className="grid size-5 shrink-0 place-items-center rounded-md"
        >
          <Icon className="size-3" strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] leading-none text-muted-foreground">{label}</span>
        {applied && <Check className="size-3 shrink-0 text-brand" strokeWidth={3} aria-label="Selected" />}
      </span>
      <span
        className={cn(
          "break-words text-[12.5px] font-semibold leading-tight",
          disabled ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value ?? "—"}
      </span>
      <span className="break-words text-[10.5px] leading-snug text-muted-foreground">{reason}</span>
    </button>
  );
}

type LastDiscoverRun = {
  outcome: DiscoverOutcome;
  jobId: string;
  /** "pool" = Instant Pool / Ranked Instant; "live" = Live Discovery. */
  source: "pool" | "live";
  /** The exact request that was sent. */
  request: DiscoverRequestPayload;
  ranking?: PoolRankingInfo;
  liveFollowUp?: { available: boolean; remaining: number };
};

const CHANNEL_GLYPH = { email: "✉", phone: "☎", instagram: "ig", website: "🌐" } as const;

/** Contact icons for a saved opportunity: an icon means THIS RECORD has that
 * channel. Requested-but-missing channels are shown struck through so a record
 * that violates the AND channel contract is visible instead of looking like
 * it simply has fewer channels. Unrequested, absent channels are hidden. */
function ContactChannelIcons({ lead, requested }: { lead: LeadChannelSource; requested: readonly string[] }) {
  const shown = channelPresence(lead, requested).filter((c) => c.present || c.requested);
  return (
    <div className="flex gap-1.5 pt-1" data-testid="contact-channel-icons">
      {shown.map((c) => (
        <span
          key={c.id}
          data-channel={c.id}
          data-present={c.present ? "true" : "false"}
          title={c.present ? `${c.label} available` : `${c.label} was requested but is missing`}
          className={cn(
            "size-6 rounded border flex items-center justify-center text-[10px] font-bold",
            c.present
              ? "bg-brand/5 border-brand/10 text-brand"
              : "border-dashed border-destructive/40 text-destructive/70 line-through",
          )}
        >
          {CHANNEL_GLYPH[c.id]}
        </span>
      ))}
    </div>
  );
}

/** AI Overview — a compact briefing: your CURRENT search (from the active form
 * state), one main recommendation, and recommendations for the next search. Recommendation content comes from buildDiscoverInsights()
 * (or a future `briefing`); the extra insights stay one click away behind
 * "View detailed analysis". */
function DiscoverAiOverview({
  currentSetup,
  insights,
  loading,
  suggestions,
  applied,
  onApply,
  briefing,
}: {
  /** The ACTIVE form state, built by the same function that builds the request. */
  currentSetup: { niche: string; region: string; amount: string; channels: string; methodLabel: string };
  insights: DiscoverInsight[];
  loading: boolean;
  /** RECOMMENDATIONS for what to search next — not the configured search. See buildNextSearchSuggestions(). */
  suggestions: NextSearchSuggestions;
  applied: AiApplied;
  onApply: AiApply;
  /** Optional override, e.g. a real AI-generated recommendation. */
  briefing?: AiBriefing;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!loading && insights.length === 0 && !briefing) return null;

  const pool = insights.slice(0, 3);
  const extra = pool.slice(1);
  const main = briefing ?? (pool[0] ? insightToBriefing(pool[0]) : null);
  const ConfIcon = main ? CONFIDENCE_ICON[main.confidence] : TrendingUp;
  const [confHead, ...confRest] = (main?.confidence ?? "").split(" ");

  const channelLabel = suggestions.channel
    ? (channelOptions.find((c) => c.id === suggestions.channel!.value)?.short ?? suggestions.channel.value)
    : null;

  return (
    <section className={cn(panelSurface, "p-4 sm:p-5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-brand/25 bg-brand/[0.13] text-brand"
          >
            <Sparkles className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground">AI Overview</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Your current search, plus recommendations for what to try next.
            </p>
          </div>
        </div>
        {!loading && extra.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs font-medium text-foreground/90 transition-colors hover:border-white/25 hover:text-foreground"
          >
            {expanded ? "Hide detailed analysis" : "View detailed analysis"}
            <ArrowRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        )}
      </div>

      <div
        data-testid="ai-current-setup"
        className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-xs"
      >
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">Your search</span>
        <span><span className="text-muted-foreground">Niche </span><span data-field="niche" className="font-medium text-foreground">{currentSetup.niche}</span></span>
        <span><span className="text-muted-foreground">Region </span><span data-field="region" className="font-medium text-foreground">{currentSetup.region}</span></span>
        <span><span className="text-muted-foreground">Amount </span><span data-field="amount" className="font-medium text-foreground">{currentSetup.amount}</span></span>
        <span><span className="text-muted-foreground">Channels </span><span data-field="channels" className="font-medium text-foreground">{currentSetup.channels}</span></span>
        <span><span className="text-muted-foreground">Method </span><span data-field="method" className="font-medium text-foreground">{currentSetup.methodLabel}</span></span>
      </div>

      {loading || !main ? (
        <div className="mt-4 space-y-2">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
        </div>
      ) : (
        <>
          <div className="mt-3.5 grid gap-2.5 lg:grid-cols-[minmax(0,2.5fr)_minmax(0,2fr)]">
            {/* main recommendation */}
            <div className="relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-brand/25 bg-brand/[0.05] py-2.5 pl-4 pr-3 shadow-[0_0_30px_-18px_var(--brand)]">
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-brand to-brand/30" />
              <div className="min-w-0 flex-1">
                <p className="text-[10.5px] font-bold uppercase tracking-wider text-brand">{main.label}</p>
                <p className="mt-0.5 text-sm font-semibold leading-snug text-foreground">{main.headline}</p>
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{main.body}</p>
                {main.action && (
                  <div className="mt-1">
                    <BriefingAction action={main.action} tone={main.tone} />
                  </div>
                )}
              </div>
              <div className="flex w-[72px] shrink-0 flex-col items-center text-center">
                <span
                  aria-hidden="true"
                  className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/[0.12] text-brand"
                >
                  <ConfIcon className="size-4" strokeWidth={2.2} />
                </span>
                <span className={`mt-1 text-xs font-semibold leading-none ${CONFIDENCE_STYLES[main.confidence]}`}>
                  {confHead}
                </span>
                <span className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{confRest.join(" ")}</span>
              </div>
            </div>

            {/* RECOMMENDATIONS for the next search — distinct from "Your search" above */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SuggestionTile
                icon={Building2}
                tint={{ bg: "rgba(112,84,255,0.2)", fg: "#a99bff" }}
                label="Suggested niche"
                value={suggestions.niche?.value ?? null}
                reason={suggestions.niche?.reason ?? "Appears after your first run."}
                applied={applied.niche}
                onApply={onApply.niche}
              />
              <SuggestionTile
                icon={MapPin}
                tint={{ bg: "rgba(40,110,230,0.2)", fg: "#4c90ff" }}
                label="Suggested region"
                value={suggestions.region?.value ?? null}
                reason={suggestions.region?.reason ?? "Appears after your first run."}
                applied={applied.region}
                onApply={onApply.region}
              />
              <SuggestionTile
                icon={BarChart3}
                tint={{ bg: "rgba(20,184,150,0.18)", fg: "#2dd4a8" }}
                label="Suggested amount"
                value={suggestions.amount ? `${suggestions.amount.value.toLocaleString()} businesses` : null}
                reason={suggestions.amount?.reason ?? "No capacity left today."}
                applied={applied.amount}
                removable={false}
                onApply={onApply.amount}
              />
              <SuggestionTile
                icon={Link2}
                tint={{ bg: "rgba(236,72,153,0.18)", fg: "#ff5fb4" }}
                label="Suggested channel"
                value={channelLabel}
                reason={suggestions.channel?.reason ?? "No channels on your plan."}
                applied={applied.channel}
                onApply={onApply.channel}
              />
            </div>
          </div>

          {/* further insights from the same buildDiscoverInsights() output */}
          {expanded && extra.length > 0 && (
            <div className={cn("mt-3 grid gap-3", extra.length >= 2 && "md:grid-cols-2")}>
              {extra.map((insight) => (
                <div key={insight.id} className="space-y-1 rounded-xl border border-white/[0.06] bg-black/20 p-4">
                  <p className={`text-[10px] font-bold uppercase tracking-wider ${CONFIDENCE_STYLES[insight.confidence]}`}>
                    {insight.confidence}
                  </p>
                  <p className="text-[13px] font-medium leading-snug text-foreground/90">{insight.title}</p>
                  <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{insight.reason}</p>
                  <BriefingAction action={{ label: insight.actionLabel, href: insight.actionHref }} tone={insight.tone} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
