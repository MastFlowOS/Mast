import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import {
  CheckCircle2,
  XCircle,
  Globe2,
  Users,
  Zap,
  Code2,
  MessageSquare,
  ArrowRight,
  Bot,
  Calendar,
  Sun,
  ShieldCheck,
  Lock,
  Database,
  Mail,
  Phone,
  Instagram,
  Check,
  X,
} from "lucide-react";
import { PlanCard } from "./index";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Mast" },
      {
        name: "description",
        content: "Simple daily opportunity limits. Every plan includes AI opportunity discovery, relationships workspace, pipeline, and mission follow-ups — no separate tools required.",
      },
      { property: "og:title", content: "Mast Pricing" },
      {
        property: "og:description",
        content: "Discover opportunities, manage relationships, track pipeline, and close deals. One platform. Simple pricing.",
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
  searchCoverage: string;
  contactChannels: string[];
  aiAccess: string[];
  relationships: string;
  automations: boolean;
  importExport: string;
  teamSeats: string;
  features: string[];
};

const tiers: Tier[] = [
  {
    name: "Free",
    price: "$0",
    desc: "Explore the platform",
    cta: "Start Free",
    popular: false,
    dailyLeads: "20 / Day",
    monthlyLeads: "300 / Month",
    searchCoverage: "Local",
    contactChannels: ["email", "phone"],
    aiAccess: ["AI Discovery", "AI Message Templates"],
    relationships: "✔",
    automations: false,
    importExport: "CSV",
    teamSeats: "1 Seat",
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
  },
  {
    name: "Starter",
    price: "$29",
    desc: "Solo operators & freelancers",
    cta: "Choose Starter",
    popular: false,
    dailyLeads: "100 / Day",
    monthlyLeads: "1,500 / Month",
    searchCoverage: "Regional",
    contactChannels: ["email", "phone", "instagram"],
    aiAccess: ["AI Discovery", "AI Recommendations"],
    relationships: "✔",
    automations: true,
    importExport: "CSV",
    teamSeats: "1 Seat",
    features: [
      "100 Opportunities / Day",
      "1,500 Opportunities / Month",
      "Mission Follow-ups",
      "Instagram Profiles",
      "AI Discovery Recommendations",
      "Regional Search",
      "1 Team Seat",
    ],
  },
  {
    name: "Pro",
    price: "$79",
    desc: "Growing agencies",
    cta: "Upgrade to Pro",
    popular: true,
    dailyLeads: "400 / Day",
    monthlyLeads: "6,000 / Month",
    searchCoverage: "Regional",
    contactChannels: ["email", "phone", "instagram", "website"],
    aiAccess: ["AI Pipeline Coaching"],
    relationships: "✔ + Pipeline",
    automations: true,
    importExport: "CSV",
    teamSeats: "3 Seats",
    features: [
      "400 Opportunities / Day",
      "6,000 Opportunities / Month",
      "Pipeline & Relationships Workspace",
      "Business Websites",
      "AI Pipeline Coaching & Recommendations",
      "3 Team Seats",
    ],
  },
  {
    name: "Premium",
    price: "$199",
    desc: "Growth operators & enterprises",
    cta: "Contact Sales",
    popular: false,
    dailyLeads: "1,000 / Day",
    monthlyLeads: "25,000 / Month",
    searchCoverage: "Regional",
    contactChannels: ["email", "phone", "instagram", "website"],
    aiAccess: ["Executive Briefings", "Weekly Intelligence", "Opportunity Insights"],
    relationships: "✔ + Pipeline",
    automations: true,
    importExport: "CSV",
    teamSeats: "Unlimited",
    features: [
      "1,000 Opportunities / Day",
      "25,000 Opportunities / Month",
      "AI Executive Briefings",
      "Weekly Intelligence",
      "AI Opportunity Insights",
      "Unlimited Team Seats",
    ],
  },
];

// Contact channel icon renderer
function ContactChannelIcons({ channels }: { channels: string[] }) {
  const iconMap: Record<string, React.ReactNode> = {
    email: <Mail key="email" className="size-4 text-sky-400" title="Business Email" />,
    phone: <Phone key="phone" className="size-4 text-purple-400" title="Business Phone" />,
    instagram: <Instagram key="instagram" className="size-4 text-pink-400" title="Instagram Profile" />,
    website: <Globe2 key="website" className="size-4 text-teal-400" title="Business Website" />,
  };
  return (
    <span className="inline-flex items-center gap-1.5 justify-center">
      {channels.map((ch) => iconMap[ch])}
    </span>
  );
}

// AI features list renderer
function AiFeatureList({ items, popular }: { items: string[]; popular: boolean }) {
  return (
    <ul className="space-y-1 text-left">
      {items.map((item) => (
        <li key={item} className={`flex items-center gap-1.5 text-xs ${popular ? "text-brand font-semibold" : "text-foreground/80"}`}>
          <Bot className={`size-3 shrink-0 ${popular ? "text-brand" : "text-brand/60"}`} />
          {item}
        </li>
      ))}
    </ul>
  );
}

type ComparisonRowDef = {
  label: string;
  key: keyof Tier;
  icon?: React.ComponentType<{ className?: string }>;
  renderCell?: (tier: Tier) => React.ReactNode;
};

const rows: ComparisonRowDef[] = [
  {
    label: "Daily Limit",
    key: "dailyLeads",
    icon: Sun,
  },
  {
    label: "Monthly Limit",
    key: "monthlyLeads",
    icon: Calendar,
  },
  {
    label: "Search Coverage",
    key: "searchCoverage",
  },
  {
    label: "Contact Channels",
    key: "contactChannels",
    renderCell: (tier) => <ContactChannelIcons channels={tier.contactChannels as string[]} />,
  },
  {
    label: "AI Features",
    key: "aiAccess",
    icon: Bot,
    renderCell: (tier) => <AiFeatureList items={tier.aiAccess as string[]} popular={tier.popular} />,
  },
  {
    label: "Relationships",
    key: "relationships",
  },
  {
    label: "Mission Follow-ups",
    key: "automations",
    renderCell: (tier) => tier.automations
      ? <CheckCircle2 className="size-4 text-emerald-400 mx-auto" />
      : <XCircle className="size-4 text-border mx-auto" />,
  },
  {
    label: "Import / Export",
    key: "importExport",
  },
  {
    label: "Team Seats",
    key: "teamSeats",
    icon: Users,
  },
];

const faqs = [
  {
    q: "How do daily limits work?",
    a: "Your daily allowance resets at midnight UTC. This keeps your pipeline active throughout the month instead of burning through a monthly cap in one session.",
  },
  {
    q: "What happens when I reach the daily limit?",
    a: "Opportunity discovery pauses until the next reset. Your monthly allowance is preserved and available again the following day.",
  },
  {
    q: "Do unused credits roll over?",
    a: "Daily allowances don't carry over — each day starts fresh. Monthly caps reset at the start of your billing cycle.",
  },
  {
    q: "Can I change plans at any time?",
    a: "Yes. Upgrade, downgrade, or cancel whenever you want. Changes take effect at the next billing cycle.",
  },
  {
    q: "What contact information does Mast surface?",
    a: "Mast discovers business emails, business phone numbers, websites, and Instagram profiles for each opportunity. The channels available depend on your plan.",
  },
  {
    q: "What does the AI actually do?",
    a: "The AI helps surface opportunity recommendations, provides pipeline coaching, generates executive briefings, and delivers weekly intelligence — depending on your plan. It works within your existing workflow rather than replacing it.",
  },
  {
    q: "Who owns my data?",
    a: "You do. Your contacts, notes, pipeline stages, and activity history are yours. Export everything at any time via CSV.",
  },
];

// ─── FAQ accordion ─────────────────────────────────────────────────────────────
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`bg-card border rounded-xl overflow-hidden transition-all duration-200 cursor-pointer ${open ? "border-brand/30" : "border-border/60 hover:border-border/90"}`}
      onClick={() => setOpen(o => !o)}
    >
      <div className="px-6 py-4 flex items-center justify-between gap-4">
        <p className="font-semibold text-foreground text-sm">{q}</p>
        <span className={`text-brand transition-transform duration-200 shrink-0 ${open ? "rotate-45" : ""}`}>+</span>
      </div>
      {open && (
        <div className="px-6 pb-4">
          <p className="text-sm text-muted-foreground leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  );
}

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
          style={{ background: "radial-gradient(closest-side, var(--brand), transparent)" }}
        />
        <div className="relative max-w-3xl mx-auto">
          <span className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-brand text-[10px] font-bold uppercase tracking-wider mb-6">
            Simple pricing · No contracts
          </span>
          <h1 className="animate-fade-up delay-100 text-[clamp(2.2rem,6vw,3.5rem)] font-bold tracking-tight mb-5">
            Pay for outcomes,<br />not seat counts.
          </h1>
          <p className="animate-fade-up delay-200 text-muted-foreground text-[1rem] leading-relaxed max-w-xl mx-auto">
            Every plan includes the full platform — opportunity discovery, relationship data, pipeline,
            and AI assistance. Upgrade when you need more volume.
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
            7-day money-back guarantee · No contracts · Cancel anytime
          </p>
        </div>
      </section>

      {/* Comparison table */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Compare</span>
            <h2 className="mt-3 text-2xl font-bold">Everything, side by side</h2>
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
                      <div className="text-lg font-bold text-foreground mt-0.5">
                        {t.price}
                        <span className="text-xs text-muted-foreground font-normal">/mo</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ label, key, icon: RowIcon, renderCell }, ri) => (
                  <tr
                    key={key}
                    className={`border-b border-border/40 hover:bg-white/[0.02] transition-colors ${ri % 2 === 0 ? "bg-background/20" : ""}`}
                  >
                    <td className="p-4 text-muted-foreground font-medium text-xs">
                      <div className="flex items-center gap-1.5">
                        {RowIcon && <RowIcon className="size-3.5 text-muted-foreground/60" />}
                        {label}
                      </div>
                    </td>
                    {tiers.map((t) => {
                      if (renderCell) {
                        return (
                          <td
                            key={t.name}
                            className={`p-4 text-center text-xs ${t.popular ? "text-brand font-semibold" : "text-foreground"}`}
                          >
                            {renderCell(t)}
                          </td>
                        );
                      }
                      const val = String(t[key]);
                      return (
                        <td
                          key={t.name}
                          className={`p-4 text-center text-xs ${t.popular ? "text-brand font-semibold" : "text-foreground/80"}`}
                        >
                          {val}
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
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Usage</span>
            <h2 className="mt-3 text-2xl font-bold">Pipeline active every day — not just week one.</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Daily limits spread your research budget evenly so your pipeline never runs dry mid-month.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              {
                icon: Sun,
                label: "Daily allowance",
                sub: "Resets at midnight UTC",
                desc: "Fresh discovery capacity every morning. Open Mast and it's ready to go.",
              },
              {
                icon: Calendar,
                label: "Monthly cap",
                sub: "Billing cycle protection",
                desc: "A ceiling that prevents surprise overages — only shows when you're close.",
              },
              {
                icon: Bot,
                label: "AI features",
                sub: "Scales with plan",
                desc: "Opportunity discovery on Free. Recommendations on Starter. Pipeline coaching on Pro. Executive Briefings & Intelligence on Premium.",
              },
              {
                icon: Zap,
                label: "Mission Follow-ups",
                sub: "Pro & Premium",
                desc: "Structured follow-up tracking so opportunities never fall through the cracks.",
              },
            ].map(({ icon: Icon, label, sub, desc }, i) => (
              <div
                key={label}
                className="relative bg-card border border-border/60 rounded-2xl p-5 card-hover animate-fade-up overflow-hidden group"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-brand/0 group-hover:from-brand/[0.04] to-transparent transition-all duration-500 rounded-2xl pointer-events-none" />
                <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center mb-4 group-hover:bg-brand/20 group-hover:scale-110 transition-all duration-200">
                  <Icon className="size-4 text-brand" />
                </div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <p className="text-[10px] font-bold text-brand uppercase tracking-wider mt-0.5">{sub}</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">Trust</span>
            <h2 className="mt-3 text-2xl font-bold">Built for professional sales teams.</h2>
            <p className="mt-3 text-muted-foreground max-w-lg mx-auto text-sm leading-relaxed">
              Responsible by design. Your data is yours. Your pipeline is private.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                icon: Database,
                title: "Your relationship data",
                desc: "Every contact, note, and pipeline stage belongs to you. Export at any time, no lock-in.",
              },
              {
                icon: Globe2,
                title: "Public business data",
                desc: "Opportunity information is sourced from publicly available business directories and websites.",
              },
              {
                icon: Lock,
                title: "Professional use only",
                desc: "MAST is built for sales teams — not bulk marketing or unsolicited outreach at scale.",
              },
            ].map(({ icon: Icon, title, desc }, i) => (
              <div
                key={title}
                className="group text-center bg-card border border-border/60 rounded-2xl p-7 card-hover animate-fade-up transition-all duration-200"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className="size-12 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center mx-auto mb-4 group-hover:bg-brand/20 group-hover:scale-110 transition-all duration-200">
                  <Icon className="size-5 text-brand" />
                </div>
                <p className="text-base font-bold text-foreground">{title}</p>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI tiers */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">AI Assistance</span>
            <h2 className="mt-3 text-2xl font-bold">AI that works quietly in the background.</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Not a chatbot. Not a widget. AI embedded in your workflow — surfacing insights,
              drafting outreach, and keeping your pipeline healthy.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              {
                plan: "Free",
                level: "AI-Assisted Opportunity Discovery",
                color: "text-muted-foreground",
                desc: "AI surfaces opportunity recommendations as you search — no manual research needed.",
              },
              {
                plan: "Starter",
                level: "AI Discovery Recommendations",
                color: "text-brand/60",
                desc: "Personalized opportunity suggestions based on your search criteria and history.",
              },
              {
                plan: "Pro",
                level: "AI Pipeline Coaching & Recommendations",
                color: "text-brand",
                desc: "AI coaching on pipeline health, follow-up prioritization, and opportunity recommendations.",
              },
              {
                plan: "Premium",
                level: "AI Executive Briefings & Intelligence",
                color: "text-brand font-bold",
                desc: "AI Executive Briefings, Weekly Intelligence reports, and in-depth opportunity insights.",
              },
            ].map(({ plan, level, color, desc }, i) => (
              <div
                key={plan}
                className="group bg-card border border-border/60 rounded-2xl p-5 animate-fade-up hover:border-brand/25 transition-all duration-200"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{plan}</span>
                  <Bot className={`size-4 ${color}`} />
                </div>
                <p className={`text-sm font-semibold ${color}`}>{level}</p>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How Discovery Credits Work */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-5xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">How Discovery Credits Work</span>
            <h2 className="mt-3 text-2xl font-bold">More data depth, more usage.</h2>
            <p className="mt-3 text-muted-foreground max-w-xl mx-auto text-sm leading-relaxed">
              Request richer information per opportunity and it counts more toward your daily allowance —
              but you get more to work with at every step.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-up delay-100">
            {[
              { icon: Zap, label: "Business Emails", cost: "Base", desc: "Verified business email addresses" },
              { icon: Globe2, label: "Business Phone Numbers", cost: "Low +", desc: "Business phone numbers" },
              { icon: MessageSquare, label: "Instagram Profiles", cost: "Medium +", desc: "Public Instagram profiles" },
              { icon: Code2, label: "Business Websites", cost: "Higher +", desc: "Business websites" },
            ].map(({ icon: Icon, label, cost, desc }, i) => (
              <div
                key={label}
                className="relative bg-card border border-border/60 rounded-2xl p-5 card-hover animate-fade-up overflow-hidden group"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-brand/0 group-hover:from-brand/[0.04] to-transparent transition-all duration-500 rounded-2xl pointer-events-none" />
                <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center mb-4 group-hover:bg-brand/20 group-hover:scale-110 transition-all duration-200">
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

      {/* FAQ — now accordion */}
      <section className="px-6 pb-24 border-t border-border/50">
        <div className="max-w-3xl mx-auto pt-20">
          <div className="text-center mb-14 animate-fade-up">
            <span className="text-[10px] font-bold text-brand uppercase tracking-[0.2em]">FAQ</span>
            <h2 className="mt-3 text-2xl font-bold">Questions, answered.</h2>
          </div>
          <div className="space-y-2 animate-fade-up delay-100">
            {faqs.map(({ q, a }) => (
              <FaqItem key={q} q={q} a={a} />
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
            style={{ background: "radial-gradient(ellipse at center, color-mix(in oklab, var(--brand) 20%, transparent), transparent 70%)" }}
          />
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
          <div className="relative">
            <p className="text-[11px] font-bold text-brand uppercase tracking-[0.2em] mb-5">Get started today</p>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
              Your pipeline starts here.
            </h2>
            <p className="mt-4 text-muted-foreground max-w-md mx-auto text-sm leading-relaxed">
              Free plan. 20 Opportunities / Day. No credit card. See the whole platform from day one.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to="/signup"
                className="group bg-brand text-brand-foreground px-7 py-3.5 rounded-xl font-semibold shadow-brand hover:bg-brand-dark transition-all duration-200 btn-press inline-flex items-center gap-2 overflow-hidden relative"
              >
                <span className="relative z-10 flex items-center gap-2">
                  Start for free
                  <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
                </span>
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
              </Link>
              <Link
                to="/dashboard"
                className="bg-background border border-border/80 px-7 py-3.5 rounded-xl font-semibold hover:border-brand/40 hover:bg-brand/5 transition-all duration-200 btn-press"
              >
                View dashboard
              </Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
