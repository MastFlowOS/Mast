import { useState } from "react";
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
  period: "morning" | "afternoon" | "evening" | "night";
  name: string;
  subtitle: string;
};

const GREETING_POOLS = {
  morning: [
    "Good Morning, {FirstName}",
    "Rise and Shine, {FirstName}",
    "Ready for another productive day?",
    "Morning, {FirstName}",
  ],
  afternoon: [
    "Welcome Back, {FirstName}",
    "Good Afternoon, {FirstName}",
    "Ready to keep the momentum going?",
    "Back at it, {FirstName}?",
  ],
  evening: [
    "Good Evening, {FirstName}",
    "Welcome Back",
    "Let's finish the day strong.",
    "Evening, {FirstName}",
  ],
  night: [
    "Welcome Back, Night Owl ✦",
    "Burning the midnight oil?",
    "Still chasing opportunities?",
    "Working late? Let's make it count.",
    "Night Shift Activated ✦",
  ],
};

export function FocusGreeting({ period, name, subtitle }: GreetingProps) {
  const [greetingText] = useState(() => {
    const pool = GREETING_POOLS[period] || GREETING_POOLS.morning;
    const template = pool[Math.floor(Math.random() * pool.length)];
    return template.replace("{FirstName}", name);
  });

  return (
    <header className="animate-fade-in focus-greeting-wrap">
      {/* Eyebrow */}
      <p className="focus-eyebrow">
        <span className="focus-eyebrow-dot" />
        AI Briefing
      </p>

      {/* Display heading */}
      <h1 className={`focus-greeting-headline focus-greeting-${period}`}>
        {greetingText}
      </h1>

      {/* Subtitle */}
      <p className="focus-greeting-subtitle">{subtitle}</p>

      <style>{`
        .focus-greeting-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }

        .focus-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--color-brand);
          margin-bottom: 1.75rem;
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
          font-size: clamp(2.25rem, 7vw, 4rem);
          font-weight: 800;
          letter-spacing: -0.03em;
          line-height: 1.15;
          margin: 0 0 1.5rem;
          display: block;
          max-width: 800px;
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        /* Sky Gradients based on Period */
        .focus-greeting-morning {
          background: linear-gradient(135deg, oklch(0.85 0.12 215), oklch(0.90 0.14 85), oklch(0.76 0.18 45));
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        .focus-greeting-afternoon {
          background: linear-gradient(135deg, oklch(0.78 0.14 210), oklch(0.85 0.16 80), oklch(0.94 0.08 95));
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        .focus-greeting-evening {
          background: linear-gradient(135deg, oklch(0.75 0.18 45), oklch(0.72 0.20 350), oklch(0.66 0.20 300));
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        .focus-greeting-night {
          background: linear-gradient(135deg, oklch(0.60 0.15 240), oklch(0.72 0.18 260), oklch(0.90 0.05 220));
          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }

        .focus-greeting-subtitle {
          font-size: 1.125rem;
          line-height: 1.6;
          color: var(--color-muted-foreground);
          max-width: 480px;
          margin: 0 auto;
        }

        @media (max-width: 680px) {
          .focus-greeting-headline {
            font-size: clamp(1.85rem, 10vw, 2.75rem);
          }
          .focus-greeting-subtitle {
            font-size: 1rem;
          }
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="briefing-panel animate-fade-up delay-100">
      {/* Header row */}
      <div className="briefing-panel-header">
        <div className="focus-section-header" style={{ marginBottom: "0.25rem" }}>
          <h2 className="focus-section-title">Today's Briefing</h2>
        </div>
        <p className="briefing-panel-sub">
          {recommendations.length} item{recommendations.length !== 1 ? "s" : ""} for you
        </p>
      </div>

      {/* Compact rows */}
      <div className="rec-list">
        {recommendations.map((item, index) => {
          const Icon = RECOMMENDATION_ICONS[item.id] ?? Sparkles;
          const tone = TONE_CONFIG[item.tone];
          const isExpanded = expandedId === item.id;

          return (
            <div
              key={item.id}
              className={cn(
                "rec-row animate-fade-up",
                isExpanded && "rec-row-expanded",
                staggerDelay(index, 60),
              )}
            >
              <button
                type="button"
                className="rec-row-main"
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
                aria-expanded={isExpanded}
              >
                <div className={cn("rec-icon-wrap", tone.icon)}>
                  <Icon className="rec-icon" />
                </div>

                <p className="rec-title">{item.title}</p>
              </button>

              <Link to={item.to} className="rec-row-arrow" aria-label={item.actionLabel}>
                <ArrowRight className="rec-action-arrow" />
              </Link>

              {isExpanded && (
                <div className="rec-row-detail animate-fade-in">
                  <p className="rec-desc">{item.description}</p>
                  <Link to={item.to} className="rec-detail-link">
                    {item.actionLabel}
                    <ArrowRight className="rec-detail-link-arrow" />
                  </Link>
                </div>
              )}
            </div>
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

        /* Panel shell — matches Weekly Intelligence's visual weight */
        .briefing-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          border: 1px solid var(--color-border);
          border-radius: 18px;
          background: color-mix(in oklab, var(--card) 95%, var(--brand) 5%);
          padding: 1.75rem 1.75rem 1.5rem;
        }

        .briefing-panel-header {
          margin-bottom: 0.5rem;
        }

        .briefing-panel-sub {
          font-size: 0.75rem;
          color: color-mix(in oklab, var(--muted-foreground) 65%, transparent);
          margin: 0;
        }

        .rec-list {
          display: flex;
          flex-direction: column;
          margin-top: 0.75rem;
        }

        /* Compact row */
        .rec-row {
          position: relative;
          display: flex;
          align-items: stretch;
          gap: 0.5rem;
          border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
        }
        .rec-row:first-child {
          border-top: none;
        }

        .rec-row-main {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 0.875rem;
          padding: 0.875rem 0;
          background: transparent;
          border: none;
          text-align: left;
          cursor: pointer;
          font: inherit;
          color: inherit;
        }

        .rec-row-arrow {
          flex-shrink: 0;
          display: grid;
          place-items: center;
          width: 2.25rem;
          color: var(--color-brand);
          text-decoration: none;
          transition: transform 150ms ease;
        }
        .rec-row-arrow:hover {
          transform: translateX(2px);
        }

        /* Icon */
        .rec-icon-wrap {
          display: grid;
          place-items: center;
          flex-shrink: 0;
          width: 2.125rem;
          height: 2.125rem;
          border-radius: 9px;
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

        /* Title — single line, truncates instead of overflowing */
        .rec-title {
          flex: 1;
          min-width: 0;
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--color-foreground);
          margin: 0;
          line-height: 1.3;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Expanded detail — revealed on row click, never overflows layout */
        .rec-row-detail {
          grid-column: 1 / -1;
        }
        .rec-row-expanded {
          flex-wrap: wrap;
        }
        .rec-row-expanded .rec-row-main {
          flex-basis: 100%;
        }
        .rec-row-detail {
          flex-basis: 100%;
          padding: 0 0 1rem calc(2.125rem + 0.875rem);
        }

        .rec-desc {
          font-size: 0.8125rem;
          color: var(--color-muted-foreground);
          margin: 0 0 0.625rem;
          line-height: 1.5;
        }

        .rec-detail-link {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: var(--color-brand);
          font-size: 0.8125rem;
          font-weight: 600;
          text-decoration: none;
        }
        .rec-detail-link-arrow {
          width: 1rem;
          height: 1rem;
          transition: transform 150ms ease;
        }
        .rec-detail-link:hover .rec-detail-link-arrow {
          transform: translateX(3px);
        }

        .rec-action-arrow {
          width: 1rem;
          height: 1rem;
        }

        @media (max-width: 680px) {
          .briefing-panel {
            padding: 1.5rem 1.25rem 1.25rem;
          }
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
    <section className="animate-fade-up delay-50 weekly-review-block">
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
          display: flex;
          flex-direction: column;
          height: 100%;
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

        /* Metrics: 3-up grid keeps cells legible at half-page width */
        .weekly-metrics-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          margin: 1.5rem 1.75rem 0;
          border-radius: 12px;
          border: 1px solid var(--color-border);
          overflow: hidden;
          background: var(--color-background);
        }

        .weekly-metric-cell {
          display: flex;
          flex-direction: column;
          padding: 1rem 0.875rem;
          border-right: 1px solid var(--color-border);
        }
        .weekly-metric-cell:nth-child(3n) {
          border-right: none;
        }
        .weekly-metric-cell:nth-child(n+4) {
          border-top: 1px solid var(--color-border);
        }

        .weekly-metric-value {
          font-size: 1.5rem;
          font-weight: 800;
          letter-spacing: -0.03em;
          color: var(--color-foreground);
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }

        .weekly-metric-label {
          font-size: 0.6562rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--color-muted-foreground);
          margin-top: 0.5rem;
          line-height: 1.3;
        }

        /* Insight block at bottom — pinned to fill remaining height */
        .weekly-insight {
          padding: 1.25rem 1.75rem 1.75rem;
          margin-top: 1.25rem;
          border-top: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
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
            margin-inline: 1.25rem;
          }
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
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.625rem;
        }

        @media (max-width: 680px) {
          .goals-list {
            grid-template-columns: 1fr;
          }
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

        .goal-check-icon { width: 1rem; height: 1rem; }
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
          border-radius: 20px;
          background: color-mix(in oklab, var(--card) 96%, var(--brand) 4%);
          padding: 2rem 2.25rem 1.75rem;
          overflow: hidden;
        }

        .milestone-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.75rem;
          margin-bottom: 1.75rem;
        }

        .milestone-tier-name {
          font-size: 1.375rem;
          font-weight: 800;
          color: var(--color-foreground);
          margin: 0 0 0.3rem;
          letter-spacing: -0.02em;
        }

        .milestone-next-hint {
          font-size: 0.8125rem;
          color: var(--color-muted-foreground);
          margin: 0;
        }

        .milestone-xp-badge {
          flex-shrink: 0;
          font-size: 1.375rem;
          font-weight: 800;
          color: var(--color-brand);
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          background: color-mix(in oklab, var(--brand) 10%, transparent);
          border: 1px solid color-mix(in oklab, var(--brand) 22%, transparent);
          padding: 0.5rem 0.875rem;
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
          height: 4px;
          border-radius: 99px;
          background: var(--color-border);
          overflow: hidden;
          margin-bottom: 1.375rem;
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

        @media (max-width: 680px) {
          .milestones-block {
            padding: 1.5rem 1.25rem 1.375rem;
          }
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

        .discover-cta-icon { width: 1rem; height: 1rem; }
        .discover-cta-arrow {
          width: 1rem;
          height: 1rem;
          transition: transform 150ms ease;
        }
        .discover-cta-link:hover .discover-cta-arrow {
          transform: translateX(3px);
        }
      `}</style>
    </div>
  );
}
