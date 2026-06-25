import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { BrandMark } from "@/components/mast/BrandMark";
import {
  Sparkles, Users, Zap, ShieldCheck,
  CheckCircle2, ArrowRight, BarChart3,
  Activity, Target, Layers,
  Bell, GitBranch,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mast — AI Sales Operating System" },
      { name: "description", content: "Mast is an AI-powered sales operating system for agencies and freelancers. Prospect research, CRM, pipeline management, and sales intelligence — unified in one platform." },
      { property: "og:title", content: "Mast — AI Sales Operating System" },
      { property: "og:description", content: "Discover companies, enrich business profiles, manage your pipeline, and execute outreach from one intelligent platform." },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      <SiteNav />
      <Hero />
      <ProductPreview />
      <Problem />
      <Features />
      <PricingPreview />
      <CTA />
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <header className="relative pt-28 pb-20 px-6 overflow-hidden">
      {/* Grid */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.18] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />

      {/* Ambient glow orbs */}
      <div
        className="pointer-events-none absolute top-[-180px] left-1/2 -translate-x-1/2 size-[700px] rounded-full opacity-30 animate-pulse-glow"
        style={{ background: "radial-gradient(closest-side, var(--brand), transparent)" }}
      />
      <div
        className="pointer-events-none absolute top-[60px] left-[8%] size-[320px] rounded-full opacity-10"
        style={{ background: "radial-gradient(closest-side, oklch(0.76 0.15 215), transparent)" }}
      />
      <div
        className="pointer-events-none absolute top-[100px] right-[6%] size-[280px] rounded-full opacity-10"
        style={{ background: "radial-gradient(closest-side, oklch(0.72 0.17 155), transparent)" }}
      />

      <div className="relative max-w-4xl mx-auto text-center">
        {/* Badge */}
        <div className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-brand text-[11px] font-bold tracking-wider uppercase mb-8 shadow-[0_0_20px_-8px_var(--color-brand)]">
          <span className="relative size-2 rounded-full bg-success ping-dot" />
          AI Sales Operating System
        </div>

        {/* Headline */}
        <h1 className="animate-fade-up delay-100 text-[clamp(2.6rem,7vw,5rem)] font-bold text-foreground tracking-tight mb-7 leading-[1.04]">
          Your complete sales platform.{" "}
          <span className="text-brand-gradient">Powered by AI.</span>
        </h1>

        {/* Sub */}
        <p className="animate-fade-up delay-200 text-[1.05rem] text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed">
          Discover companies, enrich business profiles, manage your pipeline,
          and run your entire sales operation from one intelligent workspace.
        </p>

        {/* CTAs */}
        <div className="animate-fade-up delay-300 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/signup"
            className="group relative w-full sm:w-auto bg-brand text-brand-foreground px-7 py-3.5 rounded-xl font-semibold hover:bg-brand-dark transition-all inline-flex items-center justify-center gap-2 btn-press overflow-hidden shadow-brand"
          >
            <span className="relative z-10 flex items-center gap-2">
              Start Free <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
            </span>
            <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/8 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </Link>
          <Link
            to="/pricing"
            className="w-full sm:w-auto bg-card border border-border px-7 py-3.5 rounded-xl font-semibold hover:border-border/80 hover:bg-card/80 transition-all btn-press"
          >
            View Pricing
          </Link>
          <Link
            to="/dashboard"
            className="group relative w-full sm:w-auto bg-foreground text-background px-7 py-3.5 rounded-xl font-semibold hover:bg-foreground/90 transition-all btn-press inline-flex items-center justify-center gap-2 overflow-hidden"
          >
            <span className="relative z-10 flex items-center gap-2">
              Open Dashboard <Zap className="size-4 group-hover:scale-110 transition-transform" />
            </span>
          </Link>
        </div>

        <p className="animate-fade-up delay-400 text-xs text-muted-foreground mt-5">
          No credit card required · Free plan available · Cancel anytime
        </p>

        {/* Platform capability tags */}
        <div className="animate-fade-up delay-500 mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {[
            { icon: Target, label: "Prospect Research" },
            { icon: BarChart3, label: "Pipeline Management" },
            { icon: Users, label: "CRM" },
            { icon: Sparkles, label: "AI Intelligence" },
          ].map(({ icon: Icon, label }) => (
            <span key={label} className="inline-flex items-center gap-2 group">
              <Icon className="size-3.5 text-brand group-hover:scale-110 transition-transform" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

function ProductPreview() {
  const prospects = [
    { name: "Vortex Media", stage: "Qualified", score: 98, activity: "Meeting booked" },
    { name: "Luminal AI", stage: "Proposal", score: 94, activity: "Proposal sent" },
    { name: "Skyline Growth", stage: "Discovery", score: 91, activity: "Follow-up due" },
    { name: "Northwind Studio", stage: "Qualified", score: 87, activity: "Intro call done" },
    { name: "Helix Commerce", stage: "Closing", score: 85, activity: "Contract review" },
  ];

  const stageColor: Record<string, string> = {
    Qualified: "bg-brand/10 text-brand border-brand/20",
    Proposal: "bg-warning/10 text-warning border-warning/20",
    Discovery: "bg-muted/30 text-muted-foreground border-border/40",
    Closing: "bg-success/10 text-success border-success/20",
  };

  return (
    <section className="px-6 pb-24">
      <div className="max-w-6xl mx-auto animate-scale-in delay-200">
        <div className="relative rounded-3xl overflow-hidden border border-border/70 shadow-elevated gradient-border">
          {/* Subtle inner top glow */}
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
          <div className="flex h-[580px] bg-card">
            {/* Sidebar */}
            <aside className="w-60 shrink-0 border-r border-border p-5 hidden lg:flex flex-col gap-7 bg-[oklch(0.14_0.024_265)]">
              <div className="flex items-center gap-2.5 pt-1">
                <BrandMark size={26} />
                <span className="font-bold text-[13px] tracking-[0.14em] text-foreground">MAST</span>
              </div>
              <nav className="space-y-0.5">
                {["Dashboard", "Prospects", "CRM", "Pipeline", "Analytics", "Settings"].map((l, i) => (
                  <div
                    key={l}
                    className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                      i === 2
                        ? "bg-brand/15 text-brand relative nav-active-bar"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                    }`}
                  >
                    {l}
                  </div>
                ))}
              </nav>
              <div className="mt-auto">
                <div className="bg-background/60 p-4 rounded-xl border border-border/60 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Monthly Usage</p>
                    <span className="text-[10px] font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded-md border border-brand/20">Pro</span>
                  </div>
                  <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand/70 animate-progress" style={{ width: "57%" }} />
                  </div>
                  <p className="text-xs text-foreground">
                    1,420 <span className="text-muted-foreground">/ 6,000 leads this month</span>
                  </p>
                </div>
              </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
              <div className="px-6 py-4 border-b border-border/60 flex items-center justify-between bg-background/20">
                <h2 className="text-base font-bold text-foreground">CRM — Active Pipeline</h2>
                <span className="flex items-center gap-1.5 px-3 py-1 bg-brand/10 text-brand text-[10px] font-bold border border-brand/20 rounded-md uppercase tracking-wider">
                  <span className="size-1.5 rounded-full bg-brand animate-dot-blink" />
                  12 Active Deals
                </span>
              </div>

              <div className="p-5 flex-1 overflow-hidden flex flex-col gap-4">
                {/* Pipeline stage summary */}
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { stage: "Discovery", count: 4, color: "text-muted-foreground" },
                    { stage: "Qualified", count: 3, color: "text-brand" },
                    { stage: "Proposal", count: 3, color: "text-warning" },
                    { stage: "Closing", count: 2, color: "text-success" },
                  ].map(({ stage, count, color }) => (
                    <div key={stage} className="bg-background/40 border border-border/60 rounded-lg p-3 text-center">
                      <p className={`text-lg font-bold ${color}`}>{count}</p>
                      <p className="text-[10px] text-muted-foreground font-medium mt-0.5">{stage}</p>
                    </div>
                  ))}
                </div>

                {/* Opportunity table */}
                <div className="bg-background/40 border border-border/60 rounded-xl overflow-hidden flex-1">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-card/60 border-b border-border/60">
                      <tr>
                        {["Company", "Score", "Stage", "Last Activity"].map((h, i) => (
                          <th key={h} className={`p-3.5 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider ${i === 3 ? "text-right" : ""}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {prospects.map((row, i) => (
                        <tr
                          key={row.name}
                          className={`hover:bg-white/[0.025] transition-colors ${i < prospects.length - 1 ? "border-b border-border/40" : ""}`}
                        >
                          <td className="p-3.5 text-foreground font-medium text-sm">{row.name}</td>
                          <td className="p-3.5">
                            <div className="flex items-center gap-2">
                              <div className="w-12 h-1 bg-border rounded-full overflow-hidden">
                                <div className="h-full bg-brand rounded-full" style={{ width: `${row.score}%` }} />
                              </div>
                              <span className="text-[11px] text-muted-foreground font-mono">{row.score}</span>
                            </div>
                          </td>
                          <td className="p-3.5">
                            <span className={`px-2 py-0.5 text-[10px] rounded-md border font-semibold uppercase tracking-wider ${stageColor[row.stage] ?? ""}`}>
                              {row.stage}
                            </span>
                          </td>
                          <td className="p-3.5 text-right text-xs text-muted-foreground">{row.activity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </section>
  );
}

function Problem() {
  const bullets = [
    "Research and qualify companies in minutes, not days",
    "Enrich business profiles with publicly available contact information",
    "Move opportunities through your pipeline with a built-in CRM",
    "Run follow-up sequences and stay on top of every deal",
  ];

  return (
    <section id="solutions" className="py-28 px-6">
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-20 items-center">
        <div className="animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">The Problem</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight leading-tight">
            Sales teams waste time on{" "}
            <span className="text-muted-foreground">scattered tools.</span>
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed text-[0.95rem]">
            Researching prospects across multiple platforms, manually entering contacts into a CRM,
            and tracking follow-ups in spreadsheets — it fragments your process and slows your team down.
            MAST brings prospect research, enrichment, pipeline, and outreach into one place.
          </p>
          <ul className="mt-8 space-y-3.5">
            {bullets.map((t, i) => (
              <li
                key={t}
                className="flex items-start gap-3.5 text-sm text-foreground animate-slide-right"
                style={{ animationDelay: `${i * 100 + 200}ms` }}
              >
                <CheckCircle2 className="size-5 text-brand shrink-0 mt-0.5" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-fade-up delay-200">
          <div className="relative bg-card border border-border/60 rounded-3xl p-8 shadow-elevated card-hover gradient-border">
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Active opportunities", value: "12", sub: "across pipeline stages" },
                { label: "Follow-ups due", value: "5", sub: "in the next 48 hours" },
                { label: "Prospects researched", value: "340", sub: "this month" },
                { label: "Platform modules", value: "6", sub: "unified in one workspace" },
              ].map(({ label, value, sub }) => (
                <div key={label} className="rounded-2xl bg-background/60 border border-border/50 p-4 hover:border-brand/30 transition-colors">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl border border-border/50 p-5 bg-background/40">
              <p className="text-xs font-bold text-brand uppercase tracking-wider mb-3">AI Sales Assistant</p>
              <p className="text-sm text-foreground leading-relaxed">
                Researching Luminal AI — SaaS startup, Series A, 45 employees. Strong fit for your ICP.
                Recommended action: schedule discovery call.
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">MAST Intelligence · Updated just now</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const features = [
  { icon: Target, title: "Prospect Research", desc: "Discover and qualify companies using publicly available business information. Search by industry, region, and company size to find the right opportunities." },
  { icon: Sparkles, title: "AI Business Intelligence", desc: "AI-powered enrichment surfaces company profiles, website intelligence, and business signals so you can prioritize the highest-value opportunities." },
  { icon: BarChart3, title: "Opportunity Scoring", desc: "Every prospect is scored based on relevance signals so your team always works the most promising accounts first." },
  { icon: Users, title: "Built-in CRM", desc: "Contacts, companies, notes, tags, and team assignments — all in one place. No integrations required, no data escaping to a spreadsheet." },
  { icon: GitBranch, title: "Pipeline Management", desc: "Visual pipeline stages from first contact to closed deal. Drag, update, and report on your entire book of business at a glance." },
  { icon: Bell, title: "Follow-up Automation", desc: "Scheduled reminders, follow-up sequences, and activity tracking ensure no opportunity goes cold from lack of attention." },
  { icon: Activity, title: "Sales Analytics", desc: "Track outreach activity, pipeline velocity, conversion rates, and team performance without leaving the platform." },
  { icon: Layers, title: "Multi-channel Outreach", desc: "Coordinate outreach across email, phone, and social channels from within the workspace — all activity logged automatically." },
  { icon: ShieldCheck, title: "Privacy & Compliance", desc: "Built for responsible business development. All prospect data is sourced from publicly available business information, and your CRM data belongs to you." },
];

function Features() {
  return (
    <section className="py-28 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-18 max-w-2xl mx-auto animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Platform</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight">A complete sales operating system</h2>
          <p className="mt-4 text-muted-foreground text-[0.95rem] leading-relaxed">
            Prospect research, enrichment, CRM, pipeline, and outreach — one platform built for modern sales teams.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="group relative p-7 bg-card border border-border/60 rounded-2xl card-hover overflow-hidden animate-fade-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {/* Hover bg accent */}
              <div className="absolute inset-0 bg-gradient-to-br from-brand/0 to-brand/0 group-hover:from-brand/[0.04] group-hover:to-transparent transition-all duration-500 pointer-events-none rounded-2xl" />

              <div className="relative size-11 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center mb-5 group-hover:bg-brand/20 group-hover:border-brand/35 group-hover:scale-110 transition-all duration-300 shadow-[0_0_16px_-6px_color-mix(in_oklab,var(--brand)_50%,transparent)] group-hover:shadow-[0_0_24px_-4px_color-mix(in_oklab,var(--brand)_70%,transparent)]">
                <f.icon className="size-5 text-brand" />
              </div>
              <h3 className="text-base font-bold text-foreground mb-2.5">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>

              {/* Bottom shine on hover */}
              <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const plans = [
  { name: "Free", price: "$0", desc: "Try the platform", features: ["10 prospects / day · 300 / mo", "Business profile research", "Multi-region search"], cta: "Start Free", popular: false },
  { name: "Starter", price: "$29", desc: "Solo operators", features: ["50 prospects / day · 1,500 / mo", "Full contact intelligence", "Built-in CRM + Limited AI"], cta: "Get Started", popular: false },
  { name: "Pro", price: "$79", desc: "Growing agencies", features: ["200 prospects / day · 6,000 / mo", "AI enrichment + Higher AI", "Full CRM + Pipeline + API"], cta: "Upgrade to Pro", popular: true },
  { name: "Premium", price: "$199", desc: "Growth operators", features: ["833 prospects / day · 25,000 / mo", "Premium intelligence + Highest AI", "Full automations + Team seats"], cta: "Contact Sales", popular: false },
];

export function PlanCard({ name, price, desc, features, cta, popular }: {
  name: string; price: string; desc: string; features: string[]; cta: string; popular: boolean;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-3xl p-7 overflow-hidden transition-all duration-300 card-hover ${
        popular
          ? "bg-gradient-to-b from-brand/10 to-card border-2 border-brand shadow-brand"
          : "bg-card border border-border/60"
      }`}
    >
      {popular && (
        <>
          <div className="absolute top-0 right-0 bg-brand text-brand-foreground px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-bl-xl">
            Most Popular
          </div>
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/60 to-transparent" />
        </>
      )}

      <div className={`text-[10px] font-bold uppercase tracking-[0.2em] mb-3 ${popular ? "text-brand" : "text-muted-foreground"}`}>
        {name}
      </div>
      <div className="text-[2.2rem] font-bold text-foreground leading-none">
        {price}
        <span className="text-sm text-muted-foreground font-normal">/mo</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 mb-6">{desc}</p>

      <ul className="space-y-3 flex-1 mb-7">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-brand shrink-0" /> {f}
          </li>
        ))}
      </ul>

      <Link
        to="/signup"
        className={`w-full py-3 rounded-xl font-bold transition-all btn-press text-center text-sm ${
          popular
            ? "bg-brand text-brand-foreground hover:bg-brand-dark shadow-brand"
            : "border border-border hover:border-brand/40 hover:bg-brand/5 hover:text-foreground text-muted-foreground"
        }`}
      >
        {cta}
      </Link>
    </div>
  );
}

function PricingPreview() {
  return (
    <section className="py-28 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Pricing</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold text-foreground">Simple, transparent plans</h2>
          <p className="mt-4 text-muted-foreground">Daily lead limits so your pipeline stays active all month — not just week one.</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {plans.map((p, i) => (
            <div key={p.name} className="animate-fade-up" style={{ animationDelay: `${i * 80}ms` }}>
              <PlanCard {...p} />
            </div>
          ))}
        </div>
        <div className="text-center mt-10 animate-fade-up delay-400">
          <Link
            to="/pricing"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-dark transition-colors group"
          >
            See full feature comparison
            <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-5xl mx-auto relative rounded-3xl overflow-hidden border border-border/60 p-16 text-center gradient-border">
        {/* Background */}
        <div className="absolute inset-0 bg-card" />
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{ background: "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)" }}
        />
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
        <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent" />

        <div className="relative">
          <h2 className="text-[clamp(1.9rem,5vw,3rem)] font-bold tracking-tight leading-tight animate-fade-up">
            Run your entire sales operation<br />from one platform.
          </h2>
          <p className="mt-5 text-muted-foreground max-w-xl mx-auto text-[0.95rem] leading-relaxed animate-fade-up delay-100">
            Start free — no credit card required. Research prospects, manage your pipeline,
            and close deals from day one.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up delay-200">
            <Link
              to="/signup"
              className="group relative bg-brand text-brand-foreground px-8 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all btn-press overflow-hidden"
            >
              <span className="relative z-10">Start Free</span>
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </Link>
            <Link
              to="/pricing"
              className="bg-background border border-border/80 px-8 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-brand/5 transition-all btn-press"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
