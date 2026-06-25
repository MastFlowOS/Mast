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
  Globe2,
  Target,
  Gauge,
  Sparkles,
  Lock,
  Mail,
  Phone,
  Link2,
  Instagram,
  X,
  Search,
  CheckSquare,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";
import { ApiError, type Lead } from "@/lib/api";
import { useAccount, useGenerateLeads } from "@/hooks/use-mast-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/leads")({
  head: () => ({ meta: [{ title: "Get Leads — Mast" }] }),
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

const REGIONS = [
  "North America",
  "South America",
  "Europe",
  "Asia",
  "Africa",
  "Oceania",
  "Global",
] as const;

type Region = (typeof REGIONS)[number];

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

const speeds = [
  {
    id: "scrape",
    label: "Live Scraping",
    desc: "Fresh records pulled in real time",
    premium: false,
    multiplier: 1.0,
  },
  {
    id: "pool",
    label: "Instant Pool Access",
    desc: "Tap into the pre-built lead pool",
    premium: false,
    multiplier: 1.5,
  },
  {
    id: "premium",
    label: "Premium Instant Results",
    desc: "Decision-maker pool, mobile-verified",
    premium: true,
    multiplier: 2.0,
  },
];

// Channel definitions — ordered: Phone > Email > Instagram > Website
const channelOptions = [
  { id: "phone", label: "Phone Number", icon: Phone },
  { id: "email", label: "Verified Email", icon: Mail },
  { id: "instagram", label: "Instagram", icon: Instagram },
  { id: "website", label: "Website", icon: Link2 },
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

/**
 * Base cost per lead based on selected channels.
 * Defined as a lookup table per spec:
 *   Email only                          → 1
 *   Email + Phone                       → 2
 *   Email + Phone + Instagram           → 3
 *   Email + Phone + Instagram + Website → 5
 * Any other combination falls back to the number of channels selected.
 */
function baseLeadCost(channels: ChannelId[]): number {
  const has = (id: ChannelId) => channels.includes(id);
  if (has("email") && has("phone") && has("instagram") && has("website")) return 5;
  if (has("email") && has("phone") && has("instagram")) return 3;
  if (has("email") && has("phone")) return 2;
  if (has("email")) return 1;
  // Non-standard combinations: 1 credit per channel selected, minimum 1
  return Math.max(1, channels.length);
}

/**
 * Region multiplier per spec:
 *   Global         → ×2.0
 *   4+ regions     → ×1.6
 *   3 regions      → ×1.4
 *   2 regions      → ×1.2
 *   1 region       → ×1.0
 */
function regionMultiplier(regions: Region[]): number {
  if (regions.includes("Global")) return 2.0;
  if (regions.length >= 4) return 1.6;
  if (regions.length === 3) return 1.4;
  if (regions.length === 2) return 1.2;
  return 1.0;
}

/**
 * Niche multiplier per spec:
 *   6+ niches  → ×1.4
 *   3–5 niches → ×1.2
 *   2 niches   → ×1.1
 *   0–1 niche  → ×1.0
 */
function nicheMultiplier(niches: string[]): number {
  if (niches.length >= 6) return 1.4;
  if (niches.length >= 3) return 1.2;
  if (niches.length === 2) return 1.1;
  return 1.0;
}

/**
 * Final cost formula:
 *   Quantity × baseLeadCost × regionMultiplier × nicheMultiplier × modeMultiplier
 * Rounded to nearest whole credit, minimum 1.
 */
function calcCredits(
  qty: number,
  channels: ChannelId[],
  regions: Region[],
  niches: string[],
  speedId: string,
): number {
  const modeMultiplier = speeds.find((s) => s.id === speedId)?.multiplier ?? 1.0;
  const raw = qty * baseLeadCost(channels) * regionMultiplier(regions) * nicheMultiplier(niches) * modeMultiplier;
  return Math.max(1, Math.round(raw));
}

// ─── Main Component ────────────────────────────────────────────────────────────

function GetLeads() {
  const navigate = useNavigate();

  const { data: account } = useAccount();
  const generate = useGenerateLeads();

  // Quantity state — stored as step index (0–20)
  const [qtyIndex, setQtyIndex] = useState<number>(qtyToSliderIndex(50));
  const quantity = sliderIndexToQty(qtyIndex);

  // Multi-select regions
  const [regions, setRegions] = useState<Region[]>(["North America"]);

  // Searchable multi-select niches
  const [niches, setNiches] = useState<string[]>([]);
  const [nicheSearch, setNicheSearch] = useState("");
  const [nicheDropdownOpen, setNicheDropdownOpen] = useState(false);
  const nicheRef = useRef<HTMLDivElement>(null);

  // Channels & generation mode
  const [speed, setSpeed] = useState(speeds[0].id);
  const [channels, setChannels] = useState<ChannelId[]>(["email", "phone"]);
  const [lastGenerated, setLastGenerated] = useState<Lead[]>([]);

  const maxQuantity = account?.limits.maxLeadRequest ?? 100;
  const dailyRemaining = account?.dailyUsage.remaining ?? 0;
  const monthlyRemaining = account?.monthlyUsage.remaining ?? 0;
  const currentSpeed = speeds.find((s) => s.id === speed)!;
  const hasPremiumAccess = account?.limits.allowPremiumPool ?? false;

  // Close niche dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (nicheRef.current && !nicheRef.current.contains(e.target as Node)) {
        setNicheDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggleRegion = (r: Region) => {
    if (r === "Global") {
      setRegions(["Global"]);
    } else {
      setRegions((prev) => {
        const withoutGlobal = prev.filter((x) => x !== "Global");
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

  const toggleChannel = (id: ChannelId) =>
    setChannels((c) =>
      c.includes(id) ? c.filter((x) => x !== id) : [...c, id]
    );

  const filteredNiches = NICHE_CATALOG.filter((n) =>
    n.toLowerCase().includes(nicheSearch.toLowerCase())
  );

  const channelRestricted = account
    ? channels.some(
        (channel) => !account.limits.allowedChannels.includes(channel)
      )
    : false;
  const modeRestricted =
    account &&
    ((speed === "pool" && !account.limits.allowInstantPool) ||
      (speed === "premium" && !account.limits.allowPremiumPool));
  const exceedsDailyLimit = account ? quantity > dailyRemaining : false;
  const exceedsMonthlyLimit = account ? quantity > monthlyRemaining : false;
  const canGenerate =
    !!account &&
    channels.length > 0 &&
    !channelRestricted &&
    !modeRestricted &&
    !exceedsDailyLimit &&
    !exceedsMonthlyLimit &&
    !generate.isPending;

  const handleGenerate = async () => {
    try {
      const result = await generate.mutateAsync({
        quantity,
        region: regions.join(", "),
        niche: niches.length > 0 ? niches.join(", ") : "General",
        mode: speed as "scrape" | "pool" | "premium",
        channels,
      });
      setLastGenerated(result.leads);
      toast.success(`Generated ${result.generated.toLocaleString()} leads`, {
        description: `${result.generated.toLocaleString()} leads consumed from your allowance.`,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.message.includes("LIMIT_EXCEEDED_DAILY")) {
          toast.error("Daily limit reached", { description: `You have ${dailyRemaining} leads remaining today.` });
        } else if (err.message.includes("LIMIT_EXCEEDED_MONTHLY")) {
          toast.error("Monthly limit reached", { description: `You have ${monthlyRemaining} leads remaining this month.` });
        } else if (err.message.includes("LIMIT_EXCEEDED_BOTH")) {
          toast.error("Limits reached", { description: "Both your daily and monthly lead allowances are exhausted." });
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Lead generation failed.");
      }
    }
  };

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-8">
        <span className="text-xs font-bold text-brand uppercase tracking-widest">
          Lead Generator
        </span>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Generate sales-ready leads in minutes
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Configure your search. Mast returns verified emails, mobile numbers,
          websites, and Instagram profiles — outreach-ready.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-7 space-y-7">
          {/* ── Quantity ─────────────────────────────────────────── */}
          <Section
            icon={Target}
            title="Quantity"
            subtitle="How many leads to generate?"
          >
            <div className="space-y-3">
              <input
                type="range"
                min={0}
                max={QUANTITY_STEPS.length - 1}
                step={1}
                value={qtyIndex}
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  const qty = sliderIndexToQty(idx);
                  if (qty <= maxQuantity) setQtyIndex(idx);
                }}
                className="w-full accent-[color:var(--brand)]"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1</span>
                <span className="text-foreground font-bold text-lg">
                  {quantity.toLocaleString()} leads
                </span>
                <span>100</span>
              </div>
            </div>
          </Section>

          {/* ── Region ───────────────────────────────────────────── */}
          <Section
            icon={Globe2}
            title="Region"
            subtitle="Select one or more target regions"
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {REGIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => toggleRegion(r)}
                  className={
                    regions.includes(r)
                      ? "px-3 py-2 rounded-lg border-2 border-brand bg-brand/10 text-foreground text-sm font-medium text-center"
                      : "px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 text-sm font-medium text-center transition-colors"
                  }
                >
                  {r}
                </button>
              ))}
            </div>
          </Section>

          {/* ── Niche ────────────────────────────────────────────── */}
          <Section
            icon={Sparkles}
            title="Niche"
            subtitle="Search and select one or more verticals"
          >
            <div ref={nicheRef} className="relative">
              {/* Selected niche chips */}
              {niches.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {niches.map((n) => (
                    <span
                      key={n}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand/10 border border-brand/20 text-xs font-medium text-foreground"
                    >
                      {n}
                      <button
                        onClick={() => removeNiche(n)}
                        className="text-muted-foreground hover:text-foreground ml-0.5"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search niches… (e.g. Restaurant, Marketing Agency)"
                  value={nicheSearch}
                  onChange={(e) => {
                    setNicheSearch(e.target.value);
                    setNicheDropdownOpen(true);
                  }}
                  onFocus={() => setNicheDropdownOpen(true)}
                  className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand placeholder:text-muted-foreground"
                />
              </div>

              {/* Dropdown */}
              {nicheDropdownOpen && filteredNiches.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-xl shadow-lg max-h-56 overflow-y-auto">
                  {filteredNiches.map((n) => {
                    const selected = niches.includes(n);
                    return (
                      <button
                        key={n}
                        onClick={() => {
                          toggleNiche(n);
                          setNicheSearch("");
                        }}
                        className={`w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-muted/40 transition-colors text-left ${
                          selected
                            ? "text-brand font-medium"
                            : "text-foreground"
                        }`}
                      >
                        <span>{n}</span>
                        {selected && (
                          <CheckSquare className="size-4 text-brand shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {nicheDropdownOpen &&
                nicheSearch.length > 0 &&
                filteredNiches.length === 0 && (
                  <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-xl shadow-lg px-4 py-3 text-sm text-muted-foreground">
                    No niches match "{nicheSearch}"
                  </div>
                )}
            </div>
          </Section>

          {/* ── Channels ─────────────────────────────────────────── */}
          <Section
            icon={Mail}
            title="Outreach Channels"
            subtitle="Credit cost increases per channel tier"
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {channelOptions.map((c) => {
                const active = channels.includes(c.id);
                const creditLabel =
                  c.id === "email"
                    ? "Lowest cost"
                    : c.id === "phone"
                      ? "Low cost"
                      : c.id === "instagram"
                        ? "Med cost"
                        : "High cost";
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleChannel(c.id)}
                    className={
                      active
                        ? "flex flex-col items-start gap-1 px-3 py-2.5 rounded-lg border-2 border-brand bg-brand/10 text-foreground text-sm font-medium"
                        : "flex flex-col items-start gap-1 px-3 py-2.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 text-sm font-medium transition-colors"
                    }
                  >
                    <div className="flex items-center gap-2">
                      <c.icon
                        className={
                          active ? "size-4 text-brand" : "size-4"
                        }
                      />
                      {c.label}
                    </div>
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide ${active ? "text-brand/70" : "text-muted-foreground/60"}`}
                    >
                      {creditLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* ── Generation Mode ──────────────────────────────────── */}
          <Section
            icon={Gauge}
            title="Generation Mode"
            subtitle="Live scraping vs. instant lead pool access"
          >
            <div className="grid sm:grid-cols-3 gap-3">
              {speeds.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSpeed(s.id)}
                  disabled={
                    (s.id === "pool" && account
                      ? !account.limits.allowInstantPool
                      : false) ||
                    (s.id === "premium" && account
                      ? !account.limits.allowPremiumPool
                      : false)
                  }
                  className={
                    speed === s.id
                      ? "text-left p-4 rounded-xl border-2 border-brand bg-brand/5 relative"
                      : "text-left p-4 rounded-xl border border-border hover:border-muted-foreground/40 transition-colors disabled:opacity-45"
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm">{s.label}</span>
                    {s.premium && (
                      <span className="text-[9px] font-bold bg-brand/15 text-brand px-2 py-0.5 rounded uppercase tracking-wider border border-brand/20">
                        Premium
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {s.desc}
                  </p>
                  <p className="text-[10px] text-brand font-bold uppercase tracking-wider mt-2">
                    ×{s.multiplier.toFixed(1)} credits
                  </p>
                </button>
              ))}
            </div>
          </Section>
        </div>

        {/* ── Order Summary / CTA ──────────────────────────────────── */}
        <aside className="space-y-5">
          <div className="bg-card border border-border rounded-2xl p-6">
            <h3 className="font-bold mb-4">Order Summary</h3>
            <div className="space-y-3 text-sm">
              <Row
                label="Quantity"
                value={`${quantity.toLocaleString()} leads`}
              />
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground shrink-0">Regions</span>
                <span className="text-foreground font-medium text-right">
                  {regions.join(", ")}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground shrink-0">Niches</span>
                <span className="text-foreground font-medium text-right">
                  {niches.length > 0 ? niches.join(", ") : "Any"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground shrink-0">Channels</span>
                <span className="text-foreground font-medium text-right">
                  {channels.length > 0
                    ? channelOptions
                        .filter((c) => channels.includes(c.id))
                        .map((c) => c.label)
                        .join(", ")
                    : "None"}
                </span>
              </div>
              <Row label="Mode" value={currentSpeed.label} />
            </div>
            <div className="my-5 h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Leads to consume
              </span>
              <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                <TrendingUp className="size-4 text-brand" />
                {quantity.toLocaleString()} leads
              </span>
            </div>
            <div className="mt-3 flex gap-3 text-[11px]">
              <span className="text-muted-foreground">
                Daily remaining: <span className="text-foreground font-semibold">{dailyRemaining.toLocaleString()}</span>
              </span>
              <span className="text-muted-foreground">
                Monthly: <span className="text-foreground font-semibold">{monthlyRemaining.toLocaleString()}</span>
              </span>
            </div>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="mt-5 w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold shadow-brand inline-flex items-center justify-center gap-2 disabled:opacity-55 disabled:hover:bg-brand"
            >
              <Zap className="size-4" />{" "}
              {generate.isPending ? "Generating..." : "Generate Leads"}
            </button>
            {(channelRestricted || modeRestricted || exceedsDailyLimit || exceedsMonthlyLimit) && (
              <p className="text-[11px] text-destructive text-center mt-2">
                {exceedsDailyLimit
                  ? `Daily limit: only ${dailyRemaining} leads left today.`
                  : exceedsMonthlyLimit
                  ? `Monthly limit: only ${monthlyRemaining} leads left.`
                  : "Your current plan does not include this configuration."}
              </p>
            )}
          </div>

          {lastGenerated.length > 0 && (
            <div className="bg-card border border-border rounded-2xl p-6">
              <h3 className="font-bold mb-3">Latest Batch</h3>
              <div className="space-y-3">
                {lastGenerated.slice(0, 5).map((lead) => (
                  <div
                    key={lead.id}
                    onClick={() => {
                      navigate({
                        to: "/dashboard/leads/$leadId",
                        params: { leadId: String(lead.id) },
                      });
                    }}
                    className="rounded-xl border border-border bg-background p-3 hover:border-muted-foreground/40 transition-colors cursor-pointer"
                  >
                    <p className="text-sm font-semibold">{lead.businessName}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {lead.email ||
                        lead.website ||
                        lead.instagramHandle ||
                        lead.location}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Premium Lead Pool Card — hidden if user already has premium */}
          {!hasPremiumAccess && (
            <div className="relative rounded-2xl border border-brand/30 bg-card p-6 overflow-hidden">
              <div
                className="pointer-events-none absolute inset-0 opacity-50"
                style={{
                  background:
                    "radial-gradient(ellipse at top right, color-mix(in oklab, var(--brand) 30%, transparent), transparent 60%)",
                }}
              />
              <div className="relative">
                <Lock className="size-5 text-brand mb-3" />
                <h4 className="font-bold">Unlock Premium Lead Pools</h4>
                <p className="text-sm text-muted-foreground mt-2">
                  Skip live scraping. Premium gives you instant pool access to
                  mobile-verified decision-makers and full Instagram
                  intelligence.
                </p>
                <Link
                  to="/dashboard/subscription"
                  className="mt-4 w-full block text-center bg-foreground text-background py-2.5 rounded-lg text-sm font-semibold hover:bg-foreground/90"
                >
                  Upgrade to Premium
                </Link>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
          <Icon className="size-4 text-brand" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium">{value}</span>
    </div>
  );
}
