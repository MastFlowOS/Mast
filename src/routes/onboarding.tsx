import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Binoculars,
  Briefcase,
  Building2,
  CalendarCheck,
  Check,
  ChevronLeft,
  Loader2,
  Plus,
  Rocket,
  Search,
  Sparkles,
  Store,
  TrendingUp,
  User,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/mast/BrandMark";
import { useMe, useSaveSettings } from "@/hooks/use-mast-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Personalize Your Workspace — Mast" },
      { name: "description", content: "Set up your Mast workspace in a few quick steps." },
    ],
  }),
  component: OnboardingPage,
});

// ─── Static option data ────────────────────────────────────────────────────────

const ROLES = [
  { label: "Agency", icon: Building2 },
  { label: "Freelancer", icon: User },
  { label: "Consultant", icon: Briefcase },
  { label: "Sales Team", icon: Users },
  { label: "Startup", icon: Rocket },
  { label: "Local Business", icon: Store },
  { label: "Other", icon: Sparkles },
] as const;

const GOALS = [
  { label: "Find clients", icon: Search },
  { label: "Book meetings", icon: CalendarCheck },
  { label: "Build pipeline", icon: Waypoints },
  { label: "Grow agency", icon: TrendingUp },
  { label: "Research businesses", icon: Binoculars },
  { label: "Something else", icon: Sparkles },
] as const;

const INDUSTRIES = [
  "Real Estate",
  "E-commerce & Retail",
  "Health & Wellness",
  "Fitness & Gyms",
  "Restaurants & Food Service",
  "Legal Services",
  "Financial Services",
  "Insurance",
  "Home Services",
  "Construction & Contracting",
  "Automotive",
  "Beauty & Salons",
  "Dental & Medical Practices",
  "Education & Coaching",
  "SaaS & Technology",
  "Marketing Agencies",
  "Nonprofit",
  "Hospitality & Travel",
  "Manufacturing",
  "B2B Services",
  "Logistics & Supply Chain",
  "Events & Entertainment",
  "Photography & Creative",
  "Interior Design",
  "Pet Services",
  "Cleaning Services",
  "Landscaping",
  "HVAC & Plumbing",
  "Accounting & Bookkeeping",
  "Consulting",
  "Media & Publishing",
  "Fashion & Apparel",
  "Sports & Recreation",
  "Childcare & Family Services",
  "Agriculture",
  "Energy & Utilities",
] as const;

const STEP_COPY = [
  {
    eyebrow: "Welcome",
    title: "Let's set up your workspace",
    desc: "Tell us a little about you — you can always change this later in Settings.",
  },
  {
    eyebrow: "About you",
    title: "What best describes you?",
    desc: "This helps us tailor Mast to how you work.",
  },
  {
    eyebrow: "Focus areas",
    title: "Which industries or niches do you target?",
    desc: "Search and select as many as apply. Totally optional.",
  },
  {
    eyebrow: "Your goal",
    title: "What's your primary goal with Mast?",
    desc: "We'll prioritize the tools that help you get there first.",
  },
] as const;

const TOTAL_STEPS = STEP_COPY.length;

function firstNameOf(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || "there";
}

// ─── Page ───────────────────────────────────────────────────────────────────────

function OnboardingPage() {
  const navigate = useNavigate();
  const { data: auth, isLoading: authLoading } = useMe();
  const saveSettings = useSaveSettings();
  const user = auth?.user ?? null;

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [completed, setCompleted] = useState(false);

  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [industries, setIndustries] = useState<string[]>([]);
  const [goal, setGoal] = useState<string | null>(null);
  const [industryQuery, setIndustryQuery] = useState("");

  // Pre-fill name from signup / OAuth profile the first time it loads.
  useEffect(() => {
    if (user?.fullName && !name) setName(user.fullName);
  }, [user?.fullName]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Guard: must be logged in; skip straight to dashboard if already done ──
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      void navigate({ to: "/login", replace: true });
      return;
    }
    // `!completed` guards against this effect firing right after our own
    // save succeeds and invalidates the cached user — we want to show the
    // completion screen ourselves rather than being redirected out from under it.
    if (user.onboardingCompleted && !completed) {
      void navigate({ to: "/dashboard", replace: true });
    }
  }, [authLoading, user, completed, navigate]);

  if (authLoading || !user || (user.onboardingCompleted && !completed)) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center">
        <div className="text-sm text-muted-foreground animate-pulse">Loading…</div>
      </div>
    );
  }

  const firstName = firstNameOf(name);
  const defaultWorkspaceName = `${firstName}’s Workspace`;

  const canContinue =
    step === 0 ? name.trim().length > 0 :
    step === 1 ? role !== null :
    step === 3 ? goal !== null :
    true;

  const toggleIndustry = (value: string) => {
    setIndustries((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const addCustomIndustry = (value: string) => {
    setIndustries((prev) => (prev.includes(value) ? prev : [...prev, value]));
  };

  const goBack = () => {
    if (step === 0) return;
    setDirection(-1);
    setStep((s) => s - 1);
  };

  const goNext = () => {
    if (!canContinue) return;
    if (step === TOTAL_STEPS - 1) {
      void handleComplete();
      return;
    }
    setDirection(1);
    setStep((s) => s + 1);
  };

  const handleComplete = async () => {
    try {
      await saveSettings.mutateAsync({
        settings: {
          workspaceName: workspaceName.trim() || defaultWorkspaceName,
          onboardingRole: role ?? "",
          onboardingIndustries: industries.join(", "),
          onboardingGoal: goal ?? "",
          onboardingCompleted: "true",
        },
        fullName: name.trim(),
      });
      setCompleted(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save your answers. Please try again.");
    }
  };

  const animClass =
    direction === 1
      ? "animate-in fade-in-0 slide-in-from-right-6 duration-300"
      : "animate-in fade-in-0 slide-in-from-left-6 duration-300";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col relative overflow-hidden">
      {/* Ambient background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: "radial-gradient(ellipse at 50% 0%, color-mix(in oklab, var(--brand) 22%, transparent), transparent 60%)" }}
      />
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.15]" />

      <header className="relative px-6 py-6 lg:px-10">
        <div className="flex items-center gap-2.5">
          <BrandMark size={32} />
          <span className="font-bold text-lg tracking-[0.02em] text-foreground">MAST</span>
        </div>
      </header>

      <div className="relative flex-1 flex items-start justify-center px-4 pb-16 pt-4 sm:pt-10">
        <div className="w-full max-w-xl">
          {!completed ? (
            <>
              <ProgressBar step={step} total={TOTAL_STEPS} />

              <div key={step} className={cn("mt-8", animClass)}>
                <span className="text-[11px] font-bold uppercase tracking-wider text-brand">
                  {STEP_COPY[step].eyebrow}
                </span>
                <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight">
                  {STEP_COPY[step].title}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {STEP_COPY[step].desc}
                </p>

                <div className="mt-7">
                  {step === 0 && (
                    <div className="space-y-5">
                      <FieldBlock label="Your name">
                        <input
                          autoFocus
                          type="text"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Jane Doe"
                          className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none px-3.5 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                        />
                      </FieldBlock>
                      <FieldBlock label="Workspace name" hint={`Optional — defaults to “${defaultWorkspaceName}” if left blank.`}>
                        <input
                          type="text"
                          value={workspaceName}
                          onChange={(e) => setWorkspaceName(e.target.value)}
                          placeholder={defaultWorkspaceName}
                          className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none px-3.5 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                        />
                      </FieldBlock>
                    </div>
                  )}

                  {step === 1 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {ROLES.map((r, i) => (
                        <OptionCard
                          key={r.label}
                          icon={r.icon}
                          label={r.label}
                          selected={role === r.label}
                          onClick={() => setRole(r.label)}
                          index={i}
                        />
                      ))}
                    </div>
                  )}

                  {step === 2 && (
                    <IndustryPicker
                      query={industryQuery}
                      onQueryChange={setIndustryQuery}
                      selected={industries}
                      onToggle={toggleIndustry}
                      onAddCustom={addCustomIndustry}
                    />
                  )}

                  {step === 3 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {GOALS.map((g, i) => (
                        <OptionCard
                          key={g.label}
                          icon={g.icon}
                          label={g.label}
                          selected={goal === g.label}
                          onClick={() => setGoal(g.label)}
                          index={i}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Nav */}
              <div className="mt-9 flex items-center gap-3">
                {step > 0 && (
                  <button
                    type="button"
                    onClick={goBack}
                    disabled={saveSettings.isPending}
                    className="inline-flex items-center gap-1.5 px-4 py-3 rounded-xl text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <ChevronLeft className="size-4" />
                    Back
                  </button>
                )}
                {step === 2 && (
                  <button
                    type="button"
                    onClick={goNext}
                    className="ml-auto sm:ml-0 px-4 py-3 rounded-xl text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Skip
                  </button>
                )}
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canContinue || saveSettings.isPending}
                  className={cn(
                    "flex-1 sm:flex-none sm:min-w-[180px] inline-flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-brand-foreground py-3 px-6 rounded-xl font-bold transition-colors shadow-brand disabled:opacity-50 disabled:cursor-not-allowed",
                    step !== 2 && "ml-auto",
                  )}
                >
                  {saveSettings.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Saving…
                    </>
                  ) : step === TOTAL_STEPS - 1 ? (
                    <>
                      Complete setup
                      <ArrowRight className="size-4" />
                    </>
                  ) : (
                    <>
                      Continue
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </button>
              </div>
            </>
          ) : (
            <CompletionScreen
              name={name}
              workspaceName={workspaceName.trim() || defaultWorkspaceName}
              role={role}
              industries={industries}
              goal={goal}
              onContinue={() => void navigate({ to: "/dashboard", replace: true })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({ step, total }: { step: number; total: number }) {
  const pct = Math.min(100, Math.round((step / total) * 100));
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Step {Math.min(step + 1, total)} of {total}
        </span>
        <span className="text-[11px] font-bold text-brand tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, var(--brand) 0%, oklch(0.76 0.15 215) 100%)",
          }}
        />
      </div>
    </div>
  );
}

// ─── Option card (role / goal selection) ────────────────────────────────────────

function OptionCard({
  icon: Icon,
  label,
  selected,
  onClick,
  index,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  selected: boolean;
  onClick: () => void;
  index: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ animationDelay: `${index * 40}ms` }}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left text-sm font-medium transition-all duration-200 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both",
        selected
          ? "border-brand bg-brand/10 text-foreground shadow-brand"
          : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 hover:-translate-y-0.5",
      )}
    >
      <span
        className={cn(
          "grid place-items-center size-9 rounded-lg border shrink-0 transition-colors",
          selected
            ? "bg-brand/15 border-brand/30 text-brand"
            : "bg-secondary border-border text-muted-foreground group-hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="flex-1">{label}</span>
      {selected && <Check className="size-4 text-brand shrink-0 animate-in zoom-in-50 duration-200" />}
    </button>
  );
}

// ─── Industry picker (searchable multi-select) ──────────────────────────────────

function IndustryPicker({
  query,
  onQueryChange,
  selected,
  onToggle,
  onAddCustom,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  selected: string[];
  onToggle: (v: string) => void;
  onAddCustom: (v: string) => void;
}) {
  const trimmed = query.trim();
  const filtered = INDUSTRIES.filter((i) => i.toLowerCase().includes(trimmed.toLowerCase()));
  const exactMatch = INDUSTRIES.some((i) => i.toLowerCase() === trimmed.toLowerCase());
  const canAddCustom = trimmed.length > 1 && !exactMatch && !selected.some((s) => s.toLowerCase() === trimmed.toLowerCase());

  const handleAddCustom = () => {
    if (!canAddCustom) return;
    onAddCustom(trimmed);
    onQueryChange("");
  };

  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3.5">
          {selected.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full bg-brand/10 border border-brand/30 text-xs font-semibold text-foreground animate-in zoom-in-95 fade-in-0 duration-200"
            >
              {s}
              <button
                type="button"
                onClick={() => onToggle(s)}
                aria-label={`Remove ${s}`}
                className="grid place-items-center rounded-full hover:bg-brand/20 size-4 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddCustom();
            }
          }}
          placeholder="Search industries — e.g. real estate, SaaS, fitness…"
          className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none pl-10 pr-3.5 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
        />
      </div>

      <div className="mt-3.5 max-h-56 overflow-y-auto pr-1 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {filtered.map((i) => {
          const isSelected = selected.includes(i);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onToggle(i)}
              title={i}
              className={cn(
                "px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors truncate",
                isSelected
                  ? "border-brand bg-brand/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40",
              )}
            >
              {i}
            </button>
          );
        })}
        {canAddCustom && (
          <button
            type="button"
            onClick={handleAddCustom}
            className="px-3 py-2 rounded-lg border border-dashed border-brand/40 text-brand text-xs font-semibold flex items-center gap-1.5 hover:bg-brand/10 transition-colors truncate"
          >
            <Plus className="size-3.5 shrink-0" />
            Add “{trimmed}”
          </button>
        )}
        {filtered.length === 0 && !canAddCustom && (
          <p className="col-span-full text-xs text-muted-foreground py-4 text-center">
            No matches yet — keep typing to add a custom industry.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Small field wrapper ─────────────────────────────────────────────────────────

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground/70 mt-1.5">{hint}</span>}
    </label>
  );
}

// ─── Completion screen ────────────────────────────────────────────────────────────

function CompletionScreen({
  name,
  workspaceName,
  role,
  industries,
  goal,
  onContinue,
}: {
  name: string;
  workspaceName: string;
  role: string | null;
  industries: string[];
  goal: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="text-center animate-in fade-in-0 zoom-in-95 duration-500 pt-6">
      <div className="relative mx-auto w-fit">
        <div className="absolute inset-0 bg-emerald-500/25 rounded-full blur-2xl scale-150" />
        <div className="relative size-16 rounded-full bg-emerald-500/10 border border-emerald-500/25 grid place-items-center animate-in zoom-in-50 duration-500">
          <Check className="size-8 text-emerald-400" strokeWidth={2.5} />
        </div>
      </div>

      <h1 className="mt-6 text-2xl sm:text-3xl font-bold tracking-tight">
        You’re all set, {firstNameOf(name)}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
        <span className="text-foreground font-medium">{workspaceName}</span> is ready. Here's a quick recap of what you told us.
      </p>

      <div
        className="mt-8 text-left bg-card border border-border rounded-2xl p-5 space-y-4 animate-in fade-in-0 slide-in-from-bottom-2 duration-500 fill-mode-both"
        style={{ animationDelay: "150ms" }}
      >
        <RecapRow label="Role" value={role ?? "Not specified"} />
        <RecapRow label="Industries" value={industries.length ? industries.join(", ") : "Not specified"} />
        <RecapRow label="Primary goal" value={goal ?? "Not specified"} />
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-8 w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold transition-colors shadow-brand inline-flex items-center justify-center gap-2"
      >
        Go to dashboard
        <ArrowRight className="size-4" />
      </button>
    </div>
  );
}

function RecapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs font-semibold text-muted-foreground shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-foreground font-medium text-right">{value}</span>
    </div>
  );
}
