import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode, type ReactElement } from "react";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { BrandMark } from "@/components/mast/BrandMark";
import { SignatureGlobe } from "@/components/mast/landing/SignatureGlobe";
import { LandingAtmosphere } from "@/components/mast/landing/LandingAtmosphere";
import {
  Sparkles, Users, Zap, ShieldCheck,
  CheckCircle2, ArrowRight, BarChart3,
  Activity, Target, Layers,
  Bell, GitBranch, TrendingUp, Clock,
  Building2, MessageSquareText, Compass, Radar,
  Search, Wand2, FolderKanban, Send, Trophy,
  Mail, Phone, Globe2, MapPin, Tag, Star,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mast — The AI Sales Operating System" },
      { name: "description", content: "Research businesses, manage opportunities, run your pipeline, and stay on top of every relationship — all in one AI-powered sales workspace. MAST is the operating system for modern sales teams." },
      { property: "og:title", content: "Mast — The AI Sales Operating System" },
      { property: "og:description", content: "One workspace. AI-powered. Built for teams that close deals." },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="mast-landing min-h-screen bg-background text-foreground overflow-x-hidden">
      <LandingAtmosphere />
      <SiteNav disableBackdropBlur />
      <Hero />
      <Workflow />
      <ProductShowcase />
      <TrustedBy />
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
const heroStats = [
  { icon: Building2, value: "50K+", label: "Businesses discovered" },
  { icon: ShieldCheck, value: "95%", label: "Accurate data" },
  { icon: MessageSquareText, value: "2.3x", label: "More replies" },
  { icon: Layers, value: "1", label: "Unified workspace" },
];

function Hero() {
  return (
    <header className="relative pt-32 md:pt-40 pb-16 md:pb-20 px-6 overflow-hidden">
      <div className="relative max-w-7xl mx-auto grid lg:grid-cols-[1.05fr_1fr] gap-4 lg:gap-2 items-center">
        {/* Copy column */}
        <div className="text-center lg:text-left">
          <div className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--landing-blue-tint)] border border-[var(--landing-blue-border)] text-[var(--landing-blue-bright)] text-[11px] font-bold tracking-wider uppercase mb-8 shadow-[0_0_20px_-8px_var(--landing-blue)]">
            <span className="relative size-2 rounded-full bg-[var(--landing-blue-bright)] ping-dot" />
            The AI Sales Operating System
          </div>

          <h1 className="animate-fade-up delay-100 text-[clamp(2.4rem,6vw,4.4rem)] font-bold text-foreground tracking-tight mb-6 leading-[1.05]">
            Stop switching tabs.<br />
            <span className="text-gold-gradient">Start closing deals.</span>
          </h1>

          <p className="animate-fade-up delay-200 text-[1.05rem] text-muted-foreground mb-9 max-w-[480px] mx-auto lg:mx-0 leading-relaxed">
            MAST replaces your scattered sales stack with one AI workspace —
            business research, relationship data, pipeline, and reminders, all talking to each other.
          </p>

          <div className="animate-fade-up delay-300 flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3">
            <Link
              to="/signup"
              className="group relative w-full sm:w-auto bg-[var(--landing-blue)] text-white px-8 py-3.5 rounded-xl font-semibold hover:bg-[var(--landing-blue-hover)] transition-all duration-200 inline-flex items-center justify-center gap-2 btn-press overflow-hidden shadow-[0_10px_30px_-10px_var(--landing-blue)]"
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

          {/* Stat strip */}
          <div className="animate-fade-up delay-500 mt-10 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-6 max-w-lg mx-auto lg:mx-0 pt-8 border-t border-border/50">
            {heroStats.map(({ icon: Icon, value, label }) => (
              <div key={label} className="flex items-center gap-2.5 justify-center lg:justify-start">
                <Icon className="size-4 text-foreground/70 shrink-0" />
                <div className="text-left leading-tight">
                  <p className="text-lg font-bold text-foreground tabular-nums">{value}</p>
                  <p className="text-[10.5px] text-muted-foreground font-medium">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Globe column */}
        <div className="relative h-[380px] sm:h-[460px] md:h-[560px] lg:h-[660px] animate-scale-in delay-150 lg:-mr-6 xl:-mr-10">
          <SignatureGlobe className="w-full h-full" />
        </div>
      </div>
    </header>
  );
}

// ─── Workflow — the 5-step loop ────────────────────────────────────────────────
const workflowSteps = [
  { icon: Radar, title: "Discover", desc: "We find businesses that need you" },
  { icon: Wand2, title: "Enrich", desc: "AI collects emails, phones, socials & more" },
  { icon: FolderKanban, title: "Organize", desc: "Everything in your smart workspace" },
  { icon: Send, title: "Outreach", desc: "Message with AI that gets replies" },
  { icon: Trophy, title: "Close", desc: "Move deals forward and win more" },
];

function Workflow() {
  return (
    <section className="relative px-6 pb-16 md:pb-24">
      <div className="max-w-6xl mx-auto animate-fade-up">
        <div className="relative rounded-3xl border border-border/60 bg-card/70 backdrop-blur-sm px-6 sm:px-10 py-9 sm:py-10 gradient-border overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
          <div className="flex flex-col md:flex-row items-stretch justify-between gap-8 md:gap-2">
            {workflowSteps.map((step, i) => (
              <div key={step.title} className="flex items-center md:contents">
                <div className="flex flex-col items-center text-center gap-2.5 flex-1 md:px-2">
                  <div className="relative size-11 rounded-full bg-[var(--landing-blue-tint)] border border-[var(--landing-blue-border)] grid place-items-center">
                    <span className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-[var(--landing-blue)] text-white text-[10px] font-bold grid place-items-center border-2 border-card">
                      {i + 1}
                    </span>
                    <step.icon className="size-5 text-[var(--landing-blue-bright)]" />
                  </div>
                  <p className="font-bold text-foreground text-[13px]">{step.title}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug max-w-[130px]">{step.desc}</p>
                </div>
                {i < workflowSteps.length - 1 && (
                  <ArrowRight className="hidden md:block size-4 text-muted-foreground/40 mx-1 shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Product Showcase — tabbed, screenshot-style app preview ──────────────────
type ShowcaseTab = {
  id: string;
  label: string;
  icon: typeof Target;
  navKey: string;
  eyebrow: string;
  headline: string;
  headlineAccent: string;
  desc: string;
  bullets: string[];
  cta: string;
};

const showcaseTabs: ShowcaseTab[] = [
  {
    id: "research",
    label: "Business Research",
    icon: Search,
    navKey: "Research",
    eyebrow: "Business Research",
    headline: "Research any business.",
    headlineAccent: "Know everything that matters.",
    desc: "MAST scans the entire web to build deep, accurate profiles on any company. Understand their business, find the right contacts, and reach out with confidence.",
    bullets: [
      "Find verified emails and phone numbers",
      "Discover social profiles and websites",
      "Understand their business and needs",
      "Spot opportunities your competitors miss",
    ],
    cta: "Start researching",
  },
  {
    id: "pipeline",
    label: "Pipeline",
    icon: BarChart3,
    navKey: "Pipeline",
    eyebrow: "Pipeline",
    headline: "See every deal.",
    headlineAccent: "Never lose track of a stage.",
    desc: "Visual stages from first touch to signed contract. Scores, activity, and follow-ups live right next to every opportunity — no separate spreadsheet required.",
    bullets: [
      "Drag deals through custom pipeline stages",
      "Opportunity scoring on every account",
      "Live activity feed across your team",
      "Follow-up due dates that never slip",
    ],
    cta: "View your pipeline",
  },
  {
    id: "relationships",
    label: "Relationship Data",
    icon: Users,
    navKey: "Research",
    eyebrow: "Relationship Data",
    headline: "Every contact.",
    headlineAccent: "Every connection, in one place.",
    desc: "Contacts, companies, notes, tags, and team assignments — all connected. No spreadsheets. No sync failures. No losing context between reps.",
    bullets: [
      "Unified contact and company records",
      "Notes and tags shared across the team",
      "Full interaction history per relationship",
      "Ownership and hand-offs tracked automatically",
    ],
    cta: "Explore relationships",
  },
  {
    id: "intelligence",
    label: "AI Intelligence",
    icon: Sparkles,
    navKey: "Insights",
    eyebrow: "AI Intelligence",
    headline: "AI that reads the room.",
    headlineAccent: "So you know who to call next.",
    desc: "AI surfaces company signals, funding events, and hiring trends, then recommends the next best action — before your competitors even notice the opening.",
    bullets: [
      "Signals on funding, hiring, and growth",
      "Opportunity scoring, explained in plain English",
      "Daily AI recommendations, ranked by priority",
      "Executive briefings without the busywork",
    ],
    cta: "See AI Intelligence",
  },
  {
    id: "reminders",
    label: "Reminders",
    icon: Bell,
    navKey: "Focus",
    eyebrow: "Reminders",
    headline: "Never let a deal",
    headlineAccent: "go quiet again.",
    desc: "Scheduled reminders and activity tracking keep every opportunity and relationship moving forward — even on your busiest week.",
    bullets: [
      "Smart follow-up scheduling",
      "Daily focus list, ranked by urgency",
      "Snooze, reassign, or auto-complete",
      "Nothing falls through the cracks",
    ],
    cta: "Set up reminders",
  },
];

function PanelShell({ activeNav, breadcrumb, children }: { activeNav: string; breadcrumb: string; children: ReactNode }) {
  const navItems = ["Focus", "Research", "Pipeline", "Insights", "Settings"];
  return (
    <div className="relative rounded-3xl overflow-hidden border border-border/70 shadow-elevated gradient-border h-full">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent z-10" />
      <div className="flex h-[480px] sm:h-[520px] md:h-[560px] bg-card">
        <aside className="w-48 shrink-0 border-r border-border p-4 hidden lg:flex flex-col gap-6 bg-[oklch(0.14_0.024_265)]">
          <div className="flex items-center gap-2.5 pt-1 px-1">
            <BrandMark size={20} />
            <span className="font-bold text-[11px] tracking-[0.14em] text-foreground">MAST</span>
          </div>
          <nav className="space-y-0.5">
            {navItems.map((label) => (
              <div
                key={label}
                className={`px-3 py-2 rounded-lg text-[13px] font-medium transition-all border-l-2 ${
                  label === activeNav
                    ? "bg-[var(--landing-blue-tint)] text-[var(--landing-blue-bright)] border-l-[var(--landing-blue)]"
                    : "text-muted-foreground border-l-transparent"
                }`}
              >
                {label}
              </div>
            ))}
          </nav>
          <div className="mt-auto bg-background/60 p-3 rounded-xl border border-border/60 space-y-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-4 text-brand" />
              <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Insight</p>
            </div>
            <p className="text-[11px] text-foreground leading-relaxed">
              Helix Commerce is hiring for sales roles and recently raised $12M in funding.
            </p>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between bg-background/20 shrink-0">
            <p className="text-[12px] text-muted-foreground truncate">{breadcrumb}</p>
            <ArrowRight className="size-3.5 text-muted-foreground/50 shrink-0" />
          </div>
          <div className="flex-1 overflow-hidden">{children}</div>
        </main>
      </div>
    </div>
  );
}

function ResearchPanel() {
  return (
    <PanelShell activeNav="Research" breadcrumb="Research  ›  Helix Commerce">
      <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-11 rounded-xl bg-brand/10 border border-brand/25 grid place-items-center shrink-0">
              <Building2 className="size-5 text-brand" />
            </div>
            <div>
              <p className="font-bold text-foreground text-sm">Helix Commerce</p>
              <p className="text-[11px] text-muted-foreground">B2B E-commerce Platform</p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                <MapPin className="size-3" /> New York, United States
              </p>
            </div>
          </div>
          <div className="text-right shrink-0 bg-background/50 border border-border/60 rounded-xl px-3 py-2">
            <p className="text-xl font-bold text-foreground leading-none">92</p>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider mt-1">Opportunity Score</p>
          </div>
        </div>

        <div className="flex items-center gap-4 border-b border-border/50 text-[11px] font-semibold text-muted-foreground pb-2">
          <span className="text-brand border-b-2 border-brand pb-2 -mb-2">Overview</span>
          <span>Contacts</span>
          <span className="hidden sm:inline">Signals</span>
          <span className="hidden sm:inline">Technologies</span>
          <span className="hidden sm:inline">News</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Key Information</p>
            <div className="space-y-2 text-[12px]">
              {[
                ["Industry", "E-commerce"],
                ["Company", "51–200 employees"],
                ["Founded", "2018"],
                ["Revenue", "$10M – $25M"],
                ["Funding", "Series A · $12M"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-border/30 pb-1.5">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="text-foreground font-medium">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Contacts</p>
            <div className="space-y-2.5 text-[12px]">
              {[
                { icon: Mail, v: "info@helixcommerce.com", sub: "General Inquiries" },
                { icon: Mail, v: "sarah@helixcommerce.com", sub: "Head of Sales" },
                { icon: Phone, v: "+1 (212) 555-0187", sub: "Main Number" },
              ].map((c) => (
                <div key={c.v} className="flex items-start gap-2">
                  <c.icon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-foreground font-medium truncate">{c.v}</p>
                    <p className="text-muted-foreground text-[10px]">{c.sub}</p>
                  </div>
                  <CheckCircle2 className="size-3.5 text-success ml-auto shrink-0" />
                </div>
              ))}
              <p className="text-brand text-[11px] font-semibold pt-1">View all contacts →</p>
            </div>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function PipelinePanel() {
  const [aiText, setAiText] = useState("");
  const fullAiText = "Helix Commerce — growth-stage SaaS. Strong ICP fit. Recommend scheduling a discovery call this week.";
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i++;
      setAiText(fullAiText.slice(0, i));
      if (i >= fullAiText.length) clearInterval(id);
    }, 26);
    return () => clearInterval(id);
  }, []);

  const prospects = [
    { name: "Helix Commerce", stage: "Closing", score: 98 },
    { name: "Vortex Media", stage: "Proposal", score: 94 },
    { name: "Luminal AI", stage: "Qualified", score: 91 },
    { name: "Skyline Growth", stage: "Discovery", score: 87 },
  ];
  const stageColor: Record<string, string> = {
    Qualified: "bg-brand/10 text-brand border-brand/20",
    Proposal: "bg-warning/10 text-warning border-warning/20",
    Discovery: "bg-muted/30 text-muted-foreground border-border/40",
    Closing: "bg-success/10 text-success border-success/20",
  };

  return (
    <PanelShell activeNav="Pipeline" breadcrumb="Pipeline  ›  Active Opportunities">
      <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-4 gap-2">
          {[
            { stage: "Discovery", count: 4, color: "text-muted-foreground", bg: "bg-border/40" },
            { stage: "Qualified", count: 3, color: "text-brand", bg: "bg-brand/10" },
            { stage: "Proposal", count: 3, color: "text-warning", bg: "bg-warning/10" },
            { stage: "Closing", count: 2, color: "text-success", bg: "bg-success/10" },
          ].map(({ stage, count, color, bg }) => (
            <div key={stage} className={`${bg} border border-border/40 rounded-lg p-2 text-center`}>
              <p className={`text-lg font-bold ${color}`}>{count}</p>
              <p className="text-[9px] text-muted-foreground font-medium mt-0.5">{stage}</p>
            </div>
          ))}
        </div>

        <div className="bg-background/40 border border-border/60 rounded-xl overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-card/60 border-b border-border/60">
              <tr>
                {["Company", "Score", "Stage"].map((h) => (
                  <th key={h} className="p-2.5 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prospects.map((row, i) => (
                <tr key={row.name} className={i < prospects.length - 1 ? "border-b border-border/40" : ""}>
                  <td className="p-2.5 text-foreground font-medium text-[12px]">{row.name}</td>
                  <td className="p-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-10 h-1 bg-border rounded-full overflow-hidden">
                        <div className="h-full bg-brand rounded-full" style={{ width: `${row.score}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono">{row.score}</span>
                    </div>
                  </td>
                  <td className="p-2.5">
                    <span className={`px-1.5 py-0.5 text-[9px] rounded border font-semibold uppercase tracking-wider ${stageColor[row.stage] ?? ""}`}>
                      {row.stage}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-brand/20 p-3.5 bg-background/40">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="size-4 text-brand" />
            <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Insight</p>
          </div>
          <p className="text-[12px] text-foreground leading-relaxed min-h-[34px]">
            {aiText}
            <span className="inline-block w-0.5 h-3 bg-brand ml-0.5 animate-pulse align-middle" />
          </p>
        </div>
      </div>
    </PanelShell>
  );
}

function RelationshipsPanel() {
  const contacts = [
    { name: "Sarah Whitfield", role: "Head of Sales · Helix Commerce", tag: "Warm", tagColor: "bg-success/10 text-success border-success/20" },
    { name: "Daniel Reyes", role: "Founder · Vortex Media", tag: "New", tagColor: "bg-brand/10 text-brand border-brand/20" },
    { name: "Priya Nair", role: "VP Growth · Luminal AI", tag: "Follow-up", tagColor: "bg-warning/10 text-warning border-warning/20" },
    { name: "Tom Baker", role: "Ops Lead · Skyline Growth", tag: "Cold", tagColor: "bg-muted/30 text-muted-foreground border-border/40" },
    { name: "Elena Cross", role: "CEO · Northwind Studio", tag: "Warm", tagColor: "bg-success/10 text-success border-success/20" },
  ];
  return (
    <PanelShell activeNav="Research" breadcrumb="Relationships  ›  All Contacts">
      <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-2.5">
        {contacts.map((c) => (
          <div key={c.name} className="flex items-center gap-3 bg-background/40 border border-border/50 rounded-xl p-3 hover:border-brand/30 transition-colors">
            <div className="size-9 rounded-full bg-brand/10 border border-brand/25 grid place-items-center text-[11px] font-bold text-brand shrink-0">
              {c.name.split(" ").map((n) => n[0]).join("")}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-foreground truncate">{c.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{c.role}</p>
            </div>
            <span className={`shrink-0 px-2 py-0.5 rounded-md border text-[9.5px] font-semibold uppercase tracking-wider ${c.tagColor}`}>
              {c.tag}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-1">
          <Tag className="size-3.5" /> 1,842 relationships tracked across your team
        </div>
      </div>
    </PanelShell>
  );
}

function IntelligencePanel() {
  return (
    <PanelShell activeNav="Insights" breadcrumb="Insights  ›  Weekly Intelligence">
      <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-3">
        <div className="rounded-xl border border-brand/25 p-3.5 bg-background/40">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="size-4 text-brand" />
            <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Recommendation</p>
          </div>
          <p className="text-[12px] text-foreground leading-relaxed">
            Luminal AI hasn't had an update in 6 days and their funding round closes Friday.
            Consider a follow-up meeting this week.
          </p>
        </div>
        {[
          { icon: TrendingUp, label: "Vortex Media raised a $4M seed round", time: "2h ago" },
          { icon: Users, label: "Skyline Growth is hiring 3 sales roles", time: "6h ago" },
          { icon: Globe2, label: "Northwind Studio relaunched their website", time: "1d ago" },
        ].map((s) => (
          <div key={s.label} className="flex items-start gap-2.5 bg-background/30 border border-border/40 rounded-lg p-3">
            <s.icon className="size-4 text-brand shrink-0 mt-0.5" />
            <div>
              <p className="text-[12px] text-foreground leading-snug">{s.label}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.time}</p>
            </div>
          </div>
        ))}
        <div className="grid grid-cols-3 gap-2 pt-1">
          {[
            { v: "92", l: "Avg. score" },
            { v: "14", l: "Hot signals" },
            { v: "3.1x", l: "Reply lift" },
          ].map((s) => (
            <div key={s.l} className="text-center bg-background/40 border border-border/40 rounded-lg py-2.5">
              <p className="text-base font-bold text-foreground">{s.v}</p>
              <p className="text-[9px] text-muted-foreground mt-0.5">{s.l}</p>
            </div>
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

function RemindersPanel() {
  const reminders = [
    { label: "Follow up with Helix Commerce", due: "Today, 2:00 PM", priority: "High", color: "bg-destructive/10 text-destructive border-destructive/20" },
    { label: "Send proposal to Vortex Media", due: "Tomorrow", priority: "Medium", color: "bg-warning/10 text-warning border-warning/20" },
    { label: "Check in with Luminal AI", due: "Fri, 10:00 AM", priority: "Medium", color: "bg-warning/10 text-warning border-warning/20" },
    { label: "Quarterly review — Skyline Growth", due: "Next week", priority: "Low", color: "bg-muted/30 text-muted-foreground border-border/40" },
  ];
  return (
    <PanelShell activeNav="Focus" breadcrumb="Focus  ›  Today's Follow-ups">
      <div className="h-full overflow-y-auto p-4 sm:p-5 space-y-2.5">
        {reminders.map((r) => (
          <div key={r.label} className="flex items-center gap-3 bg-background/40 border border-border/50 rounded-xl p-3">
            <div className="size-4 rounded-md border-2 border-border shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-foreground truncate">{r.label}</p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock className="size-3" /> {r.due}
              </p>
            </div>
            <span className={`shrink-0 px-2 py-0.5 rounded-md border text-[9.5px] font-semibold uppercase tracking-wider ${r.color}`}>
              {r.priority}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-1">
          <Star className="size-3.5 text-brand" /> 5 follow-ups due in the next 48 hours
        </div>
      </div>
    </PanelShell>
  );
}

const showcasePanels: Record<string, () => ReactElement> = {
  research: ResearchPanel,
  pipeline: PipelinePanel,
  relationships: RelationshipsPanel,
  intelligence: IntelligencePanel,
  reminders: RemindersPanel,
};

function ProductShowcase() {
  const [active, setActive] = useState(showcaseTabs[0].id);
  const tab = showcaseTabs.find((t) => t.id === active) ?? showcaseTabs[0];
  const Panel = showcasePanels[tab.id];

  return (
    <section className="relative px-6 pb-28 md:pb-36">
      <div className="max-w-6xl mx-auto">
        {/* Tab pills */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-14 animate-fade-up">
          {showcaseTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-semibold border transition-all duration-200 btn-press ${
                active === t.id
                  ? "bg-[var(--landing-blue-tint)] border-[var(--landing-blue-border)] text-[var(--landing-blue-bright)] shadow-[0_0_20px_-8px_var(--landing-blue)]"
                  : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
          {/* Copy */}
          <div key={tab.id} className="animate-fade-up">
            <span className="text-[10px] font-bold text-[var(--landing-blue-bright)] uppercase tracking-[0.2em]">{tab.eyebrow}</span>
            <h2 className="mt-4 text-[clamp(1.8rem,3.6vw,2.6rem)] font-bold tracking-tight leading-[1.12]">
              {tab.headline}
              <br />
              {tab.headlineAccent}
            </h2>
            <p className="mt-5 text-muted-foreground leading-relaxed text-[0.95rem]">{tab.desc}</p>
            <ul className="mt-7 space-y-3">
              {tab.bullets.map((b) => (
                <li key={b} className="flex items-start gap-3 text-sm text-foreground">
                  <CheckCircle2 className="size-4.5 text-brand shrink-0 mt-0.5" />
                  {b}
                </li>
              ))}
            </ul>
            <Link
              to="/signup"
              className="group mt-8 inline-flex items-center gap-2 bg-[var(--landing-blue)] text-white px-6 py-3 rounded-xl font-semibold hover:bg-[var(--landing-blue-hover)] transition-all duration-200 btn-press shadow-[0_10px_30px_-10px_var(--landing-blue)]"
            >
              {tab.cta}
              <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform duration-200" />
            </Link>
          </div>

          {/* Screenshot panel */}
          <div key={`${tab.id}-panel`} className="animate-scale-in">
            <Panel />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Trusted by ─────────────────────────────────────────────────────────────
const trustedLogos = [
  { name: "Vortex", icon: Compass },
  { name: "Luminal", icon: Zap },
  { name: "Skyline", icon: TrendingUp },
  { name: "Northwind", icon: Globe2 },
  { name: "Pulse", icon: Activity },
  { name: "Elite Fitness", icon: Trophy },
];

function TrustedBy() {
  return (
    <section className="px-6 pb-24 md:pb-28">
      <div className="max-w-5xl mx-auto text-center animate-fade-up">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.2em] mb-8">
          Trusted by growing teams worldwide
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
          {trustedLogos.map(({ name, icon: Icon }) => (
            <div
              key={name}
              className="flex items-center gap-2 text-muted-foreground/70 hover:text-brand transition-colors duration-300 grayscale hover:grayscale-0 cursor-default"
            >
              <Icon className="size-4" />
              <span className="font-bold text-sm tracking-tight">{name}</span>
            </div>
          ))}
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
    "Research the right businesses before your competitors do.",
    "Evaluate opportunities fast with AI-enriched business profiles.",
    "Track every deal in a pipeline that's already connected.",
    "Never miss a reminder. Never lose a deal to silence.",
  ];

  return (
    <section id="solutions" className="py-32 px-6">
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-20 items-center">
        <div className="animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Why MAST</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight leading-tight">
            Your tools don't talk to each other.{" "}
            <span className="text-muted-foreground">Yours should.</span>
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed text-[0.95rem]">
            The average sales team juggles five separate tools — a research tool, a spreadsheet,
            a database, a CRM, and a calendar. Every handoff is a gap where deals fall through.
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
                <Sparkles className="size-4 text-brand" />
                <p className="text-[10px] font-bold text-brand uppercase tracking-wider">AI Recommendation</p>
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                Luminal AI hasn't had an update in 6 days and their funding round closes Friday.
                Consider moving this opportunity forward with a follow-up meeting.
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
    outcome: "Understand your market.",
    title: "Business Research",
    desc: "Research and evaluate companies using publicly available business information. Filter by industry, region, and size to organize the right opportunities.",
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
    desc: "Every opportunity is scored on relevance signals. Your team always knows which accounts to prioritize.",
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
    outcome: "Never let a relationship go quiet.",
    title: "Reminders & Activity Tracking",
    desc: "Scheduled reminders and activity tracking keep every opportunity and relationship moving forward.",
  },
  {
    icon: BarChart3,
    outcome: "Know exactly what's working.",
    title: "Sales Insights",
    desc: "Pipeline velocity, conversion rates, and team activity — visible without leaving the platform.",
  },
  {
    icon: Layers,
    outcome: "Every conversation, in one timeline.",
    title: "Communication Management",
    desc: "Email, phone, and social channels organized inside the workspace. Every interaction logged automatically into a single history.",
  },
  {
    icon: ShieldCheck,
    outcome: "Your data. Your relationship network.",
    title: "Privacy & Ownership",
    desc: "All business data sourced from public business information. Your relationship data belongs to you — export any time.",
  },
];

function Features() {
  return (
    <section className="py-32 px-6 border-t border-border/50">
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
    outcome: "See if Mast fits your workflow.",
    features: [
      "20 Opportunities / Day",
      "300 Opportunities / Month",
      "AI-Assisted Opportunity Discovery",
      "Relationships Workspace",
      "Business Emails",
      "Business Phone Numbers",
      "CSV Import / Export",
      "Local Search",
      "1 Team Seat",
    ],
    cta: "Start Free",
    popular: false,
  },
  {
    name: "Starter",
    price: "$29",
    forWho: "Solo operators",
    outcome: "Build a real pipeline, on your own.",
    features: [
      "100 Opportunities / Day",
      "1,500 Opportunities / Month",
      "Mission Follow-ups",
      "Instagram Profiles",
      "AI Discovery Recommendations",
      "Regional Search",
      "1 Team Seat",
    ],
    cta: "Get Started",
    popular: false,
  },
  {
    name: "Pro",
    price: "$79",
    forWho: "Growing agencies",
    outcome: "Scale your pipeline without scaling headcount.",
    features: [
      "400 Opportunities / Day",
      "6,000 Opportunities / Month",
      "Pipeline & Relationships Workspace",
      "Business Websites",
      "AI Pipeline Coaching & Recommendations",
      "3 Team Seats",
    ],
    cta: "Upgrade to Pro",
    popular: true,
  },
  {
    name: "Premium",
    price: "$199",
    forWho: "Growth operators",
    outcome: "Run a full sales operation end-to-end.",
    features: [
      "1,000 Opportunities / Day",
      "25,000 Opportunities / Month",
      "AI Executive Briefings",
      "Weekly Intelligence",
      "AI Opportunity Insights",
      "Unlimited Team Seats",
    ],
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
    <section className="py-32 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Pricing</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold text-foreground">
            One price. No surprises.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Daily opportunity limits keep your pipeline active all month, not just week one.
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
    <section className="py-28 px-6">
      <div className="max-w-5xl mx-auto relative rounded-3xl overflow-hidden border border-border/60 p-16 text-center gradient-border">
        <div className="absolute inset-0 bg-card" />
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{ background: "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)" }}
        />
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
        <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent" />

        <div className="relative">
          <p className="animate-fade-up text-[11px] font-bold text-[var(--landing-blue-bright)] uppercase tracking-[0.2em] mb-5">Get started today</p>
          <h2 className="text-[clamp(1.9rem,5vw,3rem)] font-bold tracking-tight leading-tight animate-fade-up delay-100">
            Your sales operation,<br />finally in one place.
          </h2>
          <p className="mt-5 text-muted-foreground max-w-md mx-auto text-[0.95rem] leading-relaxed animate-fade-up delay-200">
            Start free. No credit card. Research your first opportunities and see how MAST connects
            the dots between discovery, pipeline, and close.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up delay-300">
            <Link
              to="/signup"
              className="group relative bg-[var(--landing-blue)] text-white px-8 py-3.5 rounded-xl font-semibold shadow-[0_10px_30px_-10px_var(--landing-blue)] hover:bg-[var(--landing-blue-hover)] transition-all duration-200 btn-press overflow-hidden"
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
