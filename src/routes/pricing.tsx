import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { CheckCircle2, Coins, Globe2, Crown, Users, Zap, Code2, MessageSquare, ArrowRight } from "lucide-react";
import { PlanCard } from "./index";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Mast" },
      { name: "description", content: "Credit-based pricing for multi-channel lead generation. Verified emails, phone numbers, websites, and Instagram on every plan." },
      { property: "og:title", content: "Mast Pricing" },
      { property: "og:description", content: "Credit-based lead intelligence. Pay for what you actually generate." },
    ],
  }),
  component: PricingPage,
});

type Tier = {
  name: string; price: string; desc: string; cta: string; popular: boolean;
  credits: string; regions: string; pool: string; crm: string;
  outreach: string; seats: string; api: string; features: string[];
};

const tiers: Tier[] = [
  {
    name: "Free", price: "$0", desc: "Try the platform", cta: "Start Free", popular: false,
    credits: "100 / month", regions: "5 regions", pool: "Live scraping only", crm: "CSV export",
    outreach: "Email + website", seats: "1 seat", api: "—",
    features: ["Email + website data", "Multi-region search", "CSV export"],
  },
  {
    name: "Starter", price: "$49", desc: "Solo operators & freelancers", cta: "Choose Starter", popular: false,
    credits: "500 / month", regions: "20 regions", pool: "Live scraping", crm: "Built-in CRM",
    outreach: "Email · Phone · Web · IG", seats: "1 seat", api: "—",
    features: ["All Free features", "Phone numbers", "Instagram profiles", "Built-in CRM", "20-region search"],
  },
  {
    name: "Pro", price: "$99", desc: "Scaling agencies", cta: "Upgrade to Pro", popular: true,
    credits: "2,500 / month", regions: "Unlimited", pool: "Instant pool access", crm: "Full pipeline CRM",
    outreach: "All channels + sequences", seats: "3 seats", api: "Full API access",
    features: ["All Starter features", "Instant pool access", "Lead scoring", "API access", "3 team seats", "Priority support"],
  },
  {
    name: "Premium", price: "$249", desc: "Growth operators & enterprises", cta: "Contact Sales", popular: false,
    credits: "25,000 / month", regions: "Unlimited", pool: "Premium decision-maker pool", crm: "Full pipeline + automations",
    outreach: "All channels + automations", seats: "Unlimited seats", api: "Dedicated + webhooks",
    features: ["All Pro features", "25,000 credits/mo", "Premium lead pools", "Unlimited seats", "Dedicated AM", "SSO / SAML", "Custom integrations"],
  },
];

const rows: { label: string; key: keyof Tier }[] = [
  { label: "Credits / month", key: "credits" },
  { label: "Regions", key: "regions" },
  { label: "Lead pool", key: "pool" },
  { label: "CRM", key: "crm" },
  { label: "Outreach channels", key: "outreach" },
  { label: "Team seats", key: "seats" },
  { label: "API", key: "api" },
];

const faqs = [
  { q: "What is a credit?", a: "1 credit = 1 lead enriched with email. Additional channels (phone, website, Instagram) each add 0.25 credits per lead." },
  { q: "Do unused credits roll over?", a: "Credits reset monthly. Unused credits do not roll over, but you can upgrade or buy top-ups at any time." },
  { q: "Can I change plans anytime?", a: "Yes — upgrade, downgrade, or cancel at any time. Changes take effect at the next billing cycle." },
  { q: "What's the difference between Live Scraping and Instant Pool?", a: "Live Scraping fetches fresh records in real time. Instant Pool gives immediate access to our pre-verified, refreshed lead database — faster results, higher quality." },
  { q: "Is there a free trial?", a: "The Free plan includes 100 credits with no credit card required. You can generate real leads immediately." },
];

function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      {/* Hero */}
      <section className="relative pt-28 pb-20 px-6 overflow-hidden text-center">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.15] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
        <div
          className="pointer-events-none absolute top-[-150px] left-1/2 -translate-x-1/2 size-[600px] rounded-full opacity-25 animate-pulse-glow"
          style={{ background: "radial-gradient(closest-side, var(--brand), transparent)" }}
        />
        <div className="relative max-w-3xl mx-auto">
          <span className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-brand text-[10px] font-bold uppercase tracking-wider mb-6">
            <Coins className="size-3" /> Credit-based pricing
          </span>
          <h1 className="animate-fade-up delay-100 text-[clamp(2.2rem,6vw,3.5rem)] font-bold tracking-tight mb-5">
            Pay for leads, not for seats.
          </h1>
          <p className="animate-fade-up delay-200 text-muted-foreground text-[1rem] leading-relaxed max-w-xl mx-auto">
            One credit = one lead. Channels are additive. Scale up or down without contracts.
          </p>
        </div>
      </section>

      {/* Plan cards */}
      <section className="px-6 pb-24">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {tiers.map((t, i) => (
              <div key={t.name} className="animate-fade-up" style={{ animationDelay: `${i * 80}ms` }}>
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
            All plans include a 7-day money-back guarantee · No contracts · Cancel anytime
          </p>
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Compare</span>
            <h2 className="mt-3 text-2xl font-bold">Full feature breakdown</h2>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border/60 animate-fade-up delay-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-card/50">
                  <th className="text-left p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider w-[200px]">Feature</th>
                  {tiers.map((t) => (
                    <th key={t.name} className="p-4 text-center">
                      <div className={`text-xs font-bold uppercase tracking-wider ${t.popular ? "text-brand" : "text-muted-foreground"}`}>
                        {t.name}
                      </div>
                      <div className="text-lg font-bold text-foreground mt-0.5">{t.price}<span className="text-xs text-muted-foreground font-normal">/mo</span></div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ label, key }, ri) => (
                  <tr key={key} className={`border-b border-border/40 hover:bg-white/[0.02] transition-colors ${ri % 2 === 0 ? "bg-background/20" : ""}`}>
                    <td className="p-4 text-muted-foreground font-medium text-xs">{label}</td>
                    {tiers.map((t) => (
                      <td key={t.name} className={`p-4 text-center text-xs ${t.popular ? "text-brand font-semibold" : "text-foreground"}`}>
                        {String(t[key]) === "—" ? <span className="text-border">—</span> : String(t[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Credit calculator */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Credits</span>
            <h2 className="mt-3 text-2xl font-bold">How credits work</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Every lead starts at 1 credit. Add channels for richer data — each extra channel costs 0.25 credits.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              { icon: Zap, label: "Base lead", cost: "1.0 credit", desc: "Email + website data" },
              { icon: Globe2, label: "+ Phone number", cost: "+0.25 credits", desc: "Mobile + office line" },
              { icon: Code2, label: "+ Website data", cost: "+0.25 credits", desc: "URL, tech stack, contacts" },
              { icon: MessageSquare, label: "+ Instagram", cost: "+0.25 credits", desc: "Profile, followers, engagement" },
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

      {/* Social proof strip */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { icon: Users, value: "4,200+", label: "Agencies & operators" },
              { icon: CheckCircle2, value: "99.8%", label: "Email deliverability" },
              { icon: Crown, value: "180+", label: "Countries covered" },
            ].map(({ icon: Icon, value, label }, i) => (
              <div
                key={label}
                className="text-center bg-card border border-border/60 rounded-2xl p-7 card-hover animate-fade-up"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className="size-12 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center mx-auto mb-4">
                  <Icon className="size-5 text-brand" />
                </div>
                <p className="text-3xl font-bold text-foreground">{value}</p>
                <p className="text-sm text-muted-foreground mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-3xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">FAQ</span>
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
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 pb-24">
        <div className="max-w-4xl mx-auto relative rounded-3xl overflow-hidden border border-border/60 p-16 text-center animate-fade-up">
          <div className="absolute inset-0 bg-card" />
          <div className="absolute inset-0 opacity-35" style={{ background: "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)" }} />
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
          <div className="relative">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Start generating leads today</h2>
            <p className="mt-4 text-muted-foreground max-w-md mx-auto text-sm">100 free credits. No credit card. Real data, real leads, real results.</p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link to="/signup" className="group bg-brand text-brand-foreground px-7 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all btn-press inline-flex items-center gap-2">
                Start Free
                <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <Link to="/dashboard/leads" className="bg-background border border-border/80 px-7 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-brand/5 transition-all btn-press">
                View Demo
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
