import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { BrandMark } from "@/components/mast/BrandMark";
import {
  Globe2, Instagram, Sparkles, Users, Zap, ShieldCheck,
  CheckCircle2, ArrowRight, Quote, Mail, Phone, Link2, BarChart3,
  TrendingUp, Star,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mast — Sales-ready lead intelligence for client acquisition" },
      { name: "description", content: "Mast is the premium OS for client acquisition. Verified emails, cold-calling phone numbers, websites, and Instagram profiles — all in one outreach-ready CRM." },
      { property: "og:title", content: "Mast — Sales-ready lead intelligence" },
      { property: "og:description", content: "Multi-channel lead generation: verified emails, phone numbers, websites, and social — built for agencies, freelancers, and growth operators." },
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
      <LogoStrip />
      <Problem />
      <Features />
      <PricingPreview />
      <Testimonials />
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
          Multi-channel lead intelligence — Live
        </div>

        {/* Headline */}
        <h1 className="animate-fade-up delay-100 text-[clamp(2.6rem,7vw,5rem)] font-bold text-foreground tracking-tight mb-7 leading-[1.04]">
          Sales-ready leads for{" "}
          <span className="text-brand-gradient">client acquisition.</span>
        </h1>

        {/* Sub */}
        <p className="animate-fade-up delay-200 text-[1.05rem] text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed">
          The premium operating system for outreach. Verified emails, cold-calling numbers,
          websites, and Instagram — enriched, scored, and pushed into a built-in CRM.
        </p>

        {/* CTAs */}
        <div className="animate-fade-up delay-300 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/signup"
            className="group relative w-full sm:w-auto bg-foreground text-background px-7 py-3.5 rounded-xl font-semibold hover:bg-foreground/90 transition-all inline-flex items-center justify-center gap-2 btn-press overflow-hidden"
          >
            <span className="relative z-10 flex items-center gap-2">
              Start Free <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </Link>
          <Link
            to="/pricing"
            className="w-full sm:w-auto bg-card border border-border px-7 py-3.5 rounded-xl font-semibold hover:border-border/80 hover:bg-card/80 transition-all btn-press"
          >
            View Pricing
          </Link>
          <Link
            to="/dashboard/leads"
            className="group relative w-full sm:w-auto bg-brand text-brand-foreground px-7 py-3.5 rounded-xl font-semibold hover:bg-brand-dark transition-all shadow-brand btn-press inline-flex items-center justify-center gap-2 overflow-hidden"
          >
            <span className="relative z-10 flex items-center gap-2">
              Generate Leads <Zap className="size-4 group-hover:scale-110 transition-transform" />
            </span>
            <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/8 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </Link>
        </div>

        <p className="animate-fade-up delay-400 text-xs text-muted-foreground mt-5">
          No credit card required · 100 free credits · Cancel anytime
        </p>

        {/* Channel tags */}
        <div className="animate-fade-up delay-500 mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {[
            { icon: Mail, label: "Verified Emails" },
            { icon: Phone, label: "Phone Numbers" },
            { icon: Link2, label: "Websites" },
            { icon: Instagram, label: "Instagram" },
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
  const sampleLeads = [
    { name: "Vortex Media", channels: ["email", "phone", "web", "ig"], score: 98, status: "Ready" },
    { name: "Luminal AI", channels: ["email", "web", "ig"], score: 94, status: "Ready" },
    { name: "Skyline Growth", channels: ["email", "phone", "web"], score: 91, status: "Ready" },
    { name: "Northwind Studio", channels: ["email", "phone", "ig"], score: 87, status: "Ready" },
    { name: "Helix Commerce", channels: ["email", "phone", "web", "ig"], score: 85, status: "Ready" },
  ];

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
                {["Dashboard", "Get Leads", "CRM Management", "Campaigns", "Subscription"].map((l, i) => (
                  <div
                    key={l}
                    className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                      i === 1
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
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Credits</p>
                    <span className="text-[10px] font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded-md border border-brand/20">Pro</span>
                  </div>
                  <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand/70 animate-progress" style={{ width: "57%" }} />
                  </div>
                  <p className="text-xs text-foreground">
                    1,420 <span className="text-muted-foreground">/ 2,500 credits</span>
                  </p>
                </div>
              </div>
            </aside>

            {/* Main */}
            <main className="flex-1 flex flex-col min-w-0">
              <div className="px-6 py-4 border-b border-border/60 flex items-center justify-between bg-background/20">
                <h2 className="text-base font-bold text-foreground">Lead Discovery</h2>
                <span className="flex items-center gap-1.5 px-3 py-1 bg-success/10 text-success text-[10px] font-bold border border-success/20 rounded-md uppercase tracking-wider">
                  <span className="size-1.5 rounded-full bg-success animate-dot-blink" />
                  Live Data
                </span>
              </div>

              <div className="p-5 grid grid-cols-12 gap-5 flex-1 overflow-hidden">
                {/* Config panel */}
                <div className="col-span-12 lg:col-span-4 space-y-4">
                  {[
                    { label: "Region", value: "United States, UK" },
                    { label: "Niche", value: "SaaS Founders" },
                    { label: "Channels", value: "Email · Phone · IG · Web" },
                    { label: "Quantity", value: "500 leads" },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{label}</p>
                      <div className="w-full bg-background/60 border border-border/60 px-3 py-2.5 rounded-lg text-sm text-foreground">
                        {value}
                      </div>
                    </div>
                  ))}
                  <button className="w-full bg-brand hover:bg-brand-dark py-2.5 rounded-xl font-bold text-brand-foreground shadow-brand transition-all btn-press text-sm mt-1 flex items-center justify-center gap-2">
                    <Zap className="size-3.5" />
                    Generate Leads
                  </button>
                </div>

                {/* Lead table */}
                <div className="col-span-12 lg:col-span-8">
                  <div className="bg-background/40 border border-border/60 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-card/60 border-b border-border/60">
                        <tr>
                          {["Company", "Score", "Channels", "Status"].map((h, i) => (
                            <th key={h} className={`p-3.5 font-semibold text-muted-foreground text-[10px] uppercase tracking-wider ${i === 3 ? "text-right" : ""}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sampleLeads.map((row, i) => (
                          <tr
                            key={row.name}
                            className={`hover:bg-white/[0.025] transition-colors ${i < sampleLeads.length - 1 ? "border-b border-border/40" : ""}`}
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
                              <div className="flex items-center gap-1.5">
                                {row.channels.includes("email") && <Mail className="size-3.5 text-brand" />}
                                {row.channels.includes("phone") && <Phone className="size-3.5 text-brand" />}
                                {row.channels.includes("web") && <Link2 className="size-3.5 text-brand" />}
                                {row.channels.includes("ig") && <Instagram className="size-3.5 text-brand" />}
                              </div>
                            </td>
                            <td className="p-3.5 text-right">
                              <span className="px-2 py-0.5 text-[10px] rounded-md border font-semibold uppercase tracking-wider bg-success/10 text-success border-success/20">
                                {row.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </section>
  );
}

function LogoStrip() {
  const logos = ["Northwind", "Apex Agency", "Lumen Co", "Vega Labs", "Crestline", "Tidal Group"];
  return (
    <section className="border-y border-border/60 bg-card/20 py-10 px-6">
      <div className="max-w-7xl mx-auto">
        <p className="text-center text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70 mb-7">
          Trusted by 4,200+ agencies &amp; operators
        </p>
        <div className="flex flex-wrap justify-center items-center gap-x-12 gap-y-4">
          {logos.map((l, i) => (
            <span
              key={l}
              className="text-base font-bold tracking-tight text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors duration-300 cursor-default select-none animate-fade-in"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              {l}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Problem() {
  const bullets = [
    "Cut sourcing time from days to minutes",
    "Get verified emails, mobile numbers, websites & social in one record",
    "Sync directly to the built-in CRM — outreach-ready on day one",
    "Scale multi-channel outreach without scaling your team",
  ];

  return (
    <section id="solutions" className="py-28 px-6">
      <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-20 items-center">
        <div className="animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">The Problem</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight leading-tight">
            Client acquisition is broken by{" "}
            <span className="text-muted-foreground">noise.</span>
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed text-[0.95rem]">
            Cold lists are dead. Manual prospecting eats hours. Generic scrapers return bounced emails,
            missing numbers, and ghost accounts. Agencies burn budget chasing leads that were never going to convert.
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
                { label: "Email deliverability", value: "99.8%", trend: "+2.1%", up: true },
                { label: "Phone match rate", value: "86%", trend: "+4.0%", up: true },
                { label: "Avg. time saved", value: "38h/mo", trend: "", up: false },
                { label: "Regions covered", value: "180+", trend: "", up: false },
              ].map(({ label, value, trend, up }) => (
                <div key={label} className="rounded-2xl bg-background/60 border border-border/50 p-4 hover:border-brand/30 transition-colors">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-bold text-foreground">{value}</p>
                  {trend && (
                    <p className="flex items-center gap-1 text-xs text-success font-medium mt-1">
                      <TrendingUp className="size-3" /> {trend}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl border border-border/50 p-5 bg-background/40">
              <div className="flex gap-1 mb-3">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="size-3.5 fill-warning text-warning" />
                ))}
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                "We replaced three tools and a VA with Mast. Pipeline doubled in 6 weeks."
              </p>
              <p className="mt-3 text-xs text-muted-foreground">— Maya Chen, Founder · Northwind</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const features = [
  { icon: Mail, title: "Verified Business Emails", desc: "Deliverable, SMTP-validated inboxes for decision-makers — 99.8% accuracy, ready for cold sequences." },
  { icon: Phone, title: "Cold-Calling Phone Numbers", desc: "Direct mobile and office lines for outbound calling, SMS, and WhatsApp at scale." },
  { icon: Link2, title: "Website & Contact Extraction", desc: "Pulls company URLs, contact pages, tech stack signals, and structured business data." },
  { icon: Instagram, title: "Instagram Business Profiles", desc: "Social discovery with follower growth, engagement, and niche-fit scoring baked in." },
  { icon: Globe2, title: "Multi-Region Targeting", desc: "Hyper-local prospecting across 180 countries. Find the exact niche in the exact city." },
  { icon: BarChart3, title: "Lead Scoring & Intelligence", desc: "Every lead enriched and ranked by intent signals so your team works the highest-value first." },
  { icon: Users, title: "Built-in CRM", desc: "Pipeline stages, tags, notes, and team assignments — no Zapier glue required." },
  { icon: Zap, title: "Multi-Channel Outreach Ready", desc: "Push leads straight into email, dialer, and DM workflows — every channel pre-populated." },
  { icon: ShieldCheck, title: "Premium Lead Pools", desc: "Pre-verified, high-intent contacts delivered to your dashboard on demand." },
];

function Features() {
  return (
    <section className="py-28 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-18 max-w-2xl mx-auto animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Platform</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold tracking-tight">A complete client acquisition stack</h2>
          <p className="mt-4 text-muted-foreground text-[0.95rem] leading-relaxed">
            Sourcing, enrichment, scoring, CRM, and multi-channel outreach — one platform, no duct-taped stack.
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
  { name: "Free", price: "$0", desc: "Try it out", features: ["100 credits / mo", "Email + website data", "Multi-region search"], cta: "Start Free", popular: false },
  { name: "Starter", price: "$49", desc: "Solo operators", features: ["500 credits / mo", "Email · Phone · Web · IG", "Built-in CRM"], cta: "Get Started", popular: false },
  { name: "Pro", price: "$99", desc: "Scaling agencies", features: ["2,500 credits / mo", "Instant pool access", "Lead scoring + API"], cta: "Upgrade to Pro", popular: true },
  { name: "Premium", price: "$249", desc: "Growth operators", features: ["25,000 credits / mo", "Premium instant pool", "Dedicated AM + SSO"], cta: "Contact Sales", popular: false },
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
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold text-foreground">Ready to scale?</h2>
          <p className="mt-4 text-muted-foreground">Choose the engine that matches your growth ambitions.</p>
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

function Testimonials() {
  const items = [
    { quote: "Mast gave us verified emails AND mobile numbers in the same export. Our reply rate jumped from 3% to 14%.", author: "Daniel Park", role: "Co-founder, Tidal Group", rating: 5 },
    { quote: "Email, phone, website, Instagram — every record is outreach-ready. We're closing local studios in 48 hours.", author: "Sara Lopez", role: "Owner, Pulse Agency", rating: 5 },
    { quote: "We canceled Apollo, a dialer tool, and our VA. Mast replaced all three with better data.", author: "Marcus Lee", role: "Director of Growth, Helix", rating: 5 },
  ];

  return (
    <section id="testimonials" className="py-28 px-6 border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 animate-fade-up">
          <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Customers</span>
          <h2 className="mt-4 text-[clamp(1.9rem,4vw,2.8rem)] font-bold">Loved by operators who ship pipeline</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-5">
          {items.map((t, i) => (
            <div
              key={t.author}
              className="group relative bg-card border border-border/60 rounded-2xl p-7 flex flex-col card-hover animate-fade-up overflow-hidden"
              style={{ animationDelay: `${i * 100}ms` }}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-brand/0 to-brand/0 group-hover:from-brand/[0.03] group-hover:to-transparent transition-all duration-500 rounded-2xl pointer-events-none" />
              <div className="flex gap-0.5 mb-4">
                {[...Array(t.rating)].map((_, si) => (
                  <Star key={si} className="size-3.5 fill-warning text-warning" />
                ))}
              </div>
              <Quote className="size-5 text-brand mb-3 opacity-60" />
              <p className="text-foreground leading-relaxed flex-1 text-[0.92rem]">{t.quote}</p>
              <div className="mt-6 pt-5 border-t border-border/50">
                <p className="text-sm font-semibold text-foreground">{t.author}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t.role}</p>
              </div>
            </div>
          ))}
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
            Build your client acquisition<br />pipeline today.
          </h2>
          <p className="mt-5 text-muted-foreground max-w-xl mx-auto text-[0.95rem] leading-relaxed animate-fade-up delay-100">
            100 free credits to generate outreach-ready leads — email, phone, website, and Instagram included. No credit card. Cancel anytime.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up delay-200">
            <Link
              to="/signup"
              className="group relative bg-brand text-brand-foreground px-8 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all btn-press overflow-hidden"
            >
              <span className="relative z-10">Start Free — it's free</span>
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
