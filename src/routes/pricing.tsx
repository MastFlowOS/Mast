import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import {
  CheckCircle2,
  XCircle,
  Globe2,
  Crown,
  Users,
  Zap,
  Code2,
  MessageSquare,
  ArrowRight,
  Bot,
  Calendar,
  Sun,
  ShieldCheck,
  Target,
} from "lucide-react";
import { PlanCard } from "./index";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Mast" },
      {
        name: "description",
        content:
          "Simple daily and monthly lead usage limits. Full access to prospect research, CRM, pipeline, and AI intelligence on every plan.",
      },
      { property: "og:title", content: "Mast Pricing" },
      {
        property: "og:description",
        content:
          "Daily prospect limits from 10 to 833 per day. Research, enrich, manage pipeline, and execute outreach from one platform.",
      },
    ],
  }),
  component: PricingPage,
});

// ─── Plan definitions ─────────────────────────────────────────────────────────

type Tier = {
  name: string;
  price: string;
  desc: string;
  cta: string;
  popular: boolean;
  dailyLeads: string;
  monthlyLeads: string;
  crm: string;
  aiAccess: string;
  premiumPool: string;
  automations: string;
  teamSeats: string;
  features: string[];
};

const tiers: Tier[] = [
  {
    name: "Free",
    price: "$0",
    desc: "Try the platform",
    cta: "Start Free",
    popular: false,
    dailyLeads: "10 / day",
    monthlyLeads: "300 / mo",
    crm: "CSV export",
    aiAccess: "—",
    premiumPool: "—",
    automations: "—",
    teamSeats: "1 seat",
    features: [
      "10 prospects / day (300 / mo)",
      "Business profile research",
      "Multi-region search",
      "CSV export",
    ],
  },
  {
    name: "Starter",
    price: "$29",
    desc: "Solo operators & freelancers",
    cta: "Choose Starter",
    popular: false,
    dailyLeads: "50 / day",
    monthlyLeads: "1,500 / mo",
    crm: "Built-in CRM",
    aiAccess: "Limited",
    premiumPool: "—",
    automations: "—",
    teamSeats: "1 seat",
    features: [
      "50 prospects / day (1,500 / mo)",
      "Full contact intelligence",
      "Built-in CRM",
      "Limited AI assistance",
    ],
  },
  {
    name: "Pro",
    price: "$79",
    desc: "Growing agencies",
    cta: "Upgrade to Pro",
    popular: true,
    dailyLeads: "200 / day",
    monthlyLeads: "6,000 / mo",
    crm: "Full pipeline CRM",
    aiAccess: "Higher",
    premiumPool: "—",
    automations: "Sequences",
    teamSeats: "3 seats",
    features: [
      "200 prospects / day (6,000 / mo)",
      "All modules + sequences",
      "Instant intelligence pool",
      "Higher AI assistance",
      "Full CRM + pipeline",
      "API access",
      "3 team seats",
    ],
  },
  {
    name: "Premium",
    price: "$199",
    desc: "Growth operators & enterprises",
    cta: "Contact Sales",
    popular: false,
    dailyLeads: "833 / day",
    monthlyLeads: "25,000 / mo",
    crm: "CRM + automations",
    aiAccess: "Highest",
    premiumPool: "✓",
    automations: "Full automations",
    teamSeats: "Unlimited",
    features: [
      "833 prospects / day (25,000 / mo)",
      "Premium intelligence pool",
      "Highest AI assistance",
      "Full CRM + automations",
      "Unlimited team seats",
      "Dedicated account manager",
    ],
  },
];

type ComparisonRowDef = { label: string; key: keyof Tier; icon?: React.ComponentType<{ className?: string }> };

const rows: ComparisonRowDef[] = [
  { label: "Daily lead usage", key: "dailyLeads", icon: Sun },
  { label: "Monthly lead usage", key: "monthlyLeads", icon: Calendar },
  { label: "CRM access", key: "crm" },
  { label: "AI assistance", key: "aiAccess", icon: Bot },
  { label: "Premium intelligence pool", key: "premiumPool" },
  { label: "Automations", key: "automations" },
  { label: "Team seats", key: "teamSeats", icon: Users },
];

const faqs = [
  {
    q: "How do daily limits work?",
    a: "Your daily lead usage resets every 24 hours at midnight UTC. This keeps your pipeline active throughout the month rather than exhausting your monthly allowance in one session.",
  },
  {
    q: "What happens when I reach the daily limit?",
    a: "Prospect discovery pauses for the day. You'll see a countdown to the next reset. Your monthly allowance is preserved, and it's available again the following day.",
  },
  {
    q: "Do unused leads roll over?",
    a: "Daily allowances reset each day — unused daily capacity doesn't carry over. Monthly caps reset at the start of each billing cycle.",
  },
  {
    q: "Can I change plans at any time?",
    a: "Yes — upgrade, downgrade, or cancel at any time. Changes take effect at the next billing cycle.",
  },
  {
    q: "What's the difference between live research and the instant pool?",
    a: "Live research fetches fresh business information in real time. The instant intelligence pool on Pro and Premium gives immediate access to our pre-enriched, regularly refreshed company database — faster results, higher confidence.",
  },
  {
    q: "What does AI assistance include?",
    a: "AI assistance helps with outreach drafts, niche-aware messaging, and channel-specific copy — from basic templates on Starter to fully adaptive multi-step sequences on Premium.",
  },
  {
    q: "Who owns my CRM data?",
    a: "You do. Your contacts, notes, pipeline stages, and activity history are yours. You can export everything at any time.",
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      {/* Hero */}
      <section className="relative pt-28 pb-20 px-6 overflow-hidden text-center">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.15] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
        <div
          className="pointer-events-none absolute top-[-150px] left-1/2 -translate-x-1/2 size-[600px] rounded-full opacity-25 animate-pulse-glow"
          style={{
            background:
              "radial-gradient(closest-side, var(--brand), transparent)",
          }}
        />
        <div className="relative max-w-3xl mx-auto">
          <span className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-brand text-[10px] font-bold uppercase tracking-wider mb-6">
            <Target className="size-3" /> Daily usage limits · No contracts
          </span>
          <h1 className="animate-fade-up delay-100 text-[clamp(2.2rem,6vw,3.5rem)] font-bold tracking-tight mb-5">
            Active pipeline, every single day.
          </h1>
          <p className="animate-fade-up delay-200 text-muted-foreground text-[1rem] leading-relaxed max-w-xl mx-auto">
            Every plan includes a daily lead allowance so your prospect research stays
            consistent all month — not just in week one.
          </p>
        </div>
      </section>

      {/* Plan cards */}
      <section className="px-6 pb-24">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {tiers.map((t, i) => (
              <div
                key={t.name}
                className="animate-fade-up"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <PlanCard
                  name={t.name}
                  price={t.price}
                  desc={t.desc}
                  features={t.features}
                  cta={t.cta}
                  popular={t.popular}
                />
              </div>
            ))}
          </div>

          <p className="text-center text-xs text-muted-foreground mt-6 animate-fade-up delay-400">
            All plans include a 7-day money-back guarantee · No contracts ·
            Cancel anytime
          </p>
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              Compare
            </span>
            <h2 className="mt-3 text-2xl font-bold">Full feature breakdown</h2>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border/60 animate-fade-up delay-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-card/50">
                  <th className="text-left p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider w-[200px]">
                    Feature
                  </th>
                  {tiers.map((t) => (
                    <th key={t.name} className="p-4 text-center">
                      <div
                        className={`text-xs font-bold uppercase tracking-wider ${t.popular ? "text-brand" : "text-muted-foreground"}`}
                      >
                        {t.name}
                      </div>
                      <div className="text-lg font-bold text-foreground mt-0.5">
                        {t.price}
                        <span className="text-xs text-muted-foreground font-normal">
                          /mo
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ label, key, icon: RowIcon }, ri) => (
                  <tr
                    key={key}
                    className={`border-b border-border/40 hover:bg-white/[0.02] transition-colors ${ri % 2 === 0 ? "bg-background/20" : ""}`}
                  >
                    <td className="p-4 text-muted-foreground font-medium text-xs">
                      <div className="flex items-center gap-1.5">
                        {RowIcon && (
                          <RowIcon className="size-3 text-muted-foreground/60" />
                        )}
                        {label}
                      </div>
                    </td>
                    {tiers.map((t) => {
                      const val = String(t[key]);
                      const isDash = val === "—";
                      const isCheck = val === "✓";
                      return (
                        <td
                          key={t.name}
                          className={`p-4 text-center text-xs ${t.popular ? "text-brand font-semibold" : "text-foreground"}`}
                        >
                          {isDash ? (
                            <span className="inline-flex justify-center">
                              <XCircle className="size-4 text-border" />
                            </span>
                          ) : isCheck ? (
                            <span className="inline-flex justify-center">
                              <CheckCircle2 className="size-4 text-brand" />
                            </span>
                          ) : (
                            val
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* How daily limits work */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              Usage
            </span>
            <h2 className="mt-3 text-2xl font-bold">
              Daily limits, always-on pipeline
            </h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Instead of exhausting a monthly quota in one session, MAST
              spreads your lead budget across every working day.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              {
                icon: Sun,
                label: "Daily allowance",
                sub: "Resets every 24 h",
                desc: "Your fresh allocation each day, always ready when you open the platform.",
              },
              {
                icon: Calendar,
                label: "Monthly cap",
                sub: "Billing cycle protection",
                desc: "A ceiling that prevents overages — visible when you're approaching the limit.",
              },
              {
                icon: Bot,
                label: "AI assistance",
                sub: "Scales with plan",
                desc: "From basic templates on Starter to adaptive multi-step sequences on Premium.",
              },
              {
                icon: Zap,
                label: "Instant pool",
                sub: "Pro & Premium",
                desc: "Pre-enriched company intelligence — ready before you click search.",
              },
            ].map(({ icon: Icon, label, sub, desc }, i) => (
              <div
                key={label}
                className="relative bg-card border border-border/60 rounded-2xl p-5 card-hover animate-fade-up overflow-hidden group"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-brand/0 group-hover:from-brand/[0.04] to-transparent transition-all duration-500 rounded-2xl pointer-events-none" />
                <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center mb-4 group-hover:bg-brand/20 group-hover:scale-110 transition-all">
                  <Icon className="size-4 text-brand" />
                </div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <p className="text-[10px] font-bold text-brand uppercase tracking-wider mt-0.5">
                  {sub}
                </p>
                <p className="text-xs text-muted-foreground mt-2">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust section — replaces fabricated social proof */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              Trust & Compliance
            </span>
            <h2 className="mt-3 text-2xl font-bold">Built responsibly</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              MAST is built for responsible business development — not bulk spam.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                icon: ShieldCheck,
                title: "Your data, your CRM",
                desc: "Everything in your CRM belongs to you. Export anytime, cancel anytime.",
              },
              {
                icon: Globe2,
                title: "Public business information",
                desc: "Prospect data is sourced from publicly available business directories and websites.",
              },
              {
                icon: Crown,
                title: "Responsible use",
                desc: "MAST is designed for professional sales teams — not bulk marketing or spam operations.",
              },
            ].map(({ icon: Icon, title, desc }, i) => (
              <div
                key={title}
                className="text-center bg-card border border-border/60 rounded-2xl p-7 card-hover animate-fade-up"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className="size-12 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center mx-auto mb-4">
                  <Icon className="size-5 text-brand" />
                </div>
                <p className="text-base font-bold text-foreground">{title}</p>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI assistance explainer */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              AI Assistance
            </span>
            <h2 className="mt-3 text-2xl font-bold">
              Smarter outreach at every tier
            </h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              MAST's AI assistant helps draft outreach using company context,
              channel awareness, and tone matching. Capability scales with your plan.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              {
                plan: "Free",
                level: "No AI",
                color: "text-muted-foreground",
                desc: "Manual outreach only. You write every message from scratch.",
              },
              {
                plan: "Starter",
                level: "Limited AI",
                color: "text-brand/60",
                desc: "Basic message templates with company-aware suggestions.",
              },
              {
                plan: "Pro",
                level: "Higher AI",
                color: "text-brand",
                desc: "Channel-specific drafts, tone selector, and multi-step sequences.",
              },
              {
                plan: "Premium",
                level: "Highest AI",
                color: "text-brand font-bold",
                desc: "Fully adaptive personalization across all channels and follow-up cadences.",
              },
            ].map(({ plan, level, color, desc }, i) => (
              <div
                key={plan}
                className="bg-card border border-border/60 rounded-2xl p-5 animate-fade-up"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    {plan}
                  </span>
                  <Bot className={`size-4 ${color}`} />
                </div>
                <p className={`text-sm font-semibold ${color}`}>{level}</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Lead usage explainer (was "channel credit explainer") */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              Lead Usage
            </span>
            <h2 className="mt-3 text-2xl font-bold">How data depth affects usage</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Every prospect starts at base usage. Requesting richer contact intelligence
              uses more of your daily allowance — but also gives you more to work with.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              {
                icon: Zap,
                label: "Business Email",
                cost: "Base usage",
                desc: "Verified business email address",
              },
              {
                icon: Globe2,
                label: "Phone",
                cost: "Low additional",
                desc: "Business phone line",
              },
              {
                icon: MessageSquare,
                label: "Social Profile",
                cost: "Medium additional",
                desc: "Public social presence and engagement",
              },
              {
                icon: Code2,
                label: "Website Intelligence",
                cost: "Higher additional",
                desc: "Website, tech stack, contact info",
              },
            ].map(({ icon: Icon, label, cost, desc }, i) => (
              <div
                key={label}
                className="relative bg-card border border-border/60 rounded-2xl p-5 card-hover animate-fade-up overflow-hidden group"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-brand/0 group-hover:from-brand/[0.04] to-transparent transition-all duration-500 rounded-2xl pointer-events-none" />
                <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center mb-4 group-hover:bg-brand/20 group-hover:scale-110 transition-all">
                  <Icon className="size-4 text-brand" />
                </div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <p className="text-lg font-bold text-brand mt-1">{cost}</p>
                <p className="text-xs text-muted-foreground mt-1">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-3xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">
              FAQ
            </span>
            <h2 className="mt-3 text-2xl font-bold">Common questions</h2>
          </div>
          <div className="space-y-3 animate-fade-up delay-100">
            {faqs.map(({ q, a }, i) => (
              <div
                key={q}
                className="bg-card border border-border/60 rounded-xl p-6 hover:border-brand/25 transition-colors card-hover animate-fade-up"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <p className="font-semibold text-foreground text-sm">{q}</p>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                  {a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 pb-24">
        <div className="max-w-4xl mx-auto relative rounded-3xl overflow-hidden border border-border/60 p-16 text-center animate-fade-up">
          <div className="absolute inset-0 bg-card" />
          <div
            className="absolute inset-0 opacity-35"
            style={{
              background:
                "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)",
            }}
          />
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
          <div className="relative">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
              Start building your pipeline today
            </h2>
            <p className="mt-4 text-muted-foreground max-w-md mx-auto text-sm">
              Free plan includes 10 prospects per day. No credit card required.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to="/signup"
                className="group bg-brand text-brand-foreground px-7 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all btn-press inline-flex items-center gap-2"
              >
                Start Free
                <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link
                to="/dashboard"
                className="bg-background border border-border/80 px-7 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-brand/5 transition-all btn-press"
              >
                View Dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
