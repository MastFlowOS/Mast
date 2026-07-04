import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { BrandMark } from "@/components/mast/BrandMark";
import {
  Sparkles, Users, Zap, ShieldCheck,
  CheckCircle2, ArrowRight, BarChart3,
  Activity, Target, Layers,
  Bell, GitBranch, TrendingUp, Clock,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mast — The AI Sales Operating System" },
      { name: "description", content: "Research companies, qualify opportunities, manage your pipeline, and run follow-ups — all in one AI-powered workspace. MAST is the operating system for modern sales teams." },
      { property: "og:title", content: "Mast — The AI Sales Operating System" },
      { property: "og:description", content: "One workspace. AI-powered. Built for teams that close deals." },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      <SiteNav disableBackdropBlur />
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

// ─── Count-up hook ────────────────────────────────────────────────────────────
function useCountUp(target: number, duration = 1200, start = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    let startTime: number | null = null;
    const tick = (ts: number) => {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(ease * target));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target, duration, start]);
  return value;
}

// ─── Hero ─────────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <header className="relative pt-28 pb-20 px-6 overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.18] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
      <div
        className="pointer-events-none absolute top-[-180px] left-1/2 -translate-x-1/2 size-[700px] rounded-full opacity-30 animate-pulse-glow"
        style={{ background: "radial-gradient(closest-side, var(--brand), transparent)" }}
      />
      <div className="pointer-events-none absolute top-[60px] left-[8%] size-[320px] rounded-full opacity-10"
        style={{ background: "radial-gradient(closest-side, oklch(0.76 0.15 215), transparent)" }} />
      <div className="pointer-events-none absolute top-[100px] right-[6%] size-[280px] rounded-full opacity-10"
        style={{ background: "radial-gradient(closest-side, oklch(0.72 0.17 155), transparent)" }} />

      <div className="relative max-w-4xl mx-auto text-center">
        {/* Badge */}
        <div className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-brand text-[11px] font-bold tracking-wider uppercase mb-8 shadow-[0_0_20px_-8px_var(--color-brand)]">
          <span className="relative size-2 rounded-full bg-success ping-dot" />
          The AI Sales Operating System
        </div>

        {/* Headline */}
        <h1 className="animate-fade-up delay-100 text-[clamp(2.6rem,7vw,5rem)] font-bold text-foreground tracking-tight mb-7 leading-[1.04]">
          Stop switching tabs.<br />
          <span className="text-brand-gradient">Start closing deals.</span>
        </h1>

        {/* Sub */}
        <p className="animate-fade-up delay-200 text-[1.1rem] text-muted-foreground mb-10 max-w-[520px] mx-auto leading-relaxed">
          MAST replaces your scattered sales stack with one AI workspace —
          research, relationship data, pipeline, and follow-ups, all talking to each other.
        </p>

        {/* CTAs */}
        <div className="animate-fade-up delay-300 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/signup"
            className="group relative w-full sm:w-auto bg-brand text-brand-foreground px-8 py-3.5 rounded-xl font-semibold hover:bg-brand-dark transition-all duration-200 inline-flex items-center justify-center gap-2 btn-press overflow-hidden shadow-brand"
          >
            <span className="relative z-10 flex items-center gap-2">
              Start for free <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform duration-200" />
            </span>
            <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
          </Link>
          <Link
            to="/pricing"
            className="w-full sm:w-auto bg-card border border-border px-8 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-card/80 transition-all duration-200 btn-press"
          >
            See pricing
          </Link>
        </div>

        <p className="animate-fade-up delay-400 text-xs text-muted-foreground mt-5">
          No credit card required · Free plan available · Cancel anytime
        </p>

        {/* Platform pills */}
        <div className="animate-fade-up delay-500 mt-10 flex flex-wrap items-center justify-center gap-2">
          {[
            { icon: Target, label: "Prospect Research" },
            { icon: BarChart3, label: "Pipeline" },
            { icon: Users, label: "Relationship Data" },
            { icon: Sparkles, label: "AI Intelligence" },
            { icon: Bell, label: "Follow-ups" },
          ].map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card border border-border/60 text-[11px] font-semibold text-muted-foreground hover:border-brand/30 hover:text-foreground transition-all duration-200 cursor-default"
            >
              <Icon className="size-3 text-brand" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

// ─── Product Preview (live-feeling dashboard) ──────────────────────────────────
function ProductPreview() {
  const [tick, setTick] = useState(0);
  const [aiTyping, setAiTyping] = useState(true);
  const [aiText, setAiText] = useState("");
  const fullAiText = "Helix Commerce — growth-stage SaaS, 60 employees. Strong ICP fit. Recommend scheduling a discovery call this week.";

  // Slow AI typewriter
  useEffect(() => {
    let i = 0;
    setAiText("");
    const id = setInterval(() => {
      i++;
      setAiText(fullAiText.slice(0, i));
      if (i >= fullAiText.length) {
        clearInterval(id);
        setAiTyping(false);
      }
    }, 28);
    return () => clearInterval(id);
  }, []);

  // Subtle pulse for activity feed
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 3200);
    return () => clearInterval(id);
  }, []);

  const feed = [
    { time: "2m ago", text: "Vortex Media moved to Proposal", color: "text-warning" },
    { time: "14m ago", text: "Luminal AI — discovery call booked", color: "text-brand" },
    { time: "1h ago", text: "Skyline Growth follow-up sent", color: "text-muted-foreground" },
    { time: "3h ago", text: "Northwind Studio added to pipeline", color: "text-muted-foreground" },
  ];

  const prospects = [
    { name: "Helix Commerce", stage: "Closing", score: 98 },
    { name: "Vortex Media", stage: "Proposal", score: 94 },
    { name: "Luminal AI", stage: "Qualified", score: 91 },
    { name: "Skyline Growth", stage: "Discovery", score: 87 },
    { name: "Northwind Studio", stage: "Qualified", score: 85 },
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
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
          <div className="flex h-[600px] bg-card">

            {/* Sidebar */}
            <aside className="w-56 shrink-0 border-r border-border p-4 hidden lg:flex flex-col gap-6 bg-[oklch(0.14_0.024_265)]">
              <div className="flex items-center gap-2.5 pt-1 px-1">
                <BrandMark size={22} />
                <span className="font-bold text-[12px] tracking-[0.14em] text-foreground">MAST</span>
              </div>
              <nav className="space-y-0.5">
                {[
                  { label: "Focus", active: false },
                  { label: "Prospects", active: false },
                  { label: "Pipeline", active: true },
                  { label: "Pipeline", active: false },
                  { label: "Insights", active: false },
                  { label: "Settings", active: false },
                ].map(({ label, active }) => (
                  <div
                    key={label}
                    className={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer ${
                      active
                        ? "bg-brand/15 text-brand relative nav-active-bar"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                    }`}
                  >
                    {label}
                  </div>
                ))}
              </nav>

              {/* AI insight card */}
              <div className="mt-auto bg-background/60 p-3 rounded-xl border border-brand/20 space-y-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3 text-brand" />
                  <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Insight</p>
                </div>
                <p className="text-[11px] text-foreground leading-relaxed min-h-[52px]">
                  {aiText}
                  {aiTyping && <span className="inline-block w-0.5 h-3 bg-brand ml-0.5 animate-pulse align-middle" />}
                </p>
              </div>

              {/* Usage */}
              <div className="bg-background/60 p-3 rounded-xl border border-border/60 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Monthly Usage</p>
                  <span className="text-[10px] font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded-md border border-brand/20">Pro</span>
                </div>
                <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand/70 animate-progress" style={{ width: "57%" }} />
                </div>
                <p className="text-[11px] text-foreground">
                  1,420 <span className="text-muted-foreground">/ 6,000 this month</span>
                </p>
              </div>
            </aside>

            {/* Main area */}
            <main className="flex-1 flex flex-col min-w-0">
              {/* Topbar */}
              <div className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between bg-background/20 shrink-0">
                <h2 className="text-sm font-bold text-foreground">Pipeline · Active Opportunities</h2>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 px-2.5 py-1 bg-success/10 text-success text-[10px] font-bold border border-success/20 rounded-md uppercase tracking-wider">
                    <span className="size-1.5 rounded-full bg-success animate-dot-blink" />
                    12 deals
                  </span>
                  <span className="flex items-center gap-1 px-2.5 py-1 bg-warning/10 text-warning text-[10px] font-bold border border-warning/20 rounded-md">
                    <Clock className="size-2.5" />
                    5 follow-ups due
                  </span>
                </div>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Pipeline table */}
                <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
                  {/* Stage summary */}
                  <div className="grid grid-cols-4 gap-2.5 shrink-0">
                    {[
                      { stage: "Discovery", count: 4, color: "text-muted-foreground", bg: "bg-border/40" },
                      { stage: "Qualified", count: 3, color: "text-brand", bg: "bg-brand/10" },
                      { stage: "Proposal", count: 3, color: "text-warning", bg: "bg-warning/10" },
                      { stage: "Closing", count: 2, color: "text-success", bg: "bg-success/10" },
                    ].map(({ stage, count, color, bg }) => (
                      <div key={stage} className={`${bg} border border-border/40 rounded-lg p-2.5 text-center`}>
                        <p className={`text-xl font-bold ${color}`}>{count}</p>
                        <p className="text-[10px] text-muted-foreground font-medium mt-0.5">{stage}</p>
                      </div>
                    ))}
                  </div>

                  {/* Table */}
                  <div className="bg-background/40 border border-border/60 rounded-xl overflow-hidden flex-1">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-card/60 border-b border-border/60">
                        <tr>
                          {["Company", "Score", "Stage", "Last activity"].map((h, i) => (
                            <th key={h} className={`p-3 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider ${i === 3 ? "text-right" : ""}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {prospects.map((row, i) => (
                          <tr
                            key={row.name}
                            className={`hover:bg-white/[0.025] transition-colors ${i < prospects.length - 1 ? "border-b border-border/40" : ""}`}
                            style={{ animationDelay: `${i * 80}ms` }}
                          >
                            <td className="p-3 text-foreground font-medium text-[13px]">{row.name}</td>
                            <td className="p-3">
                              <div className="flex items-center gap-2">
                                <div className="w-10 h-1 bg-border rounded-full overflow-hidden">
                                  <div className="h-full bg-brand rounded-full transition-all duration-1000" style={{ width: `${row.score}%` }} />
                                </div>
                                <span className="text-[11px] text-muted-foreground font-mono">{row.score}</span>
                              </div>
                            </td>
                            <td className="p-3">
                              <span className={`px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wider ${stageColor[row.stage] ?? ""}`}>
                                {row.stage}
                              </span>
                            </td>
                            <td className="p-3 text-right text-[11px] text-muted-foreground">
                              {["Contract review", "Proposal sent", "Meeting booked", "Follow-up due", "Intro call done"][i]}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Activity feed */}
                <aside className="w-44 shrink-0 border-l border-border/60 p-3 hidden xl:flex flex-col gap-2 bg-background/10">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Activity className="size-2.5" /> Activity
                  </p>
                  {feed.map((item, i) => (
                    <div
                      key={i}
                      className="p-2 rounded-lg bg-card/40 border border-border/40 hover:border-border/80 transition-all duration-300"
                      style={{ opacity: tick >= 0 ? 1 : 0 }}
                    >
                      <p className={`text-[11px] font-medium leading-tight ${item.color}`}>{item.text}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{item.time}</p>
                    </div>
                  ))}
                </aside>
              </div>
            </main>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Problem / Why MAST ────────────────────────────────────────────────────────
function Problem() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.3 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const n1 = useCountUp(12, 900, visible);
  const n2 = useCountUp(5, 700, visible);
  const n3 = useCountUp(340, 1100, visible);

  const bullets = [
    "Find the right companies before your competitors do.",
    "Qualify fast with AI-enriched business profiles.",
    "Track every deal in a pipeline that's already connected.",
    "Never miss a follow-up. Never lose a deal to silence.",
  ];

  return (
    <section id="solutions" className="py-28 px-6">
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-20 items-center">
        <div className="animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Why MAST</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight leading-tight">
            Your tools don't talk to each other.{" "}
            <span className="text-muted-foreground">Yours should.</span>
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed text-[0.95rem]">
            The average sales team juggles five separate tools — a scraper, a spreadsheet,
            a database, a sequencer, and a calendar. Every handoff is a gap where deals fall through.
            MAST closes those gaps.
          </p>
          <ul className="mt-8 space-y-3.5">
            {bullets.map((t, i) => (
              <li
                key={t}
                className="flex items-start gap-3.5 text-sm text-foreground animate-slide-right"
                style={{ animationDelay: `${i * 90 + 200}ms` }}
              >
                <CheckCircle2 className="size-4.5 text-brand shrink-0 mt-0.5" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div ref={ref} className="animate-fade-up delay-200">
          <div className="relative bg-card border border-border/60 rounded-3xl p-8 shadow-elevated card-hover gradient-border">
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "Active deals", value: n1, suffix: "", sub: "across pipeline stages" },
                { label: "Follow-ups due", value: n2, suffix: "", sub: "in the next 48 hours" },
                { label: "Companies researched", value: n3, suffix: "", sub: "this month" },
                { label: "Tools replaced", value: visible ? "1" : "0", suffix: "", sub: "MAST does it all" },
              ].map(({ label, value, sub }) => (
                <div key={label} className="rounded-2xl bg-background/60 border border-border/50 p-4 hover:border-brand/30 transition-colors duration-200">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-bold text-foreground tabular-nums">{value}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>
                </div>
              ))}
            </div>

            {/* AI card */}
            <div className="mt-5 rounded-2xl border border-brand/20 p-4 bg-background/40">
              <div className="flex items-center gap-2 mb-2.5">
                <Sparkles className="size-3.5 text-brand" />
                <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Recommendation</p>
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                Luminal AI hasn't heard from you in 6 days. Their funding round closes Friday.
                Now is the right time to reach out.
              </p>
              <p className="mt-2.5 text-[10px] text-muted-foreground">MAST Intelligence · Suggested action</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Features ─────────────────────────────────────────────────────────────────
const features = [
  {
    icon: Target,
    outcome: "Find your next customer.",
    title: "Prospect Research",
    desc: "Discover and qualify companies using publicly available business information. Filter by industry, region, and size to surface the right opportunities.",
  },
  {
    icon: Sparkles,
    outcome: "Know who's worth your time.",
    title: "AI Business Intelligence",
    desc: "AI surfaces company profiles, website signals, and business context so you can focus on the accounts most likely to convert.",
  },
  {
    icon: TrendingUp,
    outcome: "Work the best deals first.",
    title: "Opportunity Scoring",
    desc: "Every prospect is scored on relevance signals. Your team always knows which accounts to prioritize.",
  },
  {
    icon: Users,
    outcome: "Keep everything in one place.",
    title: "Relationship Data",
    desc: "Contacts, companies, notes, tags, and team assignments — all connected. No spreadsheets. No sync failures.",
  },
  {
    icon: GitBranch,
    outcome: "Never lose a deal again.",
    title: "Pipeline Management",
    desc: "Visual stages from first touch to signed contract. See your entire book of business in one view.",
  },
  {
    icon: Bell,
    outcome: "Follow up before they forget you.",
    title: "Automated Follow-ups",
    desc: "Scheduled reminders and activity tracking ensure no opportunity goes cold from lack of attention.",
  },
  {
    icon: BarChart3,
    outcome: "Know exactly what's working.",
    title: "Sales Insights",
    desc: "Pipeline velocity, conversion rates, and team activity — visible without leaving the platform.",
  },
  {
    icon: Layers,
    outcome: "Reach out, all from one place.",
    title: "Multi-channel Outreach",
    desc: "Email, phone, and social channels coordinated inside the workspace. Every interaction logged automatically.",
  },
  {
    icon: ShieldCheck,
    outcome: "Your data. Your relationship network.",
    title: "Privacy & Ownership",
    desc: "All prospect data sourced from public business information. Your relationship data belongs to you — export any time.",
  },
];

function Features() {
  return (
    <section className="py-28 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-20 max-w-2xl mx-auto animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Platform</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight">
            Everything your sales team needs.
            <br />
            <span className="text-muted-foreground">Nothing it doesn't.</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-[0.95rem] leading-relaxed">
            Nine modules. One workspace. AI running through all of it.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="group relative p-7 bg-card border border-border/60 rounded-2xl card-hover overflow-hidden animate-fade-up"
              style={{ animationDelay: `${i * 55}ms` }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-brand/0 to-brand/0 group-hover:from-brand/[0.04] group-hover:to-transparent transition-all duration-500 pointer-events-none rounded-2xl" />

              <div className="relative size-11 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center mb-5 group-hover:bg-brand/20 group-hover:border-brand/35 group-hover:scale-110 transition-all duration-300 shadow-[0_0_16px_-6px_color-mix(in_oklab,var(--brand)_50%,transparent)] group-hover:shadow-[0_0_24px_-4px_color-mix(in_oklab,var(--brand)_70%,transparent)]">
                <f.icon className="size-5 text-brand" />
              </div>

              {/* Outcome-first headline */}
              <p className="text-base font-bold text-foreground mb-1">{f.outcome}</p>
              <p className="text-[11px] font-semibold text-brand uppercase tracking-wider mb-2.5">{f.title}</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>

              <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Plan card ─────────────────────────────────────────────────────────────────
const plans = [
  {
    name: "Free",
    price: "$0",
    forWho: "Explore the platform",
    outcome: "See if MAST fits your workflow.",
    features: ["10 prospects / day · 300 / mo", "Business profile research", "Multi-region search", "CSV export"],
    cta: "Start Free",
    popular: false,
  },
  {
    name: "Starter",
    price: "$29",
    forWho: "Solo operators",
    outcome: "Build a real pipeline, on your own.",
    features: ["50 prospects / day · 1,500 / mo", "Full contact intelligence", "Relationship data layer", "Limited AI assistance"],
    cta: "Get Started",
    popular: false,
  },
  {
    name: "Pro",
    price: "$79",
    forWho: "Growing agencies",
    outcome: "Scale your pipeline without scaling headcount.",
    features: ["200 prospects / day · 6,000 / mo", "AI enrichment + sequences", "Full pipeline workspace", "API access · 3 team seats"],
    cta: "Upgrade to Pro",
    popular: true,
  },
  {
    name: "Premium",
    price: "$199",
    forWho: "Growth operators",
    outcome: "Run a full sales operation end-to-end.",
    features: ["833 prospects / day · 25,000 / mo", "Premium intelligence pool", "Highest AI assistance", "Full automations · Unlimited seats"],
    cta: "Contact Sales",
    popular: false,
  },
];

export function PlanCard({ name, price, forWho, outcome, features, cta, popular }: {
  name: string; price: string; forWho?: string; outcome?: string; desc?: string; features: string[]; cta: string; popular: boolean;
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

      {/* Plan name */}
      <div className={`text-[10px] font-bold uppercase tracking-[0.2em] mb-3 ${popular ? "text-brand" : "text-muted-foreground"}`}>
        {name}
      </div>

      {/* Price */}
      <div className="text-[2.2rem] font-bold text-foreground leading-none">
        {price}
        <span className="text-sm text-muted-foreground font-normal">/mo</span>
      </div>

      {/* Who it's for */}
      {forWho && <p className="text-[11px] text-muted-foreground mt-1.5 font-medium">{forWho}</p>}

      {/* Outcome */}
      {outcome && (
        <p className="text-sm font-semibold text-foreground mt-3 mb-5 leading-snug">{outcome}</p>
      )}

      <ul className="space-y-3 flex-1 mb-7">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-brand shrink-0 mt-0.5" /> {f}
          </li>
        ))}
      </ul>

      <Link
        to="/signup"
        className={`w-full py-3 rounded-xl font-bold transition-all duration-200 btn-press text-center text-sm ${
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
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold text-foreground">
            One price. No surprises.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Daily lead limits keep your pipeline active all month, not just week one.
          </p>
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
            Full feature comparison
            <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─── CTA ──────────────────────────────────────────────────────────────────────
function CTA() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-5xl mx-auto relative rounded-3xl overflow-hidden border border-border/60 p-16 text-center gradient-border">
        <div className="absolute inset-0 bg-card" />
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{ background: "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)" }}
        />
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
        <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent" />

        <div className="relative">
          <p className="animate-fade-up text-[11px] font-bold text-brand uppercase tracking-[0.2em] mb-5">Get started today</p>
          <h2 className="text-[clamp(1.9rem,5vw,3rem)] font-bold tracking-tight leading-tight animate-fade-up delay-100">
            Your sales operation,<br />finally in one place.
          </h2>
          <p className="mt-5 text-muted-foreground max-w-md mx-auto text-[0.95rem] leading-relaxed animate-fade-up delay-200">
            Start free. No credit card. Research your first prospects and see how MAST connects
            the dots between discovery, pipeline, and close.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up delay-300">
            <Link
              to="/signup"
              className="group relative bg-brand text-brand-foreground px-8 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all duration-200 btn-press overflow-hidden"
            >
              <span className="relative z-10">Start for free</span>
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
            </Link>
            <Link
              to="/pricing"
              className="bg-background border border-border/80 px-8 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-brand/5 transition-all duration-200 btn-press"
            >
              View pricing
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
