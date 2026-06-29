import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Mail,
  Rocket,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import {
  goalProgress,
  isGoalComplete,
  MILESTONE_TIERS,
  type FocusGoal,
  type FocusRecommendation,
  type WeeklyMetric,
} from "@/lib/focus";

type GreetingProps = {
  emoji: string;
  period: string;
  name: string;
  subtitle: string;
};

export function FocusGreeting({ emoji, period, name, subtitle }: GreetingProps) {
  return (
    <header className="animate-fade-in space-y-2">
      <h1 className="text-3xl font-bold tracking-tight">
        <span className="mr-2">{emoji}</span>
        {period}, {name}.
      </h1>
      <p className="max-w-2xl text-base text-muted-foreground">{subtitle}</p>
    </header>
  );
}

const RECOMMENDATION_ICONS: Record<string, LucideIcon> = {
  uncontacted: Mail,
  "overdue-followups": AlertTriangle,
  "due-today": AlertTriangle,
  "hot-proposals": Target,
  discover: Rocket,
  "pipeline-review": TrendingUp,
  "all-clear": Sparkles,
};

const TONE_STYLES = {
  brand: "border-brand/20 bg-brand/10 text-brand",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
  danger: "border-orange-500/20 bg-orange-500/10 text-orange-400",
};

type RecommendationsProps = {
  recommendations: FocusRecommendation[];
};

export function FocusRecommendations({ recommendations }: RecommendationsProps) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold tracking-tight">What should we work on today?</h2>
        <p className="text-sm text-muted-foreground">AI Recommendations</p>
      </div>

      <div className="space-y-3">
        {recommendations.map((item, index) => {
          const Icon = RECOMMENDATION_ICONS[item.id] ?? Sparkles;
          return (
            <Link
              key={item.id}
              to={item.to}
              className={cn(
                "group flex items-center gap-4 rounded-2xl border border-border bg-card p-4 card-hover animate-fade-up",
                staggerDelay(index + 1, 80),
              )}
            >
              <div
                className={cn(
                  "grid size-11 shrink-0 place-items-center rounded-xl border",
                  TONE_STYLES[item.tone],
                )}
              >
                <Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground">{item.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-brand">
                <span className="hidden sm:inline">{item.actionLabel}</span>
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

type WeeklyReviewProps = {
  metrics: WeeklyMetric[];
  summary: string;
  recommendation: string;
};

export function FocusWeeklyReview({ metrics, summary, recommendation }: WeeklyReviewProps) {
  return (
    <section className="animate-fade-up delay-200 space-y-4 rounded-2xl border border-border bg-card p-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">How have we been doing?</h2>
        <p className="text-sm text-muted-foreground">Previous 7 days</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={cn("rounded-xl border border-border bg-background px-4 py-3 animate-fade-up", staggerDelay(index, 50))}
          >
            <p className="text-2xl font-bold tabular-nums">{metric.value.toLocaleString()}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {metric.label}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-background p-4 text-sm leading-relaxed text-muted-foreground">
        <p>{summary}</p>
        <p className="mt-3 font-medium text-foreground">{recommendation}</p>
      </div>
    </section>
  );
}

type GoalsProps = {
  goals: FocusGoal[];
};

export function FocusGoals({ goals }: GoalsProps) {
  if (goals.length === 0) return null;

  return (
    <section className="animate-fade-up delay-300 space-y-4">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Today's Goals</h2>
        <p className="text-sm text-muted-foreground">Simple, achievable — built for today.</p>
      </div>

      <div className="space-y-3">
        {goals.map((goal, index) => (
          <GoalRow key={goal.id} goal={goal} index={index} />
        ))}
      </div>
    </section>
  );
}

function GoalRow({ goal, index }: { goal: FocusGoal; index: number }) {
  const pct = goalProgress(goal);
  const complete = isGoalComplete(goal);

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-4 transition-all duration-500 animate-fade-up",
        complete && "border-success/30 bg-success/5 opacity-80",
        staggerDelay(index, 70),
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 grid size-6 place-items-center rounded-full border",
              complete
                ? "border-success/30 bg-success/15 text-success"
                : "border-border bg-background text-muted-foreground",
            )}
          >
            {complete ? <Check className="size-3.5" /> : <span className="text-[10px] font-bold">{index + 1}</span>}
          </div>
          <div>
            <p className={cn("font-semibold", complete && "text-success")}>{goal.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {Math.min(goal.current, goal.target)} / {goal.target} · {pct}%
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full animate-progress",
            complete ? "bg-success" : "bg-brand",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

type MilestonesProps = {
  xp: number;
  currentName: string;
  nextName: string | null;
  progressPct: number;
};

export function FocusMilestones({ xp, currentName, nextName, progressPct }: MilestonesProps) {
  const currentIndex = MILESTONE_TIERS.findIndex((tier) => tier.name === currentName);

  return (
    <section className="animate-fade-up delay-400 space-y-4 rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Milestone Journey</h2>
          <p className="text-sm text-muted-foreground">
            {currentName}
            {nextName ? ` · ${xp.toLocaleString()} XP toward ${nextName}` : " · Maximum tier reached"}
          </p>
        </div>
        <div className="rounded-lg border border-brand/20 bg-brand/10 px-3 py-1.5 text-sm font-semibold text-brand">
          {xp.toLocaleString()} XP
        </div>
      </div>

      <div className="relative">
        <div className="h-2 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand to-brand/60 animate-progress"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="mt-4 flex justify-between gap-1 overflow-x-auto pb-1">
          {MILESTONE_TIERS.map((tier, index) => {
            const unlocked = xp >= tier.xpRequired;
            const active = index === currentIndex;
            return (
              <div
                key={tier.id}
                className={cn(
                  "flex min-w-[4.5rem] flex-col items-center gap-1.5 text-center",
                  unlocked ? "opacity-100" : "opacity-40",
                )}
              >
                <div
                  className={cn(
                    "size-3 rounded-full border-2 transition-colors",
                    active
                      ? "border-brand bg-brand shadow-[0_0_12px_color-mix(in_oklab,var(--brand)_50%,transparent)]"
                      : unlocked
                        ? "border-brand/60 bg-brand/40"
                        : "border-border bg-background",
                  )}
                />
                <span
                  className={cn(
                    "text-[10px] font-semibold leading-tight",
                    active ? "text-brand" : "text-muted-foreground",
                  )}
                >
                  {tier.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {nextName && (
        <p className="text-xs text-muted-foreground">
          Complete daily goals to earn XP. Next reward:{" "}
          {MILESTONE_TIERS.find((tier) => tier.name === nextName)?.reward}.
        </p>
      )}
    </section>
  );
}

export function FocusDiscoverCta() {
  return (
    <div className="animate-fade-up delay-500 flex justify-end">
      <Link
        to="/dashboard/leads"
        className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark"
      >
        <Search className="size-4" />
        Discover Opportunities
      </Link>
    </div>
  );
}
