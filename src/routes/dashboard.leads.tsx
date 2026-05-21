import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Zap, Globe2, Target, Gauge, Sparkles, Lock, Mail, Phone, Link2, Instagram, Coins } from "lucide-react";
import { ApiError, type Lead } from "@/lib/api";
import { useAccount, useGenerateLeads } from "@/hooks/use-mast-api";

export const Route = createFileRoute("/dashboard/leads")({
  head: () => ({ meta: [{ title: "Get Leads — Mast" }] }),
  component: GetLeads,
});

const regions = ["United States", "United Kingdom", "Canada", "Germany", "Australia", "Global"];
const niches = ["SaaS Founders", "E-commerce", "Marketing Agencies", "Local Services", "Fitness Studios", "Real Estate"];
const speeds = [
  { id: "scrape", label: "Live Scraping", desc: "Fresh records pulled in real time", premium: false, multiplier: 1 },
  { id: "pool", label: "Instant Pool Access", desc: "Tap into the pre-built lead pool", premium: false, multiplier: 1.2 },
  { id: "premium", label: "Premium Instant Results", desc: "Decision-maker pool, mobile-verified", premium: true, multiplier: 1.6 },
];

const channelOptions = [
  { id: "email", label: "Verified Email", icon: Mail },
  { id: "phone", label: "Phone Number", icon: Phone },
  { id: "website", label: "Website", icon: Link2 },
  { id: "instagram", label: "Instagram", icon: Instagram },
];

// Base: 1 credit per lead. Each extra channel beyond the first adds 0.25.
function calcCredits(qty: number, channels: string[], speedId: string) {
  const speed = speeds.find((s) => s.id === speedId)!;
  const channelFactor = 1 + Math.max(0, channels.length - 1) * 0.25;
  return Math.max(1, Math.ceil(qty * channelFactor * speed.multiplier));
}

function GetLeads() {
  const { data: account } = useAccount();
  const generate = useGenerateLeads();
  const [quantity, setQuantity] = useState(100);
  const [region, setRegion] = useState(regions[0]);
  const [niche, setNiche] = useState(niches[0]);
  const [speed, setSpeed] = useState(speeds[0].id);
  const [channels, setChannels] = useState<string[]>(["email", "phone", "website", "instagram"]);
  const [lastGenerated, setLastGenerated] = useState<Lead[]>([]);

  const maxQuantity = account?.limits.maxLeadRequest ?? 2500;
  const remainingCredits = account?.credits.remaining ?? 0;
  const currentSpeed = speeds.find((s) => s.id === speed)!;

  useEffect(() => {
    if (quantity > maxQuantity) setQuantity(maxQuantity);
  }, [maxQuantity, quantity]);

  const toggleChannel = (id: string) =>
    setChannels((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const credits = calcCredits(quantity, channels, speed);
  const channelRestricted = account
    ? channels.some((channel) => !account.limits.allowedChannels.includes(channel))
    : false;
  const modeRestricted =
    account && ((speed === "pool" && !account.limits.allowInstantPool) || (speed === "premium" && !account.limits.allowPremiumPool));
  const insufficientCredits = account ? credits > remainingCredits : false;
  const canGenerate = !!account && channels.length > 0 && !channelRestricted && !modeRestricted && !insufficientCredits && !generate.isPending;

  const handleGenerate = async () => {
    try {
      const result = await generate.mutateAsync({
        quantity,
        region,
        niche,
        mode: speed as "scrape" | "pool" | "premium",
        channels,
      });
      setLastGenerated(result.leads);
      toast.success(`Generated ${result.generated.toLocaleString()} leads`, {
        description: `${result.cost.toLocaleString()} credits used from ${result.source.replace(/_/g, " ")}.`,
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Lead generation failed.";
      toast.error(message);
    }
  };

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-8">
        <span className="text-xs font-bold text-brand uppercase tracking-widest">Lead Generator</span>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Generate sales-ready leads in minutes</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Configure your search. Mast returns verified emails, mobile numbers, websites, and Instagram profiles — outreach-ready.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-7 space-y-7">
          {/* Quantity */}
          <Section icon={Target} title="Quantity" subtitle="How many leads to generate?">
            <div className="space-y-3">
              <input
                type="range"
                min={50}
                max={maxQuantity}
                step={50}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="w-full accent-[color:var(--brand)]"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>50</span>
                <span className="text-foreground font-bold text-lg">{quantity.toLocaleString()} leads</span>
                <span>{maxQuantity.toLocaleString()}</span>
              </div>
            </div>
          </Section>

          {/* Region */}
          <Section icon={Globe2} title="Region" subtitle="Target up to 6 regions per search">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {regions.map((r) => (
                <Pill key={r} active={region === r} onClick={() => setRegion(r)}>
                  {r}
                </Pill>
              ))}
            </div>
          </Section>

          {/* Niche */}
          <Section icon={Sparkles} title="Niche" subtitle="Choose a vertical or use custom keywords">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {niches.map((n) => (
                <Pill key={n} active={niche === n} onClick={() => setNiche(n)}>
                  {n}
                </Pill>
              ))}
            </div>
          </Section>

          {/* Channels */}
          <Section icon={Mail} title="Outreach Channels" subtitle="Each extra channel costs slightly more credits per lead">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {channelOptions.map((c) => {
                const active = channels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleChannel(c.id)}
                    className={
                      active
                        ? "flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 border-brand bg-brand/10 text-foreground text-sm font-medium"
                        : "flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 text-sm font-medium transition-colors"
                    }
                  >
                    <c.icon className={active ? "size-4 text-brand" : "size-4"} />
                    {c.label}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Generation mode */}
          <Section icon={Gauge} title="Generation Mode" subtitle="Live scraping vs. instant lead pool access">
            <div className="grid sm:grid-cols-3 gap-3">
              {speeds.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSpeed(s.id)}
                  disabled={(s.id === "pool" && account ? !account.limits.allowInstantPool : false) || (s.id === "premium" && account ? !account.limits.allowPremiumPool : false)}
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
                  <p className="text-xs text-muted-foreground mt-1">{s.desc}</p>
                  <p className="text-[10px] text-brand font-bold uppercase tracking-wider mt-2">
                    ×{s.multiplier.toFixed(2)} credits
                  </p>
                </button>
              ))}
            </div>
          </Section>
        </div>

        {/* Summary / CTA */}
        <aside className="space-y-5">
          <div className="bg-card border border-border rounded-2xl p-6">
            <h3 className="font-bold mb-4">Order Summary</h3>
            <div className="space-y-3 text-sm">
              <Row label="Quantity" value={`${quantity.toLocaleString()} leads`} />
              <Row label="Region" value={region} />
              <Row label="Niche" value={niche} />
              <Row label="Mode" value={currentSpeed.label} />
              <Row label="Channels" value={channels.length ? `${channels.length} active` : "None"} />
            </div>
            <div className="my-5 h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Cost</span>
              <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                <Coins className="size-4 text-brand" />
                {credits.toLocaleString()} credits
              </span>
            </div>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="mt-5 w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold shadow-brand inline-flex items-center justify-center gap-2 disabled:opacity-55 disabled:hover:bg-brand"
            >
              <Zap className="size-4" /> {generate.isPending ? "Generating..." : "Generate Leads"}
            </button>
            <p className="text-[11px] text-muted-foreground text-center mt-3">
              {remainingCredits.toLocaleString()} credits remaining this month
            </p>
            {(channelRestricted || modeRestricted || insufficientCredits) && (
              <p className="text-[11px] text-destructive text-center mt-2">
                {insufficientCredits
                  ? "Not enough credits for this search."
                  : "Your current plan does not include this configuration."}
              </p>
            )}
          </div>

          {lastGenerated.length > 0 && (
            <div className="bg-card border border-border rounded-2xl p-6">
              <h3 className="font-bold mb-3">Latest Batch</h3>
              <div className="space-y-3">
                {lastGenerated.slice(0, 5).map((lead) => (
                  <div key={lead.id} className="rounded-xl border border-border bg-background p-3">
                    <p className="text-sm font-semibold">{lead.businessName}</p>
                    <p className="text-xs text-muted-foreground mt-1">{lead.email || lead.website || lead.instagramHandle || lead.location}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="relative rounded-2xl border border-brand/30 bg-card p-6 overflow-hidden">
            <div
              className="pointer-events-none absolute inset-0 opacity-50"
              style={{ background: "radial-gradient(ellipse at top right, color-mix(in oklab, var(--brand) 30%, transparent), transparent 60%)" }}
            />
            <div className="relative">
              <Lock className="size-5 text-brand mb-3" />
              <h4 className="font-bold">Unlock Premium Lead Pools</h4>
              <p className="text-sm text-muted-foreground mt-2">
                Skip live scraping. Premium gives you instant pool access to mobile-verified decision-makers and full Instagram intelligence.
              </p>
              <button className="mt-4 w-full bg-foreground text-background py-2.5 rounded-lg text-sm font-semibold hover:bg-foreground/90">
                Upgrade to Premium
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

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

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "px-3 py-2 rounded-lg border-2 border-brand bg-brand/10 text-foreground text-sm font-medium text-center"
          : "px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 text-sm font-medium text-center transition-colors"
      }
    >
      {children}
    </button>
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
