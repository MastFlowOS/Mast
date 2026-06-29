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

// ── Greeting ────────────────────────────────────────────────────────────────

type GreetingProps = {
  emoji: string;
  period: string;
  name: string;
  subtitle: string;
};

export function FocusGreeting({ emoji, period, name, subtitle }: GreetingProps) {
  return (
    <header className="animate-fade-in" style={{ paddingTop: "0.25rem" }}>
      {/* Eyebrow */}
      <p className="focus-eyebrow">
        <span className="focus-eyebrow-dot" />
        AI Briefing
      </p>

      {/* Display heading */}
      <h1 className="focus-greeting-headline">
        <span className="focus-greeting-emoji" aria-hidden="true">{emoji}</span>
        {period}, {name}.
      </h1>

      {/* Subtitle */}
      <p className="focus-greeting-subtitle">{subtitle}</p>

      <style>{`
        .focus-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--color-brand);
          margin-bottom: 1.25rem;
        }

        .focus-eyebrow-dot {
          display: inline-block;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--color-brand);
          box-shadow: 0 0 8px color-mix(in oklab, var(--brand) 70%, transparent);
          animation: pulse-glow 2.2s ease-in-out infinite;
        }

        .focus-greeting-headline {
          font-size: clamp(2rem, 5vw, 2.75rem);
          font-weight: 800;
          letter-spacing: -0.03em;
          line-height: 1.1;
          color: var(--color-foreground);
          margin: 0 0 0.875rem;
          display: flex;
          align-items: baseline;
          gap: 0.4em;
          flex-wrap: wrap;
        }

        .focus-greeting-emoji {
          font-size: 0.85em;
          line-height: 1;
        }

        .focus-greeting-subtitle {
          font-size: 1rem;
          line-height: 1.6;
          color: var(--color-muted-foreground);
          max-width: 520px;
          margin: 0;
        }
      `}</style>
    </header>
  );
}

// ── Recommendations ──────────────────────────────────────────────────────────

const RECOMMENDATION_ICONS: Record<string, LucideIcon> = {
  uncontacted: Mail,
  "overdue-followups": AlertTriangle,
  "due-today": AlertTriangle,
  "hot-proposals": Target,
  discover: Rocket,
  "pipeline-review": TrendingUp,
  "all-clear": Sparkles,
};

const TONE_CONFIG = {
  brand: {
    icon: "rec-icon-brand",
    card: "rec-card-brand",
    badge: "rec-badge-brand",
  },
  warning: {
    icon: "rec-icon-warning",
    card: "rec-card-warning",
    badge: "rec-badge-warning",
  },
  success: {
    icon: "rec-icon-success",
    card: "rec-card-success",
    badge: "rec-badge-success",
  },
  danger: {
    icon: "rec-icon-danger",
    card: "rec-card-danger",
    badge: "rec-badge-danger",
  },
};

type RecommendationsProps = {
  recommendations: FocusRecommendation[];
};

export function FocusRecommendations({ recommendations }: RecommendationsProps) {
  return (
    <section>
      {/* Section label */}
      <div className="focus-section-header">
        <h2 className="focus-section-title">Today's Briefing</h2>
        <span className="focus-section-count">{recommendations.length} item{recommendations.length !== 1 ? "s" : ""}</span>
      </div>

      {/* First recommendation is the hero item */}
      <div className="rec-list">
        {recommendations.map((item, index) => {
          const Icon = RECOMMENDATION_ICONS[item.id] ?? Sparkles;
          const tone = TONE_CONFIG[item.tone];
          const isHero = index === 0;

          return (
            <Link
              key={item.id}
              to={item.to}
              className={cn(
                "rec-card animate-fade-up",
                isHero ? "rec-card-hero" : "rec-card-secondary",
                tone.card,
                staggerDelay(index, 80),
              )}
            >
              {/* Priority indicator for hero */}
              {isHero && (
                <span className="rec-priority-label">Priority</span>
              )}

              <div className={cn("rec-icon-wrap", tone.icon)}>
                <Icon className="rec-icon" />
              </div>

              <div className="rec-body">
                <p className="rec-title">{item.title}</p>
                <p className="rec-desc">{item.description}</p>
              </div>

              <div className="rec-action">
                <span className="rec-action-label">{item.actionLabel}</span>
                <ArrowRight className="rec-action-arrow" />
              </div>
            </Link>
          );
        })}
      </div>

      <style>{`
        .focus-section-header {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }

        .focus-section-title {
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .focus-section-count {
          font-size: 0.75rem;
          font-weight: 500;
          color: color-mix(in oklab, var(--muted-foreground) 60%, transparent);
        }

        .rec-list {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
        }

        /* Base card */
        .rec-card {
          position: relative;
          display: flex;
          align-items: center;
          gap: 1rem;
          border-radius: 14px;
          border: 1px solid var(--color-border);
          background: var(--color-card);
          text-decoration: none;
          transition:
            transform 250ms cubic-bezier(0.16, 1, 0.3, 1),
            box-shadow 250ms cubic-bezier(0.16, 1, 0.3, 1),
            border-color 150ms ease;
        }
        .rec-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 16px 48px -12px rgb(0 0 0 / 0.5),
                      0 0 0 1px color-mix(in oklab, var(--brand) 25%, transparent);
          border-color: color-mix(in oklab, var(--brand) 30%, transparent);
        }

        /* Hero card — larger, slightly elevated */
        .rec-card-hero {
          padding: 1.125rem 1.25rem;
          background: color-mix(in oklab, var(--card) 95%, var(--brand) 5%);
        }

        /* Secondary cards — compact */
        .rec-card-secondary {
          padding: 0.875rem 1.125rem;
        }

        /* Tone-specific border-left accents */
        .rec-card-brand  { border-left: 2px solid color-mix(in oklab, var(--brand) 70%, transparent); }
        .rec-card-warning { border-left: 2px solid color-mix(in oklab, var(--warning) 70%, transparent); }
        .rec-card-success { border-left: 2px solid color-mix(in oklab, var(--success) 70%, transparent); }
        .rec-card-danger  { border-left: 2px solid color-mix(in oklab, var(--destructive) 70%, transparent); }

        /* Priority badge */
        .rec-priority-label {
          position: absolute;
          top: -0.5rem;
          left: 1.125rem;
          font-size: 0.625rem;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--color-brand);
          background: var(--color-background);
          padding: 0.1rem 0.5rem;
          border-radius: 99px;
          border: 1px solid color-mix(in oklab, var(--brand) 30%, transparent);
        }

        /* Icon */
        .rec-icon-wrap {
          display: grid;
          place-items: center;
          flex-shrink: 0;
          width: 2.5rem;
          height: 2.5rem;
          border-radius: 10px;
          border: 1px solid;
        }
        .rec-icon-brand   { background: color-mix(in oklab, var(--brand) 12%, transparent); border-color: color-mix(in oklab, var(--brand) 25%, transparent); color: var(--color-brand); }
        .rec-icon-warning { background: color-mix(in oklab, var(--warning) 12%, transparent); border-color: color-mix(in oklab, var(--warning) 25%, transparent); color: var(--color-warning); }
        .rec-icon-success { background: color-mix(in oklab, var(--success) 12%, transparent); border-color: color-mix(in oklab, var(--success) 25%, transparent); color: var(--color-success); }
        .rec-icon-danger  { background: color-mix(in oklab, var(--destructive) 12%, transparent); border-color: color-mix(in oklab, var(--destructive) 25%, transparent); color: oklch(0.7 0.22 25); }

        .rec-icon {
          width: 1rem;
          height: 1rem;
        }

        /* Body */
        .rec-body {
          flex: 1;
          min-width: 0;
        }
        .rec-title {
          font-size: 0.9375rem;
          font-weight: 600;
          color: var(--color-foreground);
          margin: 0 0 0.2rem;
          line-height: 1.3;
        }
        .rec-desc {
          font-size: 0.8125rem;
          color: var(--color-muted-foreground);
          margin: 0;
          line-height: 1.45;
        }

        /* Action arrow */
        .rec-action {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          flex-shrink: 0;
          color: var(--color-brand);
          font-size: 0.8125rem;
          font-weight: 600;
        }
        .rec-action-label {
          display: none;
        }
        @media (min-width: 500px) {
          .rec-action-label { display: inline; }
        }
        .rec-action-arrow {
          width: 0.9rem;
          height: 0.9rem;
          transition: transform 150ms ease;
        }
        .rec-card:hover .rec-action-arrow {
          transform: translateX(3px);
        }
      `}</style>
    </section>
  );
}

// ── Weekly Review ────────────────────────────────────────────────────────────

type WeeklyReviewProps = {
  metrics: WeeklyMetric[];
  summary: string;
  recommendation: string;
};

export function FocusWeeklyReview({ metrics, summary, recommendation }: WeeklyReviewProps) {
  return (
    <section
      className="animate-fade-up delay-200 weekly-review-block"
      style={{ marginTop: "3rem" }}
    >
      {/* Header row */}
      <div className="weekly-header">
        <div>
          <div className="focus-section-header" style={{ marginBottom: "0.25rem" }}>
            <h2 className="focus-section-title">Weekly Intelligence</h2>
          </div>
          <p className="weekly-period">Previous 7 days</p>
        </div>
      </div>

      {/* Metrics row — editorial number grid */}
      <div className="weekly-metrics-grid">
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={cn("weekly-metric-cell animate-fade-up", staggerDelay(index, 50))}
          >
            <span className="weekly-metric-value">{metric.value.toLocaleString()}</span>
            <span className="weekly-metric-label">{metric.label}</span>
          </div>
        ))}
      </div>

      {/* Insight block */}
      <div className="weekly-insight">
        <p className="weekly-insight-summary">{summary}</p>
        <p className="weekly-insight-rec">
          <span className="weekly-insight-rec-arrow">→</span>
          {recommendation}
        </p>
      </div>

      <style>{`
        .focus-section-header {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }
        .focus-section-title {
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .weekly-review-block {
          border: 1px solid var(--color-border);
          border-radius: 18px;
          background: var(--color-card);
          overflow: hidden;
        }

        .weekly-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 1.75rem 1.75rem 0;
        }

        .weekly-period {
          font-size: 0.75rem;
          color: color-mix(in oklab, var(--muted-foreground) 65%, transparent);
          margin: 0;
        }

        /* Metrics: horizontal scroll on mobile, grid on desktop */
        .weekly-metrics-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          margin: 1.5rem 1.75rem 0;
          border-radius: 12px;
          border: 1px solid var(--color-border);
          overflow: hidden;
          background: var(--color-background);
        }

        .weekly-metric-cell {
          display: flex;
          flex-direction: column;
          padding: 1.125rem 1rem;
          border-right: 1px solid var(--color-border);
        }
        .weekly-metric-cell:last-child {
          border-right: none;
        }

        .weekly-metric-value {
          font-size: 1.625rem;
          font-weight: 800;
          letter-spacing: -0.03em;
          color: var(--color-foreground);
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }

        .weekly-metric-label {
          font-size: 0.6875rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          color: var(--color-muted-foreground);
          margin-top: 0.5rem;
          line-height: 1.3;
        }

        /* Insight block at bottom */
        .weekly-insight {
          padding: 1.25rem 1.75rem 1.75rem;
          margin-top: 1.25rem;
          border-top: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
        }

        .weekly-insight-summary {
          font-size: 0.875rem;
          line-height: 1.65;
          color: var(--color-muted-foreground);
          margin: 0 0 0.625rem;
        }

        .weekly-insight-rec {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--color-foreground);
          margin: 0;
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
        }

        .weekly-insight-rec-arrow {
          color: var(--color-brand);
          font-size: 1rem;
        }

        @media (max-width: 680px) {
          .weekly-metrics-grid {
            grid-template-columns: repeat(3, 1fr);
            margin-inline: 1.25rem;
          }
          .weekly-metric-cell:nth-child(3) { border-right: none; }
          .weekly-metric-cell:nth-child(4) { border-top: 1px solid var(--color-border); }
          .weekly-metric-cell:nth-child(5) { border-top: 1px solid var(--color-border); border-right: none; }
          .weekly-header, .weekly-insight {
            padding-inline: 1.25rem;
          }
        }
      `}</style>
    </section>
  );
}

// ── Goals ────────────────────────────────────────────────────────────────────

type GoalsProps = {
  goals: FocusGoal[];
};

export function FocusGoals({ goals }: GoalsProps) {
  if (goals.length === 0) return null;

  return (
    <section className="animate-fade-up delay-300 goals-block">
      <div className="focus-section-header">
        <h2 className="focus-section-title">Today's Goals</h2>
      </div>

      <div className="goals-list">
        {goals.map((goal, index) => (
          <GoalRow key={goal.id} goal={goal} index={index} />
        ))}
      </div>

      <style>{`
        .focus-section-header {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }
        .focus-section-title {
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .goals-block {
          display: flex;
          flex-direction: column;
        }

        .goals-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
      `}</style>
    </section>
  );
}

function GoalRow({ goal, index }: { goal: FocusGoal; index: number }) {
  const pct = goalProgress(goal);
  const complete = isGoalComplete(goal);

  return (
    <div
      className={cn(
        "goal-row animate-fade-up",
        complete && "goal-row-complete",
        staggerDelay(index, 70),
      )}
    >
      {/* Completion indicator */}
      <div className={cn("goal-check", complete ? "goal-check-done" : "goal-check-pending")}>
        {complete ? (
          <Check className="goal-check-icon" />
        ) : (
          <span className="goal-check-num">{index + 1}</span>
        )}
      </div>

      {/* Label + progress bar */}
      <div className="goal-content">
        <div className="goal-top">
          <p className={cn("goal-label", complete && "goal-label-done")}>{goal.label}</p>
          <span className="goal-fraction">
            {Math.min(goal.current, goal.target)}/{goal.target}
          </span>
        </div>

        <div className="goal-track">
          <div
            className={cn("goal-fill animate-progress", complete ? "goal-fill-done" : "goal-fill-active")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <style>{`
        .goal-row {
          display: flex;
          align-items: center;
          gap: 0.875rem;
          padding: 0.875rem 1rem;
          border-radius: 12px;
          border: 1px solid var(--color-border);
          background: var(--color-card);
          transition: border-color 250ms ease, background 250ms ease;
        }
        .goal-row-complete {
          border-color: color-mix(in oklab, var(--success) 25%, transparent);
          background: color-mix(in oklab, var(--success) 5%, var(--card));
          opacity: 0.85;
        }

        .goal-check {
          display: grid;
          place-items: center;
          flex-shrink: 0;
          width: 1.625rem;
          height: 1.625rem;
          border-radius: 50%;
          border: 1.5px solid;
        }
        .goal-check-pending {
          border-color: var(--color-border);
          background: var(--color-background);
          color: var(--color-muted-foreground);
        }
        .goal-check-done {
          border-color: color-mix(in oklab, var(--success) 40%, transparent);
          background: color-mix(in oklab, var(--success) 15%, transparent);
          color: var(--color-success);
        }

        .goal-check-icon { width: 0.75rem; height: 0.75rem; }
        .goal-check-num {
          font-size: 0.625rem;
          font-weight: 800;
          color: var(--color-muted-foreground);
        }

        .goal-content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .goal-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }

        .goal-label {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--color-foreground);
          margin: 0;
          line-height: 1.3;
        }
        .goal-label-done {
          color: var(--color-success);
        }

        .goal-fraction {
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--color-muted-foreground);
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }

        .goal-track {
          height: 3px;
          border-radius: 99px;
          background: var(--color-border);
          overflow: hidden;
        }

        .goal-fill {
          height: 100%;
          border-radius: 99px;
        }
        .goal-fill-active {
          background: linear-gradient(90deg, var(--color-brand), color-mix(in oklab, var(--brand) 70%, oklch(0.7 0.2 300)));
        }
        .goal-fill-done {
          background: var(--color-success);
        }
      `}</style>
    </div>
  );
}

// ── Milestones ───────────────────────────────────────────────────────────────

type MilestonesProps = {
  xp: number;
  currentName: string;
  nextName: string | null;
  progressPct: number;
};

export function FocusMilestones({ xp, currentName, nextName, progressPct }: MilestonesProps) {
  const currentIndex = MILESTONE_TIERS.findIndex((tier) => tier.name === currentName);
  const nextTier = MILESTONE_TIERS.find((t) => t.name === nextName);

  return (
    <section className="animate-fade-up delay-400 milestones-block">
      <div className="focus-section-header">
        <h2 className="focus-section-title">Milestone Journey</h2>
      </div>

      {/* XP badge + tier name */}
      <div className="milestone-header">
        <div>
          <p className="milestone-tier-name">{currentName}</p>
          {nextName && (
            <p className="milestone-next-hint">
              {nextTier ? `${nextTier.xpRequired - xp} XP to ${nextName}` : "Maximum tier"}
            </p>
          )}
        </div>
        <div className="milestone-xp-badge">
          {xp.toLocaleString()} <span className="milestone-xp-unit">XP</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="milestone-track">
        <div
          className="milestone-fill animate-progress"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Tier dots */}
      <div className="milestone-tiers">
        {MILESTONE_TIERS.map((tier, index) => {
          const unlocked = xp >= tier.xpRequired;
          const active = index === currentIndex;
          return (
            <div
              key={tier.id}
              className={cn("milestone-tier-item", !unlocked && "milestone-tier-locked")}
            >
              <div
                className={cn(
                  "milestone-dot",
                  active ? "milestone-dot-active" : unlocked ? "milestone-dot-unlocked" : "milestone-dot-locked",
                )}
              />
              <span className={cn("milestone-tier-label", active ? "milestone-tier-label-active" : "")}>
                {tier.name}
              </span>
            </div>
          );
        })}
      </div>

      {nextName && nextTier && (
        <p className="milestone-reward-hint">
          Next: <strong>{nextTier.reward}</strong>
        </p>
      )}

      <style>{`
        .focus-section-header {
          display: flex;
          align-items: baseline;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }
        .focus-section-title {
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .milestones-block {
          display: flex;
          flex-direction: column;
          gap: 0;
          border: 1px solid var(--color-border);
          border-radius: 18px;
          background: var(--color-card);
          padding: 1.375rem;
          overflow: hidden;
        }

        .milestone-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.75rem;
          margin-bottom: 1.25rem;
        }

        .milestone-tier-name {
          font-size: 1.0625rem;
          font-weight: 700;
          color: var(--color-foreground);
          margin: 0 0 0.25rem;
          letter-spacing: -0.01em;
        }

        .milestone-next-hint {
          font-size: 0.75rem;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .milestone-xp-badge {
          flex-shrink: 0;
          font-size: 1.25rem;
          font-weight: 800;
          color: var(--color-brand);
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          background: color-mix(in oklab, var(--brand) 10%, transparent);
          border: 1px solid color-mix(in oklab, var(--brand) 22%, transparent);
          padding: 0.375rem 0.75rem;
          border-radius: 10px;
          line-height: 1.2;
        }

        .milestone-xp-unit {
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          opacity: 0.7;
        }

        .milestone-track {
          height: 3px;
          border-radius: 99px;
          background: var(--color-border);
          overflow: hidden;
          margin-bottom: 1.125rem;
        }

        .milestone-fill {
          height: 100%;
          border-radius: 99px;
          background: linear-gradient(90deg, var(--color-brand), color-mix(in oklab, var(--brand) 60%, oklch(0.7 0.2 300)));
        }

        .milestone-tiers {
          display: flex;
          justify-content: space-between;
          gap: 0.25rem;
          overflow-x: auto;
          padding-bottom: 0.25rem;
        }

        .milestone-tier-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          flex: 1;
          min-width: 3rem;
        }

        .milestone-tier-locked {
          opacity: 0.38;
        }

        .milestone-dot {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          border: 1.5px solid;
          flex-shrink: 0;
        }
        .milestone-dot-active {
          border-color: var(--color-brand);
          background: var(--color-brand);
          box-shadow: 0 0 10px color-mix(in oklab, var(--brand) 60%, transparent);
        }
        .milestone-dot-unlocked {
          border-color: color-mix(in oklab, var(--brand) 60%, transparent);
          background: color-mix(in oklab, var(--brand) 35%, transparent);
        }
        .milestone-dot-locked {
          border-color: var(--color-border);
          background: var(--color-background);
        }

        .milestone-tier-label {
          font-size: 0.5625rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--color-muted-foreground);
          text-align: center;
          line-height: 1.2;
        }
        .milestone-tier-label-active {
          color: var(--color-brand);
        }

        .milestone-reward-hint {
          font-size: 0.75rem;
          color: var(--color-muted-foreground);
          margin: 1rem 0 0;
          padding-top: 1rem;
          border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
        }
        .milestone-reward-hint strong {
          color: var(--color-foreground);
          font-weight: 600;
        }
      `}</style>
    </section>
  );
}

// ── Discover CTA ─────────────────────────────────────────────────────────────

export function FocusDiscoverCta() {
  return (
    <div className="animate-fade-up delay-500 discover-cta-wrap">
      <Link
        to="/dashboard/leads"
        className="discover-cta-link"
      >
        <Search className="discover-cta-icon" />
        Discover Opportunities
        <ArrowRight className="discover-cta-arrow" />
      </Link>

      <style>{`
        .discover-cta-wrap {
          display: flex;
          justify-content: center;
          padding-top: 0.5rem;
        }

        .discover-cta-link {
          display: inline-flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.75rem 1.625rem;
          border-radius: 99px;
          background: var(--color-brand);
          color: var(--color-brand-foreground);
          font-size: 0.875rem;
          font-weight: 700;
          letter-spacing: 0.01em;
          text-decoration: none;
          box-shadow: 0 0 0 0 color-mix(in oklab, var(--brand) 50%, transparent);
          transition:
            transform 250ms cubic-bezier(0.16, 1, 0.3, 1),
            box-shadow 250ms cubic-bezier(0.16, 1, 0.3, 1),
            background 150ms ease;
        }
        .discover-cta-link:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-brand);
          background: var(--color-brand-dark);
        }
        .discover-cta-link:active {
          transform: scale(0.97);
        }

        .discover-cta-icon { width: 0.9rem; height: 0.9rem; }
        .discover-cta-arrow {
          width: 0.875rem;
          height: 0.875rem;
          transition: transform 150ms ease;
        }
        .discover-cta-link:hover .discover-cta-arrow {
          transform: translateX(3px);
        }
      `}</style>
    </div>
  );
}
