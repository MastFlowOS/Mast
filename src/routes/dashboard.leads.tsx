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
  CheckSquare,
  Check,
  Lock,
  ArrowRight,
  BarChart3,
  MapPin,
} from "lucide-react";
import { ApiError, subscribeToDiscoverJob, cancelDiscoverJob, type Lead } from "@/lib/api";

import { useAccount, useAnalytics, useGenerateLeads, useLeads, useSettings, queryKeys } from "@/hooks/use-mast-api";
import { useLiveDiscoveryState } from "@/hooks/use-live-discovery";
import { LiveDiscoveryScreen } from "@/components/mast/LiveDiscoveryScreen";
import { useQueryClient } from "@tanstack/react-query";
import { buildDiscoverInsights, type DiscoverInsight } from "@/lib/discover-insights";
import { usePermissions } from "@/hooks/use-permissions";
import { FeatureGate } from "@/components/mast/FeatureGate";
import { type FeatureId } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { DiscoverGlobe } from "@/components/mast/discover/DiscoverGlobe";
import { NicheCarousel } from "@/components/mast/discover/NicheCarousel";
import {
  AmountSlider,
  PlanCard,
  StepCard,
  SummaryCard,
  panelSurface,
  type SummaryRow,
} from "@/components/mast/discover/DiscoverPanels";
import { COUNTRIES, REGION_NAMES } from "@/lib/geo/countries";
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

/** Compact "Top Picks" shown first in the Target Region selector. */
const TOP_PICK_COUNTRIES: Region[] = ["United States", "United Kingdom", "Canada"];

/** Every supported country, A→Z (the same data discovery searches). */
const COUNTRY_NAMES: Region[] = COUNTRIES.map((c) => c.name).sort((a, b) => a.localeCompare(b));

/** Broader scopes the backend also supports; offered under "Regions" in the
 * search results so existing continent/Global capability is not lost. */
const BROAD_SCOPES: Region[] = [...REGION_NAMES, GLOBAL_SCOPE];

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
  const [regions, setRegions] = useState<Region[]>([TOP_PICK_COUNTRIES[0]]);
  // Target Region selector UI state (Top Picks are always visible; the
  // search box filters the full REGIONS list).
  const [regionSearch, setRegionSearch] = useState("");
  const [regionDropdownOpen, setRegionDropdownOpen] = useState(false);
  const regionContainerRef = useRef<HTMLDivElement>(null);

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
  // The discovery_plans.id for the CURRENT live-mode (Free tier) run, if
  // any — only present when the backend actually created a plan (queued
  // live discovery). Drives the real live Discovery screen below; null for
  // Instant Discovery (Starter/Pro/Premium pool lookups), which has no
  // Scout-level live events to show.
  const [planId, setPlanId] = useState<string | null>(null);
  // Seeds the live-state's running delivered count for the paid-tier
  // pool-shortfall backfill case, where some results may already have been
  // delivered synchronously (from the pool) before this plan existed — see
  // useLiveDiscoveryState's doc comment. Always 0 for Free's Live
  // Discovery, which never has synchronous pool results.
  const [initialDeliveredForPlan, setInitialDeliveredForPlan] = useState(0);
  const liveDiscoveryState = useLiveDiscoveryState(planId, quantity, initialDeliveredForPlan);


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

  // Close the region search dropdown on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!regionContainerRef.current?.contains(e.target as Node)) {
        setRegionDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  const regionQuery = regionSearch.trim().toLowerCase();
  const matchesRegionQuery = (r: Region) => r.toLowerCase().includes(regionQuery);
  // Names that START with the query rank first ("u" → United …, Uganda …),
  // then the rest; both groups stay A→Z.
  const startsWithQuery = (r: Region) => r.toLowerCase().startsWith(regionQuery);
  const filteredCountries = COUNTRY_NAMES.filter(matchesRegionQuery).sort(
    (a, b) => Number(startsWithQuery(b)) - Number(startsWithQuery(a)),
  );
  // Continents / Global only appear once the user is actually searching, so
  // the default list stays a pure country list.
  const filteredBroadScopes = regionQuery ? BROAD_SCOPES.filter(matchesRegionQuery) : [];
  const firstRegionMatch = filteredCountries[0] ?? filteredBroadScopes[0];

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

  const handleGenerate = async () => {
    if (!canGenerate) return;

    // Clean up any previous subscription before starting a new search.
    unsubscribeJobRef.current?.();
    unsubscribeJobRef.current = null;
    seenLeadIdsRef.current = new Set();
    activeJobIdRef.current = null;
    setIsCancelling(false);
    setPlanId(null);
    setInitialDeliveredForPlan(0);

    setIsGenerating(true);
    setShowCompletion(false);
    setNewOpportunities([]);

    const startTime = Date.now();

    // A very short minimum so an instant, fully-cached Instant Discovery
    // response doesn't flash the loading screen for a single frame — not a
    // fabricated delay, just enough to avoid visual flicker.
    const MIN_VISIBLE_MS = 700;

    const finish = (finalCount: number) => {
      unsubscribeJobRef.current?.();
      unsubscribeJobRef.current = null;

      const elapsed = Date.now() - startTime;
      const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);

      setTimeout(() => {
        setIsGenerating(false);
        setShowCompletion(true);
        toast.success(`${finalCount} opportunities added to pipeline`);
        addNotification({
          icon: "CheckCircle2",
          iconColor: "text-emerald-400",
          iconBg: "bg-emerald-400/10 border-emerald-400/20",
          title: "Leads Generated",
          body: `Successfully generated ${finalCount} new opportunities for your pipeline.`,
          category: "notifyNewLead",
        });
        // Final sync — credits/counters/CRM/analytics all reflect what was
        // actually delivered, not just the initial (possibly partial) batch.
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
        quantity,
        region: regions.join(", "),
        niche: niches.join(", "),
        // Legacy/informational field, kept for type back-compat only.
        mode: generationModeFor(selectedMethod.id),
        // The actual chosen Discovery Method — this IS honored by the
        // server (re-validated there against the resolved plan).
        method: selectedMethod.id,
        // Pass-through-unchanged contract — see channelsForRequest's
        // docstring. Whatever the user selected (any AND-combination,
        // including a single channel) reaches the engine exactly as
        // selected; no default, dedup, or OR-conversion happens here.
        channels: channelsForRequest(channels),
        // Business Currency was removed from Discover. The request contract
        // still carries the field, so send the explicit empty default.
        currencies: [],
      });

      // Whatever arrived synchronously (Instant Discovery's pool hit) shows
      // immediately.
      result.leads.forEach(appendLead);

      if (!result.pending) {
        // Nothing more coming — Instant Discovery fully satisfied the
        // request from the pool alone.
        finish(result.leads.length);
        return;
      }

      // Free's Live Discovery (nothing delivered yet), or an Instant
      // Discovery shortfall still being backfilled — either way, watch the
      // SAME job id until it resolves. The UI never needs to know which.
      activeJobIdRef.current = result.jobId;
      // Both Free's Live Discovery AND a paid-tier Instant Discovery
      // request whose pool fell short (and is now backfilling live) have a
      // real discovery_plans row — result.planId is only undefined when no
      // live scraping is happening at all (a pure pool hit, or a
      // background-only expansion with no user waiting). `result.generated`
      // is whatever the pool already delivered synchronously by the time
      // this response landed (0 for Live Discovery, which never has
      // synchronous pool results) — seeding the live state's delivered
      // count with it is what keeps the backfill's progress from
      // momentarily resetting to 0 once the Scout screen takes over.
      if (result.planId) {
        setInitialDeliveredForPlan(result.generated);
        setPlanId(result.planId);
      }
      unsubscribeJobRef.current = subscribeToDiscoverJob(
        result.jobId,
        {
          onLead: appendLead,
          onStatusChange: (status) => {
            if (status === "completed") {
              finish(seenLeadIdsRef.current.size);
            } else if (status === "completed_partial") {
              // Engine reached genuine exhaustion before hitting the full count.
                      unsubscribeJobRef.current?.();
              unsubscribeJobRef.current = null;
              activeJobIdRef.current = null;
              setIsGenerating(false);
              setIsCancelling(false);
              const found = seenLeadIdsRef.current.size;
              setShowCompletion(true);
              toast.info(
                found > 0
                  ? `Found ${found} opportunities — market is thin for this query.`
                  : "Market exhausted. No new opportunities available for this combination.",
              );
              queryClient.invalidateQueries({ queryKey: queryKeys.account });
              queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
            } else if (status === "cancelled") {
                      unsubscribeJobRef.current?.();
              unsubscribeJobRef.current = null;
              activeJobIdRef.current = null;
              setIsGenerating(false);
              setIsCancelling(false);
              const found = seenLeadIdsRef.current.size;
              if (found > 0) {
                setShowCompletion(true);
                toast.info(`Search cancelled — ${found} opportunit${found === 1 ? "y" : "ies"} saved.`);
                queryClient.invalidateQueries({ queryKey: queryKeys.account });
                queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
              } else {
                toast.info("Search cancelled.");
              }
            } else if (status === "failed") {
                      unsubscribeJobRef.current?.();
              unsubscribeJobRef.current = null;
              activeJobIdRef.current = null;
              setIsGenerating(false);
              setIsCancelling(false);
              toast.error("Discovery engine failed. Please try again.");
            }
          },
        },
        { requestedQuantity: quantity },
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
    return <LiveDiscoveryScreen state={liveDiscoveryState} onCancel={handleCancelSearch} isCancelling={isCancelling} />;
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

          {/* Success Check Icon */}
          <div className="flex justify-center">
            <div className="size-16 rounded-full bg-brand/10 border border-brand/20 flex items-center justify-center shadow-brand/10 shadow-lg animate-bounce">
              <span className="text-2xl text-brand font-bold">✓</span>
            </div>
          </div>

          {/* Wording */}
          <div className="space-y-2 max-w-md mx-auto">
            <h1 className="text-2xl font-bold text-foreground tracking-tight">
              {newOpportunities.length} new opportunities prepared
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Outreach channels have been verified and intelligence workspaces initialized. Everything is ready to launch outreach campaigns.
            </p>
          </div>

          {/* CTAs */}
          <div className="flex flex-sm-row items-center justify-center gap-3 pt-2">
            <button
              onClick={handleBeginOutreach}
              className="w-full sm:w-auto px-8 py-3.5 bg-brand hover:bg-brand-dark text-brand-foreground font-bold rounded-xl shadow-brand hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer text-sm"
            >
              <Zap className="size-4" /> Begin Outreach
            </button>
            <button
              onClick={() => {
                setShowCompletion(false);
                setNewOpportunities([]);
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
                  <div className="flex gap-1.5 pt-1">
                    {opp.email && (
                      <span className="size-6 rounded bg-brand/5 border border-brand/10 flex items-center justify-center text-[10px] text-brand font-bold">
                        ✉
                      </span>
                    )}
                    {opp.phone && (
                      <span className="size-6 rounded bg-brand/5 border border-brand/10 flex items-center justify-center text-[10px] text-brand font-bold">
                        ☎
                      </span>
                    )}
                    {opp.instagramHandle && (
                      <span className="size-6 rounded bg-brand/5 border border-brand/10 flex items-center justify-center text-[10px] text-brand font-bold">
                        ig
                      </span>
                    )}
                    {opp.website && (
                      <span className="size-6 rounded bg-brand/5 border border-brand/10 flex items-center justify-center text-[10px] text-brand font-bold">
                        🌐
                      </span>
                    )}
                  </div>
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
    <div className="relative mx-auto max-w-[1500px] animate-page-enter px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_368px]">
        {/* ── Left: hero + the five steps + launch ─────────────────── */}
        <div className="@container min-w-0">
          <div style={{ ["--g" as string]: "clamp(190px, 36cqw, 400px)" }}>
            {/* Hero */}
            <div className="relative flex flex-col items-center overflow-x-clip @2xl:block @2xl:h-[var(--g)]">
              <div className="@2xl:absolute @2xl:left-[63%] @2xl:top-0 @2xl:-translate-x-1/2">
                <DiscoverGlobe regions={regions} niches={niches} />
              </div>
              <div className="relative z-10 mt-8 text-center @2xl:mt-0 @2xl:max-w-[30rem] @2xl:pt-7 @2xl:text-left">
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

            <div className="relative z-10 mt-7 space-y-4 @2xl:-mt-[calc(var(--g)*0.12)]">
              {/* Row 1 — niche (full width: the carousel needs the room). */}
              <div className="relative z-10">
                <StepCard
                  step={1}
                  icon={Sparkles}
                  title="Business Niche"
                  hint="Required · pick one or more"
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
                      className="h-11 w-full rounded-xl border border-white/10 bg-black/25 pl-10 pr-10 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-brand/35"
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
                      niches={filteredNiches}
                      selected={niches}
                      focused={focusedNiche}
                      query={nicheSearch}
                      onToggle={toggleNiche}
                    />
                  </div>
                </StepCard>
              </div>

              {/* Row 2 — amount · region. z-20 so the region dropdown floats
                  over the cards below it. */}
              <div className="relative z-20 grid gap-4 @2xl:grid-cols-2">
                <StepCard
                  step={2}
                  icon={BarChart3}
                  title="Opportunity Amount"
                  hint={`Plan max: ${maxQuantity.toLocaleString()}`}
                >
                  <AmountSlider
                    steps={QUANTITY_STEPS}
                    index={qtyIndex}
                    maxIndex={maxSliderIndex}
                    onChange={setQtyIndex}
                  />
                </StepCard>

                <StepCard step={3} icon={MapPin} title="Target Region" hint="Top picks">
                  <div ref={regionContainerRef} className="relative space-y-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {[...TOP_PICK_COUNTRIES, ...regions.filter((r) => !TOP_PICK_COUNTRIES.includes(r))].map((r) => {
                        const isSelected = regions.includes(r);
                        const isLocked = !hasRegionalSearch && !isLocalGeoToken(r);
                        return (
                          <ChoiceChip
                            key={r}
                            selected={isSelected}
                            locked={isLocked}
                            onClick={() => toggleRegion(r)}
                          >
                            {r}
                          </ChoiceChip>
                        );
                      })}
                    </div>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="text"
                        role="combobox"
                        aria-expanded={regionDropdownOpen}
                        aria-controls="region-listbox"
                        aria-autocomplete="list"
                        placeholder="Search countries…"
                        value={regionSearch}
                        onChange={(e) => {
                          setRegionSearch(e.target.value);
                          setRegionDropdownOpen(true);
                        }}
                        onFocus={() => setRegionDropdownOpen(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setRegionDropdownOpen(false);
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (firstRegionMatch) {
                              toggleRegion(firstRegionMatch);
                              setRegionSearch("");
                              setRegionDropdownOpen(false);
                            }
                          }
                        }}
                        className="h-10 w-full rounded-xl border border-white/10 bg-black/25 pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-brand/35"
                      />
                      {regionDropdownOpen && (
                        <div
                          id="region-listbox"
                          role="listbox"
                          aria-multiselectable="true"
                          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-52 overflow-y-auto rounded-xl border border-border bg-card shadow-lg"
                        >
                          {filteredCountries.length + filteredBroadScopes.length > 0 ? (
                            <>
                              {filteredCountries.map((r) => (
                                <RegionOption
                                  key={r}
                                  label={r}
                                  selected={regions.includes(r)}
                                  locked={!hasRegionalSearch && !isLocalGeoToken(r)}
                                  onPick={() => {
                                    toggleRegion(r);
                                    setRegionSearch("");
                                  }}
                                />
                              ))}
                              {filteredBroadScopes.length > 0 && (
                                <p className="border-t border-border/60 px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                                  Regions
                                </p>
                              )}
                              {filteredBroadScopes.map((r) => (
                                <RegionOption
                                  key={r}
                                  label={r}
                                  selected={regions.includes(r)}
                                  locked={!hasRegionalSearch && !isLocalGeoToken(r)}
                                  onPick={() => {
                                    toggleRegion(r);
                                    setRegionSearch("");
                                  }}
                                />
                              ))}
                            </>
                          ) : (
                            <div className="px-3 py-2.5 text-xs text-muted-foreground">
                              No countries match "{regionSearch}"
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </StepCard>
              </div>

              {/* Rows 3–4 — channels, method */}
              <div className="relative z-10 space-y-4">
                <StepCard
                  step={4}
                  icon={Mail}
                  title="Contact Channels"
                  hint="More channels = stricter matching and fewer results"
                >
                  <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
                    {channelOptions.map((c) => {
                      const active = channels.includes(c.id);
                      const isLocked = !permissions.can(channelToFeature[c.id]);
                      return (
                        <ChoiceChip
                          key={c.id}
                          selected={active}
                          locked={isLocked}
                          onClick={() => toggleChannel(c.id)}
                          icon={<c.icon className="size-4 shrink-0" />}
                          size="md"
                          className="h-11 w-full"
                        >
                          {c.short}
                        </ChoiceChip>
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
                >
                  <ul className="grid gap-2 @3xl:grid-cols-3" aria-label="Discovery methods">
                    {DISCOVERY_METHODS.map((m) => {
                      const isSelected = m.id === selectedMethod.id;
                      const isEligible = isDiscoveryMethodEligible(permissions.plan, m.id);
                      return (
                        <li key={m.id} className="flex">
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
                            className={cn(
                              "flex w-full cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/60",
                              isSelected
                                ? "border-brand/60 bg-brand/[0.1] shadow-[0_0_22px_-10px_var(--brand)]"
                                : isEligible
                                  ? "border-white/10 bg-black/20 hover:border-white/25"
                                  : "border-white/10 bg-black/20 opacity-60",
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-foreground">{m.label}</span>
                                {/* PLAN BADGE — minimum plan required, always shown. */}
                                <span className="rounded bg-white/[0.07] px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                  {m.minPlanLabel}
                                </span>
                                {/* SELECTED — the user's current choice, shown separately. */}
                                {isSelected && (
                                  <span className="rounded bg-brand/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-brand">
                                    Selected
                                  </span>
                                )}
                              </span>
                              <span className="block text-xs leading-snug text-muted-foreground">{m.desc}</span>
                              {isSelected && (
                                <span className="mt-1 block text-[11px] text-muted-foreground/80">{m.note}</span>
                              )}
                              {!isEligible && (
                                <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/80">
                                  <Lock className="size-3 shrink-0" aria-label={`Locked — requires ${m.minPlanLabel}`} />
                                  Requires {m.minPlanLabel}
                                </span>
                              )}
                            </span>
                            <span
                              className={cn(
                                "shrink-0 pt-0.5 text-[11px] font-bold uppercase tabular-nums tracking-wider",
                                isSelected ? "text-brand" : "text-muted-foreground",
                              )}
                            >
                              {m.timeLabel}
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
        <DiscoverAiOverview insights={discoverInsights} loading={!account || !analytics} />
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

/** Compact selectable chip. A locked chip stays clickable on purpose: the
 * parent handler shows the plan-upgrade toast, exactly as before. */
function ChoiceChip({
  selected,
  locked,
  onClick,
  icon,
  size = "sm",
  className,
  children,
}: {
  selected: boolean;
  locked?: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border font-medium transition-colors cursor-pointer",
        size === "md" ? "h-9 px-3 text-[13px]" : "h-8 px-2.5 text-xs",
        selected
          ? "border-brand/60 bg-brand/[0.14] text-foreground shadow-[0_0_18px_-8px_var(--brand)]"
          : "border-white/10 bg-black/20 text-muted-foreground hover:text-foreground hover:border-white/25",
        locked && "opacity-60",
        className,
      )}
    >
      {icon}
      {children}
      {selected && !locked && <Check className="size-3 text-brand shrink-0" strokeWidth={3} />}
      {locked && <Lock className="size-3 shrink-0" aria-label="Locked on your plan" />}
    </button>
  );
}

function RegionOption({
  label,
  selected,
  locked,
  onPick,
}: {
  label: string;
  selected: boolean;
  locked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      role="option"
      aria-selected={selected}
      // Keep focus in the search input between picks.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cn(
        "w-full flex items-center justify-between px-3 py-2 text-xs transition-colors text-left hover:bg-muted/40",
        selected ? "text-brand font-medium" : "text-foreground",
        locked && "opacity-55"
      )}
    >
      <span>{label}</span>
      {locked ? (
        <Lock className="size-3 text-muted-foreground shrink-0" />
      ) : selected ? (
        <CheckSquare className="size-3.5 text-brand shrink-0" />
      ) : null}
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

/** AI Overview band. Content is exactly buildDiscoverInsights()'s output
 * — nothing is generated here. The top insight leads; the remaining ones
 * (up to the same 3 as before) are one click away and fill the row. */
function DiscoverAiOverview({
  insights,
  loading,
}: {
  insights: DiscoverInsight[];
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!loading && insights.length === 0) return null;

  const pool = insights.slice(0, 3);
  const shown = expanded ? pool : pool.slice(0, 1);
  const hiddenCount = pool.length - shown.length;

  return (
    <section className={cn(panelSurface, "p-4 sm:p-5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-xl border border-brand/25 bg-brand/[0.13] text-brand"
          >
            <Sparkles className="size-[18px]" />
          </span>
          <h2 className="text-[15px] font-semibold text-foreground">AI Overview</h2>
        </div>
        {!loading && pool.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="cursor-pointer text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? "Show less" : `${hiddenCount} more insight${hiddenCount === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-full animate-pulse rounded bg-muted/40" />
        </div>
      ) : (
        <div
          className={cn(
            "mt-4 grid gap-3",
            shown.length === 2 && "md:grid-cols-2",
            shown.length >= 3 && "md:grid-cols-3",
          )}
        >
          {shown.map((insight) => {
            const isRoute = insight.actionHref.startsWith("/");
            const actionClass = `inline-flex items-center text-xs font-semibold transition-colors cursor-pointer ${INSIGHT_ACTION_STYLES[insight.tone]}`;
            return (
              <div
                key={insight.id}
                className="space-y-1 rounded-xl border border-white/[0.06] bg-black/20 p-4"
              >
                <p className={`text-[10px] font-bold uppercase tracking-wider ${CONFIDENCE_STYLES[insight.confidence]}`}>
                  {insight.confidence}
                </p>
                <p className="text-[13px] font-medium leading-snug text-foreground/90">{insight.title}</p>
                <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{insight.reason}</p>
                {isRoute ? (
                  <a href={insight.actionHref} className={actionClass}>
                    {insight.actionLabel}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.querySelector(insight.actionHref) as HTMLElement | null;
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      el?.focus?.();
                    }}
                    className={actionClass}
                  >
                    {insight.actionLabel}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
