import React, { useRef, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  Activity,
  Compass,
  Zap,
  Target,
  Clock,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  goalProgress,
  isGoalComplete,
  MILESTONE_TIERS,
  type FocusGoal,
  type FocusPrimaryRecommendation,
  type FocusStackPriority,
  type FocusMomentumEvent,
  type FocusMastSignal,
  type FocusWeeklyPulse,
} from "@/lib/focus";
import { MILESTONE_XP_BADGE_ID } from "@/lib/xp-fly";

export type FocusTodayContext = {
  readyToClaimCount: number;
  totalGoalsCount: number;
  prioritiesCount: number;
  availableXp: number;
  currentXp: number;
  dailyDiscoverUsed: number;
  dailyDiscoverLimit: number;
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. WELCOME (Composed Greeting)
// ══════════════════════════════════════════════════════════════════════════════

type GreetingProps = {
  period: "morning" | "afternoon" | "evening" | "night";
  name: string;
  subtitle: string;
};

const PERIOD_LABELS: Record<GreetingProps["period"], string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Welcome back",
};

export function FocusGreeting({ period, name, subtitle }: GreetingProps) {
  const salutation = PERIOD_LABELS[period] || "Welcome back";

  return (
    <header className="focus-greeting-section animate-fade-in" aria-label="Command greeting">
      <div className="focus-greeting-container">
        <div className="focus-greeting-eyebrow">
          <span className="focus-status-beacon" aria-hidden="true" />
          <span className="focus-eyebrow-text">COMMAND LAYER · FOCUS</span>
        </div>
        <h1 className="focus-greeting-heading">
          {salutation}, <span className="focus-greeting-name">{name || "MAST"}</span>.
        </h1>
        <p className="focus-greeting-sub">{subtitle}</p>
      </div>

      <style>{`
        .focus-greeting-section {
          padding-top: 1rem;
          padding-bottom: 1.5rem;
        }

        .focus-greeting-container {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }

        .focus-greeting-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.15rem;
        }

        .focus-status-beacon {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--brand, #7c3aed);
          box-shadow: 0 0 10px rgba(124, 58, 237, 0.6);
        }

        .focus-eyebrow-text {
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.45);
          font-family: var(--font-sans, system-ui);
        }

        .focus-greeting-heading {
          font-size: clamp(1.5rem, 2.4vw, 2rem);
          font-weight: 600;
          letter-spacing: -0.025em;
          line-height: 1.2;
          color: #ffffff;
          margin: 0;
          word-break: break-word;
        }

        .focus-greeting-name {
          color: #ffffff;
          font-weight: 700;
        }

        .focus-greeting-sub {
          font-size: 0.875rem;
          color: rgba(255, 255, 255, 0.55);
          margin: 0;
          max-width: 680px;
          line-height: 1.45;
          word-break: break-word;
        }
      `}</style>
    </header>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. YOUR FOCUS (Single Composed Command Surface)
// ══════════════════════════════════════════════════════════════════════════════

type PrimaryHeroProps = {
  recommendation: FocusPrimaryRecommendation | null;
  todayContext?: FocusTodayContext;
};

export function FocusPrimaryHero({ recommendation }: PrimaryHeroProps) {
  if (!recommendation) return null;

  const tone = recommendation.tone;

  return (
    <section className="focus-hero-module animate-fade-up" aria-labelledby="your-focus-heading">
      <div className="focus-hero-surface">
        {/* 1. QUIET SEMANTIC EYEBROW */}
        <div className="focus-hero-eyebrow">
          <span className="focus-hero-eyebrow-dot" aria-hidden="true" />
          <span className="focus-hero-eyebrow-text">{recommendation.category}</span>
        </div>

        {/* 2. PRIMARY RECOMMENDATION */}
        <h2 id="your-focus-heading" className="focus-hero-headline">
          {recommendation.headline}
        </h2>

        {/* 3. SHORT SUPPORTING SENTENCE */}
        <p className="focus-hero-desc">{recommendation.description}</p>

        {/* 4. WHY NOW (Visually recessed & subtle) */}
        <div className="focus-hero-why">
          <span className="focus-hero-why-label">WHY NOW</span>
          <p className="focus-hero-why-text">{recommendation.whyNow}</p>
        </div>

        {/* 5. PRIMARY CTA */}
        <div className="focus-hero-action-row">
          <Link
            to={recommendation.to}
            hash={recommendation.hash}
            className={cn("focus-hero-cta", `focus-cta-${tone}`)}
          >
            <span>{recommendation.actionLabel}</span>
            <ArrowRight className="focus-cta-arrow" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <style>{`
        .focus-hero-module {
          position: relative;
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 16px;
          margin-bottom: 2rem;
          box-shadow: 0 4px 24px -6px rgba(0, 0, 0, 0.4);
        }

        .focus-hero-surface {
          padding: 2.5rem 3rem;
          display: flex;
          flex-direction: column;
        }

        .focus-hero-eyebrow {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.875rem;
        }

        .focus-hero-eyebrow-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.35);
        }

        .focus-hero-eyebrow-text {
          font-size: 0.6875rem;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.45);
          font-family: var(--font-sans, system-ui);
        }
        .focus-hero-headline {
          font-size: clamp(1.625rem, 2.4vw, 2.125rem);
          font-weight: 600;
          letter-spacing: -0.025em;
          line-height: 1.25;
          color: #ffffff;
          margin: 0 0 0.875rem;
          max-width: 800px;
        }

        .focus-hero-desc {
          font-size: 0.9375rem;
          color: rgba(255, 255, 255, 0.68);
          margin: 0 0 1.75rem;
          line-height: 1.55;
          max-width: 720px;
        }

        .focus-hero-why {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          padding: 0.875rem 1.25rem;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.02);
          border-left: 2px solid rgba(255, 255, 255, 0.12);
          max-width: 720px;
          margin-bottom: 2rem;
        }

        .focus-hero-why-label {
          font-size: 0.625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.1em;
          color: rgba(255, 255, 255, 0.4);
          text-transform: uppercase;
        }

        .focus-hero-why-text {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.8);
          line-height: 1.5;
          margin: 0;
        }

        .focus-hero-action-row {
          display: flex;
          align-items: center;
        }

        .focus-hero-cta {
          display: inline-flex;
          align-items: center;
          gap: 0.55rem;
          padding: 0.6875rem 1.5rem;
          border-radius: 10px;
          background: var(--brand, #7c3aed);
          color: #ffffff;
          font-size: 0.875rem;
          font-weight: 600;
          text-decoration: none;
          transition: background 150ms ease, transform 150ms ease, box-shadow 150ms ease;
        }

        .focus-hero-cta:hover {
          background: var(--brand-dark, #6d28d9);
          transform: translateY(-1px);
          box-shadow: 0 4px 16px -2px rgba(124, 58, 237, 0.4);
        }

        .focus-hero-cta:focus-visible {
          outline: 2px solid var(--brand, #7c3aed);
          outline-offset: 2px;
        }

        .focus-cta-danger {
          background: #dc2626;
        }
        .focus-cta-danger:hover {
          background: #b91c1c;
          box-shadow: 0 4px 16px -2px rgba(220, 38, 38, 0.4);
        }

        .focus-cta-warning {
          background: #d97706;
        }
        .focus-cta-warning:hover {
          background: #b45309;
          box-shadow: 0 4px 16px -2px rgba(217, 119, 6, 0.4);
        }

        .focus-cta-success {
          background: #059669;
        }
        .focus-cta-success:hover {
          background: #047857;
          box-shadow: 0 4px 16px -2px rgba(5, 150, 105, 0.4);
        }

        .focus-cta-arrow {
          width: 0.9375rem;
          height: 0.9375rem;
          transition: transform 150ms ease;
        }

        .focus-hero-cta:hover .focus-cta-arrow {
          transform: translateX(3px);
        }

        @media (max-width: 768px) {
          .focus-hero-surface {
            padding: 1.75rem 1.5rem;
          }
          .focus-hero-headline {
            font-size: 1.5rem;
          }
          .focus-hero-why {
            margin-bottom: 1.75rem;
          }
        }

        @media (max-width: 640px) {
          .focus-hero-surface {
            padding: 1.5rem 1.25rem;
          }
          .focus-hero-headline {
            font-size: 1.375rem;
            line-height: 1.3;
          }
          .focus-hero-why {
            margin-bottom: 1.5rem;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. FOCUS STACK (3 Distinct Priorities - Coherent Surface with Editorial Rows)
// ══════════════════════════════════════════════════════════════════════════════

type StackProps = {
  priorities: FocusStackPriority[];
};

export function FocusStack({ priorities }: StackProps) {
  if (priorities.length === 0) return null;

  return (
    <section className="focus-stack-section animate-fade-up" aria-labelledby="focus-stack-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="focus-stack-title" className="focus-module-title">
            FOCUS STACK
          </h2>
          <span className="focus-module-badge">
            {priorities.length} {priorities.length === 1 ? "PRIORITY" : "PRIORITIES"}
          </span>
        </div>
        <span className="focus-module-hint">Queued after your primary focus</span>
      </div>

      <div className="focus-stack-card">
        <div className="focus-stack-list" role="list">
          {priorities.map((item) => (
            <div key={item.id} role="listitem" className="focus-stack-row">
              <div className="focus-stack-main">
                <span className="focus-stack-num">{item.number}</span>

                <div className="focus-stack-info">
                  <div className="focus-stack-top">
                    <span className="focus-stack-title">{item.title}</span>
                    <span className="focus-stack-meta">{item.metadata}</span>
                  </div>
                  <div className="focus-stack-why">
                    <span className="focus-why-prefix">WHY:</span> {item.why}
                  </div>
                </div>
              </div>

              <div className="focus-stack-action">
                <Link
                  to={item.to}
                  hash={item.hash}
                  className="focus-stack-link"
                  aria-label={`${item.actionLabel} for ${item.title}`}
                >
                  <span className="focus-link-text">{item.actionLabel}</span>
                  <ArrowRight className="focus-link-arrow" aria-hidden="true" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .focus-stack-section {
          margin-bottom: 2rem;
        }

        .focus-module-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 0.625rem;
          margin-bottom: 0.5rem;
        }

        .focus-module-title-wrap {
          display: flex;
          align-items: center;
          gap: 0.625rem;
        }

        .focus-module-title {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.7);
          margin: 0;
        }

        .focus-module-badge {
          font-size: 0.625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.06em;
          color: var(--brand, #a855f7);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 0.1rem 0.45rem;
          border-radius: 4px;
        }

        .focus-module-hint {
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-stack-card {
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 14px;
          overflow: hidden;
        }

        .focus-stack-list {
          display: flex;
          flex-direction: column;
        }

        .focus-stack-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.25rem;
          padding: 1.125rem 1.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          transition: background 150ms ease;
        }

        .focus-stack-row:last-child {
          border-bottom: none;
        }

        .focus-stack-row:hover {
          background: rgba(255, 255, 255, 0.02);
        }

        .focus-stack-main {
          display: flex;
          align-items: flex-start;
          gap: 1.125rem;
          flex: 1;
          min-width: 0;
        }

        .focus-stack-num {
          font-family: var(--font-mono, monospace);
          font-size: 0.8125rem;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.35);
          padding-top: 0.1rem;
          flex-shrink: 0;
        }

        .focus-stack-info {
          flex: 1;
          min-width: 0;
        }

        .focus-stack-top {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 0.35rem 0.875rem;
        }

        .focus-stack-title {
          font-size: 0.9375rem;
          font-weight: 600;
          color: #ffffff;
        }

        .focus-stack-meta {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
        }

        .focus-stack-why {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.55);
          line-height: 1.4;
          margin-top: 0.25rem;
        }

        .focus-why-prefix {
          font-weight: 700;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-stack-action {
          flex-shrink: 0;
        }

        .focus-stack-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          color: rgba(255, 255, 255, 0.7);
          text-decoration: none;
          font-size: 0.8125rem;
          font-weight: 600;
          padding: 0.375rem 0.75rem;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.02);
          transition: all 150ms ease;
        }

        .focus-stack-link:hover {
          color: #ffffff;
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.16);
        }

        .focus-link-arrow {
          width: 0.8125rem;
          height: 0.8125rem;
          transition: transform 150ms ease;
        }

        .focus-stack-link:hover .focus-link-arrow {
          transform: translateX(3px);
        }

        @media (max-width: 640px) {
          .focus-stack-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.75rem;
            padding: 1rem;
          }
          .focus-stack-action {
            align-self: flex-end;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. TODAY'S GOALS (Row-based with Nearest-to-Completion Emphasis)
// ══════════════════════════════════════════════════════════════════════════════

type GoalsProps = {
  goals: FocusGoal[];
  onClaim: (goal: FocusGoal, cardEl: HTMLElement | null) => void;
  claimedGoalIds: Set<string>;
  claimingGoalIds: Set<string>;
  exitingGoalIds: Set<string>;
};

export function FocusGoals({
  goals,
  onClaim,
  claimedGoalIds,
  claimingGoalIds,
  exitingGoalIds,
}: GoalsProps) {
  if (goals.length === 0) return null;

  const completedCount = goals.filter((g) => isGoalComplete(g)).length;
  const totalXp = goals.reduce((sum, g) => sum + g.xp, 0);

  // Find nearest-to-completion incomplete goal to emphasize
  const incompleteGoals = goals.filter((g) => !isGoalComplete(g));
  const nearestGoalId =
    incompleteGoals.length > 0
      ? incompleteGoals.reduce((nearest, g) =>
          goalProgress(g) > goalProgress(nearest) ? g : nearest,
        ).id
      : null;

  return (
    <div id="focus-goals" className="focus-goals-module" aria-labelledby="todays-goals-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="todays-goals-title" className="focus-module-title">
            TODAY'S GOALS
          </h2>
          <span className="focus-module-badge">
            {completedCount} / {goals.length}
          </span>
        </div>
        <span className="focus-goals-xp-summary">+{totalXp} XP</span>
      </div>

      <div className="focus-goals-card">
        <div className="focus-goals-table" role="list">
          {goals.map((goal, index) => {
            const pct = goalProgress(goal);
            const complete = isGoalComplete(goal);
            const isClaimed = claimedGoalIds.has(goal.id);
            const isClaiming = claimingGoalIds.has(goal.id);
            const isExiting = exitingGoalIds.has(goal.id);
            const claimable = complete && !isClaimed && !isClaiming;
            const isPriority = goal.id === nearestGoalId;

            return (
              <GoalEditorialRow
                key={goal.id}
                goal={goal}
                index={index}
                pct={pct}
                complete={complete}
                claimable={claimable}
                isClaimed={isClaimed}
                isClaiming={isClaiming}
                isExiting={isExiting}
                isPriority={isPriority}
                onClaim={onClaim}
              />
            );
          })}
        </div>
      </div>

      <style>{`
        .focus-goals-module {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .focus-goals-xp-summary {
          font-size: 0.6875rem;
          font-weight: 700;
          color: #fbbf24;
          font-family: var(--font-mono, monospace);
        }

        .focus-goals-card {
          flex: 1;
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 14px;
          overflow: hidden;
        }

        .focus-goals-table {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
      `}</style>
    </div>
  );
}

function GoalEditorialRow({
  goal,
  pct,
  complete,
  claimable,
  isClaiming,
  isExiting,
  isPriority,
  onClaim,
}: {
  goal: FocusGoal;
  index: number;
  pct: number;
  complete: boolean;
  claimable: boolean;
  isClaimed: boolean;
  isClaiming: boolean;
  isExiting: boolean;
  isPriority: boolean;
  onClaim: (goal: FocusGoal, el: HTMLElement | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  function handleClick() {
    if (!claimable) return;
    onClaim(goal, rowRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <div
      ref={rowRef}
      role={claimable ? "button" : "listitem"}
      tabIndex={claimable ? 0 : undefined}
      aria-label={
        claimable
          ? `Claim +${goal.xp} XP for ${goal.label}`
          : `${goal.label}, ${pct}% complete`
      }
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "focus-goal-row",
        complete && "focus-goal-complete",
        claimable && "focus-goal-claimable",
        isClaiming && "focus-goal-claiming",
        isExiting && "focus-goal-exiting",
        isPriority && "focus-goal-priority",
      )}
    >
      <div className="focus-goal-header-row">
        <div className="focus-goal-title-wrap">
          <span className="focus-goal-label">{goal.label}</span>
          {isPriority && <span className="focus-priority-tag">NEAREST</span>}
        </div>
        <div className="focus-goal-fraction">
          {Math.min(goal.current, goal.target)} / {goal.target}
        </div>
      </div>

      <div className="focus-goal-progress-row">
        <div className="focus-goal-track">
          <div
            className={cn("focus-goal-fill", complete ? "focus-fill-complete" : "focus-fill-active")}
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="focus-goal-status-col">
          {complete ? (
            <span className={cn("focus-goal-badge-complete", claimable && "focus-badge-interactive")}>
              <Check className="focus-goal-check" aria-hidden="true" />
              {claimable ? `CLAIM +${goal.xp} XP` : "DONE"}
            </span>
          ) : (
            <span className="focus-goal-xp">+{goal.xp} XP</span>
          )}
        </div>
      </div>

      <style>{`
        .focus-goal-row {
          padding: 0.9375rem 1.375rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          transition: background 150ms ease;
        }

        .focus-goal-row:last-child {
          border-bottom: none;
        }

        .focus-goal-priority {
          background: rgba(255, 255, 255, 0.02);
        }

        .focus-goal-claimable {
          cursor: pointer;
        }

        .focus-goal-claimable:hover {
          background: rgba(255, 255, 255, 0.035);
        }

        .focus-goal-claimable:focus-visible {
          outline: 2px solid var(--brand, #7c3aed);
          outline-offset: -2px;
        }

        .focus-goal-header-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 0.5rem;
        }

        .focus-goal-title-wrap {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .focus-goal-label {
          font-size: 0.8125rem;
          font-weight: 500;
          color: #ffffff;
        }

        .focus-priority-tag {
          font-size: 0.5625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.06em;
          color: rgba(255, 255, 255, 0.45);
          background: rgba(255, 255, 255, 0.05);
          padding: 0.1rem 0.35rem;
          border-radius: 3px;
        }

        .focus-goal-fraction {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
          font-variant-numeric: tabular-nums;
        }

        .focus-goal-progress-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .focus-goal-track {
          flex: 1;
          height: 4px;
          border-radius: 99px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }

        .focus-goal-fill {
          height: 100%;
          border-radius: 99px;
          transition: width 350ms ease;
        }

        .focus-fill-active {
          background: var(--brand, #7c3aed);
        }

        .focus-fill-complete {
          background: #10b981;
        }

        .focus-goal-status-col {
          flex-shrink: 0;
        }

        .focus-goal-xp {
          font-family: var(--font-mono, monospace);
          font-size: 0.6875rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-goal-badge-complete {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.04em;
          color: #34d399;
          background: rgba(52, 211, 153, 0.1);
          border: 1px solid rgba(52, 211, 153, 0.25);
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
          transition: all 150ms ease;
        }

        .focus-badge-interactive:hover {
          background: rgba(52, 211, 153, 0.2);
          border-color: rgba(52, 211, 153, 0.4);
          transform: translateY(-1px);
        }

        .focus-goal-check {
          width: 0.6875rem;
          height: 0.6875rem;
        }

        .focus-goal-claiming {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. MOMENTUM (Timeline Stream / Recent Activity)
// ══════════════════════════════════════════════════════════════════════════════

type MomentumProps = {
  events: FocusMomentumEvent[];
};

export function FocusMomentum({ events }: MomentumProps) {
  return (
    <div className="focus-momentum-module" aria-label="Recent Momentum">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 className="focus-module-title">RECENT ACTIVITY</h2>
          <span className="focus-module-badge">7 DAYS</span>
        </div>
        <Activity className="focus-module-icon" aria-hidden="true" />
      </div>

      <div className="focus-momentum-card">
        {events.length === 0 ? (
          <div className="focus-timeline-empty">
            <p className="focus-timeline-empty-text">No activity recorded in the last 7 days.</p>
          </div>
        ) : (
          <div className="focus-timeline-list" role="list">
            {events.map((evt, idx) => (
              <div key={evt.id} className="focus-timeline-item" role="listitem">
                <div className="focus-timeline-rail">
                  <div className="focus-timeline-bullet" aria-hidden="true" />
                  {idx < events.length - 1 && <div className="focus-timeline-line" aria-hidden="true" />}
                </div>
                <div className="focus-timeline-body">
                  <div className="focus-timeline-header">
                    <span className="focus-timeline-delta">{evt.delta}</span>
                    <span className="focus-timeline-label">{evt.label}</span>
                  </div>
                  <p className="focus-timeline-detail">{evt.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .focus-momentum-module {
          display: flex;
          flex-direction: column;
        }

        .focus-module-icon {
          width: 0.8125rem;
          height: 0.8125rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-momentum-card {
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 14px;
          padding: 1.25rem 1.5rem;
          display: flex;
          flex-direction: column;
          min-height: 90px;
        }

        .focus-timeline-empty {
          padding: 0.875rem 0;
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .focus-timeline-empty-text {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.45);
          margin: 0;
        }

        .focus-timeline-list {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .focus-timeline-item {
          display: flex;
          align-items: flex-start;
          gap: 0.875rem;
          position: relative;
          padding-bottom: 0.875rem;
        }

        .focus-timeline-item:last-child {
          padding-bottom: 0;
        }

        .focus-timeline-rail {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 12px;
          flex-shrink: 0;
          position: relative;
          padding-top: 0.25rem;
        }

        .focus-timeline-bullet {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--brand, #7c3aed);
          box-shadow: 0 0 6px rgba(124, 58, 237, 0.5);
          z-index: 1;
        }

        .focus-timeline-line {
          position: absolute;
          top: 0.75rem;
          bottom: -0.75rem;
          width: 1px;
          background: rgba(255, 255, 255, 0.08);
          z-index: 0;
        }

        .focus-timeline-body {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          flex: 1;
          min-width: 0;
        }

        .focus-timeline-header {
          display: flex;
          align-items: baseline;
          gap: 0.45rem;
        }

        .focus-timeline-delta {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          font-weight: 700;
          color: #34d399;
          flex-shrink: 0;
        }

        .focus-timeline-label {
          font-size: 0.8125rem;
          font-weight: 600;
          color: #ffffff;
        }

        .focus-timeline-detail {
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.45);
          margin: 0;
          line-height: 1.35;
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. MILESTONE JOURNEY (Compressed & Purposeful Progression)
// ══════════════════════════════════════════════════════════════════════════════

type MilestoneProps = {
  xp: number;
  currentName: string;
  nextName: string | null;
  progressPct: number;
  leveledUpTier?: string | null;
};

export function FocusMilestoneJourney({
  xp,
  currentName,
  nextName,
  progressPct,
}: MilestoneProps) {
  const currentIndex = Math.max(0, MILESTONE_TIERS.findIndex((t) => t.name === currentName));
  const nextTier = MILESTONE_TIERS.find((t) => t.name === nextName);
  const xpRemaining = nextTier ? Math.max(0, nextTier.xpRequired - xp) : 0;

  const displayTiers = useMemo(() => {
    const maxStart = Math.max(0, MILESTONE_TIERS.length - 4);
    const idealStart = currentIndex > 1 ? currentIndex - 1 : 0;
    const start = Math.min(idealStart, maxStart);
    return MILESTONE_TIERS.slice(start, start + 4);
  }, [currentIndex]);

  return (
    <section className="focus-milestone-section animate-fade-up" aria-label="Progression Journey">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 className="focus-module-title">MILESTONE JOURNEY</h2>
        </div>
      </div>

      <div className="focus-milestone-card">
        {/* Tier Destinations Track */}
        <div className="focus-journey-destinations">
          <div className="focus-journey-connector" aria-hidden="true" />

          {displayTiers.map((tier) => {
            const tierGlobalIndex = MILESTONE_TIERS.findIndex((t) => t.id === tier.id);
            const isPassed = tierGlobalIndex < currentIndex;
            const isCurrent = tierGlobalIndex === currentIndex;
            const isNext = tierGlobalIndex === currentIndex + 1;
            const isFuture = tierGlobalIndex > currentIndex + 1;

            let stateLabel = "LOCKED";
            if (isPassed) stateLabel = "COMPLETED";
            else if (isCurrent) stateLabel = "CURRENT";
            else if (isNext) stateLabel = "NEXT";

            return (
              <div
                key={tier.id}
                className={cn(
                  "focus-destination-node",
                  isCurrent && "focus-destination-current",
                  isPassed && "focus-destination-passed",
                  isNext && "focus-destination-next",
                  isFuture && "focus-destination-future",
                )}
              >
                <div
                  id={isCurrent ? MILESTONE_XP_BADGE_ID : undefined}
                  className="focus-node-circle"
                  aria-label={`${tier.name}: ${stateLabel}, ${tier.xpRequired} XP`}
                >
                  {isPassed ? (
                    <Check className="focus-node-check" aria-hidden="true" />
                  ) : isCurrent ? (
                    <span className="focus-node-current-dot" />
                  ) : isNext ? (
                    <span className="focus-node-next-dot" />
                  ) : (
                    <span className="focus-node-future-dot" />
                  )}
                </div>

                <div className="focus-destination-meta">
                  <div className="focus-destination-name-wrap">
                    <span className="focus-stage-tag">{stateLabel}</span>
                    <span className="focus-stage-name">{tier.name}</span>
                  </div>
                  <span className="focus-stage-xp">{tier.xpRequired.toLocaleString()} XP</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Subordinate Hierarchy Strip */}
        <div className="focus-milestone-status-strip">
          <div className="focus-status-item">
            <span className="focus-status-caption">CURRENT TIER</span>
            <span className="focus-status-value">{currentName}</span>
          </div>

          <div className="focus-status-divider" />

          <div className="focus-status-item">
            <span className="focus-status-caption">XP PROGRESS</span>
            <span className="focus-status-value">{progressPct}%</span>
          </div>

          <div className="focus-status-divider" />

          <div className="focus-status-item">
            <span className="focus-status-caption">XP TO NEXT TIER</span>
            <span className="focus-status-value focus-status-highlight">
              {nextTier ? `${xpRemaining.toLocaleString()} XP to ${nextTier.name}` : "Top tier reached"}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        .focus-milestone-section {
          margin-bottom: 1.25rem;
        }

        .focus-milestone-card {
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 14px;
          padding: 1.5rem 1.75rem 1.25rem;
        }

        .focus-journey-destinations {
          position: relative;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 0.5rem 0 0.25rem;
        }

        .focus-journey-connector {
          position: absolute;
          top: 21px;
          left: 12.5%;
          right: 12.5%;
          height: 1px;
          background: rgba(255, 255, 255, 0.09);
          z-index: 0;
          pointer-events: none;
        }

        .focus-destination-node {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          flex: 1;
          min-width: 0;
        }

        .focus-node-circle {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: #12151e;
          display: grid;
          place-items: center;
          margin-bottom: 0.75rem;
          transition: all 200ms ease;
        }

        .focus-destination-passed .focus-node-circle {
          border: 1.5px solid rgba(52, 211, 153, 0.4);
          background: rgba(52, 211, 153, 0.08);
        }

        .focus-node-check {
          width: 0.75rem;
          height: 0.75rem;
          color: #34d399;
          stroke-width: 2.5;
        }

        .focus-destination-current .focus-node-circle {
          border: 2px solid var(--brand, #8b5cf6);
          background: #12151e;
          box-shadow: 0 0 10px rgba(139, 92, 246, 0.45);
        }

        .focus-node-current-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--brand, #a78bfa);
          box-shadow: 0 0 6px rgba(167, 139, 250, 0.6);
        }

        .focus-destination-next .focus-node-circle {
          border: 1.5px solid rgba(245, 158, 11, 0.65);
          background: #12151e;
          box-shadow: 0 0 8px rgba(245, 158, 11, 0.15);
        }

        .focus-node-next-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #f59e0b;
        }

        .focus-destination-future .focus-node-circle {
          border: 1.5px solid rgba(255, 255, 255, 0.12);
          background: #12151e;
        }

        .focus-node-future-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.12);
        }

        .focus-destination-meta {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
        }

        .focus-destination-name-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.2rem;
        }

        .focus-stage-tag {
          font-size: 0.5625rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .focus-destination-passed .focus-stage-tag {
          color: rgba(52, 211, 153, 0.75);
        }

        .focus-destination-current .focus-stage-tag {
          color: #c4b5fd;
        }

        .focus-destination-next .focus-stage-tag {
          color: #f59e0b;
        }

        .focus-destination-future .focus-stage-tag {
          color: rgba(255, 255, 255, 0.28);
        }

        .focus-stage-name {
          font-size: 0.8125rem;
          line-height: 1.25;
        }

        .focus-destination-passed .focus-stage-name {
          color: rgba(255, 255, 255, 0.7);
          font-weight: 500;
        }

        .focus-destination-current .focus-stage-name {
          color: #ffffff;
          font-weight: 700;
        }

        .focus-destination-next .focus-stage-name {
          color: rgba(255, 255, 255, 0.9);
          font-weight: 600;
        }

        .focus-destination-future .focus-stage-name {
          color: rgba(255, 255, 255, 0.4);
          font-weight: 500;
        }

        .focus-stage-xp {
          font-size: 0.6875rem;
          font-family: var(--font-mono, monospace);
          line-height: 1.25;
        }

        .focus-destination-passed .focus-stage-xp {
          color: rgba(255, 255, 255, 0.35);
        }

        .focus-destination-current .focus-stage-xp {
          color: rgba(255, 255, 255, 0.75);
          font-weight: 600;
        }

        .focus-destination-next .focus-stage-xp {
          color: rgba(245, 158, 11, 0.75);
          font-weight: 600;
        }

        .focus-destination-future .focus-stage-xp {
          color: rgba(255, 255, 255, 0.25);
        }

        .focus-milestone-status-strip {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-top: 1rem;
          margin-top: 1.25rem;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }

        .focus-status-item {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }

        .focus-status-caption {
          font-size: 0.5625rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.38);
        }

        .focus-status-value {
          font-size: 0.75rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.85);
        }

        .focus-status-highlight {
          color: rgba(255, 255, 255, 0.9);
          font-family: var(--font-mono, monospace);
        }

        .focus-status-divider {
          width: 1px;
          height: 18px;
          background: rgba(255, 255, 255, 0.06);
        }

        @media (max-width: 640px) {
          .focus-milestone-card {
            padding: 1.25rem 1rem 1rem;
          }

          .focus-journey-destinations {
            flex-direction: column;
            gap: 1.125rem;
            align-items: stretch;
            padding: 0.25rem 0;
          }

          .focus-journey-connector {
            top: 17px;
            bottom: 17px;
            left: 13px;
            right: auto;
            width: 1px;
            height: auto;
          }

          .focus-destination-node {
            flex-direction: row;
            align-items: center;
            text-align: left;
            gap: 1rem;
          }

          .focus-node-circle {
            margin-bottom: 0;
            flex-shrink: 0;
          }

          .focus-destination-meta {
            flex-direction: row;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            gap: 0.75rem;
          }

          .focus-destination-name-wrap {
            align-items: flex-start;
          }

          .focus-milestone-status-strip {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.625rem;
            padding-top: 0.875rem;
            margin-top: 1rem;
          }

          .focus-status-divider {
            display: none;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. MAST SIGNAL (Intelligence Dispatch Module)
// ══════════════════════════════════════════════════════════════════════════════

type SignalProps = {
  signal: FocusMastSignal;
};

export function FocusSignal({ signal }: SignalProps) {
  const isQuiet = signal.isQuiet;

  return (
    <div className="focus-signal-module" aria-labelledby="mast-signal-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="mast-signal-title" className="focus-module-title">
            MAST SIGNAL
          </h2>
          <span className={cn("focus-module-badge", isQuiet ? "focus-badge-quiet" : "focus-badge-active")}>
            {isQuiet ? "QUIET" : "ACTIVE OBSERVATION"}
          </span>
        </div>
      </div>

      <div className={cn("focus-signal-card", isQuiet && "focus-signal-quiet-card")}>
        <div className="focus-signal-body">
          <h3 className="focus-signal-headline">{signal.headline}</h3>
          <p className="focus-signal-detail">{signal.detail}</p>
        </div>

        {signal.to && signal.actionLabel && (
          <div className="focus-signal-action">
            <Link to={signal.to} className="focus-signal-link">
              <span>{signal.actionLabel}</span>
              <ArrowRight className="focus-signal-arrow" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>

      <style>{`
        .focus-signal-module {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .focus-badge-active {
          color: var(--brand, #a855f7);
          border-color: rgba(124, 58, 237, 0.3);
          background: rgba(124, 58, 237, 0.08);
        }

        .focus-badge-quiet {
          color: rgba(255, 255, 255, 0.4);
          border-color: rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
        }

        .focus-signal-card {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 1.25rem;
          padding: 1.25rem 1.5rem;
          border-radius: 14px;
          background: oklch(0.145 0.024 265);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-left: 3px solid var(--brand, #7c3aed);
        }

        .focus-signal-quiet-card {
          border-left: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          background: var(--card, #12151e);
        }

        .focus-signal-headline {
          font-size: 0.9375rem;
          font-weight: 600;
          color: #ffffff;
          margin: 0 0 0.35rem;
          line-height: 1.35;
        }

        .focus-signal-detail {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.55);
          margin: 0;
          line-height: 1.45;
        }

        .focus-signal-action {
          display: flex;
          justify-content: flex-end;
        }

        .focus-signal-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          color: rgba(255, 255, 255, 0.75);
          font-size: 0.75rem;
          font-weight: 600;
          text-decoration: none;
          padding: 0.35rem 0.75rem;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          transition: all 150ms ease;
        }

        .focus-signal-link:hover {
          color: #ffffff;
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.16);
        }

        .focus-signal-arrow {
          width: 0.75rem;
          height: 0.75rem;
          transition: transform 150ms ease;
        }

        .focus-signal-link:hover .focus-signal-arrow {
          transform: translateX(3px);
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. WEEKLY PULSE (Operational Metric Strip)
// ══════════════════════════════════════════════════════════════════════════════

type WeeklyPulseProps = {
  pulse: FocusWeeklyPulse;
};

export function FocusWeeklyPulse({ pulse }: WeeklyPulseProps) {
  return (
    <div className="focus-pulse-module" aria-labelledby="weekly-pulse-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <Compass className="focus-module-icon" aria-hidden="true" />
          <h2 id="weekly-pulse-title" className="focus-module-title">
            WEEKLY PULSE
          </h2>
        </div>
        <div className="focus-pulse-momentum">
          <span className="focus-pulse-momentum-label">{pulse.basisLabel}</span>
        </div>
      </div>

      <div className="focus-pulse-card">
        <div
          className="focus-pulse-grid"
          style={{ gridTemplateColumns: `repeat(${pulse.tiles.length}, 1fr)` }}
        >
          {pulse.tiles.map((tile) => (
            <div key={tile.label} className="focus-pulse-stat">
              <span className="focus-pulse-label">{tile.label}</span>
              <span className="focus-pulse-num">{tile.value}</span>
            </div>
          ))}
        </div>

        <p className="focus-pulse-summary">{pulse.summary}</p>
      </div>

      <style>{`
        .focus-pulse-module {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .focus-pulse-momentum {
          display: flex;
          align-items: center;
          gap: 0.35rem;
        }

        .focus-pulse-momentum-label {
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-pulse-card {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: oklch(0.125 0.022 265);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 14px;
          padding: 1.25rem 1.5rem;
        }

        .focus-pulse-grid {
          display: grid;
          gap: 0.75rem;
          margin-bottom: 0.75rem;
          background: rgba(255, 255, 255, 0.015);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 10px;
          padding: 0.875rem 1rem;
        }

        .focus-pulse-stat {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .focus-pulse-label {
          font-size: 0.625rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255, 255, 255, 0.4);
          font-weight: 600;
        }

        .focus-pulse-num {
          font-family: var(--font-mono, monospace);
          font-size: 1.25rem;
          font-weight: 700;
          color: #ffffff;
          font-variant-numeric: tabular-nums;
        }

        .focus-pulse-summary {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
          margin: 0;
          line-height: 1.4;
        }

        @media (max-width: 640px) {
          .focus-pulse-grid {
            grid-template-columns: repeat(2, 1fr) !important;
            gap: 1rem 0.75rem;
          }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. EMPTY STATE ("YOU'RE CLEAR.")
// ══════════════════════════════════════════════════════════════════════════════

type EmptyStateProps = {
  goalsClaimedToday: number;
  xp: number;
  nextTierName: string | null;
  xpToNextTier: number;
};

export function FocusEmptyState({
  goalsClaimedToday,
  xp,
  nextTierName,
  xpToNextTier,
}: EmptyStateProps) {
  return (
    <section className="focus-empty-section animate-fade-in" aria-label="Command clear state">
      <div className="focus-empty-card">
        <div className="focus-empty-check-wrap">
          <Check className="focus-empty-check" aria-hidden="true" />
        </div>

        <h2 className="focus-empty-heading">YOU'RE CLEAR.</h2>

        <p className="focus-empty-sub">Nothing important needs your attention right now.</p>

        <div className="focus-empty-stats">
          <div className="focus-empty-stat">
            <span className="focus-empty-stat-num">{goalsClaimedToday}</span>
            <span className="focus-empty-stat-label">Goals claimed today</span>
          </div>
          <div className="focus-empty-stat-divider" />
          <div className="focus-empty-stat">
            <span className="focus-empty-stat-num">{xp.toLocaleString()}</span>
            <span className="focus-empty-stat-label">Total XP</span>
          </div>
          {nextTierName && (
            <>
              <div className="focus-empty-stat-divider" />
              <div className="focus-empty-stat">
                <span className="focus-empty-stat-num">{xpToNextTier}</span>
                <span className="focus-empty-stat-label">XP to {nextTierName}</span>
              </div>
            </>
          )}
        </div>

        <div className="focus-empty-actions">
          <Link to="/dashboard/leads" className="focus-empty-primary-btn">
            Discover something new →
          </Link>
        </div>
      </div>

      <style>{`
        .focus-empty-section {
          padding: 3rem 0;
          display: flex;
          justify-content: center;
        }

        .focus-empty-card {
          width: 100%;
          max-width: 580px;
          background: var(--card, #12151e);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 16px;
          padding: 3rem 2.5rem;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .focus-empty-check-wrap {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: rgba(52, 211, 153, 0.12);
          border: 1px solid rgba(52, 211, 153, 0.3);
          display: grid;
          place-items: center;
          margin-bottom: 1.5rem;
        }

        .focus-empty-check {
          width: 24px;
          height: 24px;
          color: #34d399;
        }

        .focus-empty-heading {
          font-size: 1.375rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          color: #ffffff;
          margin: 0 0 0.75rem;
        }

        .focus-empty-sub {
          font-size: 0.875rem;
          color: rgba(255, 255, 255, 0.6);
          line-height: 1.5;
          margin: 0 0 2rem;
          max-width: 440px;
        }

        .focus-empty-stats {
          display: flex;
          align-items: center;
          gap: 2rem;
          padding: 1rem 1.75rem;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          margin-bottom: 2rem;
        }

        .focus-empty-stat {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }

        .focus-empty-stat-num {
          font-family: var(--font-mono, monospace);
          font-size: 1.125rem;
          font-weight: 700;
          color: #ffffff;
        }

        .focus-empty-stat-label {
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.45);
        }

        .focus-empty-stat-divider {
          width: 1px;
          height: 24px;
          background: rgba(255, 255, 255, 0.08);
        }

        .focus-empty-actions {
          display: flex;
          align-items: center;
          gap: 0.875rem;
        }

        .focus-empty-primary-btn {
          font-size: 0.8125rem;
          font-weight: 600;
          color: #ffffff;
          background: var(--brand, #7c3aed);
          padding: 0.55rem 1.25rem;
          border-radius: 8px;
          text-decoration: none;
          transition: background 150ms ease;
        }

        .focus-empty-primary-btn:hover {
          background: var(--brand-dark, #6d28d9);
        }
      `}</style>
    </section>
  );
}
